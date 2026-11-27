// A stdio MCP server for the Go oracle client's raw-catalog test (R-ORC-11). Its tools carry what go-sdk v1.8.0's typed
// mcp.Tool cannot hold, in the shapes the 25-27 Nov live-probe results showed: `execution` (503 results),
// annotations.returnDirect (schemacrawler/SchemaCrawler-AI@78890054b17c), annotations.description
// (sterion66/godot-mcp-server@b7e6e327f6b0), an empty annotations.title (igorolv/jdbc-mcp-server@d8937cd2dbeb), and hints
// at the tool's top level (GuardianVigil-Labs/Prufgate@0965a5a197ef). Two pages, so the raw pages are joined in order.
import { createInterface } from 'node:readline';

const obj = { type: 'object', properties: { q: { type: 'string' } } };
const PAGES = [
  [
    { name: 'list_tables', description: 'List tables.', inputSchema: obj, execution: { taskSupport: 'forbidden' }, annotations: { readOnlyHint: true, returnDirect: true } },
    { name: 'scene_tree', description: 'Read the scene tree.', inputSchema: obj, annotations: { description: 'Reads the open scene', readOnlyHint: true } },
  ],
  [
    { name: 'run_query', description: 'Run a query.', inputSchema: obj, annotations: { title: '', destructiveHint: false } },
    { name: 'check_gate', description: 'Check a gate.', inputSchema: obj, readOnlyHint: true, openWorldHint: false },
  ],
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'raw-fields', version: '1.0.0' } } });
  if (m.method === 'tools/list') {
    const page = m.params && m.params.cursor === 'p2' ? 1 : 0;
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: PAGES[page], ...(page === 0 ? { nextCursor: 'p2' } : {}) } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
