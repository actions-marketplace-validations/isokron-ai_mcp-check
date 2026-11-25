#!/usr/bin/env node
// A fixture MCP server for the fuzz stage's tests (test/fuzz.test.mjs), over stdio, JSON-RPC lines.
//
//   node fuzz-server.cjs <mode> [state file]
//
// Each mode breaks exactly one invariant of corpus/fuzz/judge.mjs (or none: "good"). The state file counts server
// starts across sessions, so a mode can differ between sessions (cat-across, flaky-*). It answers the list methods
// only and exits 9 on anything else (tools/call is never sent by the stage).
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const [mode = 'good', stateFile = null] = process.argv.slice(2);

let start = 1;
if (stateFile) { try { start = Number(fs.readFileSync(stateFile, 'utf8')) + 1; } catch { start = 1; } fs.writeFileSync(stateFile, String(start)); }

const tool = (name) => ({ name, description: 'Tool ' + name, inputSchema: { type: 'object', properties: {} } });
const tools = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map(tool);
const PAGE = 3;
const token = 's' + start + 'p' + process.pid;

if (mode === 'uni-invisible') tools[2] = tool('char​lie');                 // zero-width space
if (mode === 'uni-collision') tools.push(tool('dеlta'));                      // Cyrillic е: the same skeleton as "delta"
if (mode === 'uni-nfc') tools[4] = tool('café');                            // e + combining acute: not NFC
if (mode === 'uni-illformed') tools[4] = tool('ech\ud800o');                       // a lone surrogate, as JSON allows it
if (mode === 'uni-mixed') tools[1] = tool('brаvo');                           // Cyrillic а inside a Latin word
const prompts = [{ name: 'greet', description: 'Greeting' }, { name: mode === 'uni-prompt-invisible' ? 'sum⁠mary' : 'summary', description: 'Summary' }];
const caps = { tools: { listChanged: mode === 'cat-listchanged' }, ...(mode === 'uni-prompt-invisible' ? { prompts: {} } : {}) };

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (id, result) => out({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
let issued = 0;
let traversals = 0; // tools/list answers without a cursor in this session
const enc = (n) => Buffer.from(JSON.stringify({ n, s: token, k: ++issued, tr: traversals })).toString('base64url');
function dec(c) { try { const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); return Number.isInteger(o.n) && typeof o.s === 'string' ? o : null; } catch { return null; } }

const spent = new Set();

function catalog(tr) {
  let t = tools.slice();
  if (mode === 'cat-session' && tr === 2) t = t.slice(0, 5).concat(tool('zulu'));          // the second listing differs
  if (mode === 'cat-reorder' && tr === 2) t = t.reverse();                                  // same tools, other order
  if (mode === 'cat-listchanged' && tr === 2) t = t.slice(0, 6);                            // differs, but announces it
  if (mode === 'cat-across' && start % 2 === 0) t = t.concat(tool('zulu'));                        // every second session differs
  if (mode === 'flaky-across' && start === 2) t = t.concat(tool('zulu'));                          // only the second start, once
  if (mode === 'flaky-session' && start === 1 && tr >= 2) t = t.slice(0, 5);               // only the first start's second listing
  return t;
}

function pageAt(id, all, n) {
  let page = all.slice(n, n + PAGE);
  if (mode === 'pag-dup' && n === PAGE) page = all.slice(n - 1, n - 1 + PAGE);                      // page 2 starts with page 1's last tool
  const more = n + PAGE < all.length;
  return ok(id, more ? { tools: page, nextCursor: enc(n + PAGE) } : { tools: page });
}

function listTools(id, params) {
  const cursor = params && params.cursor;
  if (cursor === undefined) traversals++;
  const d = cursor === undefined ? null : dec(cursor);
  const all = catalog(cursor === undefined ? traversals : d ? d.tr : traversals); // a page belongs to the listing that began it
  if (mode === 'unpaged') return ok(id, { tools: all });
  if (cursor === undefined) return pageAt(id, all, 0);
  if (!d) {                                                                                        // a cursor nobody issued
    if (mode === 'pag-invented-ignored') return pageAt(id, all, 0);
    if (mode === 'pag-invented-accepted') return pageAt(id, all, PAGE);
    return err(id, -32602, 'Invalid cursor');
  }
  if (d.s !== token) {                                                                             // issued by another session
    if (mode === 'pag-foreign') return pageAt(id, all, 0);
    if (mode !== 'pag-stateless') return err(id, -32602, 'Cursor from another session');
  }
  if (mode === 'pag-spent' && spent.has(cursor)) return pageAt(id, all, d.n + PAGE);              // a used cursor moves on
  spent.add(cursor);
  return pageAt(id, all, d.n);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return ok(m.id, { protocolVersion: '2025-11-25', capabilities: caps, serverInfo: { name: 'fuzz-fixture', version: '1.0.0' } });
  if (m.id === undefined) return;
  if (m.method === 'ping') return ok(m.id, {});
  if (m.method === 'tools/list') {
    if (mode === 'hang') return;
    if (mode === 'crash' && traversals >= 1) process.exit(1);
    if (mode === 'cat-listchanged' && traversals === 1 && !(m.params && m.params.cursor)) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    return listTools(m.id, m.params);
  }
  if (m.method === 'prompts/list') return caps.prompts ? ok(m.id, { prompts }) : err(m.id, -32601, 'Method not found');
  if (m.method === 'resources/list' || m.method === 'resources/templates/list') return err(m.id, -32601, 'Method not found');
  process.stderr.write('UNEXPECTED ' + m.method + '\n');
  process.exit(9);
});
