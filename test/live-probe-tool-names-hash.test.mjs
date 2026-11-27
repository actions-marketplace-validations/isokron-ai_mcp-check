// R-LP-87: tool_names_sha256 on each graded live-probe result, the same hash as the ast-grep oracle's tool_set_sha256.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

/** corpus/<file> with `from` replaced by `to`, imported fresh (a mutation check). */
async function mutant(from, to, file = 'live-probe.mjs') {
  const src = readFileSync(join(root, 'corpus', file), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/' + file + ': ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}
import { createHash } from 'node:crypto';
import { summarize } from '../corpus/ast-grep/index.mjs';

test('R-LP-87: tool_names_sha256 is the sha256 of the JSON array of the live list\'s tool names, each once, sorted: the ast-grep oracle\'s tool_set_sha256 for the same names', async () => {
  const live = [{ name: 'search', inputSchema: {} }, { name: 'Zeta' }, { name: 'alpha' }, { name: 'search' }, { name: 'éclair' }, { description: 'no name' }, { name: 7 }];
  const want = createHash('sha256').update(JSON.stringify(['Zeta', 'alpha', 'search', 'éclair'])).digest('hex');
  assert.equal(LP.toolNamesSha256(live), want);
  // The ast-grep oracle's hash over the same names (its own order of finding them) is the same value.
  const ag = summarize({ tools: ['éclair', 'search', 'alpha', 'Zeta', 'alpha'].map((name, i) => ({ name, idiom: 'ts-register-tool', name_source: 'literal', file: 'src/x.ts', line: i + 1 })), unreadable: [], stats: { files: 1 } });
  assert.equal(ag.tool_set_sha256, want);
  assert.equal(LP.toolNamesSha256([]), null);
  assert.equal(LP.toolNamesSha256([{ description: 'x' }]), null, 'no named tool, no hash (as ast-grep: null)');
  // On the result: from the primary probe's tools/list pages.
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  assert.ok(src.includes("tool_names_sha256: toolNamesSha256(toolsOf(primary.lists['tools/list'].raw_pages))"));
  // Mutation check: unsorted names give another hash than ast-grep's.
  const M = await mutant(".filter((n) => n !== null))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));", '.filter((n) => n !== null))];');
  assert.notEqual(M.toolNamesSha256(live), ag.tool_set_sha256);
});
