// The real-repo QA of the static reader (qa/, .github/workflows/reader-qa.yml): its committed targets and truth, the
// gate rules of qa/score.mjs on synthetic outputs, the runner's retry rule and the workflow's safety properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const qa = path.join(root, 'qa');
const targets = JSON.parse(fs.readFileSync(path.join(qa, 'targets.json'), 'utf8')).targets;
const wf = fs.readFileSync(path.join(root, '.github/workflows/reader-qa.yml'), 'utf8');
const code = wf.replace(/^\s*#.*$/gm, '');
const truthOf = (id) => JSON.parse(fs.readFileSync(path.join(qa, 'truth', id + '.json'), 'utf8'));

/** Synthetic outputs for one label: every truth target returns its default tools, every multi-server root refuses. */
function synth(out, label, tweak = () => null) {
  const dir = path.join(out, label, 'remote');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of targets) {
    const o = { meta: { id: t.id, exit: 0, ms: 1000, attempts: 1 }, report: null, err: '' };
    const { meta } = o;
    if (t.multi_server) { meta.exit = 3; o.err = 'This repository holds several servers: pick a subfolder.'; }
    else {
      const tr = t.truth ? truthOf(t.id) : null;
      const names = tr && tr.usable !== false ? tr.tools.filter((x) => x.default !== false).map((x) => x.name) : [];
      if (!names.length) { meta.exit = 3; o.err = 'no tool definitions found'; }
      else o.report = { sections: { spec: { grade: 'A' } }, source: { fidelity: 'schemas', from: 'source', files: [] }, tools: names.map((name) => ({ name })) };
    }
    tweak(t, o);
    const { report, err } = o;
    fs.writeFileSync(path.join(dir, t.id + '.meta.json'), JSON.stringify(o.meta));
    fs.writeFileSync(path.join(dir, t.id + '.json'), report ? JSON.stringify(report) : '');
    fs.writeFileSync(path.join(dir, t.id + '.tools.json'), report ? JSON.stringify(report.tools) : '');
    fs.writeFileSync(path.join(dir, t.id + '.err'), err);
  }
}

function score(out, ...args) {
  const r = spawnSync(process.execPath, [path.join(qa, 'score.mjs'), '--label', 'head', '--out', out, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reader-qa-'));

test('R-QA-01: the committed targets are public repositories at 40-hex commits, each truth file holds names only, no secret-shaped text', () => {
  assert.ok(targets.length >= 100);
  const ids = new Set();
  for (const t of targets) {
    assert.ok(!ids.has(t.id), t.id + ' twice'); ids.add(t.id);
    assert.match(t.id, /^[a-z0-9][a-z0-9._-]*$/);
    assert.match(t.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(t.sha, /^[0-9a-f]{40}$/, t.id);
    assert.ok(['ts', 'python', 'go', 'rust', 'csharp', 'matlab', 'mixed'].includes(t.language), t.id);
    assert.equal(!!t.truth, fs.existsSync(path.join(qa, 'truth', t.id + '.json')), t.id + ': truth flag and file disagree');
    assert.deepEqual(Object.keys(t).filter((k) => !['id', 'repo', 'sha', 'subdir', 'language', 'patterns', 'multi_server', 'truth_source', 'truth'].includes(k)), [], t.id);
  }
  const files = ['targets.json', 'servers.json', 'reference.json', ...fs.readdirSync(path.join(qa, 'truth')).map((f) => 'truth/' + f)];
  for (const f of files) {
    const text = fs.readFileSync(path.join(qa, f), 'utf8');
    assert.ok(!/ghp_|github_pat_|sk-[A-Za-z0-9]{20}|AKIA[A-Z0-9]{12}|xox[bp]-|BEGIN [A-Z ]*PRIVATE KEY/.test(text), f);
    if (f.startsWith('truth/')) {
      const j = JSON.parse(text);
      assert.deepEqual(Object.keys(j).filter((k) => !['id', 'tools', 'usable', 'server_root'].includes(k)), [], f);
      for (const x of j.tools) assert.deepEqual(Object.keys(x).filter((k) => !['name', 'default'].includes(k)), [], f);
    }
  }
});

test('R-QA-02: the runner retries a rate limit or a GitHub-side failure with a growing wait, never a clean "no tool definitions found"', () => {
  const src = fs.readFileSync(path.join(qa, 'run.mjs'), 'utf8');
  assert.match(src, /rate limit[^\n]*HTTP \(403\|429\|5\\d\\d\)/);
  assert.match(src, /if \(\/no tool definitions found\/i\.test\(stderr\)\) return false;/);
  assert.match(src, /attempt >= 4/);
  assert.match(src, /5000 \* attempt \* attempt \+ Math\.floor\(Math\.random\(\)/);
  assert.match(src, /GITHUB_TOKEN: TOKEN/);
  assert.ok(!/\$\{TOKEN\}|\+ TOKEN/.test(src), 'the token is never put into a message');
  assert.match(src, /split\(TOKEN\)\.join\('\*\*\*'\)/);
});

test('R-QA-03: four shards cover every target once, and the shard flag is the only way a run splits', () => {
  const cover = new Map();
  for (let k = 1; k <= 4; k++) targets.filter((_, i) => i % 4 === k - 1).forEach((t) => cover.set(t.id, (cover.get(t.id) || 0) + 1));
  assert.equal(cover.size, targets.length);
  assert.ok([...cover.values()].every((n) => n === 1));
  assert.match(wf, /shard: \[1, 2, 3, 4\]/);
  assert.match(code, /--shard "\$\{\{ matrix\.shard \}\}\/4"/);
  assert.match(fs.readFileSync(path.join(qa, 'run.mjs'), 'utf8'), /i % opt\.shard\[1\] === opt\.shard\[0\] - 1/);
});

test('R-QA-04: the gate passes on a perfect run and fails on low recall, an error, a silent merge, a names-only list graded and a regression against the base', () => {
  const out = tmp();
  synth(out, 'head'); synth(out, 'base');
  let r = score(out, '--base', 'base', '--gate');
  assert.equal(r.code, 0, r.err + r.out.slice(0, 600));
  assert.match(r.out, /Byte-identical output[^\n]*\*\*113 of 113\*\*/);
  assert.match(r.out, /Recall, Go \| 1\.00/);

  // recall: the Go targets lose half their tools
  const low = tmp(); synth(low, 'head', (t, o) => { if (t.language === 'go' && o.report) o.report.tools = o.report.tools.slice(0, Math.floor(o.report.tools.length / 2)); });
  r = score(low, '--gate'); assert.equal(r.code, 1); assert.match(r.err, /Go recall 0\.\d\d < 0\.8/);

  // a crash
  const bad = tmp(); synth(bad, 'head', (t, o) => { if (t.id === 'ref-time') { o.meta.exit = 2; o.report = null; o.err = 'boom'; } });
  r = score(bad, '--gate'); assert.equal(r.code, 1); assert.match(r.err, /ended in error or are missing: ref-time/);

  // a names-only list graded on a schema check
  const names = tmp(); synth(names, 'head', (t, o) => { if (t.id === 'ref-time') { o.report.source.fidelity = 'names'; o.report.tools[0].findings = [{ id: 'schema-missing' }]; } });
  r = score(names, '--gate'); assert.equal(r.code, 1); assert.match(r.err, /names-only list\(s\) graded on schema\/annotation checks: ref-time/);

  // a multi-server root graded with a list of one server's tools is a silent pick, with tools of two a silent merge
  const pick = tmp(); synth(pick, 'head', (t, o) => { if (t.id === 'ref-root') { o.meta.exit = 0; o.err = ''; o.report = { sections: { spec: { grade: 'A' } }, source: { fidelity: 'schemas', from: 'source', files: [] }, tools: [{ name: 'zzz-not-a-tool' }] }; } });
  r = score(pick, '--gate'); assert.equal(r.code, 1); assert.match(r.err, /silent pick/);

  // a regression: one default tool lost against the base, recall still above the threshold
  const reg = tmp(); synth(reg, 'base'); synth(reg, 'head', (t, o) => { if (t.id === 'ref-time') o.report.tools = o.report.tools.slice(1); });
  r = score(reg, '--base', 'base', '--gate'); assert.equal(r.code, 1); assert.match(r.err, /1 regression\(s\) against base: ref-time/);
  assert.match(r.out, /Byte-identical output[^\n]*\*\*112 of 113\*\*/);
  assert.match(r.out, /ref-time: default tools found \d+ -> \d+/);
});

test('R-QA-05: reader-qa.yml: dispatch and labelled pull_request only, contents: read, no secret, no pull_request_target, shard inputs fixed, base and head pinned', () => {
  assert.match(wf, /\non:\n  workflow_dispatch:\n[\s\S]*\n  pull_request:\n    types: \[opened, reopened, synchronize, labeled\]\n/);
  assert.ok(!/pull_request_target|workflow_run|\n  (push|schedule|workflow_call):/.test(code));
  assert.match(wf, /\npermissions:\n  contents: read\n/);
  assert.ok(!/secrets\./.test(code), 'no secret');
  assert.ok(!/\n\s+(contents|issues|pull-requests|actions|id-token|packages): write/.test(code), 'no write permission');
  assert.match(code, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'reader-change'\)/);
  assert.match(code, /github\.event\.label\.name == 'reader-change'/);
  assert.match(code, /github\.repository == 'isokron-ai\/mcp-check'/);
  assert.match(code, /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| inputs\.base_ref \|\| 'main' \}\}/);
  assert.match(code, /BASE_REF: \$\{\{ inputs\.base_ref \}\}/);
  for (const m of code.matchAll(/run: \|?\n?((?:.*\n)*?)(?=      - |\n?$)/g)) assert.ok(!/\$\{\{\s*(inputs|github\.event\.pull_request)\./.test(m[1]), 'an input or PR field expanded in a run: script');
  // the token is set only on the two steps that read repositories, and no step installs or builds anything
  assert.equal([...code.matchAll(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g)].length, 2);
  assert.ok(!/npm (ci|install)|\bgit clone\b|\bdocker\b|\bnpx\b/.test(code), 'nothing is installed, cloned or run from a target');
  assert.match(code, /--gate/);
});
