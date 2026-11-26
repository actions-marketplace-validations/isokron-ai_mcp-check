// Version pins (tool-qa R-PIN-01): tool-qa files every result under the commits its lane pins and, once it enforces
// them, dispatches with `tool_sha`, expects the worker to run exactly that commit and to say so in manifest `tools`.
// These tests pin the two workflows' half (the input, the checkout, the check, the report) and run the reported
// shapes through the same expectation as tool-qa's ingest (pump/pins.mjs there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ranCommit } from '../corpus/tool-commit.mjs';
import { toolsRan } from '../corpus/live-probe.mjs';
import { buildBundle } from '../corpus/scan-static.mjs';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const wfText = (f) => readFileSync(join(root, '.github', 'workflows', f), 'utf8');
const LANES = [['scan-static', 'scan-static.yml'], ['live-probe', 'live-probe.yml']];
const FULL = 'd4a373a' + '0123456789abcdef0123456789abcdef0'.slice(0, 33);
const FULL2 = '75503c1' + 'fedcba9876543210fedcba9876543210f'.slice(0, 33);
const DATE = '2026-01-02T03:04:05Z';

/** The `run:` body of the step with this name, with its env: block as an object (raw expressions). */
function step(yml, name) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: ' + name || l.trim() === 'name: ' + name);
  assert.ok(at >= 0, 'no step named ' + name);
  const ind = lines[at].search(/\S/);
  const body = [];
  for (let i = at + 1; i < lines.length; i++) { if (lines[i].trim() && lines[i].search(/\S/) <= ind && /^\s*- /.test(lines[i])) break; body.push(lines[i]); }
  const text = '\n' + body.join('\n');
  const env = {};
  const e = text.match(/\n\s*env:\n((?:\s+[A-Z_]+: .*\n?)+)/);
  if (e) for (const m of e[1].matchAll(/^\s+([A-Z_]+): (.*)$/gm)) env[m[1]] = m[2];
  const run = text.match(/\n(\s*)run: \|\n([\s\S]*)$/);
  assert.ok(run, name + ' has a run block');
  const script = run[2].split('\n').filter((l) => l.startsWith(run[1] + '  ') || !l.trim()).map((l) => l.slice(run[1].length + 2)).join('\n');
  return { env, script };
}
const bash = (script, env, cwd) => spawnSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env }, cwd, encoding: 'utf8' });

// ------------------------------------------------------------------ the inputs

function inputsCase(lane, file) {
  const y = wfText(file);
  assert.match(y, /\n      tool_sha:\n        description: [^\n]+\n        required: false\n        type: string\n        default: ''\n/);
  const { env, script } = step(y, 'Check the inputs');
  assert.equal(env.TOOL_SHA, '${{ inputs.tool_sha }}', 'reaches the script through env: only');
  assert.ok(!script.includes('${{'), 'no expression is interpolated into the script');
  const base = { SHARD_ID: 's-1', ATTEMPT_ID: 'a-1', ITEMS: '[{"subject":"o/r"}]' };
  for (const ok of ['', FULL]) assert.equal(bash(script, { ...base, TOOL_SHA: ok }).status, 0, JSON.stringify(ok));
  for (const bad of ['main', FULL.slice(0, 7), FULL + '0', FULL.toUpperCase(), FULL.slice(0, 39) + 'g', FULL + '\n', ' ' + FULL, '$(id)' + FULL.slice(5)]) {
    const r = bash(script, { ...base, TOOL_SHA: bad });
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.match(r.stdout, /tool_sha must be empty or a full 40-character commit/);
  }
}

function checkoutCase(lane, file) {
  const y = wfText(file);
  // The checkout of this repository that runs the lane code: the one right after the input check.
  const after = y.slice(y.indexOf('- name: Check the inputs'));
  const m = after.match(/- uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n        with:\n          persist-credentials: false\n          ref: \$\{\{ inputs\.tool_sha \|\| github\.sha \}\}\n/);
  assert.ok(m, 'the lane job checks out inputs.tool_sha || github.sha');
  assert.ok(after.indexOf(m[0]) < after.indexOf('id: tool'), 'the check follows the checkout');
  // The guard job's sparse checkout stays on the dispatched commit.
  assert.doesNotMatch(y.slice(0, y.indexOf('- name: Check the inputs')).split('\n  guard:')[1] || '', /inputs\.tool_sha/);

  const { env, script } = step(y, 'Check the checkout is the commit asked for');
  assert.deepEqual(env, { TOOL_SHA: '${{ inputs.tool_sha }}' });
  assert.ok(!script.includes('${{'));
  const repo = mkdtempSync(join(tmpdir(), 'pins-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'a'), '1'); git('add', 'a'); git('commit', '-qm', 'one');
  const one = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a'), '2'); git('commit', '-qam', 'two');
  const two = git('rev-parse', 'HEAD');
  const out = join(repo, 'gh-output');
  const run = (tool, sha) => bash(script, { TOOL_SHA: tool, GITHUB_SHA: sha, GITHUB_OUTPUT: out }, repo);
  // Empty tool_sha: HEAD must be the dispatched commit, as today.
  assert.equal(run('', two).status, 0);
  assert.equal(readFileSync(out, 'utf8'), 'commit=' + two + '\n');
  assert.equal(run('', one).status, 1, 'empty tool_sha and a checkout that is not the dispatched commit');
  // A pin: HEAD must be it, whatever the dispatched commit.
  git('checkout', '-q', one);
  assert.equal(run(one, two).status, 0, 'the pinned commit is checked out');
  git('checkout', '-q', two);
  const bad = run(one, two);
  assert.equal(bad.status, 1, 'the checkout is not the pin');
  assert.match(bad.stdout, /the checkout is not the commit asked for/);
}

test('R-PIN-01: scan-static and live-probe take an optional tool_sha and accept only empty or a full lower-case commit', () => {
  for (const [lane, file] of LANES) inputsCase(lane, file);
});

test('R-PIN-02: both workflows check out tool_sha (else the dispatched commit) and fail the job unless HEAD is exactly it', () => {
  for (const [lane, file] of LANES) checkoutCase(lane, file);
});

// ------------------------------------------------------------------ what is reported

test('R-PIN-03: the commit that ran is passed from the checking step to the step that builds the bundles, and only a full commit is taken', () => {
  assert.equal(step(wfText('scan-static.yml'), 'Check the checkout is the commit asked for').script.includes('GITHUB_OUTPUT'), true);
  assert.match(wfText('scan-static.yml'), /- id: scan\n[\s\S]*?MCP_CHECK_COMMIT: \$\{\{ steps\.tool\.outputs\.commit \}\}\n        run: node corpus\/scan-static\.mjs run/);
  assert.match(wfText('live-probe.yml'), /- id: bundle\n        name: Check the controls and build the bundles\n        env:\n(?:\s+#[^\n]*\n)?\s+MCP_CHECK_COMMIT: \$\{\{ steps\.tool\.outputs\.commit \}\}\n        run: node corpus\/live-probe\.mjs bundle/);
  assert.equal(ranCommit({ MCP_CHECK_COMMIT: FULL }), FULL);
  for (const bad of [undefined, '', FULL.slice(0, 7), FULL.toUpperCase(), FULL + '0', 'main']) assert.equal(ranCommit({ MCP_CHECK_COMMIT: bad }), VERSION, String(bad));
  assert.equal(ranCommit({}), VERSION);
});

test('R-PIN-04: scan-static reports mcp-check at the commit that ran, not the package version', () => {
  const item = { subject: 'o/r', repo: 'o/r', run_key: 'a'.repeat(64), fence: 1 };
  const scan = { status: 'skipped', detail: 'repo_unavailable', http_status: 404, list_error: null, error_name: null, language_hint: null, repository: null, commit: null, listing: null, list: null, grade: null, raw: {} };
  const meta = (env) => { const was = process.env.MCP_CHECK_COMMIT; if (env === undefined) delete process.env.MCP_CHECK_COMMIT; else process.env.MCP_CHECK_COMMIT = env; try { return buildBundle({ item, scan, controls: [], startedAt: DATE, finishedAt: DATE }).meta; } finally { if (was === undefined) delete process.env.MCP_CHECK_COMMIT; else process.env.MCP_CHECK_COMMIT = was; } };
  assert.deepEqual(meta(FULL).tools, [{ name: 'mcp-check', version: FULL }]);
  assert.deepEqual(meta(undefined).tools, [{ name: 'mcp-check', version: VERSION }], 'outside the workflow: the package version, which proves nothing');
  assert.deepEqual(buildBundle({ item, scan, controls: [], startedAt: DATE, finishedAt: DATE, commit: FULL2 }).meta.tools, [{ name: 'mcp-check', version: FULL2 }]);
});

test('R-PIN-05: live-probe reports the package, the corpus commit it used, and fuzz only when the stage ran', () => {
  const msc = '11974fbb75a8c276214c887a079d6ad6df374124';
  assert.deepEqual(toolsRan({ commit: FULL, mscCommit: msc, fuzz: true }), [
    { name: '@isokron/mcp-check', version: FULL }, { name: 'isokron-ai/mcp-surface-corpus', version: msc }, { name: 'fuzz', version: FULL },
  ]);
  assert.deepEqual(toolsRan({ commit: FULL, mscCommit: msc, fuzz: false }), [{ name: '@isokron/mcp-check', version: FULL }, { name: 'isokron-ai/mcp-surface-corpus', version: msc }]);
  assert.deepEqual(toolsRan({ commit: FULL, mscCommit: null, fuzz: false }), [{ name: '@isokron/mcp-check', version: FULL }], 'no corpus commit read: nothing invented');
});

// ------------------------------------------------------------------ tool-qa's expectation

// tool-qa pump/pins.mjs (isokron-ai/tool-qa#78), copied for the rules this repository's reports must meet. When a
// checkout of that file is at TOOL_QA_PINS (a path), the same cases run against the real one as well.
const COMMIT_PIN_RE = /^[0-9a-f]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const reportsComponent = (n, key) => typeof n === 'string' && (n === key || n.endsWith('/' + key) || n === 'tool-qa-' + key);
function pinEvidence(pin, version) {
  if (typeof version !== 'string') return 'silent';
  if (COMMIT_PIN_RE.test(pin)) {
    if (!COMMIT_PIN_RE.test(version)) return 'silent';
    if (!(version.startsWith(pin) || pin.startsWith(version))) return 'contradiction';
    return FULL_SHA_RE.test(version) ? 'proof' : 'silent';
  }
  return version === pin ? 'proof' : 'contradiction';
}
function checkPinsCopy(expected, tools) {
  const out = { verified: [], unverified: [], mismatched: [] };
  for (const kind of ['tool', 'probe']) for (const [name, pin] of Object.entries(expected[kind] ?? {})) {
    const seen = tools.filter((c) => reportsComponent(c.name, name)).map((c) => ({ version: c.version, says: pinEvidence(pin, c.version) }));
    if (seen.some((s) => s.says === 'contradiction')) out.mismatched.push({ kind, name });
    else if (seen.some((s) => s.says === 'proof')) out.verified.push({ kind, name });
    else out.unverified.push({ kind, name });
  }
  return out;
}
const realPins = process.env.TOOL_QA_PINS && existsSync(process.env.TOOL_QA_PINS) ? await import(pathToFileURL(process.env.TOOL_QA_PINS).href) : null;
const SCAN_PINS = { tool: { 'mcp-check': '75503c1' }, probe: {} };
const LIVE_PINS = { tool: { 'mcp-check': 'd4a373a' }, probe: { 'mcp-surface-corpus': '11974fb', fuzz: 'd4a373a' } };
const MSC = '11974fbb75a8c276214c887a079d6ad6df374124';

test('R-PIN-06: the reported shapes prove the lane pins to tool-qa\'s pin check: a full commit proves a short pin, another commit contradicts it, a package version proves nothing', () => {
  const impls = [['copy', (e, t) => checkPinsCopy(e, t)], ...(realPins ? [['tool-qa pump/pins.mjs', (e, t) => realPins.checkPins(e, t)]] : [])];
  for (const [which, check] of impls) {
    const names = (r) => ({ ok: r.verified.map((x) => x.name), unverified: r.unverified.map((x) => x.name), bad: r.mismatched.map((x) => x.name) });
    // scan-static, run at its pin: proven.
    assert.deepEqual(names(check(SCAN_PINS, [{ name: 'mcp-check', version: FULL2 }])), { ok: ['mcp-check'], unverified: [], bad: [] }, which);
    // live-probe at its pins, fuzz ran: all three proven (the package under its scoped name).
    assert.deepEqual(names(check(LIVE_PINS, toolsRan({ commit: FULL, mscCommit: MSC, fuzz: true }))), { ok: ['mcp-check', 'mcp-surface-corpus', 'fuzz'], unverified: [], bad: [] }, which);
    // fuzz off: its pin is unproven (not wrong); tool-qa decides per lane mode.
    assert.deepEqual(names(check(LIVE_PINS, toolsRan({ commit: FULL, mscCommit: MSC, fuzz: false }))), { ok: ['mcp-check', 'mcp-surface-corpus'], unverified: ['fuzz'], bad: [] }, which);
    // A branch head that is not the pin: contradiction, so a worker that runs `main` past a label pin is refused.
    assert.deepEqual(names(check(SCAN_PINS, [{ name: 'mcp-check', version: FULL }])), { ok: [], unverified: [], bad: ['mcp-check'] }, which);
    // Outside the workflow (package version): unproven, never wrong.
    assert.deepEqual(names(check(SCAN_PINS, [{ name: 'mcp-check', version: VERSION }])), { ok: [], unverified: ['mcp-check'], bad: [] }, which);
  }
});

test('R-PIN-08: the probe job comment states the lease the pump gives a shard: 1.5 x (setup 8 + 10 x 3 minutes) + 10 = 67', () => {
  assert.match(wfText('live-probe.yml'), /1\.5 x \(8 \+ 10 x 3\) \+ 10 = 67 minutes/);
  assert.equal(1.5 * (8 + 10 * 3) + 10, 67);
  assert.doesNotMatch(wfText('live-probe.yml'), /= 46 minutes/);
});
