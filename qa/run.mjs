#!/usr/bin/env node
// Real-repo QA of the static source reader (`--repo`): runner. See qa/README.md.
//
// Runs one mcp-check build over the targets in qa/targets.json (a public repository at a pinned commit, an optional
// subfolder) and keeps the raw outputs under <out>/<label>/remote/<id>.{json,tools.json,err,meta.json}. The reader
// is static: it lists the repository through the GitHub API and reads files from raw.githubusercontent.com. Nothing
// of a target is cloned, installed, built or run.
//
//   node qa/run.mjs --label head --bin bin/mcp-check.js [--out qa/out] [--shard 1/4] [--only id,id] [--concurrency 4]
//
// GITHUB_TOKEN is passed by name (--github-token-env); it is never printed and is scrubbed from every saved output.
// A remote read that failed for a network or GitHub-side reason (5xx, 403/429 rate limit, reset) is retried up to 4
// times with a growing, jittered wait. A clean "no tool definitions found" answer is never retried.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTIONS = 'spec,anthropic,openai,security,quality,surface';

function parseArgs(argv) {
  const o = { label: null, bin: null, out: path.join(HERE, 'out'), only: null, shard: null, concurrency: 4, timeout: 120, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--label') o.label = next();
    else if (a === '--bin') o.bin = path.resolve(next());
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--only') o.only = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--shard') { const m = /^(\d+)\/(\d+)$/.exec(next()); if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error('--shard is k/n, 1 <= k <= n'); o.shard = [+m[1], +m[2]]; }
    else if (a === '--concurrency') o.concurrency = Math.max(1, Math.min(8, Number(next()) || 4));
    else if (a === '--timeout') o.timeout = Math.max(10, Math.min(600, Number(next()) || 120));
    else if (a === '--force') o.force = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.label)) throw new Error('--label is required (letters, digits, . _ -)');
  if (!o.bin) throw new Error('--bin <path/to/bin/mcp-check.js> is required');
  return o;
}

const TOKEN = process.env.GITHUB_TOKEN || '';
const scrub = (s) => (TOKEN && s ? String(s).split(TOKEN).join('***') : String(s ?? ''));

// Only remote reads that failed for a network or GitHub-side reason are retried.
function transient(stderr) {
  if (/no tool definitions found/i.test(stderr)) return false;
  return /rate limit|secondary rate|abuse|HTTP (403|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|timed? ?out|other side closed|did not answer/i.test(stderr);
}

function runOnce(bin, args, timeoutS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: TOKEN, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => { err += `\n[qa] killed after ${timeoutS}s`; child.kill('SIGKILL'); }, timeoutS * 1000);
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code: code ?? (signal ? 124 : 1), out, err, ms: Date.now() - t0 }); });
  });
}

async function runTarget(t, opt, outDir) {
  const base = path.join(outDir, t.id);
  if (!opt.force && fs.existsSync(base + '.meta.json')) return JSON.parse(fs.readFileSync(base + '.meta.json', 'utf8'));
  fs.rmSync(base + '.tools.json', { force: true });
  const ref = `github.com/${t.repo}/tree/${t.sha}${t.subdir ? '/' + t.subdir : ''}`;
  const args = ['--repo', ref, '--github-token-env', 'GITHUB_TOKEN', '--format', 'json', '--sections', SECTIONS, '--save', base + '.tools.json', '--timeout', String(opt.timeout)];
  let r, attempt = 0;
  for (;;) {
    attempt++;
    r = await runOnce(opt.bin, args, opt.timeout + 15);
    if (r.code === 0 || r.code === 1 || attempt >= 4 || !transient(r.err)) break;
    const wait = 5000 * attempt * attempt + Math.floor(Math.random() * 2000);
    console.error(`::warning title=reader-qa::${t.id}: transient failure (exit ${r.code}), retry ${attempt} in ${Math.round(wait / 1000)}s`);
    await new Promise((res) => setTimeout(res, wait));
  }
  fs.writeFileSync(base + '.json', scrub(r.out));
  fs.writeFileSync(base + '.err', scrub(r.err));
  const meta = { id: t.id, mode: 'remote', exit: r.code, ms: r.ms, attempts: attempt };
  fs.writeFileSync(base + '.meta.json', JSON.stringify(meta, null, 1) + '\n');
  return meta;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  let targets = JSON.parse(fs.readFileSync(path.join(HERE, 'targets.json'), 'utf8')).targets;
  if (opt.only) { targets = targets.filter((t) => opt.only.has(t.id)); if (targets.length !== opt.only.size) throw new Error('unknown target id in --only'); }
  if (opt.shard) targets = targets.filter((_, i) => i % opt.shard[1] === opt.shard[0] - 1);
  if (!TOKEN) console.error('::warning title=reader-qa::GITHUB_TOKEN is not set: reads run at the anonymous rate limit');
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(opt.bin)), 'package.json'), 'utf8')).version;
  const outRoot = path.join(opt.out, opt.label);
  const outDir = path.join(outRoot, 'remote');
  fs.mkdirSync(outDir, { recursive: true });
  console.error(`mcp-check ${version} (${opt.label}): ${targets.length} targets${opt.shard ? ` (shard ${opt.shard.join('/')})` : ''}, concurrency ${opt.concurrency}`);
  const res = []; let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(opt.concurrency, targets.length) }, async () => {
    while (i < targets.length) {
      const t = targets[i++];
      const m = await runTarget(t, opt, outDir);
      res.push(m); done++;
      console.error(`[${String(done).padStart(3)}/${targets.length}] ${t.id.padEnd(18)} exit ${m.exit} ${(m.ms / 1000).toFixed(1)}s${m.attempts > 1 ? ' x' + m.attempts : ''}`);
    }
  }));
  const info = { label: opt.label, version, shard: opt.shard ? opt.shard.join('/') : null, targets: targets.length, exits: res.reduce((a, m) => { a[m.exit] = (a[m.exit] || 0) + 1; return a; }, {}) };
  fs.writeFileSync(path.join(outRoot, `run${opt.shard ? '-' + opt.shard[0] : ''}.json`), JSON.stringify(info, null, 1) + '\n');
}

main().catch((e) => { console.error('qa/run.mjs: ' + scrub(e && e.message)); process.exit(2); });
