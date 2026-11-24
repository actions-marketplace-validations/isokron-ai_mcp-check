/**
 * The stdio-to-HTTP bridge of the live-probe lane's conformance oracle (corpus/LIVE-PROBE.md, "Oracles").
 *
 * The official conformance suite tests a server over Streamable HTTP only. A stdio server is reached through this
 * bridge: a plain HTTP server on 127.0.0.1 (an ephemeral port, never a fixed one) that turns each POSTed JSON-RPC
 * message into one line on the server's stdin and returns the server's own answer line, byte for byte, as the
 * response body (application/json). Nothing is re-encoded, so the suite's wire-schema checks see the server's bytes.
 *
 * Sessions. `initialize` without an Mcp-Session-Id starts a fresh server process (`spawnSession`) and a session id
 * of the bridge's own; any session still open is closed first, so at most one server process is alive at a time
 * (in the lane each one is a sandbox container at the same fixed address). A request with no session id and another
 * method (the stateless 2026-07-28 wire) goes to one shared process, started on first use. DELETE ends a session;
 * GET is 405 (no server-to-client stream).
 *
 * What a bridge cannot carry is excluded from the results, never scored against the server (the design's bridge
 * discipline): transport checks, and the session id, which is the bridge's. Server-to-client requests that arrive
 * while a POST waits are answered here as our own probe answers them (ping, an empty roots/list, else method not
 * found) and counted; notifications are counted and dropped. Every line in either direction is kept in a bounded
 * transcript (`transcript`), with the session it belongs to.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const BRIDGE_NAME = 'isokron-stdio-http-bridge';
export const BRIDGE_VERSION = '1';
export const BODY_CAP = 4 * 1024 * 1024;
export const LINE_CAP = 24 * 1024 * 1024;
export const TRANSCRIPT_CAP = 16 * 1024 * 1024;
export const TRANSCRIPT_LINE_CAP = 1024 * 1024;

const json = (o) => JSON.stringify(o);
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const idKey = (id) => (typeof id === 'string' ? `s:${id}` : typeof id === 'number' ? `n:${id}` : null);

/**
 * @param {object} o
 * @param {() => Promise<{ stdin, stdout, on, kill, dispose?: () => Promise<void> }>} o.spawnSession  a fresh server
 *   process: a ChildProcess-like object (stdin, stdout, 'close' event); `dispose` stops it for good.
 * @param {number} [o.requestTimeoutMs]  how long a POSTed request waits for its answer
 * @param {number} [o.startTimeoutMs]    how long spawnSession may take
 */
export function createBridge({ spawnSession, requestTimeoutMs = 15_000, startTimeoutMs = 30_000, now = () => Date.now() }) {
  const t0 = now();
  const sessions = new Map(); // sid ('' for the stateless one) -> session
  const transcript = [];
  let transcriptBytes = 0;
  const stats = { http_requests: 0, sessions: 0, superseded: 0, exited_early: 0, timeouts: 0, server_requests_answered: 0, notifications_dropped: 0, non_json_lines: 0, reencoded_bodies: 0, refused: 0, duplicate_ids: 0, transcript_truncated: false };

  function keep(sid, dir, raw) {
    const s = String(raw);
    const bytes = Buffer.byteLength(s);
    if (transcriptBytes + Math.min(bytes, TRANSCRIPT_LINE_CAP) > TRANSCRIPT_CAP) { stats.transcript_truncated = true; return; }
    const cut = bytes > TRANSCRIPT_LINE_CAP;
    transcript.push({ t: now() - t0, session: sid || 'stateless', dir, bytes, raw: cut ? s.slice(0, TRANSCRIPT_LINE_CAP) : s, ...(cut ? { cut: true } : {}) });
    transcriptBytes += Math.min(bytes, TRANSCRIPT_LINE_CAP);
  }

  async function start(sid) {
    stats.sessions++;
    let timer;
    const proc = await Promise.race([
      spawnSession(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('the server process did not start in time')), startTimeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    const s = { sid, proc, pending: new Map(), buf: Buffer.alloc(0), read: 0, exited: null, closing: false };
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (c) => {
      s.read += c.length;
      if (s.read > LINE_CAP) { fail(s, 'the server wrote more than the bridge reads'); return; }
      s.buf = Buffer.concat([s.buf, c]);
      let i;
      while ((i = s.buf.indexOf(10)) >= 0) {
        const line = s.buf.subarray(0, i).toString('utf8').replace(/\r$/, '');
        s.buf = s.buf.subarray(i + 1);
        if (line.trim()) onLine(s, line);
      }
    });
    proc.on('close', (code, signal) => {
      s.exited = { code, signal };
      if (!s.closing) stats.exited_early++;
      fail(s, `the server exited (exit ${code}, signal ${signal})`);
    });
    sessions.set(sid, s);
    return s;
  }

  function fail(s, why) {
    for (const [k, w] of s.pending) { s.pending.delete(k); w({ status: 502, body: rpcError(w.id, -32603, `bridge: ${why}`) }); }
  }

  function onLine(s, line) {
    keep(s.sid, 's2c', line);
    let m;
    try { m = JSON.parse(line); } catch { stats.non_json_lines++; return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { stats.non_json_lines++; return; }
    if (typeof m.method === 'string') {
      if (m.id === undefined) { stats.notifications_dropped++; return; }
      // A request from the server while a POST waits: answered here, as the lane's probe answers it.
      stats.server_requests_answered++;
      const reply = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} }
        : m.method === 'roots/list' ? { jsonrpc: '2.0', id: m.id, result: { roots: [] } }
          : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
      write(s, json(reply), 'bridge');
      return;
    }
    const k = idKey(m.id);
    const w = k && s.pending.get(k);
    if (!w) return;
    s.pending.delete(k);
    w({ status: 200, body: line });
  }

  function write(s, line, dir = 'c2s') {
    keep(s.sid, dir, line);
    try { s.proc.stdin.write(`${line}\n`); } catch { /* closed: the close handler answers */ }
  }

  async function dispose(s) {
    if (!s) return;
    s.closing = true;
    sessions.delete(s.sid);
    fail(s, 'the session ended');
    try { s.proc.stdin.end(); } catch { /* closed */ }
    if (typeof s.proc.dispose === 'function') await s.proc.dispose();
    else if (!s.exited) { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } }
  }

  async function closeAll() {
    for (const s of [...sessions.values()]) await dispose(s);
  }

  // Starting and ending sessions take turns: two initialize requests at once still leave one server process alive.
  let turn = Promise.resolve();
  const exclusive = (fn) => { const r = turn.then(fn, fn); turn = r.then(() => {}, () => {}); return r; };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body ?? '');
  }

  async function onPost(req, res, text) {
    let m;
    try { m = JSON.parse(text); } catch { stats.refused++; return send(res, 400, rpcError(null, -32700, 'bridge: the body is not JSON')); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { stats.refused++; return send(res, 400, rpcError(null, -32600, 'bridge: one JSON-RPC message per request')); }
    // One line on stdin: the body as sent, unless it holds a line break (then the parsed message, re-encoded).
    let line = text;
    if (/[\r\n]/.test(text)) { line = json(m); stats.reencoded_bodies++; }
    const hdr = req.headers['mcp-session-id'];
    let s; let newSid = null;
    if (typeof hdr === 'string' && hdr) {
      s = sessions.get(hdr);
      if (!s) { stats.refused++; return send(res, 404, rpcError(m.id, -32001, 'bridge: no such session')); }
    } else if (m.method === 'initialize') {
      newSid = randomBytes(16).toString('hex');
      try {
        s = await exclusive(async () => { if (sessions.size) { stats.superseded += sessions.size; await closeAll(); } return start(newSid); });
      } catch (e) { return send(res, 502, rpcError(m.id, -32603, `bridge: ${String(e.message).slice(0, 200)}`)); }
    } else {
      try {
        s = await exclusive(async () => {
          const have = sessions.get('');
          if (have) return have;
          if (sessions.size) { stats.superseded += sessions.size; await closeAll(); }
          return start('');
        });
      } catch (e) { return send(res, 502, rpcError(m.id, -32603, `bridge: ${String(e.message).slice(0, 200)}`)); }
    }
    const sidHeader = newSid ? { 'mcp-session-id': newSid } : {};
    const isRequest = typeof m.method === 'string' && m.id !== undefined && m.id !== null;
    if (!isRequest) { write(s, line); return send(res, 202, '', sidHeader); }
    const k = idKey(m.id);
    if (!k) { stats.refused++; return send(res, 400, rpcError(null, -32600, 'bridge: the request id is not a string or a number')); }
    if (s.pending.has(k)) { stats.duplicate_ids++; return send(res, 409, rpcError(m.id, -32600, 'bridge: a request with this id is still waiting')); }
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => { if (s.pending.get(k) === w) { s.pending.delete(k); stats.timeouts++; resolve({ status: 504, body: rpcError(m.id, -32603, `bridge: no answer in ${requestTimeoutMs} ms`) }); } }, requestTimeoutMs);
      const w = (x) => { clearTimeout(timer); resolve(x); };
      w.id = m.id;
      s.pending.set(k, w);
      if (s.exited) { s.pending.delete(k); clearTimeout(timer); resolve({ status: 502, body: rpcError(m.id, -32603, 'bridge: the server has exited') }); return; }
      write(s, line);
    });
    send(res, answer.status, answer.body, sidHeader);
  }

  const server = createServer((req, res) => {
    stats.http_requests++;
    if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
    if (req.method === 'DELETE') {
      const s = sessions.get(String(req.headers['mcp-session-id'] || '\u0000'));
      if (!s) { res.writeHead(404); return res.end(); }
      exclusive(() => dispose(s)).then(() => { res.writeHead(200); res.end(); }, () => { res.writeHead(200); res.end(); });
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { n += c.length; if (n > BODY_CAP) { over = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (over) return;
      onPost(req, res, Buffer.concat(chunks).toString('utf8')).catch((e) => { try { send(res, 500, rpcError(null, -32603, `bridge: ${String(e && e.message).slice(0, 200)}`)); } catch { /* sent */ } });
    });
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/mcp`));
    }),
    /** Ends every session (between scenarios), keeping the transcript and the counts. */
    reset: () => exclusive(closeAll),
    close: async () => { await exclusive(closeAll); server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); },
    transcript,
    stats,
    info: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
  };
}
