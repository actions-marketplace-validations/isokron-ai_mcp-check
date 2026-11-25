/**
 * The fuzz stage of the live-probe lane (corpus/FUZZ.md): read-only protocol sessions against one target, judged by
 * corpus/fuzz/judge.mjs. Off unless the lane is switched on (the driver's `--fuzz on`).
 *
 * Round 1 is two fresh sessions of the target, each a sandbox container made from the driver's own `docker run`
 * (the oracle stage's variantCommand: same image, mounts, env, network, limits; one alive at a time, removed after,
 * its syscall trace summarised):
 *
 *   A  initialize; every list (tools, and prompts and resources when declared) twice; then, if a list is paginated,
 *      its first cursor again (spent), and two cursors the server never issued
 *   B  initialize; every list once; then A's first cursor (issued in another session)
 *
 * A fail or warn that depends on observations is repeated in round 2 (a fresh A and B) before the server is blamed.
 * Only initialize, ping and the list methods are ever sent (session.mjs): no tool is called.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { variantCommand } from '../oracles/run.mjs';
import { Session, PRIMITIVES, traverse, page, sha256, PROTOCOL_VERSION } from './session.mjs';
import { judgeRound, judgeUnicode, attribute, summaryOf, PRIMS, SUBJECT_CAPABLE } from './judge.mjs';

export const FORMAT = 'isokron-live-probe-fuzz/1';
export const FUZZ_BUDGET_MS = 60_000;
export const SESSION_MS = 20_000;
export const CLEANUP_SLACK_MS = 8_000;
export const MIN_SESSION_MS = 6_000;
/** fuzz.json stays well under the bundle's 6 MiB raw-file cut (corpus/live-probe.mjs RAW_FILE_CAP), so it is never cut in half. */
export const RECORD_CAP = 3 * 1024 * 1024;
export const REPRODUCERS_CAP = 1024 * 1024;
/** Cursors no server issued: one plain, one with bidi and NUL characters and a non-BMP one. */
export const INVENTED_CURSORS = Object.freeze([['ascii', 'isokron-fuzz-invalid-cursor'], ['unicode', '‮\u0000ünï😀']]);
/** Container name suffixes are -o<k> for the oracles; the fuzz sessions start at 100. */
const SESSION_K0 = 100;

const sha = (s) => sha256(String(s));
const canonicalJson = (v) => JSON.stringify(v);
/** A server's cursor as the record keeps it: a hash. */
const curHash = (c) => (typeof c === 'string' ? 'cur-' + sha(c).slice(0, 16) : null);

/** The health of a finished session, from our side of the pipe. */
function healthOf(s, init) {
  return { init_ok: !!(init && init.ok), limit: s.limit, closed: s.closed, timeouts: s.timeouts, requests: s.requests, noise_lines: s.noise, server_requests: s.serverRequests, exit: s.exit, list_changed: { tools: s.count('notifications/tools/list_changed'), prompts: s.count('notifications/prompts/list_changed'), resources: s.count('notifications/resources/list_changed') } };
}

/**
 * One session's script. role 'A' or 'B'. `shared` carries what A issued to B ({ primitive, cursor, original }).
 * Returns the session record; the session's request log stays on the (non-enumerable) `log`.
 */
export async function exercise(s, role, label, shared, { deadline, now = () => Date.now() } = {}) {
  const rec = { label, role, init: null, health: null, invalid_utf8: 0, trav: {}, probes: {} };
  const left = () => deadline - now();
  s.phase = 'init'; s.primitive = null;
  const init = await s.initialize();
  // Not the whole answer (its instructions and server info stay out of the record): a hash, and the few facts a verdict needs.
  const caps0 = init.ok && init.result.capabilities && typeof init.result.capabilities === 'object' ? init.result.capabilities : null;
  const flag = (k) => !!(caps0 && caps0[k] && typeof caps0[k] === 'object' && caps0[k].listChanged === true);
  rec.init = init.ok ? { ok: true, protocol: typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion.slice(0, 40) : null, result_sha256: sha(canonicalJson(init.result)), declares: { tools: !!(caps0 && caps0.tools), prompts: !!(caps0 && caps0.prompts), resources: !!(caps0 && caps0.resources) }, list_changed: { tools: flag('tools'), prompts: flag('prompts'), resources: flag('resources') } } : { ok: false, limit: init.limit || null, error: init.error || null };
  if (init.ok) {
    const caps = caps0 || {};
    const prims = PRIMS.filter((p) => p === 'tools' ? true : caps[PRIMITIVES[p].capability] !== undefined && caps[PRIMITIVES[p].capability] !== null && caps[PRIMITIVES[p].capability] !== false);
    const runs = role === 'A' ? ['t1', 't2'] : ['t1'];
    for (const run of runs) {
      for (const p of prims) {
        if (left() < 1500 || s.closed) break;
        s.phase = run; s.primitive = p;
        (rec.trav[p] ||= []).push(await traverse(s, p));
      }
    }
    // Cursor probes, on the first list that came in pages.
    const paged = prims.find((p) => rec.trav[p] && rec.trav[p][0] && rec.trav[p][0].stop === 'end' && rec.trav[p][0].pages.length >= 2);
    if (paged && !s.closed && left() > 1500) {
      const t1 = rec.trav[paged][0];
      const cursor = t1.pages[0].next; const original = t1.pages[1];
      if (role === 'A') {
        Object.defineProperty(rec, 'issued', { enumerable: false, value: null, writable: true });
        rec.issued = { primitive: paged, cursor, original: slim(original) };
        s.phase = 'spent'; s.primitive = paged;
        rec.probes.spent = { primitive: paged, cursor_sha256: sha(cursor), original: slim(original), replay: slim(await page(s, paged, cursor)) };
        rec.probes.invented = [];
        for (const [kind, c] of INVENTED_CURSORS) {
          if (left() < 1500 || s.closed) break;
          s.phase = 'invented'; s.primitive = paged;
          rec.probes.invented.push({ primitive: paged, cursor_kind: kind, first: slim(t1.pages[0]), replay: slim(await page(s, paged, c)) });
        }
      }
    }
    if (role === 'B' && shared && shared.cursor !== undefined && shared.cursor !== null && !s.closed && left() > 1500) {
      s.phase = 'foreign'; s.primitive = shared.primitive;
      rec.probes.foreign = { primitive: shared.primitive, cursor_sha256: sha(shared.cursor), original: shared.original, replay: slim(await page(s, shared.primitive, shared.cursor)) };
    }
  }
  rec.health = healthOf(s, init);
  rec.invalid_utf8 = s.invalidUtf8;
  // Cursors are the server's opaque strings: the record keeps hashes (the live ones stay in memory, for B's probe).
  for (const ts of Object.values(rec.trav)) for (const t of ts) for (const p of t.pages) { p.cursor_in = curHash(p.cursor_in); p.next = curHash(p.next); }
  return rec;
}

const slim = (p) => (p ? { ok: p.ok, error: p.error, limit: p.limit, items: p.items, next: p.next === null ? null : '(cursor)', malformed: p.malformed } : p);

/** The reproducer of one subject-fault result: the requests and answers that show it, as a replayable spec. */
export function reproducerOf(result, sessions) {
  const by = Object.fromEntries(sessions.map((s) => [s.rec.label, s]));
  // A server's cursors become hashes in the spec; the replay hands the hashes back, so the keys still match.
  // Our own invented cursors are constants and stay as they are.
  const mine = new Set(INVENTED_CURSORS.map((x) => x[1]));
  const map = new Map();
  for (const s of sessions) for (const e of s.log) if (e.result && typeof e.result.nextCursor === 'string') map.set(e.result.nextCursor, curHash(e.result.nextCursor));
  const hashed = (c) => (typeof c === 'string' && !mine.has(c) ? (map.get(c) || curHash(c)) : c);
  // The initialize answer is cut down to what a replay needs: no instructions, no server info.
  const reduce = (e) => {
    if (e.method === 'initialize' && e.result) {
      const c = e.result.capabilities && typeof e.result.capabilities === 'object' ? e.result.capabilities : {};
      const keep = {}; for (const k of ['tools', 'prompts', 'resources']) if (c[k] !== undefined) keep[k] = { listChanged: !!(c[k] && c[k].listChanged) };
      return { method: e.method, params: {}, result: { protocolVersion: e.result.protocolVersion, capabilities: keep, serverInfo: { name: 'replay', version: '0' } } };
    }
    const params = e.params && e.params.cursor !== undefined ? { ...e.params, cursor: hashed(e.params.cursor) } : e.params;
    const r = e.result && typeof e.result.nextCursor === 'string' ? { ...e.result, nextCursor: hashed(e.result.nextCursor) } : e.result;
    return { method: e.method, params, ...(r !== undefined ? { result: r } : { error: e.error }) };
  };
  const steps = (label, keep) => {
    const s = by[label]; if (!s) return [];
    return s.log.filter((e) => e.phase === 'init' || keep(e)).map(reduce);
  };
  const p = result.primitive;
  const P = (e, ...phases) => e.primitive === p && phases.includes(e.phase);
  let spec;
  if (result.id === 'FZ-CAT-1') spec = { A: steps('A', (e) => P(e, 't1', 't2')) };
  else if (result.id === 'FZ-CAT-2') spec = { A: steps('A', (e) => P(e, 't1')), B: steps('B', (e) => P(e, 't1')) };
  else if (result.id === 'FZ-PAG-1') spec = { A: steps('A', (e) => P(e, 't1')) };
  else if (result.id === 'FZ-PAG-2') spec = { A: steps('A', (e) => P(e, 't1', 'spent')) };
  else if (result.id === 'FZ-PAG-3') spec = { A: steps('A', (e) => P(e, 't1', 'invented')) };
  else if (result.id === 'FZ-PAG-4') spec = { A: steps('A', (e) => P(e, 't1')), B: steps('B', (e) => e.phase === 'foreign') };
  else if (result.id.startsWith('FZ-UNI')) spec = { A: steps('A', (e) => e.phase === 't1') };
  else return null;
  const used = Object.keys(spec);
  const size = JSON.stringify(spec).length;
  const head = { format: 'isokron-fuzz-reproducer/1', invariant: result.id, primitive: p, kind: result.kind, attribution: result.fault === 'subject' ? 'subject' : 'observation' };
  if (size > REPRODUCERS_CAP / 2) return { ...head, truncated: true, bytes: size };
  return { ...head, expect: { verdict: result.first_seen ? result.first_seen.verdict : result.verdict, kind: result.first_seen ? result.first_seen.kind : result.kind }, protocol_version: PROTOCOL_VERSION, order: used.length === 2 ? ['A', 'B'] : ['A', 'A'], sessions: spec };
}

/** The record under RECORD_CAP: first the reproducers that do not fit, then the item lists of the sessions (hashes stay). */
export function capRecord(rec, cap = RECORD_CAP) {
  const size = () => Buffer.byteLength(JSON.stringify(rec));
  let used = 0;
  rec.reproducers = (rec.reproducers || []).map((r) => { const n = r.sessions ? JSON.stringify(r.sessions).length : 0; if (r.sessions && used + n > REPRODUCERS_CAP) { const { sessions, order, ...rest } = r; return { ...rest, truncated: true, bytes: n }; } used += n; return r; });
  if (size() <= cap) return rec;
  rec.truncated = ['reproducers'];
  for (const r of rec.reproducers) if (r.sessions) { delete r.sessions; delete r.order; r.truncated = true; }
  if (size() <= cap) return rec;
  rec.truncated.push('item_lists');
  for (const round of rec.rounds || []) for (const sess of round.sessions) for (const ts of Object.values(sess.trav || {})) for (const t of ts) for (const pg of t.pages) if (pg.items) { pg.item_count = pg.items.length; pg.items = null; }
  return rec;
}

/**
 * The stage for one target.
 * @param {object} o
 * @param {string[]} o.command      the driver's `docker run` command for the target
 * @param {object} o.dockerEnv      the Docker client's environment (the driver's)
 * @param {number} o.budgetMs       time for the whole stage
 * @param {(cid: string) => Promise<object|null>} [o.takeTrace]
 * @param {(name: string) => Promise<void>} [o.removeContainer]
 * @param {(command: string[], k: number) => { command, name, cidfile }} [o.variant]  for tests: the session command
 * @param {number} [o.requestMs]  for tests: the time limit of one request (default 10 s)
 */
export async function runFuzz({ command, dockerEnv, budgetMs, takeTrace = async () => null, removeContainer, variant = variantCommand, now = () => Date.now(), requestMs = undefined }) {
  const t0 = now(); const deadline = t0 + budgetMs;
  const out = { format: FORMAT, mode: 'full', started_at: new Date(t0).toISOString(), budget_ms: budgetMs, ms: null, rounds: [], results: [], reproducers: [], containers: [], errors: [], summary: null };
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const [k, v] of Object.entries(dockerEnv || {})) if (/^DOCKER_[A-Z_]{1,40}$/.test(k) && typeof v === 'string') env[k] = v;
  const rm = removeContainer || (async (name) => { spawnSync('docker', ['rm', '-f', '-v', name], { env, stdio: 'ignore', timeout: 15_000 }); });
  let k = SESSION_K0;
  const live = [];

  const session = async (role, label, shared, roundDeadline) => {
    const v = variant(command, ++k);
    if (v.cidfile) rmSync(v.cidfile, { force: true });
    const s = new Session(v.command, { env, ...(requestMs ? { requestMs } : {}) }).start();
    let rec;
    const guard = setTimeout(() => { s.stop('timeout'); }, Math.max(1000, Math.min(SESSION_MS, roundDeadline - now())));
    try { rec = await exercise(s, role, label, shared, { deadline: Math.min(roundDeadline, now() + SESSION_MS), now }); } finally { clearTimeout(guard); }
    await s.close();
    await rm(v.name);
    let cid = null;
    try { if (v.cidfile && existsSync(v.cidfile)) { const t = readFileSync(v.cidfile, 'utf8').trim(); cid = /^[0-9a-f]{64}$/.test(t) ? t : null; } } catch { /* none */ }
    let trace = null;
    if (cid) { try { trace = await takeTrace(cid); } catch { trace = null; } }
    if (v.cidfile) rmSync(v.cidfile, { force: true });
    out.containers.push({ session: k - SESSION_K0, role: label, trace_summary: trace, exit: s.exit });
    live.push({ rec, log: s.log });
    return { rec, log: s.log, label };
  };

  const round = async (n) => {
    const roundDeadline = deadline - CLEANUP_SLACK_MS;
    const half = (roundDeadline - now()) / 2;
    if (half < MIN_SESSION_MS) return null;
    const A = await session('A', 'A' + (n > 1 ? n : ''), null, now() + half);
    if (roundDeadline - now() < MIN_SESSION_MS) return { A, B: null };
    const B = await session('B', 'B' + (n > 1 ? n : ''), A.rec.issued ? { ...A.rec.issued } : null, roundDeadline);
    return { A, B };
  };

  try {
    const r1 = await round(1);
    if (!r1) { out.mode = 'skipped'; out.why = 'time_budget'; }
    else {
      out.rounds.push({ round: 1, sessions: [r1.A.rec, r1.B && r1.B.rec].filter(Boolean) });
      const first = judgeRound(r1.A.rec, r1.B && r1.B.rec);
      const sessionsOk = [r1.A.rec, r1.B && r1.B.rec].filter(Boolean);
      const unicode = judgeUnicode(sessionsOk);
      const needs = first.some((x) => x.verdict === 'fail' && (SUBJECT_CAPABLE[x.id] || []).includes(x.kind));
      let second = null;
      if (needs && deadline - now() > 2 * MIN_SESSION_MS + CLEANUP_SLACK_MS) {
        const r2 = await round(2);
        if (r2 && r2.B) { out.rounds.push({ round: 2, sessions: [r2.A.rec, r2.B.rec] }); second = judgeRound(r2.A.rec, r2.B.rec); }
      }
      out.results = attribute(first, second, unicode).map((x) => ({ ...x, round_labels: undefined }));
      for (const x of out.results) {
        if (x.fault === 'subject' || x.verdict === 'observation') { const rp = reproducerOf(x, [r1.A && { rec: r1.A.rec, log: r1.A.log }, r1.B && { rec: r1.B.rec, log: r1.B.log }].filter(Boolean)); if (rp) out.reproducers.push(rp); }
      }
      out.summary = summaryOf(out.results);
    }
  } catch (e) {
    out.mode = 'error'; out.errors.push(String(e && e.message).slice(0, 300));
  } finally {
    out.ms = now() - t0;
  }
  return capRecord(out);
}
