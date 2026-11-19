// mcp-client: fetch an MCP server's tool list over Streamable HTTP. Browser and Node 18+ (global fetch).
// Shared with the isokron.ai/mcp-check web checker's connect page (UMD).
// No dependencies. Sends only what a client must send to list tools: no tools/call, no resources, no prompts.
//
//   const r = await McpClient.listToolsHttp(url, { headers, timeoutMs });
//   McpCheck.parseData(r.pages)   // r.pages is an array of JSON-RPC answers, one per tools/list page
//
// Protocol eras (MCP 2026-07-28, transports/streamable-http "Backward Compatibility"):
//   modern (2026-07-28): stateless. tools/list carries protocol version, client info and capabilities in _meta,
//     with MCP-Protocol-Version and Mcp-Method headers. No initialize, no session.
//   legacy (2025-03-26 .. 2025-11-25): initialize, notifications/initialized, then tools/list, optional Mcp-Session-Id.
// The client tries modern first. On 400/404/405 whose body is not a recognised modern JSON-RPC error, and on a
// network error (in a browser a CORS preflight that rejects the Mcp-Method header looks like one), it falls back
// to legacy without the Mcp-Method header, as the spec describes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.McpClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MODERN = '2026-07-28';
  const LEGACY = '2025-11-25';
  const CLIENT_INFO = { name: 'isokron-mcp-check', version: typeof require === 'function' ? require('../../package.json').version : '1' };
  const MODERN_ERRORS = new Set([-32020, -32021, -32022]); // HeaderMismatch, MissingRequiredClientCapability, UnsupportedProtocolVersion
  const DEFAULTS = { timeoutMs: 20000, maxPages: 50, maxBytes: 8 * 1024 * 1024 };

  class McpFetchError extends Error {
    constructor(code, message, extra) { super(message); this.name = 'McpFetchError'; this.code = code; Object.assign(this, extra || {}); }
  }

  // ---- body parsing: one JSON object (or batch) or an SSE stream of JSON-RPC messages
  function parseSse(text) {
    const out = [];
    text.replace(/\r\n?/g, '\n').split('\n\n').forEach((block) => {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data.trim()) return;
      try { out.push(JSON.parse(data)); } catch (e) { /* a non-JSON event (keep-alive, endpoint) is skipped */ }
    });
    return out;
  }
  function parseMessages(text, contentType) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('text/event-stream') || /^\s*(event|data|id|:)/.test(text)) return parseSse(text);
    if (!text.trim()) return [];
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  }

  async function readText(res, maxBytes) {
    const len = Number(res.headers.get('content-length'));
    if (len && len > maxBytes) throw new McpFetchError('too_large', 'The answer is larger than ' + maxBytes + ' bytes.');
    if (!res.body || typeof res.body.getReader !== 'function') {
      const t = await res.text();
      if (t.length > maxBytes) throw new McpFetchError('too_large', 'The answer is larger than ' + maxBytes + ' bytes.');
      return t;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let n = 0; let t = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new McpFetchError('too_large', 'The answer is larger than ' + maxBytes + ' bytes.'); }
      t += dec.decode(value, { stream: true });
      // An SSE answer may stay open after the response; stop once the final JSON-RPC response has arrived.
      if (/text\/event-stream/i.test(res.headers.get('content-type') || '') && /\n\n/.test(t) && parseSse(t).some((m) => m && m.id !== undefined && (m.result || m.error))) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        break;
      }
    }
    return t + dec.decode();
  }

  // WWW-Authenticate: Bearer resource_metadata="...", scope="..."
  function parseAuthHeader(h) {
    if (!h) return null;
    const out = { scheme: (h.match(/^\s*(\w+)/) || [])[1] || null };
    h.replace(/(\w+)="([^"]*)"/g, (m, k, v) => { out[k] = v; return m; });
    return out;
  }

  async function post(url, message, o, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, extraHeaders || {}, o.headers || {});
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs) : null;
    const t0 = Date.now();
    let res;
    try {
      res = await o.fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: ctl ? ctl.signal : undefined, redirect: o.redirect || 'follow', credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new McpFetchError('timeout', 'No answer within ' + Math.round(o.timeoutMs / 1000) + ' s.');
      throw new McpFetchError('network', 'The request did not complete: ' + (e && e.message ? e.message : String(e)) + '.', { cause: e });
    }
    let text = '';
    try { text = await readText(res, o.maxBytes); } finally { if (timer) clearTimeout(timer); }
    o.transcript.push({ method: message.method, status: res.status, ms: Date.now() - t0, contentType: res.headers.get('content-type') || null });
    let messages = [];
    try { messages = parseMessages(text, res.headers.get('content-type')); } catch (e) { messages = null; }
    return { res, status: res.status, text, messages, sessionId: res.headers.get('mcp-session-id'), auth: parseAuthHeader(res.headers.get('www-authenticate')) };
  }

  function answerFor(r, id) { return (r.messages || []).find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined)) || null; }
  function isModernError(r) { return (r.messages || []).some((m) => m && m.error && MODERN_ERRORS.has(m.error.code)); }

  function httpError(r, step) {
    if (r.status === 401 || (r.status === 403 && r.auth)) {
      return new McpFetchError('auth', 'The server needs authorization (' + r.status + ' at ' + step + ').', { status: r.status, auth: r.auth, resourceMetadata: r.auth && r.auth.resource_metadata ? r.auth.resource_metadata : null });
    }
    if (r.status === 403) return new McpFetchError('forbidden', 'The server refused the request (403 at ' + step + '). It may not accept requests from this origin or client.', { status: 403 });
    if (r.status === 404) return new McpFetchError('not_found', 'No MCP endpoint at this URL (404 at ' + step + ').', { status: 404 });
    const rpc = (r.messages || []).find((m) => m && m.error);
    return new McpFetchError('http', 'HTTP ' + r.status + ' at ' + step + (rpc ? ': ' + rpc.error.message : '') + '.', { status: r.status, rpcError: rpc ? rpc.error : null });
  }

  function rpcError(ans, step) {
    return new McpFetchError('rpc_error', step + ' failed: ' + (ans.error.message || 'error ' + ans.error.code) + '.', { rpcError: ans.error });
  }

  function checkUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { throw new McpFetchError('bad_url', 'Not a valid URL.'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new McpFetchError('bad_url', 'Only http and https URLs are supported.');
    if (u.username || u.password) throw new McpFetchError('bad_url', 'Put credentials in a header, not in the URL.');
    return u.href;
  }

  // ---- modern era: stateless tools/list with _meta
  async function modernPages(url, o, version) {
    const pages = []; let cursor; let id = 1;
    for (let i = 0; i < o.maxPages; i++) {
      const params = { _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': {} } };
      if (cursor) params.cursor = cursor;
      const msg = { jsonrpc: '2.0', id: id, method: 'tools/list', params };
      const r = await post(url, msg, o, { 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/list' });
      const ans = answerFor(r, id); id++;
      if (i === 0 && !(ans && ans.result)) return { fallback: true, first: r, answer: ans };
      if (r.status >= 400 && !(ans && ans.result)) throw httpError(r, 'tools/list');
      if (!ans) throw new McpFetchError('protocol', 'tools/list got no JSON-RPC answer (HTTP ' + r.status + ').');
      if (ans.error) throw rpcError(ans, 'tools/list');
      pages.push(ans);
      cursor = ans.result && ans.result.nextCursor;
      if (!cursor) break;
    }
    return { pages };
  }

  // ---- legacy era: initialize handshake, optional session
  async function legacyPages(url, o) {
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT_INFO } };
    const r0 = await post(url, init, o);
    const a0 = answerFor(r0, 0);
    if (!(a0 && a0.result)) { if (a0 && a0.error && r0.status < 400) throw rpcError(a0, 'initialize'); throw httpError(r0, 'initialize'); }
    const version = a0.result.protocolVersion || LEGACY;
    const session = r0.sessionId;
    const h = { 'MCP-Protocol-Version': version };
    if (session) h['Mcp-Session-Id'] = session;
    try { await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, o, h); } catch (e) { if (e.code === 'timeout') throw e; }
    const pages = []; let cursor; let id = 1;
    for (let i = 0; i < o.maxPages; i++) {
      const msg = { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} };
      const r = await post(url, msg, o, h);
      const ans = answerFor(r, id); id++;
      if (!(ans && (ans.result || ans.error))) {
        const err = httpError(r, 'tools/list');
        if (!session && r.status === 400) err.message += ' The server may use a session id that a browser cannot read (Mcp-Session-Id not exposed by CORS).';
        throw err;
      }
      if (ans.error) throw rpcError(ans, 'tools/list');
      pages.push(ans);
      cursor = ans.result.nextCursor;
      if (!cursor) break;
    }
    if (session && o.closeSession !== false) {
      // Best effort: end the session. Ignored on any failure.
      try { await o.fetch(url, { method: 'DELETE', headers: Object.assign({}, h, o.headers || {}), credentials: 'omit' }); } catch (e) { /* ignore */ }
    }
    return { pages, version, serverInfo: a0.result.serverInfo || null, instructions: typeof a0.result.instructions === 'string' ? a0.result.instructions : null, session: !!session };
  }

  async function listToolsHttp(url, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    o.fetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : undefined) : null);
    if (!o.fetch) throw new McpFetchError('unsupported', 'No fetch() in this environment.');
    o.transcript = [];
    url = checkUrl(url);
    const mode = o.protocol || 'auto';
    let modernFailure = null;
    if (mode !== 'legacy') {
      try {
        const m = await modernPages(url, o, MODERN);
        if (!m.fallback) {
          const first = m.pages[0];
          const meta = (first.result && first.result._meta) || {};
          // A 2026-07-28 result carries resultType (required) and usually ttlMs/cacheScope; a legacy server in
          // stateless mode also answers tools/list without initialize, but without those fields.
          const r0 = first.result || {};
          const modern = r0.resultType !== undefined || r0.ttlMs !== undefined || r0.cacheScope !== undefined || !!meta['io.modelcontextprotocol/serverInfo'];
          return { url, era: modern ? 'modern' : 'legacy-stateless', protocolVersion: modern ? MODERN : null, serverInfo: meta['io.modelcontextprotocol/serverInfo'] || null, pages: m.pages, transcript: o.transcript };
        }
        const r = m.first;
        if (r.status === 401 || (r.status === 403 && r.auth)) throw httpError(r, 'tools/list');
        if (isModernError(r)) {
          const e = (r.messages || []).find((x) => x && x.error).error;
          const sup = e.data && Array.isArray(e.data.supported) ? e.data.supported : [];
          // A modern server that does not speak 2026-07-28 but advertises a legacy version: use the legacy handshake.
          if (!sup.some((v) => v < MODERN)) throw new McpFetchError('protocol', 'The server speaks a protocol version this checker does not: ' + (sup.join(', ') || e.message) + '.', { rpcError: e });
        }
        modernFailure = r;
        if (mode === 'modern') throw httpError(r, 'tools/list');
      } catch (e) {
        if (!(e instanceof McpFetchError) || !(e.code === 'network') || mode === 'modern') throw e;
        modernFailure = e;
      }
    }
    try {
      const l = await legacyPages(url, o);
      return { url, era: 'legacy', protocolVersion: l.version, serverInfo: l.serverInfo, instructions: l.instructions, session: l.session, pages: l.pages, transcript: o.transcript };
    } catch (e) {
      if (e instanceof McpFetchError && e.code === 'network') {
        e.message += ' In a browser this usually means the server does not allow cross-origin requests (CORS). Use the CLI: npx @isokron/mcp-check --url ' + url;
        e.likelyCors = true;
      }
      if (modernFailure && !(modernFailure instanceof Error)) e.modernStatus = modernFailure.status;
      throw e;
    }
  }

  return { listToolsHttp, parseMessages, parseSse, parseAuthHeader, McpFetchError, MODERN, LEGACY, CLIENT_INFO };
});
