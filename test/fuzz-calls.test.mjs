// R-FC-*: the tools/call fuzz stage (corpus/fuzz/calls): fixtures only, input generation, invariants, the matrix
// and its controls. The stage sends tools/call, so it runs only against our own seeded and tiny-tracker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES, fixtureIds, getFixture, launch } from '../corpus/fuzz/calls/fixtures.mjs';
import { generate, OVERSIZE_BYTES, valid } from '../corpus/fuzz/calls/gen.mjs';
import { judgeCall } from '../corpus/fuzz/calls/invariants.mjs';
import { build, controls, runMatrix, verdict, SUBJECT_ID } from '../corpus/fuzz/calls/matrix.mjs';
import { fuzzFixture, MAX_RESTARTS } from '../corpus/fuzz/calls/run.mjs';
import { validate } from '../corpus/fuzz/calls/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEEDED = fixtureIds().filter((id) => getFixture(id).kind === 'seeded');
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: { text: { type: 'string', minLength: 1, maxLength: 20 }, n: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 3 }, kind: { enum: ['a', 'b'] } },
};

test('R-FC-01: the stage runs only fixtures of our own: no third-party server is in fixtures.json, and a caller cannot name a command', () => {
  assert.ok(FIXTURES.fixtures.length >= 20);
  for (const f of FIXTURES.fixtures) assert.ok(['seeded', 'tiny-tracker'].includes(f.kind), `${f.id}: ${f.kind}`);
  assert.ok(!/docker|npx|uvx|pip |npm install|registry|github\.com/i.test(JSON.stringify(FIXTURES.fixtures)), 'no container, package or repository reference in a fixture');
  for (const id of ['seeded-clean', 'tiny-tracker-correct']) assert.ok(fixtureIds().includes(id));
  for (const bad of ['', 'node', 'node x.js', '../etc/passwd', 'docker run x', 'seeded-clean; id', 'SEEDED-CLEAN', undefined, 5, null]) {
    assert.throws(() => getFixture(bad), /not a fixture/, String(bad));
    assert.throws(() => launch(bad), /not a fixture/, String(bad));
  }
  const spec = launch('seeded-hang-boundary');
  assert.equal(spec.command[0], process.execPath);
  assert.ok(spec.command[1].startsWith(ROOT), 'the seeded server is in this repository');
  assert.equal(spec.env.FAULT, 'hang-boundary');
  assert.deepEqual(Object.keys(spec.env).sort(), ['FAULT', 'HOME', 'LANG', 'PATH'], 'a fixture gets no other environment (no token reaches it)');
});

test('R-FC-01: a tiny-tracker fixture needs a built checkout at an absolute path, and its argv is only plain defect names', () => {
  assert.deepEqual(launch('tiny-tracker-correct', { tinyDir: undefined }), { unavailable: 'tiny_tracker_not_built' });
  assert.deepEqual(launch('tiny-tracker-correct', { tinyDir: 'relative/dir' }), { unavailable: 'tiny_tracker_not_built' });
  const l = launch('tiny-tracker-backend-lookup-unscoped', { tinyDir: '/x/tiny-tracker' });
  assert.deepEqual(l.command, [process.execPath, '/x/tiny-tracker/dist/src/cli.js', 'stdio', '--backend-defect', 'lookup-unscoped']);
  const m = launch('tiny-tracker-lookup-reexecutes', { tinyDir: '/x/tiny-tracker' });
  assert.deepEqual(m.command.slice(2), ['stdio', '--defect', 'lookup-reexecutes']);
  assert.equal(Object.keys(l.env).includes('GITHUB_TOKEN'), false);
});

test('R-FC-02: generated inputs: valid satisfies the schema, invalid violates it, boundary and oversize are marked "any", all four classes appear', () => {
  const cases = generate(SCHEMA);
  const classes = new Set(cases.map((c) => c.class));
  for (const c of ['valid', 'boundary', 'invalid', 'oversize']) assert.ok(classes.has(c), c);
  for (const c of cases.filter((x) => x.class === 'valid')) assert.equal(validate(SCHEMA, c.arguments).ok, true, c.id);
  for (const c of cases.filter((x) => x.expect === 'reject')) assert.equal(validate(SCHEMA, c.arguments).ok, false, `${c.id} violates the schema`);
  for (const c of cases.filter((x) => x.class === 'boundary' && x.expect === 'any' && !/unicode|zero|safe-int|empty/.test(x.id))) assert.equal(validate(SCHEMA, c.arguments).ok, true, `${c.id} satisfies the schema`);
  assert.ok(cases.some((c) => c.id === 'invalid:missing-text'));
  assert.ok(cases.some((c) => c.id === 'invalid:wrong-type-n'));
  assert.ok(cases.some((c) => c.id === 'invalid:not-in-enum-kind'));
  assert.ok(cases.some((c) => c.id === 'invalid:unexpected-property'));
  assert.ok(cases.some((c) => c.id === 'boundary:text-maxLength' && c.arguments.text.length === 20));
  const big = cases.filter((c) => c.class === 'oversize');
  assert.ok(big.length >= 1 && big.every((c) => JSON.stringify(c.arguments).length >= OVERSIZE_BYTES), 'oversize cases are at least 1 MiB');
  assert.deepEqual(generate(SCHEMA).map((c) => c.id), cases.map((c) => c.id), 'deterministic');
  assert.deepEqual(valid({ type: 'string', minLength: 3 }), 'xxx');
  assert.equal(valid({ $ref: '#/x' }), undefined, 'a schema it cannot read gives no value, never a wrong one');
});

test('R-FC-02: a schema the generator cannot read still gets the schema-independent cases, and an oversize string goes in each string property that allows it', () => {
  const cases = generate({ $ref: '#/$defs/x' });
  assert.ok(cases.some((c) => c.id === 'invalid:arguments-is-array'));
  const two = generate({ type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string', maxLength: 10 } } });
  assert.deepEqual(two.filter((c) => c.class === 'oversize').map((c) => c.id), ['oversize:a-1MiB', 'oversize:unknown-property-1MiB']);
});

const SCHEMA_OUT = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] };
const call = (response, over = {}) => judgeCall({ tool: { name: 't', outputSchema: SCHEMA_OUT }, kase: { id: 'k', class: 'valid', expect: 'accept' }, outcome: { response }, ...over });
const ids = (j) => j.findings.map((f) => f.id);
const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { id: 1 } } };

test('R-FC-03: a clean answer has no finding', () => {
  assert.deepEqual(call(ok).findings, []);
});

test('R-FC-03: LIFE-1 and LIFE-2: an exited process and a missing answer are findings; an answer over our own line cap is inconclusive, never a finding', () => {
  assert.deepEqual(ids(call(null, { outcome: { exited: { code: 1 } } })), ['LIFE-1']);
  assert.deepEqual(ids(call(null, { outcome: { timedOut: true } })), ['LIFE-2']);
  const cap = call(null, { outcome: { lineCap: true } });
  assert.deepEqual(cap.findings, []);
  assert.equal(cap.inconclusive.length, 1);
});

test('R-FC-03: ERR-1: an error needs an integer code and a string message and no result beside it; an answer with another id is named, not called a hang', () => {
  assert.deepEqual(ids(call({ id: 1, error: { code: 'x', message: 'm' } })), ['ERR-1']);
  assert.deepEqual(ids(call({ id: 1, error: { code: -32602, message: 5 } })), ['ERR-1']);
  assert.deepEqual(ids(call({ id: 1, error: { code: -32602, message: 'm' }, result: {} })), ['ERR-1']);
  assert.deepEqual(ids(call({ id: 1 })), ['ERR-1']);
  assert.deepEqual(ids(call({ id: 1, error: { code: -32602, message: 'bad' } })), [], 'a proper error is fine');
  assert.deepEqual(ids(call(null, { outcome: { timedOut: true }, strays: [{ id: 99 }] })), ['ERR-1']);
  assert.deepEqual(ids(call(null, { outcome: { timedOut: true }, strays: [{ malformed: true }] })), ['LIFE-2'], 'a malformed line has no id to blame');
});

test('R-FC-03: ERR-2 (unknown tool succeeded), ISERR-2 (invalid input succeeded) and what counts as an error answer', () => {
  const unknown = { id: 'u', class: 'unknown-tool', expect: 'any' };
  assert.deepEqual(ids(call({ id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }, { tool: null, kase: unknown })), ['ERR-2']);
  assert.deepEqual(ids(call({ id: 1, result: { isError: true, content: [{ type: 'text', text: 'no' }] } }, { tool: null, kase: unknown })), []);
  assert.deepEqual(ids(call({ id: 1, error: { code: -32602, message: 'no' } }, { tool: null, kase: unknown })), []);
  const rej = { id: 'r', class: 'invalid', expect: 'reject' };
  assert.deepEqual(ids(call(ok, { kase: rej })), ['ISERR-2']);
  assert.deepEqual(ids(call({ id: 1, result: { isError: true, content: [{ type: 'text', text: 'bad' }] } }, { kase: rej })), []);
  assert.deepEqual(ids(call({ id: 1, error: { code: -32602, message: 'bad' } }, { kase: rej })), []);
});

test('R-FC-03: ISERR-1 (isError a boolean, content when true) and RES-1 (content array)', () => {
  assert.deepEqual(ids(call({ id: 1, result: { isError: 'yes', content: [{ type: 'text', text: 'x' }] } })), ['ISERR-1']);
  assert.deepEqual(ids(call({ id: 1, result: { isError: true, content: [] } })), ['ISERR-1']);
  assert.deepEqual(ids(call({ id: 1, result: { isError: true } })), ['ISERR-1']);
  assert.deepEqual(ids(call({ id: 1, result: { structuredContent: { id: 1 } } })), ['RES-1']);
  assert.deepEqual(ids(call({ id: 1, result: 'x' })), ['RES-1']);
});

test('R-FC-03: OUT-1: structuredContent must satisfy the outputSchema; a schema we cannot read is inconclusive, never the server\'s fault', () => {
  assert.deepEqual(ids(call({ id: 1, result: { content: [], structuredContent: { id: 'one' } } })), ['OUT-1']);
  assert.deepEqual(ids(call({ id: 1, result: { content: [] } })), ['OUT-1']);
  const odd = call({ id: 1, result: { content: [], structuredContent: { id: 'one' } } }, { tool: { name: 't', outputSchema: { $ref: '#/x' } } });
  assert.deepEqual(odd.findings, []);
  assert.equal(odd.inconclusive[0].id, 'OUT-1');
  assert.deepEqual(ids(call({ id: 1, result: { content: [{ type: 'text', text: 'x' }] } }, { tool: { name: 't' } })), [], 'no outputSchema, no OUT-1');
});

test('R-FC-04: every seeded fault is found, and exactly that one (the known-answer fixtures of the stage)', async () => {
  assert.ok(SEEDED.length >= 9);
  for (const id of SEEDED) {
    const f = getFixture(id);
    const r = await fuzzFixture(id, { requestMs: 1500 });
    assert.equal(r.status, 'ran', id);
    assert.deepEqual(r.found, [...f.expect].sort(), `${id}: found ${r.found.join(',') || 'nothing'}, known to break ${f.expect.join(',') || 'nothing'}`);
    assert.ok(r.calls >= 20, `${id}: ${r.calls} calls`);
  }
});

test('R-FC-04: a server that keeps crashing is restarted a bounded number of times and the run ends', async () => {
  const r = await fuzzFixture('seeded-crash-oversize', { requestMs: 1500 });
  assert.ok(r.restarts >= 1 && r.restarts <= MAX_RESTARTS + 1);
  assert.ok(r.found.includes('LIFE-1'));
});

const fx = (id, expect) => ({ id, expect });
const ran = (found) => ({ status: 'ran', found, calls: 1, tools: 1, restarts: 0, inconclusive: [] });

test('R-FC-05: controls: a missed known fault fails known_bad, an unexpected finding fails known_good, a fixture that did not run is incomplete', () => {
  const vOk = [verdict(fx('a', []), ran([])), verdict(fx('b', ['ERR-1']), ran(['ERR-1']))];
  assert.deepEqual(controls(vOk), [{ kind: 'known_good', expected: 'no_extra', observed: 'no_extra' }, { kind: 'known_bad', expected: 'all_found', observed: 'all_found' }]);
  const missed = [verdict(fx('b', ['ERR-1', 'OUT-1']), ran(['ERR-1']))];
  assert.equal(missed[0].missed[0], 'OUT-1');
  assert.deepEqual(controls(missed).map((c) => c.observed), ['no_extra', 'missed']);
  const extra = [verdict(fx('a', []), ran(['LIFE-2']))];
  assert.deepEqual(controls(extra).map((c) => c.observed), ['extra', 'all_found']);
  const down = [verdict(fx('t', []), { status: 'unavailable', reason: 'tiny_tracker_not_built' }), ...vOk];
  assert.deepEqual(controls(down).map((c) => c.observed), ['incomplete', 'incomplete']);
});

test('R-FC-05: the meta file: subject, tools, one known_good and one known_bad control, no skips', () => {
  const b = build({ verdicts: [verdict(fx('a', []), ran([]))], env: { GITHUB_SHA: 'd'.repeat(40), GITHUB_REPOSITORY: 'isokron-ai/mcp-check' } });
  assert.equal(b.meta.subject.id, SUBJECT_ID);
  assert.equal(b.meta.subject.sha, 'd'.repeat(40));
  assert.deepEqual(b.meta.controls.map((c) => c.kind), ['known_good', 'known_bad']);
  assert.deepEqual(b.meta.skips, []);
  assert.deepEqual(b.report.missed, []);
});

test('R-FC-06: the matrix over the seeded fixtures with no tiny-tracker build: the seeded controls hold, and tiny-tracker is incomplete, never passing', async () => {
  const v = await runMatrix({ ids: ['seeded-clean', 'seeded-error-shape', 'tiny-tracker-correct'], requestMs: 1500, tinyDir: undefined });
  assert.equal(v.find((x) => x.id === 'tiny-tracker-correct').status, 'incomplete');
  assert.deepEqual(controls(v).map((c) => c.observed), ['incomplete', 'incomplete']);
  const seededOnly = await runMatrix({ ids: ['seeded-clean', 'seeded-error-shape'], requestMs: 1500 });
  assert.deepEqual(controls(seededOnly).map((c) => c.observed), ['no_extra', 'all_found']);
});

test('R-FC-07: the read-only fuzz session of the live-probe stage still refuses tools/call (this stage has its own session and runs no third-party server)', () => {
  const src = readFileSync(join(ROOT, 'corpus', 'fuzz', 'session.mjs'), 'utf8');
  assert.match(src, /READ_ONLY_METHODS = Object\.freeze\(\['initialize', 'ping', 'tools\/list', 'prompts\/list', 'resources\/list', 'resources\/templates\/list'\]\)/);
  for (const f of ['run.mjs', 'oracles/run.mjs']) { /* the live-probe stage must not import the call session */ }
  for (const f of ['live-probe.mjs', 'live-probe-driver.mjs', 'fuzz/run.mjs', 'fuzz/judge.mjs']) assert.doesNotMatch(readFileSync(join(ROOT, 'corpus', f), 'utf8'), /fuzz\/calls|\.\/calls\//, `${f} does not use the tools/call stage`);
});

test('R-FC-08: the fuzz-calls worker: dispatch only, kill switch first, fixtures from pinned commits, the bundle sealed by a job that runs none of the fixtures', () => {
  const y = readFileSync(join(ROOT, '.github', 'workflows', 'fuzz-calls.yml'), 'utf8');
  assert.match(y, /\non:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(y, /\n {2}(schedule|push|pull_request|pull_request_target):/);
  assert.match(y, /LOOP_ENABLED" != "true"/);
  assert.match(y, /TINY_TRACKER_REF: '[0-9a-f]{40}'/);
  for (const m of y.matchAll(/uses: (\S+)@(\S+)/g)) assert.match(m[2], /^[0-9a-f]{40}$/, `${m[1]} is pinned to a full commit`);
  const manifest = y.slice(y.indexOf('\n  t0-manifest:'));
  assert.doesNotMatch(manifest, /matrix\.mjs|npm |checkout/, 'the sealing job runs none of the fixtures and checks nothing out');
  assert.match(manifest, /worker-kit@[0-9a-f]{40}/);
  assert.doesNotMatch(y, /\$\{\{\s*secrets\./);
});
