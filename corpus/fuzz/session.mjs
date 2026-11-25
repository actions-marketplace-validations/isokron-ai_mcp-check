/**
 * One stdio JSON-RPC session with a server, for the fuzz stage (corpus/FUZZ.md). The server is a sandbox container
 * (`docker run -i`, the driver's own arguments); nothing of it runs on the runner.
 *
 * Read-only by construction: `request` refuses every method that is not in READ_ONLY_METHODS, so no `tools/call`,
 * `prompts/get` or `resources/read` can leave this file, whatever a caller asks for (R-FZ-10). A server that asks us
 * something (ping, roots/list, sampling) gets "method not found" back; a notification is only counted.
 *
 * Every limit is ours, and a session that hit one says so (`limit`): the judge never blames a server for it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const READ_ONLY_METHODS = Object.freeze(['initialize', 'ping', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
export const PROTOCOL_VERSION = '2025-11-25';
export const LINE_CAP = 4 * 1024 * 1024;
export const BYTES_CAP = 24 * 1024 * 1024;
export const REQUEST_MS = 10_000;
/** Pages and items one traversal reads at most (a server that never ends is our limit, never its fault). */
export const PAGE_CAP = 50;
export const ITEM_CAP = 5000;
export const LOG_CAP = 4 * 1024 * 1024;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Canonical JSON (sorted keys): the hash of an item does not depend on the server's key order. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class Session {
  /**
   * @param {string[]} command  argv of the server (a `docker run -i` in the lane, a node script in tests)
   * @param {object} [o]  env, lineCap, bytesCap, requestMs
   */
  constructor(command, { env = process.env, lineCap = LINE_CAP, bytesCap = BYTES_CAP, requestMs = REQUEST_MS } = {}) {
    this.command = command; this.env = env; this.lineCap = lineCap; this.bytesCap = bytesCap; this.requestMs = requestMs;
    this.nextId = 1; this.pending = new Map(); this.notifications = {}; this.noise = 0; this.invalidUtf8 = 0;
    this.closed = false; this.exit = null; this.limit = null; this.bytes = 0; this.buf = Buffer.alloc(0);
    this.requests = 0; this.timeouts = 0; this.serverRequests = 0;
    // What was asked and answered, kept for reproducers (corpus/FUZZ.md): in memory only, capped, never serialised.
    Object.defineProperty(this, 'log', { value: [], enumerable: false });
    this.logBytes = 0; this.phase = null; this.primitive = null;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  start() {
    this.child = spawn(this.command[0], this.command.slice(1), { env: this.env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', (c) => this.onData(c));
    this.child.on('error', () => this.end('spawn_error'));
    this.child.on('close', (code, signal) => { this.exit = { code, signal }; this.end('closed'); });
    return this;
  }

  end(why) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p({ ok: false, limit: this.limit || (why === 'spawn_error' ? 'spawn_error' : 'closed') });
    this.pending.clear();
  }

  onData(chunk) {
    if (this.limit) return;
    this.bytes += chunk.length;
    if (this.bytes > this.bytesCap) { this.stop('byte_cap'); return; }
    this.buf = Buffer.concat([this.buf, chunk]);
    let nl;
    while ((nl = this.buf.indexOf(10)) >= 0) {
      const line = this.buf.subarray(0, nl); this.buf = this.buf.subarray(nl + 1);
      if (line.length > this.lineCap) { this.stop('line_cap'); return; }
      this.onLine(line);
    }
    if (this.buf.length > this.lineCap) this.stop('line_cap');
  }

  stop(limit) {
    this.limit = this.limit || limit;
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    this.end(limit);
  }

  onLine(line) {
    if (!line.length) return;
    let text;
    try { text = this.decoder.decode(line); } catch { this.invalidUtf8++; text = Buffer.from(line).toString('utf8'); }
    let m;
    try { m = JSON.parse(text); } catch { this.noise++; return; }
    if (!isObj(m)) { this.noise++; return; }
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) {
        this.serverRequests++;
        this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      } else this.notifications[m.method] = (this.notifications[m.method] || 0) + 1;
      return;
    }
    const resolve = this.pending.get(m.id);
    if (!resolve) return;
    this.pending.delete(m.id);
    if (isObj(m.error)) resolve({ ok: false, error: { code: Number.isSafeInteger(m.error.code) ? m.error.code : null, message: typeof m.error.message === 'string' ? m.error.message.slice(0, 200) : null } });
    else if (isObj(m.result)) resolve({ ok: true, result: m.result });
    else resolve({ ok: false, error: { code: null, message: 'no result object' }, malformed: true });
  }

  record(method, params, r) {
    if (!r || r.limit || this.logBytes > LOG_CAP) return;
    const entry = { method, params, phase: this.phase, primitive: this.primitive, ...(r.ok ? { result: r.result } : { error: r.error }) };
    this.logBytes += JSON.stringify(entry).length;
    this.log.push(entry);
  }

  write(obj) { try { this.child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* closed */ } }

  /** One request. { ok: true, result } | { ok: false, error } | { ok: false, limit: 'timeout'|'closed'|... }. */
  request(method, params = {}, ms = this.requestMs) {
    if (!READ_ONLY_METHODS.includes(method)) throw new Error('not a read-only method: ' + String(method).slice(0, 40));
    if (this.closed) return Promise.resolve({ ok: false, limit: this.limit || 'closed' });
    const id = this.nextId++;
    this.requests++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.timeouts++; resolve({ ok: false, limit: 'timeout' }); }, ms);
      timer.unref();
      this.pending.set(id, (r) => { clearTimeout(timer); this.record(method, params, r); resolve(r); });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** initialize and notifications/initialized. */
  async initialize(ms = this.requestMs) {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'isokron-fuzz', version: '1' } }, ms);
    if (r.ok) this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }

  count(method) { return this.notifications[method] || 0; }

  close() {
    return new Promise((resolve) => {
      if (this.closed || !this.child) { resolve(); return; }
      this.child.once('close', () => resolve());
      try { this.child.stdin.end(); } catch { /* closed */ }
      setTimeout(() => { try { this.child.kill('SIGTERM'); } catch { /* gone */ } }, 500).unref();
      setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000).unref();
    });
  }
}

/** What each list method answers with, and which capability declares it. */
export const PRIMITIVES = Object.freeze({
  tools: { method: 'tools/list', key: 'tools', capability: 'tools' },
  prompts: { method: 'prompts/list', key: 'prompts', capability: 'prompts' },
  resources: { method: 'resources/list', key: 'resources', capability: 'resources' },
  templates: { method: 'resources/templates/list', key: 'resourceTemplates', capability: 'resources' },
});

/** An item as the stage keeps it: its identifiers and a hash of the whole definition (names stay in raw/ only). */
export function summarise(item) {
  if (!isObj(item)) return { name: null, uri: null, h: sha256(canonical(item)) };
  return { name: typeof item.name === 'string' ? item.name : null, uri: typeof item.uri === 'string' ? item.uri : typeof item.uriTemplate === 'string' ? item.uriTemplate : null, h: sha256(canonical(item)) };
}

/** One list request, as a page record. */
export async function page(session, primitive, cursor = null) {
  const P = PRIMITIVES[primitive];
  const before = session.count('notifications/' + primitive.replace('templates', 'resources') + '/list_changed');
  const r = await session.request(P.method, cursor === null ? {} : { cursor });
  const out = { cursor_in: cursor, ok: r.ok === true, error: r.error || null, limit: r.limit || null, items: null, next: null, malformed: false, notified: session.count('notifications/' + primitive.replace('templates', 'resources') + '/list_changed') - before };
  if (r.ok) {
    const list = r.result[P.key];
    if (!Array.isArray(list)) { out.ok = false; out.malformed = true; out.error = { code: null, message: `no ${P.key} array` }; return out; }
    out.items = list.map(summarise);
    if (r.result.nextCursor !== undefined && r.result.nextCursor !== null) {
      if (typeof r.result.nextCursor === 'string') out.next = r.result.nextCursor; else { out.malformed = true; out.error = { code: null, message: 'nextCursor is not a string' }; }
    }
  }
  return out;
}

/**
 * Every page of one list, following nextCursor. stop: 'end' (no more cursor), 'error' (a JSON-RPC error or a
 * malformed page), 'timeout', 'closed' or another limit of ours, 'page_cap', 'item_cap', 'cursor_repeat' (the server
 * handed back a cursor it had already given: the existing probe records that as a list failure).
 */
export async function traverse(session, primitive, { startCursor = null } = {}) {
  const t0 = Date.now();
  const t = { primitive, pages: [], stop: null, ms: null, notified: 0 };
  const seen = new Set(); let cursor = startCursor; let items = 0;
  for (;;) {
    if (t.pages.length >= PAGE_CAP) { t.stop = 'page_cap'; break; }
    const p = await page(session, primitive, cursor);
    t.pages.push(p); t.notified += p.notified;
    if (!p.ok) { t.stop = p.limit || 'error'; break; }
    items += p.items.length;
    if (items > ITEM_CAP) { t.stop = 'item_cap'; break; }
    if (p.next === null) { t.stop = p.malformed ? 'error' : 'end'; break; }
    if (seen.has(p.next)) { t.stop = 'cursor_repeat'; break; }
    seen.add(p.next); cursor = p.next;
  }
  t.ms = Date.now() - t0;
  return t;
}
