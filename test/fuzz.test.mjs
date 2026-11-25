// The live-probe lane's fuzz stage (corpus/FUZZ.md): the session client, the invariants and their fault rules, the
// driver's probe option, the bundle and the reproducer replay. No Docker, no network: the servers are fixtures,
// test/fake/fuzz-server.cjs (one mode per broken invariant, and "good") and corpus/fuzz/replay-server.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFuzz, INVENTED_CURSORS } from '../corpus/fuzz/run.mjs';
import { Session, READ_ONLY_METHODS } from '../corpus/fuzz/session.mjs';
import { attribute, setMutation, skeleton, INVARIANTS } from '../corpus/fuzz/judge.mjs';
import { fuzzProbe, parse as parseDriver } from '../corpus/live-probe-driver.mjs';
import * as LP from '../corpus/live-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(root, 'test', 'fake', 'fuzz-server.cjs');
const REPLAY = join(root, 'corpus', 'fuzz', 'replay-server.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'fuzz-'));

/** The stage against one fixture mode: each session is a start of the fixture (the lane: a docker run). */
async function stage(mode, extra = {}) {
  const state = join(tmp(), 'state');
  return runFuzz({ command: ['docker', 'run'], dockerEnv: {}, budgetMs: 60_000, removeContainer: async () => {}, variant: (_c, k) => ({ command: [process.execPath, SERVER, mode, state], name: 'f' + k, cidfile: null }), ...extra });
}
/** A reproducer (from a bundle's raw/fuzz.json) played back through the stage: the fixture for a new R-FZ test (corpus/FUZZ.md). */
export async function replayCase(reproducer, extra = {}) {
  const dir = tmp(); const spec = join(dir, 'spec.json'); const state = join(dir, 'state');
  writeFileSync(spec, JSON.stringify(reproducer));
  return runFuzz({ command: ['x'], dockerEnv: {}, budgetMs: 60_000, removeContainer: async () => {}, variant: (_c, k) => ({ command: [process.execPath, REPLAY, spec, state], name: 'r' + k, cidfile: null }), ...extra });
}
const find = (rec, id, primitive = null) => rec.results.find((r) => r.id === id && (primitive === null || r.primitive === primitive));
const bad = (rec) => rec.results.filter((r) => r.verdict === 'fail' || r.verdict === 'warn');

test('fuzz fixtures: the good server passes every invariant it can be asked, and no tool is ever called', async () => {
  const rec = await stage('good');
  assert.equal(rec.mode, 'full');
  assert.deepEqual(bad(rec), []);
  assert.deepEqual(rec.results.filter((r) => r.verdict === 'inconclusive'), []);
  for (const id of Object.keys(INVARIANTS)) assert.ok(rec.results.some((r) => r.id === id && r.verdict === 'pass'), id + ' passes');
  assert.equal(rec.rounds.length, 1, 'no failure, no second round');
  assert.equal(rec.containers.length, 2);
  assert.ok(rec.containers.every((c) => c.exit && c.exit.code !== 9), 'the fixture exits 9 on any method it should never get');
  assert.ok(INVENTED_CURSORS.length === 2);
});

test('R-FZ-01: a catalog that differs when listed twice in one session fails FZ-CAT-1, and a second round confirms it before the server is blamed', async () => {
  const rec = await stage('cat-session');
  const r = find(rec, 'FZ-CAT-1', 'tools');
  assert.deepEqual([r.verdict, r.kind, r.fault, r.reproduced], ['fail', 'content_unstable', 'subject', true]);
  assert.deepEqual([r.evidence.added, r.evidence.removed], [1, 2]);
  assert.equal(rec.rounds.length, 2);
  assert.equal(rec.reproducers.length, 1);
});

test('R-FZ-02: the same tools in another order is a warning, and a server that announced list_changed is not applicable', async () => {
  const order = find(await stage('cat-reorder'), 'FZ-CAT-1', 'tools');
  assert.deepEqual([order.verdict, order.kind, order.fault], ['warn', 'order_unstable', 'subject']);
  const announced = find(await stage('cat-listchanged'), 'FZ-CAT-1', 'tools');
  assert.deepEqual([announced.verdict, announced.kind, announced.fault], ['na', 'list_changed_announced', null]);
});

test('R-FZ-03: a catalog that differs between two sessions fails FZ-CAT-2', async () => {
  const rec = await stage('cat-across');
  const r = find(rec, 'FZ-CAT-2', 'tools');
  assert.deepEqual([r.verdict, r.kind, r.fault, r.reproduced], ['fail', 'session_content_unstable', 'subject', true]);
  assert.equal(find(rec, 'FZ-CAT-1', 'tools').verdict, 'pass', 'stable inside each session');
});

test('R-FZ-04: a tool that comes back on the next page fails FZ-PAG-1', async () => {
  const r = find(await stage('pag-dup'), 'FZ-PAG-1', 'tools');
  assert.deepEqual([r.verdict, r.kind, r.fault], ['fail', 'duplicate_item', 'subject']);
  assert.equal(r.evidence.duplicates, 1);
});

test('R-FZ-05: a cursor that gives another page the second time fails FZ-PAG-2; an error or the same page passes', async () => {
  const r = find(await stage('pag-spent'), 'FZ-PAG-2');
  assert.deepEqual([r.verdict, r.kind, r.fault], ['fail', 'spent_cursor_other_page', 'subject']);
  assert.equal(find(await stage('good'), 'FZ-PAG-2').kind, 'same_page');
});

test('R-FZ-06: a cursor nobody issued: an error passes, the first page again warns, any other answer fails FZ-PAG-3', async () => {
  assert.equal(find(await stage('good'), 'FZ-PAG-3').kind, 'rejected');
  const ignored = find(await stage('pag-invented-ignored'), 'FZ-PAG-3');
  assert.deepEqual([ignored.verdict, ignored.kind, ignored.fault], ['warn', 'cursor_ignored', 'subject']);
  const accepted = find(await stage('pag-invented-accepted'), 'FZ-PAG-3');
  assert.deepEqual([accepted.verdict, accepted.kind, accepted.fault], ['fail', 'invented_cursor_accepted', 'subject']);
});

test('R-FZ-07: a cursor from another session: an error or the same page passes, another page fails FZ-PAG-4', async () => {
  const r = find(await stage('pag-foreign'), 'FZ-PAG-4');
  assert.deepEqual([r.verdict, r.kind, r.fault], ['fail', 'foreign_cursor_other_page', 'subject']);
  assert.equal(find(await stage('good'), 'FZ-PAG-4').kind, 'rejected');
  assert.equal(find(await stage('pag-stateless'), 'FZ-PAG-4').kind, 'same_page', 'an offset cursor any session can use is allowed');
});

test('R-FZ-08: Unicode in identifiers: invisible and ill-formed code points, collisions, NFC and mixed scripts, across tools and prompts', async () => {
  const one = async (mode, id) => find(await stage(mode), id);
  const inv = await one('uni-invisible', 'FZ-UNI-1');
  assert.deepEqual([inv.verdict, inv.kind, inv.fault, inv.evidence.findings[0].codepoints], ['fail', 'invisible_or_control', 'subject', ['U+200B']]);
  assert.equal((await one('uni-illformed', 'FZ-UNI-1')).kind, 'ill_formed');
  const prompt = await one('uni-prompt-invisible', 'FZ-UNI-1');
  assert.deepEqual([prompt.verdict, prompt.evidence.findings[0].primitive, prompt.evidence.findings[0].codepoints], ['fail', 'prompts', ['U+2060']]);
  const col = await one('uni-collision', 'FZ-UNI-2');
  assert.deepEqual([col.verdict, col.kind, col.fault], ['fail', 'collision', 'subject']);
  assert.deepEqual(['dеlta', 'delta'].map(skeleton), ['delta', 'delta']);
  assert.deepEqual(['Delta', 'delta'].map(skeleton), ['Delta', 'delta'], 'case alone is the separate, weaker rule');
  const nfc = await one('uni-nfc', 'FZ-UNI-3');
  assert.deepEqual([nfc.verdict, nfc.kind], ['warn', 'not_nfc']);
  const mixed = await one('uni-mixed', 'FZ-UNI-4');
  assert.deepEqual([mixed.verdict, mixed.kind], ['warn', 'mixed_script']);
  assert.equal((await one('good', 'FZ-UNI-1')).verdict, 'pass');
  // Evidence holds hashes and code points, never the identifier itself.
  assert.ok(!JSON.stringify(inv.evidence).includes('char'));
});

test('R-FZ-09: a failure that does not repeat, a server that hangs or crashes, and a missing second round are our side, never the server\'s', async () => {
  for (const mode of ['flaky-across', 'flaky-session']) {
    const rec = await stage(mode);
    const flaky = rec.results.filter((r) => r.kind.startsWith('unconfirmed_'));
    assert.ok(flaky.length >= 1, mode);
    for (const r of flaky) assert.deepEqual([r.verdict, r.fault, r.reproduced], ['inconclusive', 'tool', false], mode);
    assert.deepEqual(rec.results.filter((r) => r.fault === 'subject'), [], mode);
  }
  const crash = await stage('crash');
  assert.deepEqual(crash.results.filter((r) => r.fault === 'subject'), []);
  assert.ok(crash.results.some((r) => r.kind === 'incomplete_traversal' && r.fault === 'tool'));
  const hang = await stage('hang', { requestMs: 300 });
  assert.deepEqual(hang.results.filter((r) => r.fault === 'subject'), []);
  assert.ok(hang.results.some((r) => r.kind === 'incomplete_traversal' && r.evidence.stop === 'timeout'));
  // No time for a second round: the first sighting alone is not enough.
  const first = [{ id: 'FZ-CAT-1', primitive: 'tools', verdict: 'fail', kind: 'content_unstable', fault: null, reproduced: null, sessions: ['A'], evidence: {} }];
  const [x] = attribute(first, null, []);
  assert.deepEqual([x.verdict, x.kind, x.fault, x.confirmation, x.first_seen.verdict], ['inconclusive', 'unconfirmed_content_unstable', 'tool', 'not_run', 'fail']);
  const [y] = attribute(first, [{ ...first[0], verdict: 'pass', kind: 'equal' }], []);
  assert.deepEqual([y.verdict, y.fault, y.reproduced], ['inconclusive', 'tool', false]);
});

test('R-FZ-10: only initialize, ping and the list methods can be sent: tools/call, prompts/get and resources/read are refused before the wire', async () => {
  assert.deepEqual([...READ_ONLY_METHODS], ['initialize', 'ping', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
  const s = new Session([process.execPath, SERVER, 'good']).start();
  try {
    for (const m of ['tools/call', 'prompts/get', 'resources/read', 'resources/subscribe', 'completion/complete', 'logging/setLevel']) assert.throws(() => s.request(m, {}), /not a read-only method/, m);
    assert.equal(s.requests, 0, 'nothing was written');
    assert.equal((await s.initialize()).ok, true);
    assert.equal((await s.request('tools/list', {})).ok, true);
  } finally { await s.close(); }
  // A whole run only ever sends those: the fixture exits 9 on anything else and would show as a failed session.
  const rec = await stage('good');
  assert.ok(rec.rounds[0].sessions.every((x) => x.health.init_ok && x.health.timeouts === 0 && x.health.limit === null));
});

test('R-FZ-11: mutation check: with an invariant switched off its fixture goes unnoticed, so each regression test depends on its invariant', async (t) => {
  const table = [
    ['FZ-CAT-1', 'cat-session'], ['FZ-CAT-2', 'cat-across'], ['FZ-PAG-1', 'pag-dup'], ['FZ-PAG-2', 'pag-spent'], ['FZ-PAG-3', 'pag-invented-accepted'], ['FZ-PAG-4', 'pag-foreign'],
    ['FZ-UNI-1', 'uni-invisible'], ['FZ-UNI-2', 'uni-collision'], ['FZ-UNI-3', 'uni-nfc'], ['FZ-UNI-4', 'uni-mixed'],
  ];
  assert.deepEqual(table.map((x) => x[0]), Object.keys(INVARIANTS), 'one row per invariant');
  for (const [id, mode] of table) {
    const real = (await stage(mode)).results.filter((r) => r.id === id && r.fault === 'subject');
    assert.ok(real.length >= 1, id + ': the fixture violates it');
    setMutation(id);
    let mutant;
    try { mutant = (await stage(mode)).results.filter((r) => r.id === id && (r.fault === 'subject' || r.verdict === 'fail' || r.verdict === 'warn')); } finally { setMutation(null); }
    assert.deepEqual(mutant, [], id + ': switched off, the violation is missed (mutant killed by the test above)');
    t.diagnostic(id + ' ' + mode + ': mutant killed');
  }
});

test('R-FZ-12: a reproducer from a failing run replays to the same verdict, and passes with the invariant switched off', async () => {
  const cases = [['cat-session', 'FZ-CAT-1', 'content_unstable'], ['cat-across', 'FZ-CAT-2', 'session_content_unstable'], ['pag-dup', 'FZ-PAG-1', 'duplicate_item'], ['pag-spent', 'FZ-PAG-2', 'spent_cursor_other_page'], ['pag-invented-accepted', 'FZ-PAG-3', 'invented_cursor_accepted'], ['pag-foreign', 'FZ-PAG-4', 'foreign_cursor_other_page'], ['uni-collision', 'FZ-UNI-2', 'collision'], ['uni-invisible', 'FZ-UNI-1', 'invisible_or_control']];
  for (const [mode, id, kind] of cases) {
    const rec = await stage(mode);
    const rp = rec.reproducers.find((x) => x.invariant === id);
    assert.ok(rp && rp.sessions && !rp.truncated, id + ' has a reproducer');
    assert.equal(rp.format, 'isokron-fuzz-reproducer/1');
    assert.deepEqual([rp.expect.verdict !== undefined, rp.expect.kind], [true, kind]);
    const again = (await replayCase(rp)).results.find((r) => r.id === id && r.kind === kind);
    assert.ok(again && (again.fault === 'subject' || again.verdict === 'fail' || again.verdict === 'warn'), id + ': the replay shows ' + kind);
    setMutation(id);
    try { assert.deepEqual((await replayCase(rp)).results.filter((r) => r.id === id && (r.verdict === 'fail' || r.verdict === 'warn')), [], id + ': muted'); } finally { setMutation(null); }
  }
});

test('R-FZ-13: the stage is off unless asked: the driver option defaults to off, runs once per target after a probe that listed, skips for lack of time, and never throws into the driver', async () => {
  assert.equal(parseDriver(['--msc', 'a', '--oracles', 'none', '--', 'x']).fuzz, 'off');
  assert.equal(parseDriver(['--msc', 'a', '--oracles', 'none', '--fuzz', 'on', '--', 'x']).fuzz, 'on');
  assert.throws(() => parseDriver(['--msc', 'a', '--oracles', 'none', '--fuzz', 'yes', '--', 'x']), /on or off/);
  const writes = []; const runs = [];
  const listedP = { lists: { 'tools/list': { ok: true } } };
  const cmd = (n) => ['docker', 'run', '--name', `surface-0123456789ab-${n}`];
  const base = { listed: (p) => !!(p && p.lists['tools/list']), out: tmp(), starts: new Map([['s001', Date.now()], ['s002', Date.now()], ['s003', Date.now() - 200_000]]), limits: new Map([['s001', 300], ['s002', 300], ['s003', 240]]), write: (f, r) => writes.push([f.split('/').slice(-2).join('/'), r.mode]), remove: async () => {}, run: async (o) => { runs.push(o.command[3].slice(-7)); return { format: 'x', mode: 'full' }; } };
  const off = fuzzProbe({ ...base, probe: async () => listedP, enabled: false });
  await off(cmd('s001-s1'), {});
  assert.deepEqual(runs, []);
  const on = fuzzProbe({ ...base, probe: async (c) => (c[3].endsWith('s1') ? { lists: {} } : listedP), enabled: true });
  for (const n of ['s001-s1', 's001-s2', 's001-s3', 's002-s4', 'shard-base5', 's003-s6']) assert.ok((await on(cmd(n), {})).lists);
  assert.deepEqual(runs, ['s001-s2', 's002-s4'], 'once per target, only after a probe that listed, never for the baseline');
  assert.ok(writes.some((w) => w[0] === 's003/fuzz.json' && w[1] === 'skipped'), 'no time left: a recorded skip');
  const boom = fuzzProbe({ ...base, probe: async () => listedP, enabled: true, run: async () => { throw new Error('boom'); }, write: (f, r) => writes.push([r.mode, r.error]) });
  assert.ok((await boom(cmd('s002-s1'), {})).lists);
  assert.deepEqual(writes.at(-1), ['error', 'boom']);
});

test('R-FZ-14: the plan adds the stage\'s allowance only when it is on, and a bundle holds nothing of it unless the plan says so, and only counts, hashes and code points when it does', async () => {
  assert.equal(LP.FUZZ_ALLOWANCE_S, 60);
  const dir = tmp();
  const rec = await stage('uni-invisible');
  writeFileSync(join(dir, 'fuzz.json'), JSON.stringify(rec));
  const item = { target: { launch: { transport: 'stdio' } } };
  assert.equal(LP.fuzzFor(dir, item, { plan: {} }), null, 'the plan did not switch it on: no key, no raw file');
  const f = LP.fuzzFor(dir, item, { plan: { fuzz: true } });
  assert.equal(f.summary.status, 'ran');
  assert.deepEqual(f.lines, [], 'no field is written while EMIT_FUZZ_FIELDS is off');
  assert.equal(LP.EMIT_FUZZ_FIELDS, false);
  assert.deepEqual(f.raw.map((x) => x[0]), ['raw/fuzz.json']);
  const text = JSON.stringify(f.summary);
  assert.ok(!text.includes('charlie') && !text.includes('alpha') && !text.includes('​'), 'no identifier of the server outside raw/');
  const row = f.summary.results.find((r) => r.id === 'FZ-UNI-1');
  assert.deepEqual([row.verdict, row.fault, row.evidence.findings[0].codepoints], ['fail', 'subject', ['U+200B']]);
  const noRun = LP.fuzzFor(tmp(), { target: { launch: { transport: 'http' } } }, { plan: { fuzz: true } });
  assert.deepEqual([noRun.summary.status, noRun.summary.why], ['not_run', 'http_transport']);
  // A server's string in a field of the record cannot get out through the summary.
  const forged = LP.fuzzRow({ id: 'FZ-CAT-1', primitive: 'tools', verdict: 'fail', kind: 'attempt_id=abc run_key=1', fault: 'subject', reproduced: true, evidence: { note: 'attempt-id 7', count: 3, hash: 'a'.repeat(64) } });
  assert.deepEqual([forged.kind, forged.evidence], [null, { count: 3, hash: 'a'.repeat(64) }]);
  // The self test's expectation on our own servers.
  assert.deepEqual(LP.fuzzExpectProblems({ fuzz: { status: 'ran', results: [{ id: 'FZ-CAT-1', primitive: 'tools', verdict: 'pass', kind: 'equal', fault: null }] } }), []);
  assert.equal(LP.fuzzExpectProblems({ fuzz: { status: 'ran', results: [{ id: 'FZ-CAT-1', primitive: 'tools', verdict: 'warn', kind: 'order_unstable', fault: 'subject' }] } })[0].reason, 'fuzz_finding_on_our_own_server');
  assert.equal(LP.fuzzExpectProblems({})[0].reason, 'fuzz_not_run');
});

test('R-FZ-15: the field list names list_determinism as the registry has it; the proposed fields stay off until the registry holds them', () => {
  const reg = readFileSync(join(root, 'test', 'fixtures', 'live-probe', 'fields-registry.yaml'), 'utf8');
  assert.match(reg, /\{id: list_determinism, layer: protocol, type: boolean,/);
  assert.equal(LP.FUZZ_FIELDS.list_determinism, 'boolean');
  for (const f of ['fuzz_stage', 'invariant_results', 'unicode_identifier_findings']) assert.ok(!reg.includes('id: ' + f + ','), f + ' is proposed, not yet in the registry copy');
  assert.equal(LP.EMIT_FUZZ_FIELDS, false);
  assert.throws(() => LP.obs('fuzz_stage', {}), /not a field of this lane/);
});

test('R-FZ-16: the workflows read the stage\'s switch from one repository variable, off when it is not exactly "on"', () => {
  const w = readFileSync(join(root, '.github', 'workflows', 'live-probe.yml'), 'utf8');
  assert.match(w, /LIVE_PROBE_FUZZ: \$\{\{ vars\.LANE_LIVE_PROBE_FUZZ \}\}/);
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  assert.match(sh, /fuzz=off\n.*plan\.json.*\.fuzz === true.*; then fuzz=on; fi/);
  assert.match(sh, /--fuzz "\$fuzz"/);
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  assert.match(src, /fuzz: env\.LIVE_PROBE_FUZZ === 'on'/);
});
