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
import { judgeRound, judgeUnicode, attribute, summaryOf, PRIMS, NEEDS_CONFIRMATION } from './judge.mjs';

export const FORMAT = 'isokron-live-probe-fuzz/1';
export const FUZZ_BUDGET_MS = 60_000;
export const SESSION_MS = 20_000;
export const CLEANUP_SLACK_MS = 8_000;
export const MIN_SESSION_MS = 6_000;
/** Cursors no server issued: one plain, one with bidi and NUL characters and a non-BMP one. */
export const INVENTED_CURSORS = Object.freeze([['ascii', 'isokron-fuzz-invalid-cursor'], ['unicode', '‮\u0000ünï😀']]);
/** Container name suffixes are -o<k> for the oracles; the fuzz sessions start at 100. */
const SESSION_K0 = 100;

const sha = (s) => sha256(String(s));

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
  rec.init = init.ok ? { ok: true, protocol: typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion.slice(0, 40) : null, capabilities: init.result.capabilities && typeof init.result.capabilities === 'object' ? init.result.capabilities : null } : { ok: false, limit: init.limit || null, error: init.error || null };
  if (init.ok) {
    const caps = rec.init.capabilities || {};
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
  return rec;
}

const slim = (p) => (p ? { ok: p.ok, error: p.error, limit: p.limit, items: p.items, next: p.next === null ? null : '(cursor)', malformed: p.malformed } : p);

/** The reproducer of one subject-fault result: the requests and answers that show it, as a replayable spec. */
export function reproducerOf(result, sessions) {
  const by = Object.fromEntries(sessions.map((s) => [s.rec.label, s]));
  const steps = (label, keep) => {
    const s = by[label]; if (!s) return [];
    return s.log.filter((e) => e.phase === 'init' || keep(e)).map((e) => ({ method: e.method, params: e.params, ...(e.result !== undefined ? { result: e.result } : { error: e.error }) }));
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
  if (size > 1024 * 1024) return { format: 'isokron-fuzz-reproducer/1', invariant: result.id, primitive: p, kind: result.kind, truncated: true, bytes: size };
  return { format: 'isokron-fuzz-reproducer/1', invariant: result.id, primitive: p, kind: result.kind, expect: { verdict: result.first_seen ? result.first_seen.verdict : result.verdict, kind: result.first_seen ? result.first_seen.kind : result.kind }, protocol_version: PROTOCOL_VERSION, order: used.length === 2 ? ['A', 'B'] : ['A', 'A'], sessions: spec };
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
 */
export async function runFuzz({ command, dockerEnv, budgetMs, takeTrace = async () => null, removeContainer, variant = variantCommand, now = () => Date.now() }) {
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
    const s = new Session(v.command, { env }).start();
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
      const needs = first.some((x) => (x.verdict === 'fail' || x.verdict === 'warn') && NEEDS_CONFIRMATION.has(x.id));
      let second = null;
      if (needs && deadline - now() > 2 * MIN_SESSION_MS + CLEANUP_SLACK_MS) {
        const r2 = await round(2);
        if (r2 && r2.B) { out.rounds.push({ round: 2, sessions: [r2.A.rec, r2.B.rec] }); second = judgeRound(r2.A.rec, r2.B.rec); }
      }
      out.results = attribute(first, second, unicode).map((x) => ({ ...x, round_labels: undefined }));
      for (const x of out.results) {
        if (x.fault === 'subject') { const rp = reproducerOf(x, [r1.A && { rec: r1.A.rec, log: r1.A.log }, r1.B && { rec: r1.B.rec, log: r1.B.log }].filter(Boolean)); if (rp) out.reproducers.push(rp); }
      }
      out.summary = summaryOf(out.results);
    }
  } catch (e) {
    out.mode = 'error'; out.errors.push(String(e && e.message).slice(0, 300));
  } finally {
    out.ms = now() - t0;
  }
  return out;
}
