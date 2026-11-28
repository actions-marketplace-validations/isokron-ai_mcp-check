/**
 * One stdio JSON-RPC session with a FIXTURE server, for the tools/call fuzz stage (corpus/fuzz/calls/README.md).
 *
 * Unlike corpus/fuzz/session.mjs (read-only methods, third-party servers in a sandbox container), this session sends
 * tools/call. That is only safe because it can only be built by fixtures.mjs from an entry of fixtures.json: our own
 * seeded servers and our own tiny-tracker builds. It takes an argv from that module and nothing else.
 *
 * Every limit is ours: a line over the cap or a server that never answers is reported as what happened (`exited`,
 * `timedOut`, `lineCap`); the judge decides what that means for which fixture.
 */
import { spawn } from 'node:child_process';

export const PROTOCOL_VERSION = '2025-11-25';
export const LINE_CAP = 4 * 1024 * 1024;
export const REQUEST_MS = 5_000;

export class FixtureSession {
  constructor(command, { env = process.env, cwd, requestMs = REQUEST_MS, lineCap = LINE_CAP } = {}) {
    this.command = command; this.env = env; this.cwd = cwd; this.requestMs = requestMs; this.lineCap = lineCap;
    this.nextId = 1; this.pending = new Map(); this.stray = []; this.exit = null; this.closed = false; this.buf = ''; this.lineCapHit = false;
  }

  start() {
    this.child = spawn(this.command[0], this.command.slice(1), { env: this.env, cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this.onData(c));
    this.child.on('error', () => this.end({ spawnError: true }));
    this.child.on('close', (code, signal) => this.end({ code, signal }));
    return this;
  }

  onData(chunk) {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buf.length > this.lineCap) { this.lineCapHit = true; this.kill(); }
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { this.stray.push({ malformed: true }); return; }
    if (m && typeof m === 'object' && m.method !== undefined) {
      // A request or notification from the server: we answer requests "method not found" so it never waits on us.
      if (m.id !== undefined) this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
      return;
    }
    const p = m && typeof m === 'object' ? this.pending.get(m.id) : undefined;
    if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve({ response: m }); } else this.stray.push({ id: m?.id ?? null });
  }

  write(obj) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(obj)}\n`); }

  /** @returns {Promise<{response?: object, timedOut?: true, exited?: {code, signal}, lineCap?: true}>} */
  request(method, params) {
    if (this.closed) return Promise.resolve({ exited: this.exit });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ timedOut: true }); }, this.requestMs);
      this.pending.set(id, { resolve, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  end(exit) {
    if (this.closed) return;
    this.closed = true; this.exit = exit;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve(this.lineCapHit ? { lineCap: true } : { exited: exit }); this.pending.delete(id); }
  }

  kill() { try { this.child?.kill('SIGKILL'); } catch { /* already gone */ } }

  async stop() { try { this.child?.stdin.end(); } catch { /* closed */ } await new Promise((r) => setTimeout(r, 50)); this.kill(); }

  /** initialize + notifications/initialized. @returns {Promise<boolean>} */
  async handshake() {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'isokron-fuzz-calls', version: '0' } });
    if (!r.response?.result) return false;
    this.notify('notifications/initialized');
    return true;
  }
}
