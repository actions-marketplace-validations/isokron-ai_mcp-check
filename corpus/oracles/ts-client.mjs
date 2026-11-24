#!/usr/bin/env node
/**
 * An independent oracle client for the live-probe lane (corpus/LIVE-PROBE.md, "Oracles"): the official TypeScript SDK,
 * pinned in corpus/oracles/package-lock.json, as a client would use it. It starts the server command (in the lane, a
 * `docker run -i` of the target's sandbox container: the server never runs here), connects, lists every page of
 * tools/list, and prints one JSON line. No tool is ever called.
 *
 *   node ts-client.mjs <v1|v2> <time limit ms> -- <command...>
 *
 * v1 is @modelcontextprotocol/sdk (the 1.x line), v2 is @modelcontextprotocol/client (the 2.x line). Each is used the
 * way its own documentation shows; the negotiated protocol comes from the initialize answer read off the transport.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'isokron-oracle-client/1';
export const MAX_PAGES = 100;

const CLIENT_INFO = { name: 'isokron-oracle', version: '1' };

/** Wraps a transport so the messages the SDK receives can be seen (for the negotiated version), unchanged. */
export function tap(inner, seen) {
  const t = {
    start: () => inner.start(),
    send: (m, o) => inner.send(m, o),
    close: () => inner.close(),
    get sessionId() { return inner.sessionId; },
    set onclose(f) { inner.onclose = f; },
    get onclose() { return inner.onclose; },
    set onerror(f) { inner.onerror = f; },
    get onerror() { return inner.onerror; },
    set onmessage(f) {
      inner.onmessage = (m, extra) => {
        if (m && typeof m === 'object' && m.result && typeof m.result === 'object' && typeof m.result.protocolVersion === 'string' && seen.protocol === null) seen.protocol = m.result.protocolVersion.slice(0, 40);
        return f(m, extra);
      };
    },
    get onmessage() { return inner.onmessage; },
  };
  if (typeof inner.setProtocolVersion === 'function') t.setProtocolVersion = (v) => inner.setProtocolVersion(v);
  return t;
}

/** A package's version, from the node_modules next to this file (the install folder). */
function versionOf(name) {
  const dir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
}

async function load(line) {
  if (line === 'v1') {
    const pkg = { version: versionOf('@modelcontextprotocol/sdk') };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client, StdioClientTransport, sdk: '@modelcontextprotocol/sdk', version: pkg.version };
  }
  if (line === 'v2') {
    const pkg = { version: versionOf('@modelcontextprotocol/client') };
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    return { Client, StdioClientTransport, sdk: '@modelcontextprotocol/client', version: pkg.version };
  }
  throw new Error('the SDK line must be v1 or v2');
}

const errText = (e) => String((e && (e.message || e)) || 'error').slice(0, 500);

export async function runClient(line, ms, command, { env = process.env } = {}) {
  const out = { format: FORMAT, client: `typescript-${line}`, sdk: null, sdk_version: null, outcome: null, stage: null, error: null, protocol: null, server_info: null, pages: 0, tools: null, ms: null };
  const t0 = Date.now();
  let client = null;
  const seen = { protocol: null };
  const timer = setTimeout(() => { out.outcome ??= 'timeout'; out.error ??= `time limit (${ms} ms)`; try { client && client.close(); } catch { /* closing */ } finish(); }, ms);
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    out.ms = Date.now() - t0;
    process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
  }
  try {
    const m = await load(line);
    out.sdk = m.sdk; out.sdk_version = m.version;
    const transport = new m.StdioClientTransport({ command: command[0], args: command.slice(1), env, stderr: 'ignore' });
    client = new m.Client(CLIENT_INFO, { capabilities: {} });
    out.stage = 'connect';
    await client.connect(tap(transport, seen));
    out.protocol = (typeof client.getNegotiatedProtocolVersion === 'function' && client.getNegotiatedProtocolVersion()) || seen.protocol;
    const info = client.getServerVersion && client.getServerVersion();
    out.server_info = info && typeof info === 'object' ? { name: typeof info.name === 'string' ? info.name.slice(0, 200) : null, version: typeof info.version === 'string' ? info.version.slice(0, 64) : null } : null;
    out.stage = 'list';
    const tools = [];
    let cursor;
    for (;;) {
      const r = await client.listTools(cursor === undefined ? undefined : { cursor });
      out.pages++;
      if (!r || !Array.isArray(r.tools)) throw new Error('the tools/list result has no tools array');
      tools.push(...r.tools);
      if (r.nextCursor === undefined || r.nextCursor === null) break;
      if (out.pages >= MAX_PAGES) throw new Error(`paging stopped after ${MAX_PAGES} pages`);
      if (r.nextCursor === cursor) throw new Error('the server repeated the same cursor');
      cursor = r.nextCursor;
    }
    out.tools = tools;
    out.outcome = 'listed';
  } catch (e) {
    out.outcome ??= out.stage === 'list' ? 'list_failed' : out.stage === 'connect' ? 'init_failed' : 'client_error';
    out.error ??= errText(e);
  }
  try { await client?.close(); } catch { /* closing */ }
  finish();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [line, ms, sep, ...command] = process.argv.slice(2);
  if (!['v1', 'v2'].includes(line) || !(Number(ms) > 0) || sep !== '--' || !command.length) {
    process.stderr.write('usage: ts-client.mjs <v1|v2> <ms> -- <command...>\n');
    process.exit(2);
  }
  runClient(line, Number(ms), command);
}
