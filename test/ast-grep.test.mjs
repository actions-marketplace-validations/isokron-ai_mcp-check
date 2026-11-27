// The ast-grep oracle (O3) of the scan-static lane: corpus/ast-grep/. Rows R-AG-NN of REGRESSIONS.md. Tests that run the
// ast-grep binary need it installed (npm ci --ignore-scripts --prefix corpus/ast-grep; CI does); without it they are skipped
// off CI and fail on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { balanced, callArgs, fields, literalBool, literalString, splitTop } from '../corpus/ast-grep/parse.mjs';
import { extractMatch, goConstants } from '../corpus/ast-grep/extract.mjs';
import { EXCLUDED_PATH, compare, readMatches, runOracle, summarize } from '../corpus/ast-grep/index.mjs';
import { PACKS, PINNED_VERSION, binaryPath, materializeRules, scan } from '../corpus/ast-grep/run.mjs';
import { fetchSource } from '../corpus/ast-grep/source.mjs';
import { eligible, oracleForScan, partsOf, readerNamesOf } from '../corpus/ast-grep/hook.mjs';
import { aggregate, scoreTarget, shardTargets, slim } from '../corpus/ast-grep/harness.mjs';
import { runShard } from '../corpus/scan-static.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(root, 'test/fixtures/ast-grep');
const BIN = binaryPath();
const needBinary = { skip: !BIN && !process.env.CI ? 'ast-grep is not installed (npm ci --ignore-scripts --prefix corpus/ast-grep)' : false };

const m = (ruleId, text, { after = '', before = '', fileText = text } = {}) => ({ ruleId, text, after, before, fileText });
const names = (recs) => recs.filter((r) => r.name).map((r) => r.name);

// ---------------------------------------------------------------------------------------------- reading literals

test('R-AG-01: a name is read only from a literal; strings, templates and joined strings are read, anything computed is not', () => {
  assert.equal(literalString('"add"'), 'add');
  assert.equal(literalString("'add'"), 'add');
  assert.equal(literalString('`add`'), 'add');
  assert.equal(literalString('"a\\nb"'), 'a\nb');
  assert.equal(literalString('"a" + "b"'), 'ab');
  assert.equal(literalString('"a" "b"'), 'ab', 'Python implicit joining');
  assert.equal(literalString('"x".into()'), 'x');
  assert.equal(literalString('"x".to_string()'), 'x');
  assert.equal(literalString('String::from("x")'), 'x');
  assert.equal(literalString('r#"x"y"#'), 'x"y');
  assert.equal(literalString('"""Doc.\n\n   more"""'), 'Doc.\n\n   more');
  for (const computed of ['PREFIX + "_x"', '`a_${n}`', 'name', 'f"a_{n}"', 'getName()', '"a" + b', 'b"bytes"', '']) assert.equal(literalString(computed), null, computed);
  assert.equal(literalBool('true'), true);
  assert.equal(literalBool('False'), false);
  assert.equal(literalBool('mcp.ToBoolPtr(true)'), true);
  assert.equal(literalBool('flag'), null);
});

test('R-AG-01: arguments and fields are split at the top level only, outside strings, comments and brackets', () => {
  assert.deepEqual(callArgs('s.tool("a,b", { x: [1, 2], y: "}" }, async () => { f(1, 2); })'), ['"a,b"', '{ x: [1, 2], y: "}" }', 'async () => { f(1, 2); }']);
  assert.deepEqual(splitTop('a, // c, d\n b'), ['a', '// c, d\n b']);
  assert.equal(balanced('x(a, "(", b) tail', 1), 'a, "(", b');
  const f = fields('name: "x", description: `d, e`, "quoted-key": 1, nested: { name: "inner" }, ...rest');
  assert.equal(f.get('name'), '"x"');
  assert.equal(f.get('quoted-key'), '1');
  assert.ok(f.get('nested').includes('inner'));
  assert.ok(!f.has('inner'), 'a key of a nested object is not a top-level key');
});

test('R-AG-01: a computed, looped, passed-in or constant name that cannot be resolved is unreadable, never guessed', () => {
  const ts = (id, text) => extractMatch(m(id, text));
  assert.deepEqual(ts('ts-server-tool', 'server.tool(PREFIX + "_computed", "d", cb)'), [{ idiom: 'ts-server-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(ts('ts-server-tool', 'server.tool(n, "looped", cb)'), [{ idiom: 'ts-server-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(ts('ts-register-tool', 'server.registerTool(`a_${n}`, {}, cb)'), [{ idiom: 'ts-register-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(ts('ts-add-tool', 'server.addTool(makeTool())'), [{ idiom: 'ts-add-tool', unreadable: 'argument_not_literal' }]);
  assert.deepEqual(ts('ts-add-tool', 'server.addTool({ name: NAME, description: "d" })'), [{ idiom: 'ts-add-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(extractMatch(m('py-tool-decorator', '@mcp.tool(name=NAME)', { after: '\ndef f(): pass' })), [{ idiom: 'py-tool-decorator', unreadable: 'name_not_literal' }]);
  assert.deepEqual(extractMatch(m('go-new-tool', 'mcp.NewTool(computed())')), [{ idiom: 'go-new-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(extractMatch(m('go-new-tool', 'mcp.NewTool(unknownConst)'), { constants: new Map() }), [{ idiom: 'go-new-tool', unreadable: 'name_not_literal' }]);
  assert.deepEqual(extractMatch(m('rs-tool-new', 'Tool::new(NAME, "d", schema)')), [{ idiom: 'rs-tool-new', unreadable: 'name_not_literal' }]);
  // a constant that two files give different values is not resolved
  assert.equal(goConstants(['const A = "x"', 'const A = "y"']).get('A'), null);
  const resolved = extractMatch(m('go-new-tool', 'mcp.NewTool(toolName, mcp.WithDescription("d"))'), { constants: goConstants(['const toolName = "by_const"']) });
  assert.deepEqual([resolved[0].name, resolved[0].name_source], ['by_const', 'const']);
});

test('R-AG-01: descriptions and annotations are kept only where they are literal', () => {
  const [t] = extractMatch(m('ts-register-tool', 'server.registerTool("w", { description: "Weather", annotations: { readOnlyHint: true, openWorldHint: flag, title: "T" } }, cb)'));
  assert.equal(t.description, 'Weather');
  assert.deepEqual(t.annotations, { readOnlyHint: true, title: 'T' }, 'a non-literal hint is left out');
  const [u] = extractMatch(m('ts-server-tool', 'server.tool("a", describe(), { x: 1 }, { destructiveHint: false }, cb)'));
  assert.equal(u.description, null);
  assert.deepEqual(u.annotations, { destructiveHint: false });
  const [p] = extractMatch(m('py-tool-decorator', '@mcp.tool()', { after: '\nasync def f(x):\n    """Does f.\n\n    More.\n    """\n    return x' }));
  assert.deepEqual([p.name, p.name_source, p.description], ['f', 'function_name', 'Does f.\n\nMore.']);
});

// ---------------------------------------------------------------------------------------------- the idioms, with ast-grep

const EXPECTED = {
  'ts-sdk': ['add_numbers', 'get_weather', 'no_description', 'tpl_tool'],
  'ts-lowlevel': ['read_file', 'write_file'],
  'ts-fastmcp': ['fm_add', 'fm_sub'],
  'py-fastmcp': ['add', 'annotated', 'bare_decorator', 'renamed_tool'],
  'py-lowlevel': ['ll_one', 'll_two'],
  'go-mcpgo': ['const_named', 'hello_world', 'second_tool'],
  'go-sdk': ['farewell', 'greet'],
  'rust-rmcp': ['get_value', 'increment'],
  'cs-sdk': ['custom_name', 'echo'],
};
async function read(dir) {
  const found = await scan({ binary: BIN, target: dir });
  assert.equal(found.error, null);
  return summarize(readMatches(found.matches, { root: dir }));
}

for (const [fixture, want] of Object.entries(EXPECTED)) {
  test(`R-AG-04: the ${fixture} idiom gives its tool names, no more and no fewer`, needBinary, async () => {
    const s = await read(join(FIXTURES, fixture));
    assert.deepEqual(s.tools.map((t) => t.name), want);
  });
}

test('R-AG-04: descriptions and annotations the source writes out are read per idiom', needBinary, async () => {
  const by = async (fixture) => Object.fromEntries((await read(join(FIXTURES, fixture))).tools.map((t) => [t.name, t]));
  const ts = await by('ts-sdk');
  assert.equal(ts.add_numbers.description, 'Add two numbers');
  assert.deepEqual(ts.get_weather.annotations, { readOnlyHint: true, openWorldHint: true });
  assert.equal((await by('ts-lowlevel')).read_file.description, 'Read a file');
  assert.deepEqual((await by('ts-fastmcp')).fm_add.annotations, { readOnlyHint: true, title: 'Add' });
  const py = await by('py-fastmcp');
  assert.equal(py.add.description, 'Add two numbers.\n\nMore text.');
  assert.equal(py.renamed_tool.description, 'Explicit description');
  assert.deepEqual(py.annotated.annotations, { readOnlyHint: true });
  assert.deepEqual((await by('py-lowlevel')).ll_two.annotations, { readOnlyHint: true });
  assert.deepEqual((await by('go-mcpgo')).hello_world.annotations, { readOnlyHint: true });
  assert.equal((await by('go-sdk')).greet.description, 'say hi');
  assert.deepEqual((await by('go-sdk')).greet.annotations, { readOnlyHint: true });
  assert.equal((await by('rust-rmcp')).get_value.description, 'Get the value');
  const cs = await by('cs-sdk');
  assert.equal(cs.echo.description, 'Echoes the message back.');
  assert.deepEqual([cs.echo.name_source, cs.custom_name.name_source], ['derived', 'literal']);
  assert.deepEqual(cs.custom_name.annotations, { readOnlyHint: true });
});

test('R-AG-02: registrations whose name cannot be read are unreadable and lower the confidence; they are not tools', needBinary, async () => {
  const s = await read(join(FIXTURES, 'ts-sdk'));
  assert.equal(s.unreadable_count, 2, 'a computed name and a looped one');
  assert.deepEqual(s.unreadable.map((u) => u.unreadable), ['name_not_literal', 'name_not_literal']);
  assert.equal(s.confidence, 'medium');
  assert.ok(!s.tools.some((t) => /computed|^n$/.test(t.name)));
  const clean = await read(join(FIXTURES, 'ts-lowlevel'));
  assert.deepEqual([clean.status, clean.confidence, clean.unreadable_count], ['read', 'high', 0]);
});

test('R-AG-03: a call in a file that is not about MCP, in tests, or in vendored code is not a registration', needBinary, async () => {
  const s = await read(join(FIXTURES, 'ts-sdk'));
  assert.ok(!s.tools.some((t) => t.name === 'not_a_tool' || t.name === 'only_in_tests'));
  assert.ok(s.files_gated_out >= 1 && s.files_excluded >= 1);
  for (const p of ['test/a.ts', 'tests/a.py', 'src/__tests__/a.ts', 'node_modules/x/a.js', 'vendor/x/a.go', 'a_test.go', 'a.test.ts', 'examples/a.ts', 'dist/a.js', 'docs/a.py', 'src/test_a.py']) assert.match(p, EXCLUDED_PATH, p);
  for (const p of ['src/index.ts', 'cmd/server/main.go', 'src/tools/latest.ts', 'server.py', 'src/attestation.rs']) assert.doesNotMatch(p, EXCLUDED_PATH, p);
});

test('R-AG-02: nothing matched is status none, registrations without a readable name is unreadable; neither is a tool list', () => {
  const none = summarize({ tools: [], unreadable: [], stats: { files: 0, excluded: 0, gated_out: 0 } });
  assert.deepEqual([none.status, none.confidence, none.tool_count, none.tool_set_sha256], ['none', null, 0, null]);
  const unread = summarize({ tools: [], unreadable: [{ idiom: 'ts-server-tool', unreadable: 'name_not_literal' }], stats: { files: 1, excluded: 0, gated_out: 0 } });
  assert.deepEqual([unread.status, unread.confidence], ['unreadable', null]);
  const err = summarize({ tools: [], unreadable: [], stats: { files: 0 } }, { error: 'timeout' });
  assert.deepEqual([err.status, err.error], ['error', 'timeout']);
  const tool = (name, source = 'literal') => ({ idiom: 'go-new-tool', name, name_source: source, description: null, annotations: null, file: 'a.go', line: 1 });
  assert.equal(summarize({ tools: [tool('a'), tool('a')], unreadable: [], stats: { files: 1 } }).tool_count, 1, 'a tool registered twice is one tool');
  assert.equal(summarize({ tools: [tool('a', 'derived')], unreadable: [], stats: { files: 1 } }).confidence, 'medium', 'a derived name is not high confidence');
  assert.equal(summarize({ tools: [tool('a')], unreadable: [{}, {}, {}], stats: { files: 1 } }).confidence, 'low');
});

// ---------------------------------------------------------------------------------------------- the comparison

const oracleOf = (tools, { unreadable = 0, source = 'literal' } = {}) => summarize({
  tools: tools.map((name, i) => ({ idiom: 'ts-server-tool', name, name_source: source, description: null, annotations: null, file: 'src/f' + (i % 2) + '.ts', line: i + 1 })),
  unreadable: Array.from({ length: unreadable }, () => ({ idiom: 'ts-server-tool', unreadable: 'name_not_literal' })), stats: { files: 2, excluded: 0, gated_out: 0 },
});

test('R-AG-05: a tool the oracle read and the reader lacks is D1, one the reader lists and the oracle did not read is D2', () => {
  const c = compare(oracleOf(['a', 'b', 'c']), { status: 'graded', names: ['a', 'x'] });
  assert.equal(c.compared, true);
  assert.deepEqual(c.missing, ['b', 'c']);
  assert.deepEqual(c.phantom, ['x']);
  assert.deepEqual(c.entries.map((e) => [e.class, e.kind, e.oracles, e.attribution, e.direction, e.count]), [['D1', 'tool_set', ['ast-grep', 'reader'], 'tool', 'reader_missing', 2], ['D2', 'tool_set', ['ast-grep', 'reader'], 'tool', 'reader_phantom', 1]]);
  assert.deepEqual(compare(oracleOf(['a']), { status: 'graded', names: ['a'] }).entries, []);
  const none = compare(oracleOf(['a']), { status: 'skipped', detail: 'no_tools' });
  assert.deepEqual(none.entries.map((e) => e.class), ['D1'], 'a reader that found no list is compared as empty');
});

test('R-AG-02: unreadable is never a disagreement: no comparison without a read answer, and no phantom unless every registration was read', () => {
  for (const status of ['none', 'unreadable', 'error']) {
    const o = status === 'error' ? summarize({ tools: [], unreadable: [], stats: { files: 0 } }, { error: 'timeout' }) : summarize({ tools: [], unreadable: status === 'unreadable' ? [{ idiom: 'x', unreadable: 'y' }] : [], stats: { files: 0 } });
    const c = compare(o, { status: 'graded', names: ['a', 'b'] });
    assert.deepEqual([c.compared, c.entries, c.why], [false, [], 'oracle_' + status], status);
  }
  const partial = compare(oracleOf(['a'], { unreadable: 2 }), { status: 'graded', names: ['a', 'z'] });
  assert.deepEqual(partial.entries, [], 'the oracle could not read everything, so the reader\'s extra tool is not a phantom');
  const derived = compare(oracleOf(['a', 'q'], { source: 'derived' }), { status: 'graded', names: ['a', 'z'] });
  assert.deepEqual(derived.entries.map((e) => e.class), ['D1'], 'derived names (medium confidence) can show a missing tool, not a phantom');
  for (const reader of [null, { status: 'skipped', detail: 'multiple_servers' }, { status: 'skipped', detail: 'repo_unavailable' }, { status: 'graded', names: null }]) assert.equal(compare(oracleOf(['a']), reader).compared, false);
});

test('R-AG-05: the fingerprint describes the shape of the disagreement, never the subject', () => {
  const a = compare(oracleOf(['alpha', 'beta']), { status: 'graded', names: [] }).entries[0];
  const b = compare(oracleOf(['gamma', 'delta']), { status: 'graded', names: [] }).entries[0];
  assert.match(a.fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(a.fingerprint, b.fingerprint, 'the same shape with other names is the same fingerprint');
  const bigger = compare(oracleOf(['a', 'b', 'c', 'd', 'e', 'f']), { status: 'graded', names: [] }).entries[0];
  assert.notEqual(a.fingerprint, bigger.fingerprint, 'a different magnitude is another fingerprint');
  const phantom = compare(oracleOf(['a']), { status: 'graded', names: ['a', 'x'] }).entries[0];
  assert.notEqual(phantom.fingerprint, a.fingerprint, 'a different class is another fingerprint');
  assert.ok(!JSON.stringify(a).includes('alpha'), 'no tool name in an entry');
});

// ---------------------------------------------------------------------------------------------- source and binary

test('R-AG-06: the source is fetched into a fresh folder with no hooks, symlinks, LFS or submodules, for a full sha only', async () => {
  const calls = [];
  const run = async (cwd, args) => { calls.push(args); };
  const inputs = [];
  const run2 = async (cwd, args, opts) => { calls.push(args); if (opts.input) inputs.push(opts.input); return args[0] === 'ls-tree' ? 'src/server.ts\nREADME.md\npackage.json\ntest/a.ts\nnode_modules/x/i.js\nsrc/__tests__/b.ts\ncmd/main.go\ndocs/x.py\nweird[1].ts\n' : ''; };
  const src = await fetchSource('owner/name', 'a'.repeat(40), { run: run2 });
  assert.ok(existsSync(join(src.dir, '..')));
  assert.deepEqual(calls.map((a) => a[0]), ['init', 'remote', 'fetch', 'ls-tree', 'sparse-checkout', 'checkout']);
  assert.deepEqual(calls[1], ['remote', 'add', 'origin', 'https://github.com/owner/name.git']);
  assert.ok(calls[2].includes('--depth') && calls[2].includes('--filter=blob:none') && calls[2].includes('--no-recurse-submodules') && calls[2].at(-1) === 'a'.repeat(40));
  assert.ok(calls[4].includes('--no-cone') && calls[4].includes('--stdin'));
  assert.equal(inputs[0], '/src/server.ts\n/cmd/main.go\n', 'only source files outside tests, docs and vendored code, and no path with a pattern character');
  src.cleanup();
  assert.ok(!existsSync(join(src.dir, '..')));
  for (const [repo, sha] of [['../etc/x', 'a'.repeat(40)], ['o/n', 'main'], ['o/n', 'A'.repeat(40)], ['o/n;rm', 'a'.repeat(40)], ['o', 'a'.repeat(40)]]) await assert.rejects(fetchSource(repo, sha, { run }), { code: 'bad_subject' });
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('ast-grep-src-')).length;
  await assert.rejects(fetchSource('o/n', 'b'.repeat(40), { run: async () => { throw Object.assign(new Error('x'), { killed: true }); } }), { code: 'timeout' });
  await assert.rejects(fetchSource('o/n', 'b'.repeat(40), { run: async () => { throw new Error('x'); } }), { code: 'fetch_failed' });
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith('ast-grep-src-')).length, before, 'a failed fetch leaves nothing behind');
  // the real git command line: fixed -c flags before the verb
  const src2 = fixedFlags();
  for (const flag of ['core.hooksPath=/dev/null', 'core.symlinks=false', 'filter.lfs.required=false', 'protocol.file.allow=never']) assert.ok(src2.includes(flag), flag);
});
function fixedFlags() { return readFileSync(join(root, 'corpus/ast-grep/source.mjs'), 'utf8'); }

test('R-AG-06: ast-grep is the pinned version, installed from a lockfile that pins its integrity, never run from a package install script', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'corpus/ast-grep/package.json'), 'utf8'));
  assert.match(pkg.dependencies['@ast-grep/cli'], /^\d+\.\d+\.\d+$/, 'an exact version');
  assert.equal(PINNED_VERSION, pkg.dependencies['@ast-grep/cli']);
  const lock = JSON.parse(readFileSync(join(root, 'corpus/ast-grep/package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@ast-grep/cli'].version, PINNED_VERSION);
  for (const [k, v] of Object.entries(lock.packages)) if (k) assert.match(v.integrity ?? '', /^sha512-/, k);
  assert.ok(!Object.keys(pkg).includes('scripts'));
});

test('R-AG-06: the rule packs are written for every idiom of the five languages and materialize per language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-rules-'));
  materializeRules(dir);
  const files = readdirSync(join(dir, 'rules')).sort();
  assert.deepEqual(files, ['csharp.yml', 'go.yml', 'python.yml', 'rust.yml', 'typescript.JavaScript.yml', 'typescript.Tsx.yml', 'typescript.TypeScript.yml']);
  const all = files.map((f) => readFileSync(join(dir, 'rules', f), 'utf8')).join('\n');
  assert.ok(!all.includes('__LANG__'));
  for (const id of ['ts-server-tool', 'ts-register-tool', 'ts-add-tool', 'ts-list-tools-handler', 'py-tool-decorator', 'py-tool-type', 'go-new-tool', 'go-tool-literal', 'go-add-tool', 'rs-tool-attribute', 'cs-mcp-server-tool']) assert.ok(all.includes('id: ' + id), id);
  assert.ok(all.includes('id: ts-server-tool.Tsx'));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(Object.keys(PACKS).sort(), ['csharp.yml', 'go.yml', 'python.yml', 'rust.yml', 'typescript.yml']);
});

test('R-AG-06: a missing binary or a failing run is an error answer, never a disagreement and never a throw', async () => {
  const noBinary = await runOracle({ repo: 'o/n', sha: 'a'.repeat(40), reader: { status: 'graded', names: ['a'] }, fetchSource: async () => { throw new Error('unused'); }, binary: null });
  assert.deepEqual([noBinary.summary.status, noBinary.summary.error, noBinary.comparison.entries], ['error', 'binary_missing', []]);
  const noSource = await runOracle({ repo: 'o/n', sha: 'a'.repeat(40), reader: { status: 'graded', names: ['a'] }, fetchSource: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); }, binary: '/bin/true' });
  assert.deepEqual([noSource.summary.error, noSource.comparison.entries], ['timeout', []]);
  let cleaned = 0;
  const failed = await runOracle({ repo: 'o/n', sha: 'a'.repeat(40), reader: { status: 'graded', names: [] }, fetchSource: async () => ({ dir: '/nonexistent', cleanup: () => { cleaned++; } }), binary: '/bin/true', scanImpl: async () => ({ matches: [], error: 'ast_grep_failed' }) });
  assert.deepEqual([failed.summary.error, failed.comparison.entries, cleaned], ['ast_grep_failed', [], 1], 'the source is removed even when the scan failed');
});

// ---------------------------------------------------------------------------------------------- the scan-static hook

const SHA = 'c'.repeat(40);
const reader = (toolNames) => ({ status: 'graded', commit: { sha: SHA }, rawFiles: { files: { 'raw/subject/tools.json': JSON.stringify(toolNames.map((name) => ({ name }))) + '\n' }, truncated: [] } });

test('R-AG-07: the oracle runs for a graded list or a reader that found none; not for other skips, a cut list or a subject with no commit', () => {
  assert.deepEqual(eligible(reader(['a', 'b'])), { status: 'graded', detail: null, names: ['a', 'b'] });
  assert.deepEqual(eligible({ status: 'skipped', detail: 'no_tools', commit: { sha: SHA } }), { status: 'skipped', detail: 'no_tools', names: [] });
  for (const detail of ['multiple_servers', 'repo_unavailable', 'rate_limited', 'unsupported_language', 'timeout', 'reader_error']) assert.equal(eligible({ status: 'skipped', detail, commit: { sha: SHA } }), null, detail);
  assert.equal(eligible({ ...reader(['a']), commit: null }), null);
  const cut = { status: 'graded', commit: { sha: SHA }, rawFiles: { files: { 'raw/subject/tools.json': '{"truncated":true,"cap_bytes":10,"total":9,"kept":1,"items":[]}\n' } } };
  assert.deepEqual(eligible(cut), { status: 'skipped', detail: 'raw_truncated', names: null }, 'a cut list is not compared');
  assert.equal(readerNamesOf({ rawFiles: { files: {} } }), null);
});

const SUMMARY_TOOLS = ['alpha', 'beta'].map((name) => ({ idiom: 'ts-server-tool', name, name_source: 'literal', description: 'secret text', annotations: null, file: 'src/a.ts', line: 3, idioms: ['ts-server-tool'] }));
const stubOracle = (found) => async (item, scan) => {
  const r = eligible(scan);
  const summary = summarize({ tools: found.map((t) => ({ ...t })), unreadable: [], stats: { files: 1, excluded: 0, gated_out: 0 } });
  return partsOf(summary, compare(summary, r), r);
};
const GOOD_FILES = { 'package.json': '{"name":"w","dependencies":{"@modelcontextprotocol/sdk":"1"}}', 'lib/server.js': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst s = new McpServer({name:"w",version:"1"});\ns.tool("alpha", "Alpha tool", {}, async () => ({}));\ns.tool("gamma", "Gamma tool", {}, async () => ({}));\n' };
const tree = (dir) => { const out = new Map(); const walk = (d, p = '') => { for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name), p + e.name + '/') : out.set(p + e.name, readFileSync(join(d, e.name), 'utf8'))); }; walk(dir); return out; };
const gh = (files) => async (url) => {
  const u = String(url);
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (/\/repos\/o\/w$/.test(u)) return json({ full_name: 'o/w', default_branch: 'main', private: false, archived: false, fork: false });
  if (/\/branches\/main$/.test(u)) return json({ name: 'main', commit: { sha: SHA, commit: { committer: { date: '2026-11-01T00:00:00Z' } } } });
  if (/\/git\/trees\//.test(u)) return json({ sha: SHA, truncated: false, tree: Object.entries(files).map(([path, t]) => ({ type: 'blob', path, size: t.length })) });
  const m = /raw\.githubusercontent\.com\/o\/w\/[0-9a-f]{40}\/(.+)$/.exec(u);
  return m && files[m[1]] !== undefined ? new Response(files[m[1]], { status: 200 }) : new Response('', { status: 404 });
};
async function shard({ astGrep, oracle }) {
  const out = join(mkdtempSync(join(tmpdir(), 'ag-shard-')), 'out');
  const items = JSON.stringify([{ subject: 'o/w', run_key: 'd'.repeat(64), fence: 7 }]);
  await runShard({ shardId: 's', attemptId: 'a', items, out, fetch: gh(GOOD_FILES), astGrep, oracle, now: () => new Date('2026-11-27T10:00:00Z') });
  return { files: tree(join(out, '0', 'bundle')), meta: JSON.parse(readFileSync(join(out, '0', 'meta.json'), 'utf8')) };
}

test('R-AG-07: off, the bundle is exactly what it was before the oracle existed; on, it adds a result block, a component, a field record and one raw file', async () => {
  const off = await shard({ astGrep: false, oracle: async () => { throw new Error('must not run'); } });
  const on = await shard({ astGrep: true, oracle: stubOracle(SUMMARY_TOOLS) });
  assert.deepEqual(off.meta.oracles, []);
  assert.ok(![...off.files.keys()].some((p) => /ast-grep/.test(p)));
  assert.ok(!('oracle_ast_grep' in JSON.parse(off.files.get('results/scan-static.json'))));
  assert.deepEqual(on.meta.oracles, [{ name: 'ast-grep', version: PINNED_VERSION }]);
  const result = JSON.parse(on.files.get('results/scan-static.json'));
  assert.deepEqual([result.oracle_ast_grep.status, result.oracle_ast_grep.tool_count, result.oracle_ast_grep.compared, result.oracle_ast_grep.missing_from_reader, result.oracle_ast_grep.not_in_oracle], ['read', 2, true, 1, 1]);
  assert.ok(on.files.has('raw/subject/ast-grep.json'));
  // everything the reader said is the same with the oracle on
  const strip = ({ oracle_ast_grep, ...rest }) => rest;
  assert.deepEqual(strip(result), strip(JSON.parse(off.files.get('results/scan-static.json'))));
  for (const p of ['raw/subject/tools.json', 'raw/subject/scan.json', 'raw/subject/report.json']) assert.equal(on.files.get(p), off.files.get(p), p);
});

test('R-AG-05: a difference is recorded as an oracle_disagreements field (a lead about our reader); agreement records none', async () => {
  const differ = await shard({ astGrep: true, oracle: stubOracle(SUMMARY_TOOLS) });
  const lines = differ.files.get('observations/static.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = lines.find((l) => l.field === 'oracle_disagreements');
  assert.equal(rec.stage, 'static');
  assert.deepEqual(rec.value.map((e) => [e.class, e.kind, e.oracles, e.attribution]), [['D1', 'tool_set', ['ast-grep', 'reader'], 'tool'], ['D2', 'tool_set', ['ast-grep', 'reader'], 'tool']]);
  const same = await shard({ astGrep: true, oracle: stubOracle(['alpha', 'gamma'].map((name) => ({ ...SUMMARY_TOOLS[0], name }))) });
  assert.ok(!same.files.get('observations/static.ndjson').includes('oracle_disagreements'));
  assert.equal(JSON.parse(same.files.get('results/scan-static.json')).oracle_ast_grep.missing_from_reader, 0);
});

test('R-AG-07: no subject text leaves raw/: names, descriptions and paths are only in raw/subject/ast-grep.json', async () => {
  const on = await shard({ astGrep: true, oracle: stubOracle(SUMMARY_TOOLS) });
  for (const [p, text] of on.files) {
    if (p.startsWith('raw/')) continue;
    for (const secret of ['alpha', 'beta', 'gamma', 'secret text', 'src/a.ts', 'lib/server.js']) assert.ok(!text.includes(secret), p + ' holds "' + secret + '"');
  }
  const raw = JSON.parse(on.files.get('raw/subject/ast-grep.json'));
  assert.deepEqual(raw.tools.map((t) => t.name), ['alpha', 'beta']);
  assert.deepEqual(raw.missing_from_reader, ['beta']);
  assert.deepEqual(raw.not_in_oracle, ['gamma']);
});

test('R-AG-07: an oracle that fails or throws leaves the bundle as the reader made it; its failure is not the subject\'s', async () => {
  const off = await shard({ astGrep: false, oracle: null });
  const thrown = await shard({ astGrep: true, oracle: async () => { throw new Error('boom'); } });
  assert.deepEqual([...thrown.files.keys()].sort(), [...off.files.keys()].sort());
  assert.deepEqual(thrown.meta.oracles, []);
  const errored = await shard({ astGrep: true, oracle: async (item, scan) => { const r = eligible(scan); const s = summarize({ tools: [], unreadable: [], stats: { files: 0 } }, { error: 'timeout' }); return partsOf(s, compare(s, r), r); } });
  const block = JSON.parse(errored.files.get('results/scan-static.json')).oracle_ast_grep;
  assert.deepEqual([block.status, block.error, block.compared], ['error', 'timeout', false]);
  assert.ok(!errored.files.get('observations/static.ndjson').includes('oracle_disagreements'));
  const hooked = await oracleForScan({ repo: 'o/w' }, reader(['a']), { runImpl: async () => { throw new Error('x'); } });
  assert.equal(hooked, null);
});

// ---------------------------------------------------------------------------------------------- the harness

test('R-AG-08: the harness scores precision against every real tool and recall over default tools, per language', () => {
  const target = { id: 't', language: 'go', tools: [['a'], ['b'], ['gated', 0]] };
  const s = scoreTarget(summarize({ tools: ['a', 'gated', 'phantom'].map((name) => ({ idiom: 'go-new-tool', name, name_source: 'literal', file: 'x.go', line: 1 })), unreadable: [], stats: { files: 1 } }), target);
  assert.deepEqual([s.found, s.tp, s.fp, s.truth_default, s.tp_default, s.truth_all, s.tp_all, s.missed, s.wrong], [3, 2, 1, 2, 1, 3, 2, ['b'], ['phantom']]);
  const rows = [{ language: 'go', holdout: false, status: 'read', confidence: 'high', score: s }, { language: 'ts', holdout: true, status: 'none', confidence: null, score: { found: 0, tp: 0, fp: 0, truth_default: 4, tp_default: 0, truth_all: 4, tp_all: 0 } }];
  const agg = aggregate(rows);
  assert.deepEqual([agg.by_language.go.all.precision, agg.by_language.go.all.recall_default, agg.by_language.ts.all.recall_default, agg.by_language.ts.holdout.targets], [0.667, 0.5, 0, 1]);
  assert.equal(agg.overall.high_confidence.targets, 1);
});

test('R-AG-08: dispatch shards stay under the input limit and keep what the scan and the scoring need', () => {
  const targets = Array.from({ length: 30 }, (_, i) => ({ id: 't' + i, repo: 'o/r' + i, sha: 'a'.repeat(40), language: 'ts', subdir: 'pkg', holdout: i % 5 === 0, expected: { tools: Array.from({ length: 40 }, (_, j) => ({ name: 'tool_number_' + j, default: j % 7 ? true : false, schema: true })) } }));
  const shards = shardTargets(targets, { limit: 8000 });
  assert.ok(shards.length > 1);
  for (const s of shards) assert.ok(JSON.stringify(s).length <= 8000);
  assert.equal(shards.flat().length, 30);
  const one = slim(targets[0]);
  assert.deepEqual(Object.keys(one).sort(), ['holdout', 'id', 'language', 'repo', 'sha', 'subdir', 'tools']);
  assert.deepEqual(one.tools[0], ['tool_number_0', 0]);
  assert.deepEqual(one.tools[1], ['tool_number_1']);
});

test('R-AG-10: this repository\'s own source reader finds no tool in the oracle\'s code, so the zero-config job and --repo-dir . still read the three tools of the server', () => {
  const r = spawnSync(process.execPath, [join(root, 'bin/mcp-check.js'), '--repo-dir', join(root, 'corpus/ast-grep')], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /no tool definitions found/);
  const all = spawnSync(process.execPath, [join(root, 'bin/mcp-check.js'), '--repo-dir', root, '--format', 'json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(all.stdout).source.files, ['src/server.js']);
});
