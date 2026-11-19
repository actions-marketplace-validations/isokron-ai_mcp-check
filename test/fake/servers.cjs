// Fake MCP servers for the input tests: modern (2026-07-28, stateless) and legacy (initialize + session, SSE).
'use strict';
const http = require('http');
const TOOLS = [
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { number: { type: 'integer', description: 'Issue number' } }, required: ['number'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'delete_issue', description: 'Delete an issue. Cannot be undone.', inputSchema: { type: 'object', properties: { number: { type: 'integer', description: 'Issue number' } }, required: ['number'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'list_issues', description: 'List open issues.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];
const page = (cursor) => (cursor === 'p2' ? { tools: TOOLS.slice(2) } : { tools: TOOLS.slice(0, 2), nextCursor: 'p2' });
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); }); }
function json(res, status, obj, headers) { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(obj === undefined ? '' : JSON.stringify(obj)); }
function sse(res, msgs, headers) { res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, headers || {})); msgs.forEach((m) => res.write('event: message\ndata: ' + JSON.stringify(m) + '\n\n')); res.end(); }

function modern(opts) {
  opts = opts || {}; const log = [];
  const srv = http.createServer(async (req, res) => {
    const m = JSON.parse(await body(req) || '{}'); log.push({ method: m.method, headers: req.headers });
    if (opts.auth && req.headers.authorization !== 'Bearer s3cret') return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
    if (req.headers['mcp-protocol-version'] !== '2026-07-28') return json(res, 400, { jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'] } } });
    if (req.headers['mcp-method'] !== m.method) return json(res, 400, { jsonrpc: '2.0', id: m.id, error: { code: -32020, message: 'Header mismatch' } });
    if (m.method !== 'tools/list') return json(res, 404, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    const meta = m.params && m.params._meta;
    if (!meta || meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') return json(res, 400, { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'missing _meta' } });
    json(res, 200, { jsonrpc: '2.0', id: m.id, result: Object.assign({ resultType: 'complete', ttlMs: 60000, cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-modern', version: '1.0.0' } } }, page(m.params.cursor)) });
  });
  return { srv, log };
}

function legacy(opts) {
  opts = opts || {}; const log = []; const sessions = new Set();
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); log.push({ method: 'DELETE' }); res.writeHead(200); return res.end(); }
    const m = JSON.parse(await body(req) || '{}'); log.push({ method: m.method, headers: req.headers });
    if (m.method === 'initialize') {
      const sid = 'sess-' + Math.random().toString(36).slice(2);
      sessions.add(sid);
      return sse(res, [{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-legacy', version: '0.9.0' }, instructions: 'Use get_issue first.' } }], opts.noSession ? {} : { 'Mcp-Session-Id': sid });
    }
    if (!opts.noSession && !sessions.has(req.headers['mcp-session-id'])) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
    if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (m.method === 'tools/list') return sse(res, [{ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing' } }, { jsonrpc: '2.0', id: m.id, result: page(m.params && m.params.cursor) }]);
    json(res, 404, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  });
  return { srv, log };
}

function listen(s) { return new Promise((r) => s.srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.srv.address().port + '/mcp'))); }
module.exports = { modern, legacy, listen, TOOLS };
if (require.main === module) { // node servers.js modern|legacy  -> prints the URL, serves until killed
  const s = (process.argv[2] === 'legacy' ? legacy : modern)();
  listen(s).then((u) => process.stdout.write(u + '\n'));
}
