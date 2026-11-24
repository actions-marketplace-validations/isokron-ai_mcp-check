#!/usr/bin/env node
/**
 * The sandbox driver of the live-probe lane, with the oracle stage (corpus/LIVE-PROBE.md, "Oracles"):
 *
 *   node corpus/live-probe-driver.mjs --msc <mcp-surface-corpus checkout> --oracles <clients.json | none> -- <run-shard args>
 *
 * Runs mcp-surface-corpus's own driver (bin/run-shard.mjs, at the checkout the sandbox guard ran from) unchanged,
 * with one addition through its probe option: after the driver's stdio probe of a target (the subjects s001...,
 * the controls s901 and s902), corpus/oracles/run.mjs runs the oracle stage on that same `docker run` command, and
 * writes <out>/<target>/oracles.json. Per target it runs at most once in full (the SDK clients and the conformance
 * suite), on the first probe that got a tool list, and at most once with the clients only (oracles-unlisted.json), on
 * the first probe that got none. It never
 * throws into the driver, and its time is bounded: at most ORACLE_BUDGET_MS, and never past the target's own time
 * limit minus RESERVE_MS (kept for the driver's second probe and its analysis).
 *
 * Streamable HTTP targets are probed inside the sandbox by a helper container, not through this option: the oracle
 * stage does not run for them (oracles.json is then absent, and the bundle says so).
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOracles, writeOracles } from './oracles/run.mjs';

export const ORACLE_BUDGET_MS = 150_000;
export const RESERVE_MS = 75_000;
export const MIN_BUDGET_MS = 20_000;
const TARGET_RE = /^s[0-9]{3}$/;
/** The driver's server container name: surface-<run>-<target>-s<n> (mcp-surface-corpus src/docker.mjs name()). */
const SERVER_NAME_RE = /^surface-[0-9a-f]{12}-(s[0-9]{3})-s[0-9]+$/;

export function parse(argv) {
  const o = { msc: null, oracles: 'none', rest: [] };
  const i = argv.indexOf('--');
  const head = i < 0 ? argv : argv.slice(0, i);
  o.rest = i < 0 ? [] : argv.slice(i + 1);
  for (let k = 0; k < head.length; k += 2) {
    if (head[k] === '--msc') o.msc = head[k + 1];
    else if (head[k] === '--oracles') o.oracles = head[k + 1];
    else throw new Error(`unknown option ${head[k]}`);
  }
  if (!o.msc || !o.oracles || !o.rest.length) throw new Error('usage: live-probe-driver.mjs --msc DIR --oracles FILE|none -- <run-shard args>');
  return o;
}

/** The target id of a probe command, from its container name, or null (the baseline, a helper). */
export function targetOf(command) {
  const i = Array.isArray(command) ? command.indexOf('--name') : -1;
  const m = i >= 0 ? SERVER_NAME_RE.exec(String(command[i + 1])) : null;
  return m ? m[1] : null;
}

/** The value of one run-shard option. */
const optionOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

/**
 * The probe option: the driver's own probe, then the oracle stage, at most once in full and once with the clients
 * only per target. `starts` holds when each target started (the driver asks for its labels first thing), `limits`
 * each target's time limit in seconds.
 */
export function oracleProbe({ probe, listed, out, install, pins, starts, limits, run = runOracles, write = writeOracles, remove = removeQuietly, takeTrace, now = () => Date.now(), log = () => {} }) {
  const full = new Set(); const unlisted = new Set();
  return async (command, opts) => {
    const p = await probe(command, opts);
    const id = targetOf(command);
    if (!install || !id || full.has(id)) return p;
    const got = listed(p);
    if (!got && unlisted.has(id)) return p;
    (got ? full : unlisted).add(id);
    const file = join(out, id, got ? 'oracles.json' : 'oracles-unlisted.json');
    try {
      const start = starts.get(id) ?? now();
      const limit = (limits.get(id) ?? 0) * 1000;
      const budget = Math.min(ORACLE_BUDGET_MS, start + limit - RESERVE_MS - now());
      mkdirSync(join(out, id), { recursive: true });
      if (budget < MIN_BUDGET_MS) { write(file, { format: 'isokron-live-probe-oracles/1', mode: 'skipped', why: 'time_budget', budget_ms: Math.max(0, Math.floor(budget)), probe_listed: got }); return p; }
      await remove(command, opts);
      const work = join(out, '_shard', 'oracle-work', id);
      // With no list from our probe, the clients only (each with a shorter limit): they show whether another client
      // gets a list where our probe did not.
      const rec = await run({ command, dockerEnv: opts && opts.env, install, pins: got ? pins : { ...pins, client_timeout_ms: Math.min(pins.client_timeout_ms, 15_000) }, budgetMs: budget, mode: got ? 'full' : 'clients_only', work, takeTrace });
      rec.probe_listed = got;
      write(file, rec);
      rmSync(work, { recursive: true, force: true });
    } catch (e) {
      log(`${id}: oracle stage error: ${String(e && e.message).slice(0, 300)}`);
      try { write(file, { format: 'isokron-live-probe-oracles/1', mode: 'error', error: String(e && e.message).slice(0, 300), probe_listed: got }); } catch { /* nothing more to do */ }
    }
    return p;
  };
}

/** The probe's container is gone before the first oracle session takes its address. */
export async function removeQuietly(command, opts) {
  const i = command.indexOf('--name');
  if (i < 0) return;
  const { spawnSync } = await import('node:child_process');
  spawnSync('docker', ['rm', '-f', '-v', command[i + 1]], { env: (opts && opts.env) || process.env, stdio: 'ignore', timeout: 30_000 });
}

export async function main(argv = process.argv.slice(2)) {
  const o = parse(argv);
  const msc = resolve(o.msc);
  const load = (p) => import(pathToFileURL(join(msc, p)).href);
  const [{ main: runShard }, { probeStdio, listed }, { Docker }, { takeTrace }, { loadRunscConfig }] = await Promise.all([
    load('bin/run-shard.mjs'), load('sandbox/probe.mjs'), load('src/docker.mjs'), load('src/sandbox-run.mjs'), load('src/runsc.mjs'),
  ]);
  const out = resolve(optionOf(o.rest, '--out'));
  const targetsFile = optionOf(o.rest, '--targets');
  const limits = new Map();
  try {
    const list = JSON.parse(readFileSync(targetsFile, 'utf8'));
    const dflt = list.defaults && Number.isFinite(list.defaults.timeout_s) ? list.defaults.timeout_s : 300;
    for (const t of list.targets || []) if (TARGET_RE.test(t.id)) limits.set(t.id, Number.isFinite(t.timeout_s) ? t.timeout_s : dflt);
  } catch { /* the driver itself refuses a bad list */ }
  let install = null;
  if (o.oracles !== 'none' && existsSync(o.oracles)) { try { install = JSON.parse(readFileSync(o.oracles, 'utf8')); } catch { install = null; } }
  const pins = JSON.parse(readFileSync(new URL('./oracles/pins.json', import.meta.url), 'utf8'));
  const starts = new Map();
  class TimedDocker extends Docker {
    labels(target = null) {
      if (target && !starts.has(target)) starts.set(target, Date.now());
      return super.labels(target);
    }
  }
  const cfg = loadRunscConfig();
  mkdirSync(join(out, '_shard'), { recursive: true });
  const probe = oracleProbe({ probe: probeStdio, listed, out, install, pins, starts, limits, takeTrace: (cid) => takeTrace(cfg, cid, { waitMs: 3000 }) });
  return runShard(o.rest, { makeDocker: (x) => new TimedDocker(x), probe, runscConfig: cfg });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`${e && e.stack}\n`); process.stdout.write('run finished, exit 125\n'); process.exit(1); });
}
