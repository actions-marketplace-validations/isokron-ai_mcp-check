import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, CaptureError } from '../src/capture.js';

// A fake stdio server: logs a line on stdout, asks the client for sampling, pages tools/list, and
// records every method it receives so the test can check that no tool was called.
const FAKE = `
const seen = [];
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
process.stdout.write('starting up (not JSON)\\n');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method) seen.push(m.method);
    if (m.method === 'initialize') { send({ id: 'srv1', method: 'sampling/createMessage', params: {} }); send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }); }
    else if (m.method === 'tools/list') {
      const page = m.params && m.params.cursor === 'p2' ? 2 : 1;
      // Written before the answer: the client stops the server once the last page arrives.
      if (page === 2) require('fs').writeFileSync(process.env.SEEN, JSON.stringify(seen));
      send({ id: m.id, result: { tools: [{ name: 'tool_' + page, inputSchema: { type: 'object' } }], ...(page === 1 ? { nextCursor: 'p2' } : {}) } });
    }
  }
});
`;

test('capture: follows pages, skips non-JSON lines, refuses server requests, calls no tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcap-'));
  const f = join(dir, 'fake.cjs');
  writeFileSync(f, FAKE);
  const seen = join(dir, 'seen.json');
  const { initialize, result, pages } = await capture([process.execPath, f], { timeoutMs: 20000, env: { ...process.env, SEEN: seen }, stderr: null });
  assert.equal(initialize.serverInfo.name, 'fake');
  assert.equal(pages, 2);
  assert.ok(Array.isArray(result));
  assert.deepEqual(result.flatMap((p) => p.tools.map((t) => t.name)), ['tool_1', 'tool_2']);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
});

test('capture: a server that never answers hits the time limit', async () => {
  await assert.rejects(capture([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 1500, stderr: null }), (e) => e instanceof CaptureError && /time limit of 2 s/.test(e.message));
});

test('capture: a JSON-RPC error on tools/list is reported', async () => {
  const src = "process.stdin.on('data', (c) => { for (const l of String(c).split('\\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'x', version: '1' } } }) + '\\n'); if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no tools here' } }) + '\\n'); } });";
  await assert.rejects(capture([process.execPath, '-e', src], { timeoutMs: 10000, stderr: null }), /tools\/list failed: no tools here/);
});

test('capture: bad argv is refused', async () => {
  await assert.rejects(capture([], {}), CaptureError);
  await assert.rejects(capture('node x', {}), CaptureError);
});
