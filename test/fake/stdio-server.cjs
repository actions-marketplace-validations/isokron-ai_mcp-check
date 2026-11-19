// Fake stdio MCP server. argv[2]: legacy | modern. Writes a log line to stdout on start (servers do this) and
// to stderr, to check the client skips non-JSON lines.
'use strict';
const { TOOLS } = require('./servers.cjs');
const mode = process.argv[2] || 'legacy';
process.stdout.write('starting fake server\n'); process.stderr.write('fake ' + mode + ' ready\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line); const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    if (m.method === 'initialize') {
      if (mode === 'modern') send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      else send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '2.0.0' } } });
    } else if (m.method === 'tools/list') {
      if (mode === 'modern' && !(m.params && m.params._meta)) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'missing _meta' } }); continue; }
      if (process.env.FAKE_REQUIRE_ENV && process.env.FAKE_TOKEN !== 'abc') { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'FAKE_TOKEN not set' } }); continue; }
      const cur = m.params && m.params.cursor;
      send({ jsonrpc: '2.0', id: m.id, result: cur ? { tools: TOOLS.slice(2) } : { tools: TOOLS.slice(0, 2), nextCursor: 'c2' } });
    }
  }
});
