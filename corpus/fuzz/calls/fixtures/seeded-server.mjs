#!/usr/bin/env node
// A dependency-free stdio MCP server with one seeded protocol fault, selected by the environment variable FAULT.
// It is a FIXTURE of the tools/call fuzz stage (corpus/fuzz/calls): the fault is known, so a fault the stage does not
// find is a miss of OUR stage. FAULT unset or "clean": no fault (the control: the stage must find nothing).
//
//   error-shape         a JSON-RPC error whose code is a string and whose message is a number          -> ERR-1
//   unknown-tool-ok     a call to an unlisted tool answers with a success result                      -> ERR-2
//   crash-oversize      the process exits on a string argument over 100000 characters                 -> LIFE-1
//   hang-boundary       an empty string argument is never answered                                    -> LIFE-2
//   output-mismatch     structuredContent that does not satisfy the declared outputSchema             -> OUT-1
//   iserror-string      isError is the string "yes" on a tool error                                   -> ISERR-1
//   missing-required-ok a call without the required argument succeeds                                 -> ISERR-2
//   no-content          a success result without a content array                                      -> RES-1
import { createInterface } from 'node:readline';

const FAULT = process.env.FAULT && process.env.FAULT !== 'clean' ? process.env.FAULT : null;
const TOOLS = [
  {
    name: 'add_note', description: 'Add a note.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 5000000 }, priority: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 10 } }, required: ['text'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'integer' }, length: { type: 'integer' } }, required: ['id', 'length'] },
  },
  { name: 'count_notes', description: 'Count notes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
];
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: FAULT === 'error-shape' ? { code: 'invalid', message: 5 } : { code, message } });
const toolError = (id, text) => out({ jsonrpc: '2.0', id, result: { isError: FAULT === 'iserror-string' ? 'yes' : true, content: [{ type: 'text', text }] } });
let notes = 0;

function validArgs(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return 'arguments must be an object';
  if (typeof a.text !== 'string' || a.text.length < 1) return 'text is required and must be a non-empty string';
  if (a.priority !== undefined && !(Number.isInteger(a.priority) && a.priority >= 1 && a.priority <= 5)) return 'priority must be an integer from 1 to 5';
  if (a.tags !== undefined && !(Array.isArray(a.tags) && a.tags.length <= 10 && a.tags.every((t) => typeof t === 'string'))) return 'tags must be up to 10 strings';
  for (const k of Object.keys(a)) if (!['text', 'priority', 'tags'].includes(k)) return `unexpected property ${k}`;
  return null;
}

function call(id, name, args) {
  if (name === 'count_notes') {
    if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return toolError(id, 'count_notes takes no arguments');
    const body = { count: notes };
    return out({ jsonrpc: '2.0', id, result: FAULT === 'no-content' ? { structuredContent: body } : { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } });
  }
  if (name !== 'add_note') {
    if (FAULT === 'unknown-tool-ok') return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
    return fail(id, -32602, `unknown tool ${String(name).slice(0, 40)}`);
  }
  if (FAULT === 'crash-oversize' && typeof args?.text === 'string' && args.text.length > 100000) process.exit(1);
  if (FAULT === 'hang-boundary' && args?.text === '') return;
  let bad = validArgs(args);
  if (FAULT === 'missing-required-ok' && bad && args && typeof args === 'object' && !Array.isArray(args) && args.text === undefined) bad = null;
  if (bad) return toolError(id, bad);
  const text = typeof args?.text === 'string' ? args.text : '';
  const body = FAULT === 'output-mismatch' ? { id: 'one', length: text.length } : { id: ++notes, length: text.length };
  out({ jsonrpc: '2.0', id, result: FAULT === 'no-content' ? { structuredContent: body } : { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fuzz-seeded', version: '1' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/call') return call(m.id, m.params?.name, m.params?.arguments);
  if (m.id !== undefined) return fail(m.id, -32601, 'method not found');
});
process.stdin.on('end', () => process.exit(0));
