import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeRun, gradeTarget, summarize, FORMAT } from '../corpus/grade.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const good = JSON.parse(readFileSync(join(root, 'test', 'catalogs', 'well-designed.json'), 'utf8'));
const ex = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'example.json'), 'utf8'));

function run() {
  const out = mkdtempSync(join(tmpdir(), 'mcpcorpus-'));
  const t = (id, files) => { mkdirSync(join(out, id)); for (const [f, v] of Object.entries(files)) writeFileSync(join(out, id, f), typeof v === 'string' ? v : JSON.stringify(v)); };
  t('t01', { 'surface.json': { initialize: { serverInfo: { name: 'good-server', version: '1.2.3' } }, tools: { tools: good.tools }, captured_at: '2026-11-18T00:00:00Z' }, 'meta.json': { surface: { sha256_jcs: 'a'.repeat(64), protocol_version: '2025-11-25', tools_pages: 1 } } });
  t('t02', { 'meta.json': { surface: null } });
  t('t03', { 'surface.json': '{not json' });
  let deep = {}; for (let i = 0; i < 100; i++) deep = { a: deep };
  t('t04', { 'surface.json': { tools: { tools: [{ name: 'x', inputSchema: deep }] } } });
  t('t05', {});
  symlinkSync('/etc/hostname', join(out, 't05', 'surface.json'));
  t('t06', { 'surface.json': { initialize: { serverInfo: { name: 'x'.repeat(300), version: 7 } }, tools: ex } });
  t('t07', { 'surface.json': { initialize: null, tools: null } });
  mkdirSync(join(out, '_shard')); writeFileSync(join(out, '_shard', 'shard.json'), '{}');
  mkdirSync(join(out, 'Bad_Name'));
  return out;
}

test('corpus grade: one record per target folder, errors recorded, never thrown', () => {
  const recs = gradeRun(run(), { gradedAt: '2026-11-18T12:00:00Z' });
  assert.deepEqual(recs.map((r) => r.target), ['t01', 't02', 't03', 't04', 't05', 't06', 't07']);
  for (const r of recs) { assert.equal(r.format, FORMAT); assert.equal(r.graded_at, '2026-11-18T12:00:00Z'); assert.equal(r.rubric_version, '2.1.1'); }
  const [t1, t2, t3, t4, t5, t6, t7] = recs;
  assert.equal(t1.error, null);
  assert.equal(t1.sections.anthropic.grade, 'A');
  assert.equal(t1.server_info.name, 'good-server');
  assert.deepEqual(t1.surface, { sha256_jcs: 'a'.repeat(64), protocol_version: '2025-11-25', tools_pages: 1, captured_at: '2026-11-18T00:00:00Z' });
  assert.equal(t1.tool_count, good.tools.length);
  assert.match(t1.catalog_hash, /^[0-9a-f]{64}$/);
  assert.equal(t2.error.code, 'no_surface');
  assert.equal(t3.error.code, 'not_json');
  assert.equal(t4.error.code, 'too_deep');
  assert.equal(t5.error.code, 'not_file', 'a symlinked surface.json is not followed');
  assert.equal(t6.error, null);
  assert.equal(t6.server_info.name, null, 'over-long strings are dropped, not cut');
  assert.equal(t6.server_info.version, null);
  assert.equal(t6.sections.anthropic.grade, 'C');
  assert.ok(t6.check_counts['anthropic-title'] >= 1);
  assert.ok(t6.findings.every((f) => f.id && f.severity));
  assert.equal(t7.error.code, 'no_tools');
  assert.equal(t7.sections, null);
});

test('corpus summarize: aggregates only, no target ids or tool names', () => {
  const s = summarize(gradeRun(run()));
  assert.equal(s.targets, 7);
  assert.equal(s.graded, 2);
  assert.deepEqual(s.errors, { no_surface: 1, not_json: 1, too_deep: 1, not_file: 1, no_tools: 1 });
  assert.equal(s.grades.anthropic.A, 1);
  assert.equal(s.grades.anthropic.C, 1);
  assert.equal(s.checks_by_targets['anthropic-title'], 1);
  const text = JSON.stringify(s);
  assert.ok(!/t0\d/.test(text) && !text.includes('good-server') && !text.includes('create_issue'));
});

test('corpus grade CLI: JSON lines on stdout; usage errors exit 2', () => {
  const out = run();
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'grade.mjs'), out], { encoding: 'utf8', env: { ...process.env, MCP_CHECK_GRADED_AT: '2026-11-18T00:00:00Z' } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 7);
  assert.equal(lines[0].graded_at, '2026-11-18T00:00:00Z');
  const f = join(out, 'd.jsonl'); writeFileSync(f, r.stdout);
  const s = spawnSync(process.execPath, [join(root, 'corpus', 'grade.mjs'), 'summarize', f], { encoding: 'utf8' });
  assert.equal(JSON.parse(s.stdout).graded, 2);
  assert.equal(spawnSync(process.execPath, [join(root, 'corpus', 'grade.mjs')], { encoding: 'utf8' }).status, 2);
});

test('corpus grade: a single target folder without meta.json grades from surface.json alone', () => {
  const out = mkdtempSync(join(tmpdir(), 'mcpcorpus1-'));
  writeFileSync(join(out, 'surface.json'), JSON.stringify({ tools: { tools: good.tools } }));
  const r = gradeTarget(out, 't99');
  assert.equal(r.error, null);
  assert.equal(r.surface.sha256_jcs, undefined);
});

test('corpus grade-shard.sh: digest-pinned image, no network, read-only mounts; dataset lands in the run folder', () => {
  // A stand-in for docker that records its arguments and runs the command on the host with the mounts mapped.
  const tmp = mkdtempSync(join(tmpdir(), 'mcpgradeshard-'));
  const bin = join(tmp, 'bin'); mkdirSync(bin);
  const fake = `#!/usr/bin/env node
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(join(tmp, 'docker-args.json'))}, JSON.stringify(a));
const map = {}; let i = 1; const env = { ...process.env };
for (; i < a.length; i++) {
  if (a[i] === '--mount') { const m = Object.fromEntries(a[++i].split(',').map((kv) => kv.split('='))); map[m.dst] = m.src; }
  else if (a[i] === '--env') { const [k, v] = a[++i].split('='); env[k] = v; }
  else if (['--network','--user','--memory','--memory-swap','--pids-limit','--cpus','--tmpfs','--security-opt','--cap-drop','--workdir'].includes(a[i])) i++;
  else if (a[i].startsWith('--')) continue;
  else break;
}
const cmd = a.slice(i + 1).map((x) => { for (const [d, s] of Object.entries(map)) if (x.startsWith(d + '/') || x === d) return s + x.slice(d.length); return x; });
const r = spawnSync(process.execPath, cmd.slice(1), { stdio: 'inherit', env });
process.exit(r.status);
`;
  writeFileSync(join(bin, 'docker'), fake, { mode: 0o755 });
  const ws = join(tmp, 'ws');
  mkdirSync(join(ws, 'runner', 'corpus'), { recursive: true });
  writeFileSync(join(ws, 'runner', 'corpus', 'images.json'), JSON.stringify({ runtime: 'docker.io/library/node:22-bookworm-slim@sha256:' + 'e'.repeat(64) }));
  for (const d of ['corpus', 'src', 'engine']) symlinkSync(join(root, d), join(ws, d));
  symlinkSync(join(root, 'package.json'), join(ws, 'package.json'));
  const rt = join(tmp, 'rt'); mkdirSync(join(rt, 'corpus'), { recursive: true });
  const out = run();
  symlinkSync(out, join(rt, 'corpus', 'out'));
  const r = spawnSync('bash', [join(root, 'corpus', 'grade-shard.sh')], { cwd: ws, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, RUNNER_TEMP: rt, GITHUB_WORKSPACE: ws } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'graded', 'nothing about targets is printed');
  const args = JSON.parse(readFileSync(join(tmp, 'docker-args.json'), 'utf8'));
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges']) assert.ok(args.join(' ').includes(flag), flag);
  assert.ok(args.filter((x) => x.startsWith('type=bind')).every((m) => m.endsWith(',readonly')), 'every mount is read-only');
  assert.ok(args.includes('docker.io/library/node:22-bookworm-slim@sha256:' + 'e'.repeat(64)));
  const lines = readFileSync(join(out, '_mcp-check', 'dataset.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 7);

  writeFileSync(join(ws, 'runner', 'corpus', 'images.json'), JSON.stringify({ runtime: 'node:22' }));
  const bad = spawnSync('bash', [join(root, 'corpus', 'grade-shard.sh')], { cwd: ws, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, RUNNER_TEMP: rt, GITHUB_WORKSPACE: ws } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not digest-pinned/);
});

test('corpus run-surface-shard.sh: only "run finished, exit N" lines reach the log', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mcpshard-'));
  const ws = join(tmp, 'ws'); mkdirSync(join(ws, 'runner', 'corpus'), { recursive: true });
  writeFileSync(join(ws, 'runner', 'corpus', 'run-shard.mjs'), "console.log('automated candidate, unreviewed: not a finding'); console.log('leaked target name t13 some-server'); console.log('run finished, exit 0'); console.log('run finished, exit 125 extra'); process.exit(1);");
  const rt = join(tmp, 'rt'); mkdirSync(join(rt, 'corpus'), { recursive: true });
  writeFileSync(join(rt, 'corpus', 'targets.json'), '{}');
  const bin = join(tmp, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const gho = join(tmp, 'gho'); writeFileSync(gho, '');
  const r = spawnSync('bash', [join(root, 'corpus', 'run-surface-shard.sh')], { cwd: ws, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, RUNNER_TEMP: rt, GITHUB_OUTPUT: gho, SHARD: '1', CORPUS_SHARDS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'run finished, exit 0\n');
  assert.equal(readFileSync(join(rt, 'corpus', 'public.txt'), 'utf8'), 'run finished, exit 0\n');
  assert.equal(readFileSync(gho, 'utf8'), 'rc=1\n', 'the driver status, not the filter status');
});
