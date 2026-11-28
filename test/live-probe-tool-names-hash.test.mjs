// R-LP-87: tool_names_sha256, the live list's names hashed exactly as the ast-grep oracle's tool_set_sha256.
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

// One shared list of names, as a server lists them and as a source read finds them: names that differ only in case,
// non-ASCII names (an accent, CJK, an emoji outside the BMP, which UTF-16 sorts by its surrogates), a name twice.
const NAMES = ['search', 'Search', 'SEARCH', 'éclair', 'eclair', 'zeta', 'Zeta', '検索', '😀tool', 'ａlpha', 'search', 'a b'];
const H = (names) => createHash('sha256').update(JSON.stringify([...new Set(names)].sort())).digest('hex');
const astGrepOf = (names) => summarize({ tools: names.map((name, i) => ({ name, idiom: 'ts-register-tool', name_source: 'literal', file: 'src/x.ts', line: i + 1 })), unreadable: [], stats: { files: 1 } });

test('R-LP-87: tool_names_sha256 is sha256(JSON.stringify([...new Set(names)].sort())) and equals the ast-grep oracle\'s tool_set_sha256 for one shared name list (case-only differences, non-ASCII)', () => {
  assert.equal(LP.toolNamesSha256(NAMES), H(NAMES));
  // The same list read by ast-grep (in its own order of finding them): the same value, byte for byte.
  assert.equal(astGrepOf([...NAMES].reverse()).tool_set_sha256, LP.toolNamesSha256(NAMES));
  // No folding: names that differ only in case are three names; a different case is a different hash.
  assert.notEqual(LP.toolNamesSha256(['search']), LP.toolNamesSha256(['Search']));
  // The default sort is UTF-16 code-unit order, not localeCompare (which puts 'eclair' and 'éclair' together).
  const sorted = [...new Set(NAMES)].sort();
  assert.notDeepEqual(sorted, [...new Set(NAMES)].sort((a, b) => a.localeCompare(b)));
  // The wire names gradeList gives (the ones tool_count counts): a tool with no string name has none.
  const g = LP.gradeList(JSON.stringify({ tools: [...NAMES.map((name) => ({ name, inputSchema: { type: 'object' } })), { inputSchema: { type: 'object' } }] }));
  assert.equal(LP.toolNamesSha256(g.names), H(NAMES));
  assert.equal(LP.toolNamesSha256([]), null);
  assert.equal(LP.toolNamesSha256([null, 7]), null, 'no named tool: null, as ast-grep');
  assert.equal(astGrepOf([]).tool_set_sha256, null);
});

test('R-LP-87: the observation sits next to tool_list_sha256, behind EMIT_TOOL_NAMES_FIELD until tool-qa\'s pinned registry declares it; mutation checks', async () => {
  assert.equal(LP.EMIT_TOOL_NAMES_FIELD, false, 'off: the registry ingest pins does not declare it yet (mcp-results R-RES-15)');
  assert.throws(() => LP.obs('tool_names_sha256', H(NAMES)), /not a field of this lane/);
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  const at = src.indexOf("lines.push(obs('tool_list_sha256', g.summary.catalog_hash));");
  const names = src.indexOf("if (EMIT_TOOL_NAMES_FIELD) lines.push(obs('tool_names_sha256', toolNamesSha256(g.names), 'the list names no tool'));");
  assert.ok(at > 0 && names > at && names - at < 300, 'emitted right after tool_list_sha256');
  // Switched on, it is a hash field of the lane, null with a why for a list that names no tool.
  const On = await mutant('export const EMIT_TOOL_NAMES_FIELD = false;', 'export const EMIT_TOOL_NAMES_FIELD = true;');
  assert.deepEqual(JSON.parse(On.obs('tool_names_sha256', H(NAMES))), { field: 'tool_names_sha256', value: H(NAMES), stage: LP.STAGE });
  assert.equal(JSON.parse(On.obs('tool_names_sha256', On.toolNamesSha256([]), 'the list names no tool')).why, 'the list names no tool');
  // Mutation checks: without the dedupe, or with a locale sort, the value is not ast-grep's.
  let M = await mutant('sha256(JSON.stringify([...new Set(list)].sort()))', 'sha256(JSON.stringify([...list].sort()))');
  assert.notEqual(M.toolNamesSha256(NAMES), astGrepOf(NAMES).tool_set_sha256);
  M = await mutant('sha256(JSON.stringify([...new Set(list)].sort()))', 'sha256(JSON.stringify([...new Set(list)].sort((a, b) => a.localeCompare(b))))');
  assert.notEqual(M.toolNamesSha256(NAMES), astGrepOf(NAMES).tool_set_sha256);
});
