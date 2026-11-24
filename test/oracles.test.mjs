// The live-probe lane's oracle stage (corpus/LIVE-PROBE.md, "Oracles"): the stdio bridge, the oracle runner, the
// driver's probe option, the judge, the pins, and the bundle with oracle results. No Docker, no network: servers,
// clients and the suite are stand-ins under test/fixtures/oracles/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../corpus/oracles/bridge.mjs';
import { lastJsonLine, oracleEnv, runOracles, suiteProblem, variantCommand } from '../corpus/oracles/run.mjs';
import { baselineProblems, clientCatalog, judgeOracles, namesSha } from '../corpus/oracles/judge.mjs';
import { oracleProbe, targetOf } from '../corpus/live-probe-driver.mjs';
import * as LP from '../corpus/live-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FX = join(root, 'test', 'fixtures', 'oracles');
const LPFX = join(root, 'test', 'fixtures', 'live-probe');
const ECHO = [process.execPath, join(FX, 'echo-server.mjs')];
const PINS = JSON.parse(readFileSync(join(root, 'corpus', 'oracles', 'pins.json'), 'utf8'));
const KNOWN_HASH = '3b6986dcdac856b5a8baaf4836be4c726f8076da7bca547fe4e186931cf02919';

function localSession(cmd = ECHO, env = {}) {
  const live = new Set();
  const spawnSession = async () => {
    const c = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
    live.add(c);
    c.on('close', () => live.delete(c));
    c.dispose = async () => { c.kill(); await new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('close', r))); };
    return c;
  };
  return { spawnSession, live };
}
const post = async (url, body, sid, raw = null) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, sid: r.headers.get('mcp-session-id'), type: r.headers.get('content-type'), text: await r.text() };
};
const init = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });

// ------------------------------------------------------------------ the bridge

test('bridge: initialize starts a server and a session; answers are the server\'s own bytes; notifications are 202; GET is 405', async () => {
  const s = localSession();
  const b = createBridge({ spawnSession: s.spawnSession });
  const url = await b.listen();
  assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/);
  assert.ok(![4710, 4711, 47310, 47311].includes(Number(new URL(url).port)));
  const i = await post(url, init());
  assert.equal(i.status, 200);
  assert.match(i.sid, /^[0-9a-f]{32}$/);
  assert.equal(i.type, 'application/json');
  assert.equal(JSON.parse(i.text).result.serverInfo.name, 'echo');
  assert.equal((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, i.sid)).status, 202);
  const t = await post(url, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, i.sid);
  const line = b.transcript.filter((x) => x.dir === 's2c').pop().raw;
  assert.equal(t.text, line, 'the response body is the server\'s line, byte for byte');
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await post(url, { jsonrpc: '2.0', id: 8, method: 'ping' }, 'f'.repeat(32))).status, 404, 'an unknown session');
  await b.close();
  assert.equal(s.live.size, 0, 'no server process outlives the bridge');
});

test('bridge: a new initialize ends the open session first, so one server process is alive at a time; DELETE ends a session', async () => {
  const s = localSession();
  const b = createBridge({ spawnSession: s.spawnSession });
  const url = await b.listen();
  const a = await post(url, init(1));
  const pidA = JSON.parse((await post(url, { jsonrpc: '2.0', id: 2, method: 'x/pid' }, a.sid)).text).result.pid;
  const c = await post(url, init(1));
  assert.notEqual(c.sid, a.sid);
  assert.equal(s.live.size, 1);
  assert.equal(b.stats.superseded, 1);
  assert.equal((await post(url, { jsonrpc: '2.0', id: 3, method: 'ping' }, a.sid)).status, 404, 'the old session is gone');
  const pidC = JSON.parse((await post(url, { jsonrpc: '2.0', id: 4, method: 'x/pid' }, c.sid)).text).result.pid;
  assert.notEqual(pidA, pidC, 'each session is a fresh process');
  assert.equal((await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': c.sid } })).status, 200);
  assert.equal(s.live.size, 0);
  assert.equal(b.stats.sessions, 2);
  await b.close();
});

test('bridge: a request with no session and another method goes to one shared (stateless) process; reset ends it', async () => {
  const s = localSession();
  const b = createBridge({ spawnSession: s.spawnSession });
  const url = await b.listen();
  const p1 = JSON.parse((await post(url, { jsonrpc: '2.0', id: 1, method: 'x/pid' })).text).result.pid;
  const p2 = JSON.parse((await post(url, { jsonrpc: '2.0', id: 2, method: 'x/pid' })).text).result.pid;
  assert.equal(p1, p2);
  assert.equal((await post(url, { jsonrpc: '2.0', id: 3, method: 'x/pid' })).sid, null, 'no session id on the stateless wire');
  await b.reset();
  assert.equal(s.live.size, 0);
  await b.close();
});

test('bridge: a server request while a POST waits is answered by the bridge; notifications are counted and dropped', async () => {
  const s = localSession();
  const b = createBridge({ spawnSession: s.spawnSession });
  const url = await b.listen();
  const i = await post(url, init());
  const r = await post(url, { jsonrpc: '2.0', id: 9, method: 'x/server-ping' }, i.sid);
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).result.pid > 0);
  assert.equal(b.stats.server_requests_answered, 1);
  assert.equal(b.stats.notifications_dropped, 1);
  assert.ok(b.transcript.some((x) => x.dir === 'bridge' && /"id":"srv-1"/.test(x.raw)));
  await b.close();
});

test('bridge: a server that exits is a 502, one that never answers a 504; a body with a line break is re-encoded; a waiting id twice is 409', async () => {
  const s = localSession();
  const b = createBridge({ spawnSession: s.spawnSession, requestTimeoutMs: 400 });
  const url = await b.listen();
  let i = await post(url, init());
  const silent = post(url, { jsonrpc: '2.0', id: 5, method: 'x/silent' }, i.sid);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await post(url, { jsonrpc: '2.0', id: 5, method: 'ping' }, i.sid)).status, 409);
  assert.equal((await silent).status, 504);
  assert.equal(b.stats.timeouts, 1);
  const multi = await post(url, null, i.sid, '{"jsonrpc":"2.0",\n"id":6,"method":"ping"}');
  assert.equal(multi.status, 200);
  assert.equal(b.stats.reencoded_bodies, 1);
  const gone = await post(url, { jsonrpc: '2.0', id: 7, method: 'x/exit' }, i.sid);
  assert.equal(gone.status, 502);
  assert.match(JSON.parse(gone.text).error.message, /bridge: the server exited/);
  assert.equal(b.stats.exited_early, 1);
  assert.equal((await post(url, null, null, 'not json')).status, 400);
  assert.equal((await post(url, null, null, '[1,2]')).status, 400);
  i = await post(url, init());
  assert.equal(i.status, 200, 'a new session after a crash');
  await b.close();
});

// ------------------------------------------------------------------ sessions as sandbox containers

test('variantCommand: each oracle session is the driver\'s own docker run with a name and cidfile of its own', () => {
  const cmd = ['docker', 'run', '--rm', '--name', 'surface-0123456789ab-s001-s4', '--runtime', 'runsc', '--network', 'n', '--ip', '10.0.0.3', '--cidfile', '/w/_shard/cid/surface-0123456789ab-s001-s4.cid', '--interactive', 'img@sha256:' + 'a'.repeat(64), 'node', 'x'];
  const v = variantCommand(cmd, 2);
  assert.equal(v.name, 'surface-0123456789ab-s001-s4-o2');
  assert.equal(v.cidfile, '/w/_shard/cid/surface-0123456789ab-s001-s4.cid.o2');
  assert.deepEqual(v.command.filter((x, k) => cmd[k] !== x), [v.name, v.cidfile], 'nothing else changes: image, network, address, limits');
  assert.throws(() => variantCommand(['podman', 'run', '--name', 'x'], 1));
  assert.throws(() => variantCommand(['docker', 'run', '--detach', '--name', 'x'], 1));
  assert.throws(() => variantCommand(['docker', 'run', '--name', 'x', '--name', 'y'], 1));
  assert.equal(targetOf(cmd), 's001');
  assert.equal(targetOf(['docker', 'run', '--name', 'surface-0123456789ab-shard-base1']), null, 'the baseline is no target');
  assert.equal(targetOf(['docker', 'run', '--name', 'surface-0123456789ab-s001-h3']), null, 'a helper is no target');
});

test('oracleEnv: a client sees the path, a home of its own and the Docker variables, never a token', () => {
  const env = oracleEnv({ DOCKER_HOST: 'unix:///x', GH_TOKEN: 't', PATH: '/p' }, '/h', { PATH: '/usr/bin', GH_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'x', GITHUB_TOKEN: 'y' });
  assert.equal(env.DOCKER_HOST, 'unix:///x');
  assert.equal(env.HOME, '/h');
  assert.equal(env.PATH, '/usr/bin');
  for (const k of Object.keys(env)) assert.ok(!/TOKEN|GITHUB|ACTIONS|RUNNER/.test(k), k);
  assert.deepEqual(lastJsonLine('noise\n{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJsonLine('[1]\nx'), null);
});

// ------------------------------------------------------------------ the pins

test('pins: every server scenario of both frozen requirement sets is listed; only read-only ones run, each on its own revision', () => {
  const READ_ONLY = { '2025-11-25': ['server-initialize', 'ping', 'tools-list', 'prompts-list', 'resources-list'], '2026-07-28': ['tools-list', 'prompts-list', 'resources-list'] };
  assert.deepEqual(Object.keys(PINS.revisions), ['2025-11-25', '2026-07-28']);
  for (const [rev, R] of Object.entries(PINS.revisions)) {
    assert.deepEqual(R.scenarios.filter((s) => s.run).map((s) => s.scenario).sort(), [...READ_ONLY[rev]].sort(), rev);
    for (const s of R.scenarios) {
      if (s.run) assert.equal(s.reason, undefined, s.scenario);
      else assert.ok(['calls_tool', 'gets_prompt', 'reads_resource', 'subscribes', 'changes_server_state', 'needs_fixture_server', 'transport_only'].includes(s.reason), s.scenario);
      if (/^tools-call|^prompts-get|^resources-read|^input-required|^tasks-|^elicitation/.test(s.scenario)) assert.equal(s.run, false, s.scenario);
    }
    assert.match(PINS.conformance.requirement_sets_sha256[rev], /^[0-9a-f]{64}$/);
  }
  assert.equal(PINS.revisions['2025-11-25'].wire, 'stateful');
  assert.equal(PINS.revisions['2026-07-28'].wire, 'stateless');
  assert.match(PINS.conformance.git_commit, /^[0-9a-f]{40}$/);
  assert.match(PINS.conformance.integrity, /^sha512-/);
  const lock = JSON.parse(readFileSync(join(root, 'corpus', 'oracles', 'package-lock.json'), 'utf8'));
  const at = (p) => lock.packages[`node_modules/${p}`];
  assert.equal(at('@modelcontextprotocol/conformance').version, PINS.conformance.version);
  assert.equal(at('@modelcontextprotocol/conformance').integrity, PINS.conformance.integrity);
  for (const c of PINS.clients.filter((x) => x.kind === 'npm')) assert.equal(at(c.sdk).version, c.version, c.id);
  for (const [k, v] of Object.entries(lock.packages)) if (k) assert.match(v.integrity || '', /^sha512-/, k);
  const req = readFileSync(join(root, 'corpus', 'oracles', 'requirements.txt'), 'utf8');
  assert.match(req, /^mcp==2\.3\.0 \\$/m);
  for (const block of req.split(/\n(?=[A-Za-z])/).filter((b) => /==/.test(b) && !b.startsWith('#'))) assert.match(block, /--hash=sha256:[0-9a-f]{64}/, block.split('\n')[0]);
  const gomod = readFileSync(join(root, 'corpus', 'oracles', 'go', 'go.mod'), 'utf8');
  assert.match(gomod, /require github\.com\/modelcontextprotocol\/go-sdk v1\.8\.0/);
  assert.match(readFileSync(join(root, 'corpus', 'oracles', 'go', 'go.sum'), 'utf8'), /github\.com\/modelcontextprotocol\/go-sdk v1\.8\.0 h1:/);
});

function fakeSuite(pins = PINS) {
  const dir = mkdtempSync(join(tmpdir(), 'suite-'));
  mkdirSync(join(dir, 'requirements'));
  const sha = {};
  for (const [rev, R] of Object.entries(pins.revisions)) {
    const text = `server:\n${R.scenarios.filter((s) => s.scored).map((s) => `  - ${s.scenario}\n`).join('')}\nclient:\n  - x\n\nnot_scored:\n${R.scenarios.filter((s) => !s.scored).map((s) => `  - scenario: ${s.scenario}\n    leg: server\n    reason: pending\n`).join('')}`;
    writeFileSync(join(dir, 'requirements', `${rev}.yaml`), text);
    sha[rev] = createHash('sha256').update(text).digest('hex');
  }
  return { dir, pins: { ...pins, conformance: { ...pins.conformance, requirement_sets_sha256: sha } } };
}

test('suiteProblem: the installed requirement sets must hash as pinned and name the pinned scenarios', () => {
  const { dir, pins } = fakeSuite();
  assert.equal(suiteProblem(dir, pins), null);
  assert.match(suiteProblem(dir, PINS), /not the pinned one/, 'the real pins name the real files');
  const p2 = JSON.parse(JSON.stringify(pins));
  p2.revisions['2025-11-25'].scenarios.pop();
  assert.match(suiteProblem(dir, p2), /differ from the pins/);
});

// ------------------------------------------------------------------ the runner

function fakeInstall(dir, { timeoutClient = null } = {}) {
  const clients = {};
  for (const c of PINS.clients) clients[c.id] = { ok: true, version: c.version, command: [process.execPath, join(FX, 'fake-client.mjs'), c.id] };
  clients.go = { ok: false, version: null, error: 'go build failed: test' };
  if (timeoutClient) clients[timeoutClient].command = ['/usr/bin/env', 'FAKE_OUTCOME=timeout', process.execPath, join(FX, 'fake-client.mjs'), timeoutClient];
  return { conformance: { ok: true, version: PINS.conformance.version, dir, bin: join(FX, 'fake-conformance.mjs') }, clients };
}
const local = (c, k) => ({ command: c, name: `local-${k}`, cidfile: null });

test('runOracles: the clients, then every read-only scenario of each revision through the bridge, each on fresh processes', async () => {
  const { dir, pins } = fakeSuite();
  const work = mkdtempSync(join(tmpdir(), 'oracle-work-'));
  const removed = [];
  const rec = await runOracles({ command: ECHO, dockerEnv: { DOCKER_HOST: 'unix:///x' }, install: fakeInstall(dir), pins, budgetMs: 120_000, work, variant: local, removeContainer: async (n) => { removed.push(n); }, takeTrace: async () => ({ events: 1 }) });
  assert.equal(rec.format, 'isokron-live-probe-oracles/1');
  assert.deepEqual(rec.clients.map((c) => [c.id, c.result ? c.result.outcome : c.outcome]), [['typescript-v1', 'listed'], ['typescript-v2', 'listed'], ['python', 'listed'], ['go', 'unavailable']]);
  const envKeys = rec.clients[0].result.env_keys;
  assert.ok(envKeys.includes('DOCKER_HOST') && !envKeys.some((k) => /TOKEN|GITHUB_/.test(k)), 'a client runs with the oracle environment only');
  assert.equal(rec.conformance.problem, null);
  assert.deepEqual(rec.conformance.runs.map((r) => `${r.revision}/${r.scenario}`), ['2025-11-25/server-initialize', '2025-11-25/ping', '2025-11-25/tools-list', '2025-11-25/resources-list', '2025-11-25/prompts-list', '2026-07-28/tools-list', '2026-07-28/resources-list', '2026-07-28/prompts-list']);
  for (const r of rec.conformance.runs) assert.ok(Array.isArray(r.checks) && r.checks.length, r.scenario);
  assert.equal(rec.bridge.stats.sessions, 8, 'one fresh server per scenario');
  assert.equal(rec.bridge.stats.superseded, 0);
  assert.equal(removed.length, 3 + 8, 'every session\'s container is removed: three clients, eight scenarios');
  assert.equal(rec.containers.length, 11);
  assert.ok(rec.containers.every((c) => c.role));
});

test('runOracles: a client that hangs is stopped at its limit; no budget left means skips, never a longer run', async () => {
  const { dir, pins } = fakeSuite();
  const work = mkdtempSync(join(tmpdir(), 'oracle-work-'));
  const p = { ...pins, client_timeout_ms: 1500 };
  const rec = await runOracles({ command: ECHO, dockerEnv: {}, install: fakeInstall(dir, { timeoutClient: 'typescript-v1' }), pins: p, budgetMs: 25_000, mode: 'clients_only', work, variant: local, removeContainer: async () => {} });
  assert.equal(rec.clients[0].timed_out, true);
  assert.equal(rec.clients[0].outcome, 'timeout');
  assert.equal(rec.conformance, null, 'clients only');
  const t0 = Date.now();
  const short = await runOracles({ command: ECHO, dockerEnv: {}, install: fakeInstall(dir), pins, budgetMs: 4000, work, variant: local, removeContainer: async () => {} });
  assert.ok(Date.now() - t0 < 4000);
  assert.ok(short.clients.filter((c) => c.outcome !== 'unavailable').every((c) => c.outcome === 'skipped' && c.why === 'time_budget'));
  assert.ok(short.conformance.runs.every((r) => r.why === 'time_budget'));
});

// ------------------------------------------------------------------ the driver's probe option

test('oracleProbe: once in full per target after a probe with a list, clients only after one without, never for the baseline', async () => {
  const runs = []; const writes = [];
  const listedP = { lists: { 'tools/list': { ok: true } } };
  const probes = { 's001-s1': { lists: {} }, 's001-s2': listedP, 's002-s3': listedP, 's002-s4': listedP, 'shard-base5': listedP };
  const cmd = (n) => ['docker', 'run', '--name', `surface-0123456789ab-${n}`];
  const hook = oracleProbe({
    probe: async (c) => probes[c[3].replace('surface-0123456789ab-', '')], listed: (p) => !!(p && p.lists['tools/list']),
    out: mkdtempSync(join(tmpdir(), 'drv-')), install: { clients: {} }, pins: PINS,
    starts: new Map([['s001', Date.now()], ['s002', Date.now()]]), limits: new Map([['s001', 300], ['s002', 300]]),
    run: async (o) => { runs.push([o.command[3].slice(-7), o.mode, o.pins.client_timeout_ms]); return { format: 'x' }; },
    write: (f, r) => writes.push([f.split('/').slice(-2).join('/'), r.probe_listed]), remove: async () => {},
  });
  for (const n of ['s001-s1', 's001-s2', 's002-s3', 's002-s4', 'shard-base5']) assert.equal(await hook(cmd(n), {}), probes[n], 'the driver gets its own probe back');
  assert.deepEqual(runs, [['s001-s1', 'clients_only', 15000], ['s001-s2', 'full', PINS.client_timeout_ms], ['s002-s3', 'full', PINS.client_timeout_ms]]);
  assert.deepEqual(writes, [['s001/oracles-unlisted.json', false], ['s001/oracles.json', true], ['s002/oracles.json', true]]);
});

test('oracleProbe: no time left before the target\'s limit (less its reserve) is a recorded skip; a stage error never reaches the driver', async () => {
  const writes = [];
  const base = { probe: async () => ({ lists: { 'tools/list': { ok: true } } }), listed: () => true, out: mkdtempSync(join(tmpdir(), 'drv-')), install: { clients: {} }, pins: PINS, write: (f, r) => writes.push(r), remove: async () => {} };
  const cmd = ['docker', 'run', '--name', 'surface-0123456789ab-s003-s1'];
  await oracleProbe({ ...base, starts: new Map([['s003', Date.now() - 200_000]]), limits: new Map([['s003', 240]]), run: async () => assert.fail('no run') })(cmd, {});
  assert.equal(writes[0].mode, 'skipped');
  assert.equal(writes[0].why, 'time_budget');
  const p = await oracleProbe({ ...base, starts: new Map([['s003', Date.now()]]), limits: new Map([['s003', 300]]), run: async () => { throw new Error('boom'); } })(cmd, {});
  assert.ok(p.lists);
  assert.equal(writes[1].mode, 'error');
  const none = await oracleProbe({ ...base, install: null, starts: new Map(), limits: new Map(), run: async () => assert.fail('no install, no stage') })(cmd, {});
  assert.ok(none.lists);
});

// ------------------------------------------------------------------ the judge

const knownRec = () => JSON.parse(readFileSync(join(LPFX, 'oracles-known.json'), 'utf8'));
const knownReader = () => {
  const p = JSON.parse(readFileSync(join(LPFX, 'probe-known.json'), 'utf8'));
  const g = LP.gradeList(LP.listText(p.lists['tools/list'].raw_pages));
  return { listed: true, tool_count: g.summary.tool_count, catalog_hash: g.summary.catalog_hash, names: g.names, tools: LP.toolsOf(p.lists['tools/list'].raw_pages), pages: 1, check_ids: Object.keys(g.summary.check_counts), capabilities: p.initialize.capabilities };
};

test('judge: every SDK client\'s catalog hashes as our reader\'s (the engine\'s catalog hash); the statuses of the checks', () => {
  const j = judgeOracles(knownRec(), { reader: knownReader(), pins: PINS, baseline: null });
  assert.equal(j.status, 'ran');
  assert.deepEqual(j.clients.map((c) => [c.client, c.outcome, c.catalog_sha256, c.protocol_negotiated]), PINS.clients.map((c) => [c.id, 'listed', KNOWN_HASH, '2025-11-25']));
  assert.deepEqual(j.disagreements, []);
  const st = (rev, sc, id) => j.conformance.checks.find((c) => c.spec_revision === rev && c.scenario === sc && c.check === id).status;
  assert.equal(st('2025-11-25', 'server-initialize', 'server-initialize'), 'pass');
  assert.equal(st('2025-11-25', 'server-initialize', 'server-session-id-visible-ascii'), 'bridge_excluded', 'the session id is the bridge\'s');
  assert.equal(st('2025-11-25', 'prompts-list', 'prompts-list'), 'not_applicable', 'prompts not declared: method not found is no failure');
  assert.equal(st('2026-07-28', 'tools-list', 'wire-schema-valid'), 'fail', 'without a baseline a failure is a failure');
  assert.deepEqual(j.conformance.summary['2025-11-25'].scenarios_not_run.find((x) => x.scenario === 'tools-call-simple-text'), { scenario: 'tools-call-simple-text', scored: true, reason: 'calls_tool' });
  assert.equal(j.conformance.summary['2025-11-25'].level, 'payload');
  assert.deepEqual(j.components.map((c) => c.name).sort(), ['@modelcontextprotocol/client', '@modelcontextprotocol/conformance', '@modelcontextprotocol/sdk', 'github.com/modelcontextprotocol/go-sdk', 'mcp']);
});

test('judge: the baseline turns a listed failure into expected_fail, and a baselined failure that passes is stale', () => {
  const base = JSON.parse(readFileSync(join(LPFX, '..', '..', '..', 'corpus', 'fixtures', 'live-probe', 'oracle-baseline.json'), 'utf8')).controls.known_good;
  const j = judgeOracles(knownRec(), { reader: knownReader(), pins: PINS, baseline: base });
  assert.equal(j.conformance.checks.find((c) => c.spec_revision === '2026-07-28' && c.check === 'wire-schema-valid').status, 'expected_fail');
  assert.deepEqual(baselineProblems(j, base), []);
  const rec = knownRec();
  for (const r of rec.conformance.runs) if (r.revision === '2026-07-28' && r.scenario === 'tools-list') for (const c of r.checks) c.status = 'SUCCESS';
  const j2 = judgeOracles(rec, { reader: knownReader(), pins: PINS, baseline: base });
  assert.deepEqual(j2.conformance.stale_baseline, ['2026-07-28/tools-list/wire-schema-valid']);
  assert.ok(baselineProblems(j2, base).some((p) => /stale baseline/.test(p)));
});

test('judge: disagreements by class: D6 names and outcomes, D12 a timeout, D4 same names but other definitions, D7 the tool-name rule', () => {
  const reader = knownReader();
  const rec = knownRec();
  const [a, b, c, d] = rec.clients;
  a.result.tools = a.result.tools.slice(1);                        // one tool fewer: D6 tool_names (reader and client)
  b.result.outcome = 'init_failed'; b.result.tools = null;         // D6 outcome
  c.result.outcome = 'timeout'; c.result.tools = null;             // D12
  d.result.tools = d.result.tools.map((t) => ({ ...t, description: 'changed' })); // D4 catalog
  const j = judgeOracles(rec, { reader, pins: PINS });
  const k = j.disagreements.map((x) => `${x.class} ${x.oracle_a} ${x.oracle_b} ${x.kind}`);
  assert.ok(k.includes('D6 reader client:typescript-v1 tool_names'), k.join('\n'));
  assert.ok(k.includes('D6 reader client:typescript-v2 outcome'));
  assert.ok(k.includes('D12 reader client:python outcome'));
  assert.ok(k.includes('D4 reader client:go catalog'));
  assert.ok(k.includes('D6 client:typescript-v1 client:go tool_names'), 'clients against each other');
  assert.deepEqual(j.disagreements.find((x) => x.kind === 'tool_names' && x.oracle_a === 'reader').detail, { only_a: 1, only_b: 0, count_a: 3, count_b: 2 });
  // Our reader got no list, a client did: the lead for a reader bug.
  const j2 = judgeOracles(knownRec(), { reader: { listed: false }, pins: PINS });
  assert.ok(j2.disagreements.every((x) => x.class === 'D6' && x.kind === 'outcome' && x.detail.a === 'not_listed'));
  assert.equal(j2.disagreements.length, 4);
  // D7: the suite says the names break the rule, our engine did not flag them.
  const rec3 = knownRec();
  for (const r of rec3.conformance.runs) if (r.revision === '2025-11-25' && r.scenario === 'tools-list') r.checks.find((x) => x.id === 'tools-name-format').status = 'FAILURE';
  const j3 = judgeOracles(rec3, { reader, pins: PINS });
  assert.deepEqual(j3.disagreements.map((x) => [x.class, x.kind, x.detail]), [['D7', 'tool_name_rule', { a: 'clean', b: 'fail' }]]);
});

test('judge: nothing a server says reaches a field except through a strict pattern (protocol strings, check ids)', () => {
  const rec = knownRec();
  rec.clients[0].result.protocol = 'attempt_id=forged';
  rec.clients[1].result.sdk_version = 'run_key: x';
  rec.conformance.runs[0].checks.push({ id: 'Fence = 999', status: 'FAILURE' });
  const j = judgeOracles(rec, { reader: knownReader(), pins: PINS });
  assert.equal(j.clients[0].protocol_negotiated, null);
  assert.equal(j.clients[1].sdk_version, PINS.clients[1].version, 'a version that is not plain falls back to the pinned one');
  assert.ok(!/Fence|attempt_id|run_key/.test(JSON.stringify(j)));
  assert.equal(judgeOracles(null, { reader: knownReader(), pins: PINS }).status, 'absent');
  assert.deepEqual(judgeOracles({ format: 'isokron-live-probe-oracles/1', mode: 'skipped', why: 'time_budget' }, { reader: {}, pins: PINS }).status, 'skipped');
  assert.equal(clientCatalog('x'), null);
  assert.equal(namesSha(['b', 'a']), namesSha(['a', 'b']));
});

test('the oracle baseline names our own servers only, and each expected failure names a scenario the pins run', () => {
  const b = JSON.parse(readFileSync(LP.ORACLE_BASELINE_FILE, 'utf8'));
  const run = new Set(Object.entries(PINS.revisions).flatMap(([rev, R]) => R.scenarios.filter((s) => s.run).map((s) => `${rev}/${s.scenario}`)));
  for (const [k, v] of [...Object.entries(b.subjects), ['control', b.controls.known_good]]) {
    if (k !== 'control') assert.match(k, /^isokron-ai\//, k);
    for (const f of v.expected_failures) assert.ok(run.has(f.split('/').slice(0, 2).join('/')), f);
    assert.deepEqual(Object.keys(v.clients).sort(), PINS.clients.map((c) => c.id).sort(), k);
  }
  assert.equal(b.controls.known_good.clients['typescript-v1'].catalog_sha256, JSON.parse(readFileSync(LP.KNOWN_ANSWER_FILE, 'utf8')).answer.catalog_hash, 'the clients\' known answer is the reader\'s');
});

// ------------------------------------------------------------------ the bundle

test('live-probe bundle with the oracle stage: six fields, raw/oracles.json, the meta file\'s oracles, a fourth control, contained forgery', () => {
  const w = mkdtempSync(join(tmpdir(), 'live-probe-oracle-'));
  const put = (p, s) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof s === 'string' ? s : JSON.stringify(s)); };
  const fx = (f) => readFileSync(join(LPFX, f), 'utf8');
  const MARKER = 'liveprobe-' + 'ab'.repeat(16);
  const resolution = { status: 'runnable', detail: null, registry: { name: 'io.github.isokron-ai/mcp-check', version: '1.3.1', entries: 1, transports: ['stdio'], remotes: 0 }, choice: { type: 'npm', identifier: '@isokron/mcp-check', version: '1.3.1', transport: 'stdio', runtime_hint: 'npx', args_n: 1, args_unfilled: 0, env_names: [], oci_digest: null, purl: 'pkg:npm/%40isokron/mcp-check@1.3.1', matched_by: 'seed', verified_by: 'seed' }, candidates: [], launch: { kind: 'npm' }, subdir: null, seed_packages: 1 };
  put('plan.json', { format: LP.PLAN_FORMAT, shard_id: 's', attempt_id: 'attempt-1', marker: MARKER, planned_at: '2026-11-24T10:00:00.000Z', subject_timeout_s: 147, runnable: 1, items: [{ index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', run_key: '1'.repeat(64), fence: 1, target_id: 's001', target: { id: 's001', launch: { kind: 'npm' } }, resolution, resolve_ms: 1 }] });
  put('sandbox.json', { oracles_installed: true, install_rc: 0, guard_rc: 0, selftest_rc: 0, selftest_check_rc: 0, controls_rc: 0, subjects_rc: 0, swept: true, left: { labelled: 0, containers: 0, volumes: 0, uid_65534_processes: 0, runsc_processes: 0 }, msc_commit: 'a'.repeat(40), gvisor_release: '20261103', worker_kit_ref: 'b'.repeat(40) });
  put('selftest/results.json', { cases: [{ case: 'direct-ip', blocked: true, logged: true, pass: true }], passed: 1, total: 1 });
  put('driver-controls/s901/probe-bare.json', fx('probe-known.json'));
  put('driver-controls/s901/record.json', fx('record-ok.json'));
  put('driver-controls/s901/oracles.json', fx('oracles-known.json'));
  put('driver-controls/s902/probe-bare.json', fx('probe-forgery.json').split('liveprobe-MARKERMARKERMARKER0000').join(MARKER));
  put('driver-controls/s902/record.json', fx('record-ok.json'));
  put('driver-controls/s902/oracles.json', fx('oracles-forgery.json').split('liveprobe-MARKERMARKERMARKER0000').join(MARKER));
  put('driver-controls/_shard/telemetry.jsonl', '');
  put('driver-subjects/_shard/telemetry.jsonl', '');
  put('driver-subjects/s001/record.json', fx('record-ok.json'));
  put('driver-subjects/s001/probe-bare.json', fx('probe-known.json'));
  put('driver-subjects/s001/oracles.json', fx('oracles-known.json'));
  LP.bundleShard({ work: w });
  const b = join(w, 'out', '0', 'bundle');
  const res = JSON.parse(readFileSync(join(b, 'results', 'live-probe.json'), 'utf8'));
  assert.equal(res.oracles.status, 'ran');
  assert.deepEqual(res.oracles.baseline_problems, [], 'our own server matches its baseline');
  assert.deepEqual(res.oracles.disagreements, []);
  assert.ok(existsSync(join(b, 'raw', 'oracles.json')));
  const recs = readFileSync(join(b, 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const by = (f) => recs.filter((o) => o.field === f).map((o) => o.value);
  for (const f of Object.keys(LP.ORACLE_FIELDS)) assert.equal(by(f).length, 1, f);
  assert.equal(by('sdk_client_results')[0].length, 4);
  assert.equal(by('conformance_suite')[0].git_commit, PINS.conformance.git_commit);
  assert.equal(by('conformance_summary')[0].revisions['2025-11-25'].scenarios_run, 5);
  assert.ok(by('conformance_checks')[0].every((c) => c.status !== 'fail'));
  const meta = JSON.parse(readFileSync(join(w, 'out', '0', 'meta.json'), 'utf8'));
  assert.ok(meta.oracles.some((o) => o.name === '@modelcontextprotocol/conformance' && o.version === '0.2.0-alpha.12'));
  assert.deepEqual(meta.controls.map((c) => `${c.kind}:${c.observed}`), ['known_good:match', 'forgery:contained', 'known_good:match', 'malicious:blocked']);
  // The forgery's oracle results went through the same code: nothing outside raw/ holds the marker.
  const forgery = readFileSync(join(b, 'controls', 'forgery.json'), 'utf8');
  assert.match(forgery, /sdk_client_results/, 'the forgery control saw the oracle fields');
  assert.ok(!forgery.includes(MARKER));
});

test('live-probe bundle: an oracle known answer that does not match stops the upload (a control)', () => {
  const w = mkdtempSync(join(tmpdir(), 'live-probe-oracle-bad-'));
  const put = (p, s) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof s === 'string' ? s : JSON.stringify(s)); };
  const fx = (f) => readFileSync(join(LPFX, f), 'utf8');
  const MARKER = 'liveprobe-' + 'cd'.repeat(16);
  put('plan.json', { format: LP.PLAN_FORMAT, shard_id: 's', attempt_id: 'attempt-1', marker: MARKER, planned_at: '2026-11-24T10:00:00.000Z', subject_timeout_s: 147, runnable: 0, items: [] });
  put('sandbox.json', { oracles_installed: true, selftest_check_rc: 0, swept: true, left: { labelled: 0, containers: 0, volumes: 0, uid_65534_processes: 0, runsc_processes: 0 } });
  put('selftest/results.json', { cases: [{ case: 'direct-ip', blocked: true, logged: true, pass: true }], passed: 1, total: 1 });
  put('driver-controls/s901/probe-bare.json', fx('probe-known.json'));
  const rec = JSON.parse(fx('oracles-known.json'));
  rec.clients[2].result.tools = rec.clients[2].result.tools.slice(1);
  put('driver-controls/s901/oracles.json', rec);
  put('driver-controls/s902/probe-bare.json', fx('probe-forgery.json').split('liveprobe-MARKERMARKERMARKER0000').join(MARKER));
  assert.throws(() => LP.bundleShard({ work: w }), (e) => e instanceof LP.ControlFailure && /known_good=mismatch/.test(e.message));
});

test('R-ORC-01: a client SDK that writes out an annotation default (Go: idempotentHint false) is the same catalog, not a D4 disagreement; a real difference still is', () => {
  // The self test on GitHub (kronicle-lite 0.10.2): the Go SDK wrote idempotentHint: false on two tools that left it
  // out, so its catalog hash differed from our reader's and the other clients', and the judge raised D4 leads that
  // would fire on most servers with annotations.
  const annotate = (tools) => tools.map((t, i) => (i === 0 ? { ...t, annotations: { readOnlyHint: true, openWorldHint: false } } : t));
  const p = JSON.parse(readFileSync(join(LPFX, 'probe-known.json'), 'utf8'));
  const tools = annotate(LP.toolsOf(p.lists['tools/list'].raw_pages));
  const g = LP.gradeList(JSON.stringify({ tools }));
  const reader = { listed: true, tool_count: g.summary.tool_count, catalog_hash: g.summary.catalog_hash, names: g.names, tools, pages: 1, check_ids: Object.keys(g.summary.check_counts), capabilities: { tools: {} } };
  const rec = knownRec();
  for (const c of rec.clients) c.result.tools = annotate(c.result.tools);
  const go = rec.clients.find((c) => c.id === 'go');
  go.result.tools[0] = { ...go.result.tools[0], annotations: { idempotentHint: false, openWorldHint: false, readOnlyHint: true } };
  const j = judgeOracles(rec, { reader, pins: PINS });
  assert.deepEqual(j.disagreements, []);
  assert.notEqual(j.clients.find((c) => c.client === 'go').catalog_sha256, reader.catalog_hash, 'the full hashes do differ');
  assert.deepEqual(j.clients.map((c) => [c.client, c.catalog_vs_reader]), [['typescript-v1', 'same'], ['typescript-v2', 'same'], ['python', 'same'], ['go', 'same_but_annotation_defaults']]);
  // A hint that is not the default is a real difference: still D4, against the reader and the other clients.
  go.result.tools[0] = { ...go.result.tools[0], annotations: { readOnlyHint: false, openWorldHint: false } };
  const k = judgeOracles(rec, { reader, pins: PINS }).disagreements.map((x) => `${x.class} ${x.oracle_a} ${x.oracle_b} ${x.kind}`);
  assert.deepEqual(k, ['D4 reader client:go catalog', 'D4 client:typescript-v1 client:go catalog']);
});

test('R-ORC-02: the driver\'s probe time holds the oracle stage (it runs inside the probe option); step_telemetry keeps the two apart', () => {
  // The self test on GitHub: probe_ms went from about 1 s to 12.4 s for mcp-check with the stage on.
  const w = mkdtempSync(join(tmpdir(), 'live-probe-oracle-t-'));
  const put = (p, s) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof s === 'string' ? s : JSON.stringify(s)); };
  const fx = (f) => readFileSync(join(LPFX, f), 'utf8');
  const MARKER = 'liveprobe-' + 'ef'.repeat(16);
  const resolution = { status: 'runnable', detail: null, registry: null, choice: null, candidates: [], launch: { kind: 'npm' }, subdir: null, seed_packages: 1 };
  put('plan.json', { format: LP.PLAN_FORMAT, shard_id: 's', attempt_id: 'attempt-1', marker: MARKER, planned_at: '2026-11-24T10:00:00.000Z', subject_timeout_s: 147, runnable: 1, items: [{ index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', run_key: '1'.repeat(64), fence: 1, target_id: 's001', target: { id: 's001', launch: { kind: 'npm' } }, resolution, resolve_ms: 1 }] });
  put('sandbox.json', { oracles_installed: false, selftest_check_rc: 0, swept: true, left: { labelled: 0, containers: 0, volumes: 0, uid_65534_processes: 0, runsc_processes: 0 } });
  put('selftest/results.json', { cases: [{ case: 'direct-ip', blocked: true, logged: true, pass: true }], passed: 1, total: 1 });
  put('driver-controls/s901/probe-bare.json', fx('probe-known.json'));
  put('driver-controls/s902/probe-bare.json', fx('probe-forgery.json').split('liveprobe-MARKERMARKERMARKER0000').join(MARKER));
  const rec = JSON.parse(fx('record-ok.json')); rec.timing = { ...(rec.timing || {}), probe_ms: 12472 };
  put('driver-subjects/s001/record.json', rec);
  put('driver-subjects/s001/probe-bare.json', fx('probe-known.json'));
  const o = JSON.parse(fx('oracles-known.json')); o.ms = 11296;
  put('driver-subjects/s001/oracles.json', o);
  LP.bundleShard({ work: w });
  const r = JSON.parse(readFileSync(join(w, 'out', '0', 'bundle', 'results', 'live-probe.json'), 'utf8'));
  assert.equal(r.timing.oracle_ms, 11296);
  assert.equal(r.timing.probe_ms, 12472 - 11296);
  const st = readFileSync(join(w, 'out', '0', 'bundle', 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.field === 'step_telemetry').value;
  assert.deepEqual([st.probe_ms, st.oracle_ms], [1176, 11296]);
});
