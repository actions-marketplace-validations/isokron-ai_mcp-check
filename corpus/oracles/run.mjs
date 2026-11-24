/**
 * The oracle stage of the live-probe lane (corpus/LIVE-PROBE.md, "Oracles"), run for one target right after the
 * sandbox driver's own probe of it, on the same `docker run` (the same image, mounts, env, network and limits):
 *
 *   1. each independent SDK client (official TypeScript 1.x and 2.x, Python, Go: corpus/oracles/pins.json) starts the
 *      target and lists every page of tools/list;
 *   2. the official conformance suite, pinned, runs the read-only server scenarios of each frozen requirement set
 *      against the target through the stdio-to-HTTP bridge (bridge.mjs), each scenario on fresh server processes.
 *
 * Every server process is a sandbox container: the driver's own `docker run` arguments with a name and cidfile of
 * its own, one alive at a time, removed after use, its syscall trace summarised and removed. Nothing of a target runs
 * on the runner. The clients and the suite run on the runner with an environment of PATH, HOME and the Docker
 * variables only (no token, no runner variables), and their output is data.
 *
 * Writes nothing outside `outFile` (oracles.json, raw: it can hold the server's text). Judging the results (catalog
 * hashes, agreement, the check table, the fields) is corpus/live-probe.mjs's work, in the bundle step.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from './bridge.mjs';

export const FORMAT = 'isokron-live-probe-oracles/1';
export const CLIENT_OUT_CAP = 24 * 1024 * 1024;
export const CHECKS_CAP = 4 * 1024 * 1024;
export const STDERR_TAIL = 16 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;
const CID_RE = /^\/[A-Za-z0-9._/-]{1,300}$/;

/**
 * The driver's `docker run` command for a target, with a name and cidfile of its own (suffix -o<k>). Refuses a
 * command that is not a `docker run` with exactly one --name and at most one --cidfile, or that holds --detach.
 */
export function variantCommand(command, k) {
  if (!Array.isArray(command) || command[0] !== 'docker' || command[1] !== 'run') throw new Error('not a docker run command');
  if (command.includes('--detach')) throw new Error('a detached container cannot be an oracle session');
  const out = [...command];
  const at = (flag) => out.reduce((a, v, i) => (v === flag ? [...a, i] : a), []);
  const names = at('--name'); const cids = at('--cidfile');
  if (names.length !== 1 || cids.length > 1) throw new Error('the command must name its container exactly once');
  const name = `${out[names[0] + 1]}-o${k}`;
  if (!NAME_RE.test(name)) throw new Error('not a container name');
  out[names[0] + 1] = name;
  let cidfile = null;
  if (cids.length) {
    cidfile = `${out[cids[0] + 1]}.o${k}`;
    if (!CID_RE.test(cidfile)) throw new Error('not a cidfile path');
    out[cids[0] + 1] = cidfile;
  }
  return { command: out, name, cidfile };
}

/** The environment of a client or of the suite: the path, a home of its own, the Docker variables. Nothing else. */
export function oracleEnv(dockerEnv, home, hostEnv = process.env) {
  const env = { PATH: hostEnv.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1', DO_NOT_TRACK: '1', npm_config_update_notifier: 'false', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
  for (const [k, v] of Object.entries(dockerEnv || {})) if (/^DOCKER_[A-Z_]{1,40}$/.test(k) && typeof v === 'string') env[k] = v;
  return env;
}

/** Runs one program to its end or its time limit: { exit, signal, timed_out, stdout (capped), stdout_bytes, stderr_tail, ms }. */
export function runProgram(cmd, args, { env, timeoutMs, cwd, cap = CLIENT_OUT_CAP }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try { child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ exit: 127, signal: null, timed_out: false, stdout: '', stdout_bytes: 0, stderr_tail: String(e.message).slice(0, 500), ms: 0 }); return; }
    const chunks = []; let n = 0; let over = false; let err = Buffer.alloc(0); let timedOut = false;
    child.stdout.on('data', (c) => { n += c.length; if (n <= cap) chunks.push(c); else over = true; });
    child.stderr.on('data', (c) => { err = Buffer.concat([err, c]); if (err.length > STDERR_TAIL) err = err.subarray(err.length - STDERR_TAIL); });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref(); }, timeoutMs);
    child.on('error', (e) => { err = Buffer.from(String(e.message)); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exit: code, signal, timed_out: timedOut, stdout: Buffer.concat(chunks).toString('utf8'), stdout_bytes: n, stdout_over_cap: over, stderr_tail: err.toString('utf8'), ms: Date.now() - t0 }); });
  });
}

/** The last JSON object line a client printed, or null. */
export function lastJsonLine(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) { try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* not JSON */ } }
  return null;
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Checks the installed suite against the pins: the requirement sets must hash as pinned (frozen), and each pinned
 * revision's server scenarios (scored and not scored) must be the ones the set names. Returns null or why not.
 */
export function suiteProblem(suiteDir, pins) {
  for (const [rev, want] of Object.entries(pins.conformance.requirement_sets_sha256)) {
    const f = join(suiteDir, 'requirements', `${rev}.yaml`);
    if (!existsSync(f)) return `requirement set ${rev} is missing`;
    if (sha256File(f) !== want) return `requirement set ${rev} is not the pinned one`;
    const text = readFileSync(f, 'utf8');
    const block = /^server:\n((?:[ ]{2}- [^\n]+\n)+)/m.exec(text);
    const scored = block ? block[1].split('\n').filter(Boolean).map((l) => l.replace(/^\s*-\s*/, '').trim()) : [];
    const notScored = [...text.matchAll(/- scenario: (\S+)\n\s+leg: server\n/g)].map((m) => m[1]);
    const pinned = (pins.revisions[rev] && pins.revisions[rev].scenarios) || [];
    const names = (xs) => [...xs].sort().join(',');
    if (names(scored) !== names(pinned.filter((s) => s.scored).map((s) => s.scenario))) return `requirement set ${rev}: the scored server scenarios differ from the pins`;
    if (names(notScored) !== names(pinned.filter((s) => !s.scored).map((s) => s.scenario))) return `requirement set ${rev}: the not-scored server scenarios differ from the pins`;
  }
  return null;
}

/**
 * The oracle stage for one target.
 * @param {object} o
 * @param {string[]} o.command      the driver's `docker run` command for the target
 * @param {object} o.dockerEnv      the Docker client's environment (the driver's)
 * @param {object} o.install        clients.json from install.mjs: where each client and the suite are, and what failed
 * @param {object} o.pins           pins.json
 * @param {number} o.budgetMs       time for the whole stage
 * @param {'full'|'clients_only'} o.mode
 * @param {string} o.work           a scratch folder (homes, the suite's result folders)
 * @param {(cid: string) => Promise<object|null>} [o.takeTrace]  summarises and removes a container's syscall trace
 * @param {(name: string) => Promise<void>} [o.removeContainer]
 * @param {(command: string[], k: number) => { command, name, cidfile }} [o.variant]  for tests: the session command
 */
export async function runOracles({ command, dockerEnv, install, pins, budgetMs, mode = 'full', work, takeTrace = async () => null, removeContainer, variant = variantCommand, now = () => Date.now() }) {
  const t0 = now();
  const deadline = t0 + budgetMs;
  const left = () => deadline - now();
  const out = { format: FORMAT, mode, started_at: new Date(t0).toISOString(), budget_ms: budgetMs, ms: null, clients: [], conformance: null, bridge: null, containers: [], errors: [] };
  mkdirSync(work, { recursive: true });
  const home = mkdtempSync(join(work, 'home-'));
  const env = oracleEnv(dockerEnv, home);
  const rm = removeContainer || (async (name) => { spawnSync('docker', ['rm', '-f', '-v', name], { env, stdio: 'ignore', timeout: 30_000 }); });
  let k = 0;
  const containers = out.containers;
  const session = async (role) => {
    const v = variant(command, ++k);
    if (v.cidfile) rmSync(v.cidfile, { force: true });
    return { ...v, role };
  };
  const finishSession = async (v, extra = {}) => {
    await rm(v.name);
    let cid = null;
    try { if (v.cidfile && existsSync(v.cidfile)) { const t = readFileSync(v.cidfile, 'utf8').trim(); cid = /^[0-9a-f]{64}$/.test(t) ? t : null; } } catch { /* none */ }
    let trace = null;
    if (cid) { try { trace = await takeTrace(cid); } catch { trace = null; } }
    if (v.cidfile) rmSync(v.cidfile, { force: true });
    containers.push({ session: k, role: v.role, trace_summary: trace, ...extra });
  };

  // 1. The SDK clients, one after the other.
  for (const c of pins.clients) {
    const inst = (install && install.clients && install.clients[c.id]) || null;
    if (!inst || !inst.ok || !Array.isArray(inst.command)) { out.clients.push({ id: c.id, outcome: 'unavailable', why: inst ? String(inst.error || 'not installed').slice(0, 200) : 'not installed' }); continue; }
    const ms = Math.min(pins.client_timeout_ms, left() - 5000);
    if (ms < Math.min(5000, pins.client_timeout_ms)) { out.clients.push({ id: c.id, outcome: 'skipped', why: 'time_budget' }); continue; }
    const v = await session(`client:${c.id}`);
    const r = await runProgram(inst.command[0], [...inst.command.slice(1), String(ms), '--', ...v.command], { env, timeoutMs: ms + 10_000, cwd: home });
    await finishSession(v, { exit: r.exit, ms: r.ms });
    const o = lastJsonLine(r.stdout);
    out.clients.push({ id: c.id, exit: r.exit, signal: r.signal, timed_out: r.timed_out, ms: r.ms, stdout_over_cap: !!r.stdout_over_cap, stderr_tail: r.stderr_tail, result: o, ...(o ? {} : { outcome: r.timed_out ? 'timeout' : 'client_error', why: 'no result line' }) });
  }

  // 2. The conformance suite through the bridge, scenario by scenario.
  if (mode === 'full') {
    const conf = { suite: install && install.conformance ? { ok: !!install.conformance.ok, version: install.conformance.version ?? null, error: install.conformance.error ?? null } : { ok: false, error: 'not installed' }, problem: null, runs: [] };
    out.conformance = conf;
    const suite = install && install.conformance && install.conformance.ok ? install.conformance : null;
    conf.problem = suite ? suiteProblem(suite.dir, pins) : 'the suite is not installed';
    if (!conf.problem) {
      const bridge = createBridge({
        requestTimeoutMs: Math.min(15_000, pins.conformance.scenario_timeout_ms),
        spawnSession: async () => {
          const v = await session('conformance');
          const child = spawn(v.command[0], v.command.slice(1), { env, stdio: ['pipe', 'pipe', 'ignore'] });
          child.dispose = async () => {
            try { child.kill('SIGTERM'); } catch { /* gone */ }
            await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else { child.once('close', r); setTimeout(r, 5000).unref(); } });
            await finishSession(v);
          };
          return child;
        },
      });
      let url = null;
      try { url = await bridge.listen(); } catch (e) { conf.problem = `the bridge did not start: ${String(e.message).slice(0, 200)}`; }
      if (url) {
        for (const [rev, R] of Object.entries(pins.revisions)) {
          for (const sc of R.scenarios) {
            if (!sc.run) continue;
            const run = { revision: rev, scenario: sc.scenario, exit: null, ms: null, timed_out: false, checks: null, why: null };
            conf.runs.push(run);
            const ms = pins.conformance.scenario_timeout_ms;
            if (left() < ms + 15_000) { run.why = 'time_budget'; continue; }
            const dir = mkdtempSync(join(work, 'conf-'));
            const r = await runProgram(process.execPath, [suite.bin, 'server', '--url', url, '--scenario', sc.scenario, '--spec-version', rev, '--timeout', String(ms), '-o', dir], { env, timeoutMs: ms + 15_000, cwd: home, cap: 1024 * 1024 });
            await bridge.reset();
            Object.assign(run, { exit: r.exit, ms: r.ms, timed_out: r.timed_out });
            const sub = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'checks.json')));
            if (sub.length === 1) {
              const buf = readFileSync(join(dir, sub[0], 'checks.json'));
              if (buf.length <= CHECKS_CAP) { try { const j = JSON.parse(buf.toString('utf8')); run.checks = Array.isArray(j) ? j : null; } catch { run.checks = null; } }
              if (!run.checks) run.why = 'unreadable_checks';
            } else run.why = r.timed_out ? 'suite_timeout' : /SKIPPED: scenario/.test(r.stdout) ? 'not_applicable' : 'no_checks';
            if (!run.checks) run.stdout_tail = r.stdout.slice(-2000);
            rmSync(dir, { recursive: true, force: true });
          }
        }
        await bridge.close();
        out.bridge = { ...bridge.info, stats: bridge.stats, transcript: bridge.transcript };
      }
    }
  }
  rmSync(home, { recursive: true, force: true });
  out.ms = now() - t0;
  return out;
}

/** Writes the stage's record (raw: it can hold the server's text). */
export function writeOracles(file, rec) {
  writeFileSync(file, `${JSON.stringify(rec)}\n`);
}
