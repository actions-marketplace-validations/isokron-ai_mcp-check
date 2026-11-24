// A stdio JSON-RPC server for the oracle tests (test/oracles.test.mjs): not an MCP server of this repository. It
// answers initialize, ping and tools/list (two tools whose names come from the environment), and a few test methods:
// x/server-ping (asks the client for a ping first, then answers), x/exit (exits), x/silent (never answers).
import { createInterface } from 'node:readline';

const names = String(process.env.ECHO_TOOLS || 'alpha,beta').split(',').filter(Boolean);
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let waiting = null;
createInterface({ input: process.stdin }).on('line', (line) => {
  let q;
  try { q = JSON.parse(line); } catch { return; }
  if (q.id !== undefined && q.method === undefined) { if (waiting && q.id === 'srv-1') { send(waiting); waiting = null; } return; }
  if (q.id === undefined) return;
  if (q.method === 'initialize') send({ jsonrpc: '2.0', id: q.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: String(process.pid) } } });
  else if (q.method === 'ping') send({ jsonrpc: '2.0', id: q.id, result: {} });
  else if (q.method === 'tools/list') send({ jsonrpc: '2.0', id: q.id, result: { tools: names.map((n) => ({ name: n, description: 'd', inputSchema: { type: 'object' } })) } });
  else if (q.method === 'x/server-ping') { waiting = { jsonrpc: '2.0', id: q.id, result: { pid: process.pid } }; send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' }); send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } }); }
  else if (q.method === 'x/pid') send({ jsonrpc: '2.0', id: q.id, result: { pid: process.pid } });
  else if (q.method === 'x/exit') process.exit(3);
  else if (q.method === 'x/silent') { /* never answers */ }
  else send({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'Method not found' } });
});
