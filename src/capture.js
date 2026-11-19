// Starts an MCP server over stdio, lists its tools, stops it. The one stdio implementation behind
// `mcp-check capture`, `mcp-check -- <command>`, `--command`, `--config` and the Action's `command` input.
//
// Sent to the server: initialize, notifications/initialized, tools/list (every page). Nothing else: no tool
// is ever called. If the server answers initialize with an error, it is treated as a 2026-07-28 (stateless)
// server and tools/list is sent with the protocol version and client info in _meta. initialize goes first
// because some legacy SDKs end the session on an unknown request sent before it, while a modern server
// answers an unknown method with -32601 and keeps running.
//
// Hostile-server protections: stdout read up to READ_CAP, at most MAX_PAGES pages, one overall time limit,
// the whole process group stopped afterwards (SIGTERM, then SIGKILL), server requests refused, and the
// server's stderr fenced with ::stop-commands:: under GitHub Actions so it cannot issue workflow commands.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { VERSION } from './version.js';

/** The legacy protocol revision offered in initialize; the server answers with the one it speaks. */
export const PROTOCOL_OFFERED = '2025-11-25';
/** The stateless revision used when initialize is refused. */
export const PROTOCOL_MODERN = '2026-07-28';
/** Bytes of server stdout read at most. */
export const READ_CAP = 16 * 1024 * 1024;
/** tools/list pages followed at most. */
export const MAX_PAGES = 100;
const STDERR_TAIL = 4000;

export class CaptureError extends Error {
  /** code: spawn | exited | timeout | too_large | rpc_error | protocol | usage */
  constructor(message, detail, code = 'protocol') { super(message); this.detail = detail; this.code = code; }
}

/** Splits a command line into words (single and double quotes, backslash escapes); no shell expansion. */
export function splitCommand(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; any = true; continue; }
    if (/\s/.test(c)) { if (any || cur) { out.push(cur); cur = ''; any = false; } continue; }
    cur += c;
  }
  if (q) throw new CaptureError('the command has an unclosed ' + q + ' quote', null, 'usage');
  if (any || cur) out.push(cur);
  return out;
}

/**
 * capture(argv, { timeoutMs, cwd, env, extraEnv, stderr, fence }) ->
 *   { initialize, result, answers, pages, era, protocolVersion, serverInfo, instructions }
 *   argv: the server command as an argument vector, e.g. ['node', 'dist/index.js'] or ['bash', '-c', '...'].
 *   timeoutMs: one overall limit for starting the server and reading initialize and every tools/list page.
 *   env: the whole environment (default process.env); extraEnv: added on top (a config's "env").
 *   stderr: where the server's stderr is copied live (null: not copied; the last lines are kept for errors).
 *   fence: wrap that copy in ::stop-commands::<random token> ... ::<token>::. Default: on under GitHub Actions.
 *   result: the tools/list result (one page) or an array of every page's result; answers: the JSON-RPC answers.
 * Rejects with a CaptureError (with .stderr, the server's last stderr output) when the server does not start,
 * does not answer, or answers tools/list with an error.
 */
export function capture(argv, { timeoutMs = 60_000, cwd, env = process.env, extraEnv = null, stderr = process.stderr, fence = process.env.GITHUB_ACTIONS === 'true' } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    return Promise.reject(new CaptureError('capture needs the server command as a non-empty list of strings', null, 'usage'));
  }
  return new Promise((resolve, reject) => {
    const token = fence && stderr ? randomBytes(16).toString('hex') : null;
    if (token) stderr.write('::stop-commands::' + token + '\n');
    const closeFence = () => { if (token) stderr.write('\n::' + token + '::\n'); };
    let child;
    try {
      // detached: the server gets its own process group, so the whole group is stopped at the end
      // (a shell wrapper's or npx's children included). On Windows a shell is needed for npx.cmd and the like.
      child = spawn(argv[0], argv.slice(1), {
        cwd, env: extraEnv ? { ...env, ...extraEnv } : env, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true, shell: process.platform === 'win32',
      });
    } catch (e) {
      closeFence();
      reject(new CaptureError('the server did not start: ' + e.message, null, 'spawn'));
      return;
    }
    const pending = new Map();
    let nextId = 0;
    let done = false;
    let buf = Buffer.alloc(0);
    let read = 0;
    let tail = '';

    const stop = () => {
      try { child.stdin.end(); } catch { /* closed */ }
      const kill = (sig) => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch { /* gone */ }
      };
      kill('SIGTERM');
      const t = setTimeout(() => kill('SIGKILL'), 2000);
      t.unref();
    };
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stderr.removeAllListeners('data');
      closeFence();
      for (const [, p] of pending) p.reject(err || new CaptureError('stopped'));
      pending.clear();
      stop();
      if (err) { err.stderr = tail; reject(err); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new CaptureError('the server did not start and answer initialize and tools/list within the time limit of ' + Math.round(timeoutMs / 1000) + ' s', null, 'timeout')), timeoutMs);

    const send = (m) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch { /* closed */ } };
    // Resolves with the whole JSON-RPC answer (result or error); the caller decides what an error means.
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej, method });
      send({ id, method, ...(params === undefined ? {} : { params }) });
    });

    child.on('error', (e) => finish(new CaptureError('the server did not start: ' + e.message, null, 'spawn')));
    child.on('close', (code, signal) => finish(new CaptureError('the server exited before answering (exit ' + code + (signal ? ', signal ' + signal : '') + ')', null, 'exited')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (c) => {
      tail = (tail + c.toString('utf8')).slice(-STDERR_TAIL);
      if (stderr) stderr.write(c);
    });
    child.stdout.on('data', (chunk) => {
      read += chunk.length;
      if (read > READ_CAP) { finish(new CaptureError('the server wrote more than ' + READ_CAP / 1048576 + ' MiB to stdout', null, 'too_large')); return; }
      buf = Buffer.concat([buf, chunk]);
      let nl;
      while ((nl = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // a log line on stdout: skipped
        if (!msg || typeof msg !== 'object') continue;
        if (msg.method && msg.id !== undefined) {
          // A request from the server: answer ping, refuse anything else (sampling, elicitation, roots).
          if (msg.method === 'ping') send({ id: msg.id, result: {} });
          else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });

    const errText = (e) => (e && typeof e.message === 'string' ? e.message : JSON.stringify(e));
    (async () => {
      const init = await request('initialize', {
        protocolVersion: PROTOCOL_OFFERED,
        capabilities: {},
        clientInfo: { name: 'isokron-mcp-check', version: VERSION },
      });
      let era = 'legacy', protocolVersion = PROTOCOL_OFFERED, serverInfo = null, instructions = null, initialize = null;
      if (init.result && typeof init.result === 'object') {
        initialize = init.result;
        protocolVersion = typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion : PROTOCOL_OFFERED;
        serverInfo = init.result.serverInfo && typeof init.result.serverInfo === 'object' ? init.result.serverInfo : null;
        instructions = typeof init.result.instructions === 'string' ? init.result.instructions : null;
        send({ method: 'notifications/initialized' });
      } else {
        era = 'modern';
        protocolVersion = PROTOCOL_MODERN;
      }
      const answers = [];
      let cursor;
      for (let i = 0; i < MAX_PAGES; i++) {
        const params = {};
        if (cursor !== undefined) params.cursor = cursor;
        if (era === 'modern') params._meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'isokron-mcp-check', version: VERSION }, 'io.modelcontextprotocol/clientCapabilities': {} };
        const ans = await request('tools/list', era === 'legacy' && cursor === undefined ? undefined : params);
        if (ans.error) {
          if (era === 'modern' && i === 0) throw new CaptureError('initialize failed (' + errText(init.error) + ') and tools/list failed (' + errText(ans.error) + ')', ans.error, 'rpc_error');
          throw new CaptureError('tools/list failed: ' + errText(ans.error), ans.error, 'rpc_error');
        }
        const page = ans.result;
        if (!page || typeof page !== 'object' || !Array.isArray(page.tools)) throw new CaptureError('tools/list did not return a result with a tools array', null, 'protocol');
        answers.push(ans);
        if (era === 'modern' && !serverInfo && page._meta && typeof page._meta === 'object') serverInfo = page._meta['io.modelcontextprotocol/serverInfo'] || null;
        cursor = page.nextCursor;
        if (typeof cursor !== 'string' || cursor === '') break;
        if (i === MAX_PAGES - 1) throw new CaptureError('tools/list returned more than ' + MAX_PAGES + ' pages', null, 'too_large');
      }
      const results = answers.map((a) => a.result);
      finish(null, { initialize, result: results.length === 1 ? results[0] : results, answers, pages: results.length, era, protocolVersion, serverInfo, instructions });
    })().catch((e) => finish(e instanceof CaptureError ? e : new CaptureError(String(e && e.message || e))));
  });
}
