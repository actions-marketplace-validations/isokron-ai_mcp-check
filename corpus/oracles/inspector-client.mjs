#!/usr/bin/env node
/**
 * The MCP Inspector as an oracle client of the live-probe lane (corpus/LIVE-PROBE.md, "Oracles", R-ORC-13): the
 * official `@modelcontextprotocol/inspector`, pinned in corpus/oracles/package-lock.json, in its documented CLI mode,
 * `mcp-inspector --cli --method tools/list -- <server command>`. It starts the server command (in the lane, a
 * `docker run -i` of the target's sandbox container: the server never runs here), lists tools/list as the Inspector
 * does (every page), and this program prints one JSON line in the format of the SDK clients. No tool is ever called.
 *
 *   node inspector-client.mjs <time limit ms> -- <command...>
 *
 * The Inspector prints the tools it listed, or an error with no stage. To tell a refused initialize from a refused
 * list, and to read the negotiated protocol, the server command runs behind this file's own pass-through
 * (`--pipe <state file> <env file> -- <command...>`): bytes go both ways unchanged, and the ids of our initialize and tools/list
 * requests are matched to the answers, which are recorded in the state file (never their contents beyond the
 * protocol version and the page count). The Inspector starts its stdio server with a default environment of its own
 * (HOME, LOGNAME, PATH, SHELL, TERM, USER), which would drop the DOCKER_* variables the lane gives this client
 * (corpus/oracles/run.mjs oracleEnv): the pass-through starts the server command with the environment this program
 * was given, written to a file of its own (mode 600) in the session folder (R-ORC-14).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FORMAT = 'isokron-oracle-client/1';
const here = dirname(fileURLToPath(import.meta.url));
const LINE_CAP = 16 * 1024 * 1024;
const OUT_CAP = 32 * 1024 * 1024;

/** The Inspector's launcher in the node_modules next to this file (the install folder), and its version. */
export function inspectorPaths(dir = here) {
  const pkg = join(dir, 'node_modules', '@modelcontextprotocol', 'inspector');
  let version = null;
  try { version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version; } catch { /* not installed */ }
  return { launcher: join(pkg, 'clients', 'launcher', 'build', 'index.js'), version };
}

/** Splits a byte stream into JSON-RPC lines for `on`, up to LINE_CAP per line; the bytes themselves are not changed. */
function lines(on) {
  let buf = '';
  let off = false;
  return (chunk) => {
    if (off) return;
    buf += chunk.toString('utf8');
    if (buf.length > LINE_CAP) { off = true; buf = ''; return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m && typeof m === 'object' && !Array.isArray(m)) on(m);
    }
  };
}

/**
 * The pass-through between the Inspector and the server: what it saw of our session. `state` is updated in place:
 * { initialized, protocol, server_info, list_pages, list_error_code }.
 */
export function watchSession(state, write = () => {}) {
  const init = new Set(); const list = new Set();
  const key = (id) => `${typeof id}:${id}`;
  return {
    request: lines((m) => {
      if (typeof m.method !== 'string' || (typeof m.id !== 'number' && typeof m.id !== 'string')) return;
      if (m.method === 'initialize') init.add(key(m.id));
      if (m.method === 'tools/list') list.add(key(m.id));
    }),
    response: lines((m) => {
      if ('method' in m) return;
      const k = key(m.id);
      if (init.has(k)) {
        init.delete(k);
        if (m.result && typeof m.result === 'object') {
          state.initialized = true;
          state.protocol = typeof m.result.protocolVersion === 'string' ? m.result.protocolVersion.slice(0, 40) : null;
          const si = m.result.serverInfo;
          state.server_info = si && typeof si === 'object' ? { name: String(si.name ?? '').slice(0, 200), version: String(si.version ?? '').slice(0, 64) } : null;
        } else state.init_error_code = Number.isInteger(m.error && m.error.code) ? m.error.code : null;
        write(state);
      } else if (list.has(k)) {
        list.delete(k);
        if (m.result && typeof m.result === 'object') state.list_pages++;
        else state.list_error_code = Number.isInteger(m.error && m.error.code) ? m.error.code : null;
        write(state);
      }
    }),
  };
}

/** The environment the server command gets (R-ORC-14): what this client was given, read back from the env file. */
export function readServerEnv(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return Object.fromEntries(Object.entries(j).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === 'string'));
  } catch { return null; }
}

/**
 * What the env file holds (R-ORC-14): the environment this client was given, less DOCKER_AUTH_CONFIG (registry
 * credentials: the server command is a `docker run` of an image already pulled, and a file in the session folder is no
 * place for them).
 */
export function serverEnvOf(env) {
  const { DOCKER_AUTH_CONFIG: _auth, ...rest } = env || {};
  return rest;
}

/** The Inspector's command line: tools/list of this file's pass-through, which starts the server command. */
export function inspectorArgs(launcher, stateFile, envFile, cmd) {
  return [launcher, '--cli', '--method', 'tools/list', '--', process.execPath, fileURLToPath(import.meta.url), '--pipe', stateFile, envFile, '--', ...cmd];
}

/** --pipe: run the server command with our stdin and stdout passed through unchanged, recording the session. */
function pipe(stateFile, envFile, cmd) {
  const state = { initialized: false, protocol: null, server_info: null, init_error_code: null, list_pages: 0, list_error_code: null };
  const save = (s) => { try { writeFileSync(stateFile, JSON.stringify(s)); } catch { /* the parent reads what is there */ } };
  save(state);
  const w = watchSession(state, save);
  // The environment this client was given (with its DOCKER_* variables), not the Inspector's default one.
  const env = readServerEnv(envFile);
  if (!env) process.exit(2);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env });
  process.stdin.on('data', (d) => { w.request(d); child.stdin.write(d); });
  process.stdin.on('end', () => child.stdin.end());
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => { w.response(d); process.stdout.write(d); });
  child.on('error', () => process.exit(127));
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  child.on('close', () => process.exit());
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
}

/** The Inspector's error text from its stderr ({"error":{"message":...}}), or the last line, cut. */
export function inspectorError(stderr) {
  const text = String(stderr || '').trim();
  for (const l of text.split('\n').reverse()) {
    try { const j = JSON.parse(l); if (j && j.error && typeof j.error.message === 'string') return j.error.message.slice(0, 500); } catch { /* not JSON */ }
  }
  return text.split('\n').pop()?.slice(0, 500) || null;
}

/**
 * The client result from the Inspector's own answer and what the pass-through saw.
 * Listed only for exit 0 with a tools array; otherwise the stage the session reached decides init_failed or
 * list_failed, and our time limit is a timeout.
 */
export function resultOf({ exit, timedOut, stdout, stderr, state, version, ms, limitMs = ms }) {
  const out = { format: FORMAT, client: 'inspector', sdk: '@modelcontextprotocol/inspector', sdk_version: version, outcome: null, stage: null, error: null, protocol: state ? state.protocol : null, server_info: state ? state.server_info : null, pages: state ? state.list_pages : 0, tools: null, tools_source: 'inspector', ms };
  out.stage = state && state.initialized ? 'list' : 'connect';
  if (timedOut) { out.outcome = 'timeout'; out.error = `time limit (${limitMs} ms)`; return out; }
  let j = null;
  if (exit === 0) { try { j = JSON.parse(String(stdout)); } catch { j = null; } }
  if (j && Array.isArray(j.tools)) { out.outcome = 'listed'; out.tools = j.tools; return out; }
  out.error = inspectorError(stderr) || (exit === 0 ? 'no tools array in the answer' : `exit ${exit}`);
  out.outcome = exit === 0 ? 'client_error' : out.stage === 'list' ? 'list_failed' : 'init_failed';
  return out;
}

async function main(argv) {
  if (argv[0] === '--pipe') { if (argv[3] !== '--' || argv.length < 5) process.exit(2); pipe(argv[1], argv[2], argv.slice(4)); return; }
  const ms = Number(argv[0]);
  if (!(Number.isInteger(ms) && ms > 0) || argv[1] !== '--' || argv.length < 3) { process.stderr.write('usage: inspector-client.mjs <ms> -- <command...>\n'); process.exit(2); }
  const t0 = Date.now();
  const { launcher, version } = inspectorPaths();
  const work = mkdtempSync(join(tmpdir(), 'oracle-inspector-'));
  const stateFile = join(work, 'session.json');
  const envFile = join(work, 'server-env.json');
  writeFileSync(envFile, JSON.stringify(serverEnvOf(process.env)), { mode: 0o600 });
  // The Inspector keeps a catalog and settings under HOME: a folder of its own, removed after.
  const env = { ...process.env, HOME: work, NO_COLOR: '1' };
  const child = spawn(process.execPath, inspectorArgs(launcher, stateFile, envFile, argv.slice(2)), { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = ''; let stderr = ''; let timedOut = false;
  child.stdout.on('data', (d) => { if (stdout.length < OUT_CAP) stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-8000); });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, ms);
  const exit = await new Promise((r) => { child.on('error', () => r(127)); child.on('close', (code) => r(code)); });
  clearTimeout(timer);
  let state = null;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = null; }
  rmSync(work, { recursive: true, force: true });
  const out = resultOf({ exit, timedOut, stdout, stderr, state, version, ms: Date.now() - t0, limitMs: ms });
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
