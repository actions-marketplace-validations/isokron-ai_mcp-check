#!/usr/bin/env node
/**
 * Replays a reproducer (corpus/fuzz/run.mjs `reproducerOf`) as a stdio MCP server, so a failing run becomes a test:
 *
 *   node corpus/fuzz/replay-server.mjs <reproducer.json> <state file>
 *
 * The state file counts starts: the k-th start plays session `order[k]` of the spec. Within a session, the answer to
 * a request is the next recorded answer for the same method and cursor (a second request for one cursor gets the
 * second recorded answer); a request with no recorded answer gets a JSON-RPC internal error. It never executes
 * anything the spec holds: the spec is data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [specFile, stateFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
let start = 0;
try { start = Number(readFileSync(stateFile, 'utf8')); } catch { start = 0; }
writeFileSync(stateFile, String(start + 1));
const label = spec.order[Math.min(start, spec.order.length - 1)];
const queues = new Map();
let init = null;
for (const s of spec.sessions[label] || []) {
  if (s.method === 'initialize') { init = s; continue; }
  const key = s.method + '\u0000' + (s.params && s.params.cursor !== undefined ? s.params.cursor : '');
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key).push(s);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return out(init && init.result ? { jsonrpc: '2.0', id: m.id, result: init.result } : { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'no recorded initialize' } });
  if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  const key = m.method + '\u0000' + (m.params && m.params.cursor !== undefined ? m.params.cursor : '');
  const q = queues.get(key);
  const next = q && q.shift();
  if (!next) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'replay: no recorded answer' } });
  out(next.result !== undefined ? { jsonrpc: '2.0', id: m.id, result: next.result } : { jsonrpc: '2.0', id: m.id, error: next.error || { code: -32603, message: 'replay' } });
});
