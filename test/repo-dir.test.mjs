// --repo-dir and RepoSource.fromDirectory: the --repo reading from a local folder, on the small server repositories in
// test/repos (TypeScript with zod, plain JavaScript literals, Python with the standalone fastmcp). No network, nothing run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const repos = join(root, 'test', 'repos');
const cli = (args, opts = {}) => spawnSync(process.execPath, [join(root, 'bin', 'mcp-check.js'), ...args], { encoding: 'utf8', ...opts });
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]));
/** A copy of a fixture repository in a fresh temporary folder, to add files to. */
function copy(name) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-repo-'));
  cpSync(join(repos, name), dir, { recursive: true });
  return dir;
}
const REG = (n) => 'import { z } from "zod";\nserver.registerTool("' + n + '", { description: "d", inputSchema: { q: z.string() } }, async () => ({}));\n';

test('fromDirectory: TypeScript with zod 4 under SDK 1.32 reads as that SDK lists it', async () => {
  const r = await R.fromDirectory(join(repos, 'ts-zod'));
  assert.equal(r.via, 'directory');
  assert.equal(r.best.kind, 'source');
  assert.equal(r.best.fidelity, 'derived');
  assert.deepEqual(r.best.sdk, { kind: 'v1', version: '1.32.2', zod: 4, py: null });
  const t = byName(r.best.tools);
  assert.deepEqual(Object.keys(t), ['search_notes', 'delete_note']);
  assert.deepEqual(t.search_notes.inputSchema, {
    type: 'object', $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { query: { type: 'string', minLength: 1, description: 'Words to look for' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most notes to return' } },
    required: ['query'],
  });
  assert.deepEqual(t.delete_note.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(t.search_notes.execution, { taskSupport: 'forbidden' }, 'SDK 1.24 to 1.x adds execution to every tool');
  assert.deepEqual(r.best.where.map((w) => [w.name, w.path, w.line]), [['search_notes', 'src/tools/notes.ts', 5], ['delete_note', 'src/tools/notes.ts', 12]]);
});

test('fromDirectory: JavaScript tool literals for the low-level Server are read exactly', async () => {
  const r = await R.fromDirectory(join(repos, 'js-literal'));
  assert.equal(r.best.fidelity, 'literal');
  assert.equal(r.best.tools.length, 1);
  assert.deepEqual(r.best.tools[0], {
    name: 'get_forecast', title: 'Get forecast', description: 'Returns the forecast for a city for the next days.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' }, days: { type: 'integer', minimum: 1, maximum: 7, description: 'Days ahead' } }, required: ['city'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  });
});

test('fromDirectory: Python with the standalone fastmcp: no titles, closed arguments, docstring Args, _meta tags', async () => {
  const r = await R.fromDirectory(join(repos, 'py-fastmcp'));
  assert.equal(r.best.sdk.py, 'fastmcp');
  const t = byName(r.best.tools);
  assert.deepEqual(t.add_note.inputSchema, {
    properties: { title: { type: 'string', description: 'Short title of the note' }, text: { type: 'string', description: 'The note itself' }, pinned: { type: 'boolean', default: false, description: 'Keep the note at the top of the list' } },
    required: ['title', 'text'], type: 'object', additionalProperties: false,
  });
  assert.equal(t.add_note.description, 'Adds a note and returns its id.');
  assert.deepEqual(t.add_note._meta, { fastmcp: { tags: [] } });
  assert.deepEqual(t.list_notes.annotations, { readOnlyHint: true });
  assert.deepEqual(t.list_notes.outputSchema, { properties: { result: { type: 'array', items: { type: 'string' } } }, required: ['result'], type: 'object', 'x-fastmcp-wrap-result': true });
});

test('fromDirectory: never enters node_modules or .git, skips vendor and dist, does not follow symlinks or read oversized files', async () => {
  const dir = copy('ts-zod');
  for (const d of ['node_modules/pkg', '.git/hooks', 'vendor/lib', 'dist', '.venv/lib']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), REG('from_node_modules'));
  writeFileSync(join(dir, '.git', 'hooks', 'tool.js'), REG('from_git'));
  writeFileSync(join(dir, 'vendor', 'lib', 'server.js'), REG('from_vendor'));
  writeFileSync(join(dir, 'dist', 'index.js'), REG('from_dist'));
  writeFileSync(join(dir, '.venv', 'lib', 'tools.py'), '@mcp.tool\ndef from_venv(a: str) -> str:\n    """x"""\n');
  const outside = mkdtempSync(join(tmpdir(), 'mcpcheck-outside-'));
  writeFileSync(join(outside, 'tools.ts'), REG('from_symlink'));
  symlinkSync(outside, join(dir, 'src', 'linked'));
  symlinkSync(join(outside, 'tools.ts'), join(dir, 'src', 'linked-tools.ts'));
  writeFileSync(join(dir, 'src', 'big-tools.ts'), REG('from_big') + '// ' + 'x'.repeat(1600 * 1024) + '\n');
  const r = await R.fromDirectory(dir);
  assert.deepEqual(r.best.tools.map((t) => t.name).sort(), ['delete_note', 'search_notes']);
  assert.equal(r.best.built, false);
  assert.equal(r.truncated, false);
});

test('fromDirectory: build output and vendor are read only when no source file defines a tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-built-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@modelcontextprotocol/sdk': '1.20.0', zod: '3.25.0' } }));
  writeFileSync(join(dir, 'dist', 'index.js'), REG('only_built'));
  const r = await R.fromDirectory(dir);
  assert.deepEqual(r.best.tools.map((t) => t.name), ['only_built']);
  assert.equal(r.best.built, true);
  assert.equal(r.best.tools[0].inputSchema.additionalProperties, false, 'zod 3: closed objects, from the root package.json');
});

test('fromDirectory: exclude and skipIfContains leave out folders such as an earlier run\'s results; a committed list wins', async () => {
  const dir = copy('ts-zod');
  mkdirSync(join(dir, 'mcp-check-results')); mkdirSync(join(dir, 'old-results'));
  const stale = JSON.stringify({ tools: [{ name: 'stale', inputSchema: { type: 'object' } }] });
  writeFileSync(join(dir, 'mcp-check-results', 'tools-list.json'), stale);
  writeFileSync(join(dir, 'old-results', 'tools-list.json'), stale);
  writeFileSync(join(dir, 'old-results', '.mcp-check-results'), 'x');
  const r = await R.fromDirectory(dir, { exclude: ['mcp-check-results'], skipIfContains: '.mcp-check-results' });
  assert.equal(r.best.kind, 'source');
  assert.ok(!r.candidates.some((c) => c.tools.some((t) => t.name === 'stale')));
  const unguarded = await R.fromDirectory(dir);
  assert.equal(unguarded.best.kind, 'source', 'without the guards, the two leftover tools-list.json files are several committed lists: neither is picked');
  assert.deepEqual(unguarded.hints.lists.map((x) => x.path).sort(), ['mcp-check-results/tools-list.json', 'old-results/tools-list.json']);
  writeFileSync(join(dir, 'old-results', 'tools-list.json'), '[]');
  assert.equal((await R.fromDirectory(dir)).best.kind, 'committed', 'one committed list still ranks first');
});

test('fromDirectory: a monorepo package reads the SDK version from the workspace root', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-mono-'));
  mkdirSync(join(ws, 'packages', 'server', 'src'), { recursive: true });
  writeFileSync(join(ws, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@modelcontextprotocol/sdk': { version: '1.30.0' }, 'node_modules/zod': { version: '4.0.5' } } }));
  writeFileSync(join(ws, 'packages', 'server', 'src', 'index.ts'), 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n' + REG('mono'));
  const alone = await R.fromDirectory(join(ws, 'packages', 'server'));
  const withRoot = await R.fromDirectory(join(ws, 'packages', 'server'), { rootDir: ws });
  assert.equal(alone.best.sdk.version, null);
  assert.equal(withRoot.best.sdk.version, '1.30.0');
  assert.deepEqual(withRoot.best.tools[0].execution, { taskSupport: 'forbidden' });
  await assert.rejects(R.fromDirectory(join(ws, 'nope')), (e) => e.code === 'not_found');
  await assert.rejects(R.fromDirectory(join(ws, 'package-lock.json')), (e) => e.code === 'not_found' && /Not a folder/.test(e.message));
});

test('reader: a same-file helper that passes a name and config on to registerTool is read as registerTool', () => {
  const code = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    'function register(server: McpServer, name: string, config: any, fn: Handler) { DEFS.push(name); server.registerTool(name, config, wrap(fn)); }',
    'const reg = async (name, cfg) => srv.registerTool(name, cfg, async () => ({}));',
    'function other(name, config) { log(name, config); }',
    'register(server, "first", { title: "First", description: "One", inputSchema: z.strictObject({ a: z.string() }), annotations: { readOnlyHint: true } }, fn);',
    'reg("second", { description: "Two", inputSchema: { b: z.number() } });',
    'other("not_a_tool", { description: "x", inputSchema: {} });',
    'register(server, dynamicName, { description: "x" }, fn);',
  ].join('\n');
  const t = byName(R.extractFromFile('server.ts', code, { sdk: { kind: 'v1', version: '1.20.0', zod: 3 } }).map((x) => x.tool));
  assert.deepEqual(Object.keys(t), ['first', 'second']);
  assert.deepEqual(t.first.inputSchema, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' });
  assert.deepEqual(t.first.annotations, { readOnlyHint: true });
  assert.equal(t.first.title, 'First');
  assert.deepEqual(t.second.inputSchema.required, ['b']);
});

test('cli: --repo-dir grades a local folder and prints the Source line; this repository reads as its own three tools', () => {
  const r = cli(['--repo-dir', join(repos, 'ts-zod')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Source: local folder .*ts-zod \(read statically, nothing was run\), derived: /m);
  assert.match(r.stderr, /found 2 tools in /);
  const j = JSON.parse(cli(['--repo-dir', root, '--format', 'json']).stdout);
  assert.equal(j.source.kind, 'dir');
  assert.deepEqual(j.source.files, ['src/server.js']);
  assert.equal(j.input.tools, 3);
  assert.equal(j.sections.anthropic.grade, 'A');
});

test('cli: --repo-dir exit codes: 3 with advice when nothing is found, 2 for a missing folder or a second input', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mcpcheck-empty-'));
  writeFileSync(join(empty, 'README.md'), '# not a server\n');
  const none = cli(['--repo-dir', empty]);
  assert.equal(none.status, 3);
  assert.match(none.stderr, /no tool definitions found in .* Grade the live list instead: start the server with --command "<start command>", or give a saved tools\/list file \(in the GitHub Action: set command or tools-file\)\./);
  assert.equal(cli(['--repo-dir', join(empty, 'missing')]).status, 2);
  assert.throws(() => parseArgs(['--repo-dir', '.', '--repo', 'github.com/a/b']), /give one input/);
  assert.throws(() => parseArgs(['--repo-dir', '.', '--github-token-env', 'T']), /--github-token-env goes with --repo or --registry/);
  assert.equal(parseArgs(['--repo-dir', 'x']).repoDir, 'x');
});

test('mcp-catalog-snap: a .mcp-catalog snapshot is an exact committed list, ahead of the code; shapes that are not one are ignored', async () => {
  const r = await R.fromDirectory(join(repos, 'catalog-snap'));
  assert.equal(r.best.kind, 'catalog');
  assert.equal(r.best.fidelity, 'exact');
  assert.equal(r.best.path, '.mcp-catalog/tickets.json');
  assert.equal(r.best.server, 'tickets');
  assert.deepEqual(r.best.tools.map((t) => t.name), ['ticket_get', 'ticket_create']);
  assert.ok(r.candidates.some((c) => c.kind === 'source'), 'the code is read too, ranked below');
  const withoutSnap = await R.fromDirectory(join(repos, 'catalog-snap'), { exclude: ['.mcp-catalog/tickets.json'] });
  assert.equal(withoutSnap.best.kind, 'source', 'an excluded file (a baseline) is not read');
  const text = readFileSync(join(repos, 'catalog-snap', '.mcp-catalog', 'tickets.json'), 'utf8');
  assert.equal(R.fromCatalogSnap(text).tools.length, 2);
  const j = JSON.parse(text);
  assert.equal(R.fromCatalogSnap(JSON.stringify({ ...j, capturedWith: 'other-tool/1', format: 'x' })), null, 'not written by mcp-catalog-snap');
  assert.equal(R.fromCatalogSnap(JSON.stringify({ ...j, capturedWith: undefined, format: 'mcp-catalog-snap/2' })).tools.length, 2, 'format alone identifies it');
  assert.equal(R.fromCatalogSnap(JSON.stringify({ ...j, catalog: { tools: [] } })), null);
  assert.deepEqual(R.planFiles(['.mcp-catalog/a.json', 'test/.mcp-catalog/b.json', 'x/.mcp-catalog/c.json', '.mcp-catalog/sub/d.json']).exact, ['.mcp-catalog/a.json', 'x/.mcp-catalog/c.json']);
  const j2 = JSON.parse(cli(['--repo-dir', join(repos, 'catalog-snap'), '--format', 'json']).stdout);
  assert.match(j2.source.provenance, /^exact: committed mcp-catalog-snap snapshot \.mcp-catalog\/tickets\.json/);
});

test('fromGitHub reads an .mcp-catalog snapshot too (sea-lite\'s layout)', async () => {
  const snap = readFileSync(join(repos, 'catalog-snap', '.mcp-catalog', 'tickets.json'), 'utf8');
  const fetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
    if (url === 'https://api.github.com/repos/o/r') return ok(JSON.stringify({ default_branch: 'main' }));
    if (url.startsWith('https://api.github.com/repos/o/r/git/trees/')) return ok(JSON.stringify({ sha: 'abc', truncated: false, tree: [{ type: 'blob', path: '.mcp-catalog/sea-lite.json', size: snap.length }, { type: 'blob', path: 'README.md', size: 10 }] }));
    if (url.endsWith('/.mcp-catalog/sea-lite.json')) return ok(snap);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const r = await R.fromGitHub('github.com/o/r', { fetch });
  assert.equal(r.best.kind, 'catalog');
  assert.equal(r.best.tools.length, 2);
});

test('fromDirectory: tools.json under test/ or tests/ is a fixture, not the server\'s list', async () => {
  const dir = copy('ts-zod');
  for (const d of ['test', 'tests', 'pkg/__tests__']) { mkdirSync(join(dir, d), { recursive: true }); writeFileSync(join(dir, d, 'tools.json'), JSON.stringify({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] })); }
  const r = await R.fromDirectory(dir);
  assert.equal(r.best.kind, 'source');
  assert.ok(!r.candidates.some((c) => c.kind === 'committed'));
});

test('fromDirectory: over the listing limit it says truncated, and lists likely source folders and shallow files first', async () => {
  const dir = copy('ts-zod');
  mkdirSync(join(dir, 'aaa', 'deep'), { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(join(dir, 'aaa', 'deep', 'f' + i + '.txt'), 'x');
  const r = await R.fromDirectory(dir, { maxList: 10 });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.best.tools.map((t) => t.name), ['search_notes', 'delete_note'], 'src/ was listed before aaa/deep');
  assert.equal((await R.fromDirectory(dir)).truncated, false);
  const { sourceLine } = await import('../src/inputs/collect.js');
  assert.match(sourceLine({ kind: 'dir', dir: '.', provenance: 'derived: x', truncated: true }), /the folder holds more files than the listing limit, so the deepest were not read$/);
});

// ------------------------------------------------------------ snapshot ownership and file order
const SNAP = (server, tools) => JSON.stringify({ capturedWith: 'mcp-catalog-snap/0.3.0', format: 'mcp-catalog-snap/2', server: { name: server, version: '1' }, catalog: { prompts: [], resourceTemplates: [], tools: tools.map((n) => ({ name: n, description: 'd', inputSchema: { type: 'object' } })) } });
function snapRepo({ pkg = null, src = null, snaps = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-snap-'));
  mkdirSync(join(dir, '.mcp-catalog'));
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
  if (src) { mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'server.ts'), src); }
  for (const [f, body] of Object.entries(snaps)) writeFileSync(join(dir, '.mcp-catalog', f), body);
  return dir;
}
const SRC = "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst server = new McpServer({ name: 'notes', version: '1' });\nserver.registerTool('note_get', { description: 'd', inputSchema: {} }, async () => ({}));\n";

test('snapshots: a matching server name wins over source; names compare without case, scope or mcp affix', async () => {
  for (const [pkg, server] of [['@acme/notes-mcp', 'Notes'], ['mcp-notes', 'notes'], ['notes', 'NOTES-MCP']]) {
    const r = await R.fromDirectory(snapRepo({ pkg, src: SRC.replace("name: 'notes'", "name: 'unrelated'"), snaps: { 'x.json': SNAP(server, ['a', 'b']) } }));
    assert.equal(r.best.kind, 'catalog', pkg + ' / ' + server);
    assert.ok(!r.best.foreign);
  }
  const fromCtor = await R.fromDirectory(snapRepo({ src: SRC, snaps: { 'notes.json': SNAP('notes', ['a']) } }));
  assert.equal(fromCtor.best.kind, 'catalog', 'the McpServer({ name }) of the source counts without a package.json');
  assert.deepEqual([...R.ownServerNames(new Map([['srv.py', 'mcp = FastMCP("Py Notes")'], ['pyproject.toml', '[project]\nname = "py-notes-mcp"\n']]))], ['py-notes']);
  assert.equal(R.normName('@scope/MCP-Thing_Server-mcp'), 'thing-server');
});

test('snapshots: one of another server is never chosen over source; alone it is used and marked; several are not used', async () => {
  const withSrc = await R.fromDirectory(snapRepo({ pkg: 'notes', src: SRC, snaps: { 'github.json': SNAP('github', ['u1', 'u2', 'u3']) } }));
  assert.equal(withSrc.best.kind, 'source');
  assert.ok(!withSrc.candidates.some((c) => c.kind === 'catalog'));
  assert.deepEqual(withSrc.hints.foreignSnapshots, [{ path: '.mcp-catalog/github.json', server: 'github' }]);
  const single = await R.fromDirectory(snapRepo({ pkg: 'notes', snaps: { 'github.json': SNAP('github', ['u1']) } }));
  assert.equal(single.best.kind, 'catalog');
  assert.equal(single.best.foreign, true);
  const several = await R.fromDirectory(snapRepo({ pkg: 'notes', snaps: { 'github.json': SNAP('github', ['u1']), 'slack.json': SNAP('slack', ['s1']) } }));
  assert.equal(several.best, null);
  assert.equal(several.hints.foreignSnapshots.length, 2);
  const none = cli(['--repo-dir', snapRepo({ pkg: 'notes', snaps: { 'github.json': SNAP('github', ['u1']), 'slack.json': SNAP('slack', ['s1']) } })]);
  assert.equal(none.status, 3);
  assert.match(none.stderr, /Not used: 2 mcp-catalog-snap snapshots of other servers/);
  const one = JSON.parse(cli(['--repo-dir', snapRepo({ pkg: 'notes', snaps: { 'github.json': SNAP('github', ['u1']) } }), '--format', 'json']).stdout);
  assert.match(one.source.provenance, /snapshot \.mcp-catalog\/github\.json of github, which may not be this repository's server/);
});

test('snapshots: sea-lite over GitHub: its snapshot names sea-lite, as its package.json does, so it is the exact list', async () => {
  const snap = SNAP('sea-lite', ['sea_get', 'sea_claim']);
  const files = { '.mcp-catalog/sea-lite.json': snap, 'package.json': JSON.stringify({ name: 'sea-lite', dependencies: { '@modelcontextprotocol/sdk': '1.29.0', zod: '4.1.0' } }), 'src/server.ts': SRC.replace(/notes/g, 'sea-lite').replace('note_get', 'sea_from_source') };
  const fetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
    if (url === 'https://api.github.com/repos/isokron-ai/sea-lite') return ok(JSON.stringify({ default_branch: 'main' }));
    if (url.startsWith('https://api.github.com/repos/isokron-ai/sea-lite/git/trees/')) return ok(JSON.stringify({ sha: 'abc', truncated: false, tree: Object.keys(files).map((path) => ({ type: 'blob', path, size: files[path].length })) }));
    const hit = Object.keys(files).find((p) => url.endsWith('/abc/' + p.split('/').map(encodeURIComponent).join('/')));
    return hit ? ok(files[hit]) : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const r = await R.fromGitHub('github.com/isokron-ai/sea-lite', { fetch });
  assert.equal(r.best.kind, 'catalog');
  assert.ok(!r.best.foreign);
  assert.deepEqual(r.best.tools.map((t) => t.name), ['sea_get', 'sea_claim']);
});

test('--repo-dir and --repo read the same source files, whatever order the listing has', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-order-'));
  const files = {};
  for (const d of ['b', 'a/z', 'c', 'a']) for (let i = 0; i < 3; i++) files[d + '/f' + i + '.ts'] = 'server.registerTool("t_' + d.replace('/', '_') + '_' + i + '", { description: "d", inputSchema: {} }, async () => ({}));\n';
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); }
  const local = await R.fromDirectory(dir, { maxSourceFiles: 4 });
  const shuffled = Object.keys(files).sort(() => 0.5 - Math.random()).reverse();
  const fetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
    if (url === 'https://api.github.com/repos/o/r') return ok(JSON.stringify({ default_branch: 'main' }));
    if (url.includes('/git/trees/')) return ok(JSON.stringify({ sha: 's', tree: shuffled.map((path) => ({ type: 'blob', path, size: 10 })) }));
    const hit = Object.keys(files).find((p) => url.endsWith('/s/' + p));
    return hit ? ok(files[hit]) : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const remote = await R.fromGitHub('github.com/o/r', { fetch, maxSourceFiles: 4 });
  assert.deepEqual(local.best.files.slice().sort(), remote.best.files.slice().sort());
  assert.deepEqual(local.best.tools.map((t) => t.name), remote.best.tools.map((t) => t.name));
  assert.equal(local.best.tools.length, 4);
});

// ------------------------------------------------------------ 1.1.1: one server or several, names only, approximate
/** A workspace with packages/<name> servers, each registering the given tools; returns its folder. */
function mono(pkgs, rootManifest = true) {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-mono2-'));
  if (rootManifest) writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'mono', private: true }));
  for (const [dir, tools, ctor = true] of pkgs) {
    mkdirSync(join(ws, dir, 'src'), { recursive: true });
    writeFileSync(join(ws, dir, 'package.json'), JSON.stringify({ name: dir.split('/').pop() }));
    writeFileSync(join(ws, dir, 'src', 'index.ts'), 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\n'
      + (ctor ? 'const server = new McpServer({ name: "' + dir + '", version: "1" });\n' : '') + tools.map((n) => 'server.registerTool("' + n + '", { description: "d", inputSchema: { q: z.string() } }, async () => ({}));\n').join(''));
  }
  return ws;
}

test('reader: tools of several packages are not merged; one package is graded; admin, docs and eval packages are set aside', async () => {
  const two = await R.fromDirectory(mono([['src/files', ['read_file', 'write_file']], ['src/memory', ['create_entities']]]));
  assert.equal(two.best, null, 'no merged list');
  assert.deepEqual(two.hints.servers, [{ path: 'src/files', tools: 2, constructor: true }, { path: 'src/memory', tools: 1, constructor: true }]);
  // A package with a constructor and no tools (a stub) is dropped when another package has tools.
  const ctorOnly = await R.fromDirectory(mono([['packages/a', ['a_tool']], ['packages/b', []]]));
  assert.deepEqual(ctorOnly.best.tools.map((t) => t.name), ['a_tool']);
  // Admin, console, docs and eval packages are set aside when another package remains; their tools are listed as left out.
  const withDocs = await R.fromDirectory(mono([['apps/docs-server', ['search_docs']], ['packages/core', ['real_tool']]]));
  assert.deepEqual(withDocs.best.tools.map((t) => t.name), ['real_tool']);
  assert.deepEqual(withDocs.best.excluded.map((x) => [x.name, x.reasons]), [['search_docs', ['not-server-folder (apps/docs-server)']]]);
  const adminOnly = await R.fromDirectory(mono([['packages/admin-mcp', ['internal_stats']], ['packages/mcp', []]]));
  assert.equal(adminOnly.best, null, 'the admin package is never graded from the root');
  assert.equal(adminOnly.hints.serverWithoutTools, 'packages/mcp');
  assert.deepEqual(adminOnly.hints.ignoredFolders.map((x) => x.path), ['packages/admin-mcp']);
  // One package plus the root: one server, unchanged.
  const single = await R.fromDirectory(mono([['.', ['one', 'two']]].map(([d, t]) => [d, t])));
  assert.deepEqual(single.best.tools.map((t) => t.name), ['one', 'two']);
  assert.equal(single.hints.servers, undefined);
  assert.equal(R.notServerFolder('packages/admin-mcp'), false, 'whole folder names only, unless words is set');
  assert.equal(R.notServerFolder('packages/admin-mcp', true), true);
  assert.equal(R.notServerFolder('mcp-evals', true), true);
  assert.equal(R.notServerFolder('apps/docs'), true);
  assert.equal(R.notServerFolder('packages/mcp-server', true), false);
  assert.equal(R.notServerFolder('packages/administrator', true), false, 'whole words only');
});

test('reader: evaluation harnesses, benchmarks, playgrounds and web sites are not read as the server', async () => {
  const dir = copy('ts-zod');
  for (const d of ['evals/selection', 'bench', 'playground', 'website/src', 'e2e']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'harness.ts'), 'export const tools = [{ name: "write_file", description: "Writes a file.", inputSchema: { type: "object" } }];\nserver.registerTool("phantom_' + d.replace(/\W/g, '_') + '", { description: "x", inputSchema: {} }, async () => ({}));\n');
  }
  const r = await R.fromDirectory(dir);
  assert.deepEqual(r.best.tools.map((t) => t.name).sort(), ['delete_note', 'search_notes']);
});

test('reader: several committed lists in different folders are not picked from; the language of a Go server is named', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-lists-'));
  for (const d of ['lists/slack', 'lists/github']) { mkdirSync(join(ws, d), { recursive: true }); writeFileSync(join(ws, d, 'tools.json'), JSON.stringify({ tools: [{ name: d.split('/')[1] + '_x', inputSchema: { type: 'object' } }] })); }
  const r = await R.fromDirectory(ws);
  assert.equal(r.best, null);
  assert.deepEqual(r.hints.lists.map((x) => x.path).sort(), ['lists/github/tools.json', 'lists/slack/tools.json']);
  const go = mkdtempSync(join(tmpdir(), 'mcpcheck-go-'));
  writeFileSync(join(go, 'main.go'), 'package main\n'); writeFileSync(join(go, 'tools.go'), 'package main\n'); writeFileSync(join(go, 'tools_test.go'), 'package main\n');
  const g = await R.fromDirectory(go);
  assert.deepEqual(g.hints.otherLanguages, [{ name: 'Go', files: 2, readFiles: 0 }]);
});

test('cli: --repo-dir with several servers exits 3 and names the folders; pointed into one package it grades that one', () => {
  const ws = mono([['src/files', ['read_file']], ['src/memory', ['create_entities']]]);
  const r = cli(['--repo-dir', ws]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /found tool definitions of more than one server in .*: src\/files \(server constructor, 1 tool\), src\/memory \(server constructor, 1 tool\)\. Nothing was merged or picked\. Check one server at a time \(--repo-dir .*\/src\/files, --repo-dir .*\/src\/memory\), or grade the live list instead/);
  const one = cli(['--repo-dir', join(ws, 'src', 'memory'), '--format', 'json']);
  assert.equal(one.status, 0, one.stderr);
  const j = JSON.parse(one.stdout);
  assert.equal(j.input.tools, 1);
  assert.equal(j.source.approximate, true);
});

test('cli: names-only lists are never graded (exit 3, same advice as the Action); text output of a source read says approximate', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-names-'));
  writeFileSync(join(ws, 'manifest.json'), JSON.stringify({ manifest_version: '0.2', name: 'x', server: { type: 'node', entry_point: 'server/index.js' }, tools: [{ name: 'search', description: 'Searches.' }] }));
  const r = cli(['--repo-dir', ws, '--min-grade', 'F']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /only tool names were found in .* \(manifest\.json lists names and descriptions without schemas\), which cannot be graded\. Grade the live list instead: start the server with --command "<start command>", or give a saved tools\/list file/);
  assert.equal(r.stdout, '');
  const t = cli(['--repo-dir', join(repos, 'ts-zod')]);
  assert.match(t.stdout, /^Approximate: read from source, not the server's live list\. For exact grades, run the server \(--command "<start command>"\) or grade a saved tools\/list file\.$/m);
  const md = cli(['--repo-dir', join(repos, 'ts-zod'), '--format', 'md']);
  assert.match(md.stdout, /Approximate: read from source, not the server's live list\./);
  // An exact committed list is not approximate.
  const snap = JSON.parse(cli(['--repo-dir', join(repos, 'catalog-snap'), '--format', 'json']).stdout);
  assert.equal(snap.source.approximate, false);
  assert.ok(!/Approximate/.test(cli(['--repo-dir', join(repos, 'catalog-snap')]).stdout));
});

test('cli: a Go or C# repository with no tool definition exits 3 and names the forms read; a Swift one says it is not read yet', () => {
  const go = mkdtempSync(join(tmpdir(), 'mcpcheck-go-'));
  writeFileSync(join(go, 'main.go'), 'package main\n');
  const r = cli(['--repo-dir', go]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /The source here is Go \(1 \.go file\): no tool definition the reader knows was found in it/);
  const cs = mkdtempSync(join(tmpdir(), 'mcpcheck-cs-'));
  writeFileSync(join(cs, 'Program.cs'), 'class P {}\n');
  const c = cli(['--repo-dir', cs]);
  assert.equal(c.status, 3);
  assert.match(c.stderr, /The source here is C# \(1 \.cs file\): no tool definition the reader knows was found in it \(the official C# SDK's \[McpServerTool\] methods/);
  const sw = mkdtempSync(join(tmpdir(), 'mcpcheck-swift-'));
  writeFileSync(join(sw, 'main.swift'), 'print("hi")\n');
  const w = cli(['--repo-dir', sw]);
  assert.equal(w.status, 3);
  assert.match(w.stderr, /The source here is Swift \(1 \.swift file\): Swift source is not read yet \(the reader reads TypeScript, JavaScript, Python, Go, Rust and C#\)/);
});

/** A folder holding the given files (path -> text). */
function tree(files) {
  const d = mkdtempSync(join(tmpdir(), 'mcpcheck-tree-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), t); }
  return d;
}
const PKG = (name) => JSON.stringify({ name, dependencies: { '@modelcontextprotocol/sdk': '1.20.0', zod: '3.25.0' } });
const SERVER = (tools) => "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { z } from 'zod';\nexport const server = new McpServer({ name: 'notes', version: '1' });\n" + tools.map((t) => "server.registerTool('" + t + "', { title: '" + t + "', description: 'Does " + t + ".', inputSchema: { id: z.string() } }, async () => ({ content: [] }));\n").join('');
const REG_ONLY = (tools) => "import { z } from 'zod';\nimport type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport function registerTools(server: McpServer) {\n" + tools.map((t) => "  server.registerTool('" + t + "', { title: '" + t + "', description: 'Does " + t + ".', inputSchema: { id: z.string() } }, async () => ({ content: [] }));\n").join('') + '}\n';
const CLIENT_LIT = "import OpenAI from 'openai';\nconst tools = [{ name: 'lookup_order', description: 'Look up an order for the chat demo.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }];\nexport async function ask(q) { return new OpenAI().responses.create({ input: q, tools }); }\n";
const PY_SERVER = 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("notes")\n\n@mcp.tool()\ndef add_note(text: str) -> str:\n    """Add a note."""\n    return text\n';
const names = (r) => (r.best ? r.best.tools.map((t) => t.name).sort() : null);

test('reader: a monorepo with one server is graded (S1 to S7 of the 1.1.1 review)', async () => {
  // S1: a server package and a client package with a bare tool literal: the server is graded, the literal set aside.
  const s1 = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': SERVER(['add_note', 'get_note']), 'packages/client/package.json': PKG('c'), 'packages/client/src/tools.ts': CLIENT_LIT }));
  assert.deepEqual(names(s1), ['add_note', 'get_note']);
  assert.deepEqual(s1.best.excluded.map((x) => [x.name, x.reasons]), [['lookup_order', ['not-server-package (packages/client)']]]);
  // S2: a root manifest and one server package.
  const s2 = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': SERVER(['add_note', 'get_note']) }));
  assert.deepEqual(names(s2), ['add_note', 'get_note']);
  // S3: the server package constructs, a tools package registers.
  const s3 = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { registerTools } from '@notes/tools';\nconst server = new McpServer({ name: 'notes', version: '1' });\nregisterTools(server);\n", 'packages/tools/package.json': PKG('@notes/tools'), 'packages/tools/src/index.ts': REG_ONLY(['add_note', 'get_note']) }));
  assert.deepEqual(names(s3), ['add_note', 'get_note']);
  // S3b: the same with a tool in the server package too: the registrations package is graded with it.
  const s3b = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': SERVER(['ping']), 'packages/tools/package.json': PKG('@notes/tools'), 'packages/tools/src/index.ts': REG_ONLY(['add_note']) }));
  assert.deepEqual(names(s3b), ['add_note', 'ping']);
  // S4: a stub package that constructs a server with no tools.
  const s4 = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': SERVER(['add_note']), 'packages/inspector/package.json': PKG('i'), 'packages/inspector/src/main.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst s = new McpServer({ name: 'stub', version: '1' });\n" }));
  assert.deepEqual(names(s4), ['add_note']);
  // S5: the only server lives in a folder named like admin-mcp: graded (nothing else constructs a server).
  const s5 = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/admin-mcp/package.json': PKG('a'), 'packages/admin-mcp/src/index.ts': SERVER(['list_users']) }));
  assert.deepEqual(names(s5), ['list_users']);
  // S6: a Python server and a Python client package with tool dicts.
  const s6 = await R.fromDirectory(tree({ 'pyproject.toml': '[project]\nname = "notes"\ndependencies = ["mcp>=1.9"]\n', 'src/notes/server.py': PY_SERVER, 'clients/py/pyproject.toml': '[project]\nname = "notes-client"\n', 'clients/py/notes_client/tools.py': 'TOOLS = [{"name": "lookup", "description": "d", "inputSchema": {"type": "object", "properties": {}}}]\n' }));
  assert.deepEqual(names(s6), ['add_note']);
  // S7: a docs site package (site/) with a demo server is set aside.
  const s7 = await R.fromDirectory(tree({ 'package.json': PKG('notes'), 'src/index.ts': SERVER(['add_note']), 'site/package.json': PKG('site'), 'site/src/demo.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst s = new McpServer({ name: 'demo', version: '1' });\ns.registerTool('demo_tool', { description: 'Demo.', inputSchema: {} }, async () => ({ content: [] }));\n" }));
  assert.deepEqual(names(s7), ['add_note']);
  // Two packages that each construct a server and have tools: refused.
  const two = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/a/package.json': PKG('a'), 'packages/a/src/index.ts': SERVER(['a1']), 'packages/b/package.json': PKG('b'), 'packages/b/src/index.ts': SERVER(['b1']) }));
  assert.equal(two.best, null);
  assert.deepEqual(two.hints.servers.map((x) => x.path), ['packages/a', 'packages/b']);
  // One constructor (say in a shared library) and two or more packages of registrations: they may be servers whose
  // constructor was not read, so nothing is graded.
  const shared = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/common/package.json': PKG('common'), 'packages/common/src/index.ts': SERVER(['whoami']), 'apps/a/package.json': PKG('a'), 'apps/a/src/index.ts': REG_ONLY(['a1']), 'apps/b/package.json': PKG('b'), 'apps/b/src/index.ts': REG_ONLY(['b1']) }));
  assert.equal(shared.best, null);
  assert.deepEqual(shared.hints.servers.map((x) => x.path), ['packages/common', 'apps/a', 'apps/b']);
  // No constructor anywhere: two packages with SDK registrations are refused; registrations beat a bare literal.
  const noCtor = await R.fromDirectory(tree({ 'packages/a/package.json': PKG('a'), 'packages/a/src/index.ts': REG_ONLY(['a1']), 'packages/b/package.json': PKG('b'), 'packages/b/src/index.ts': REG_ONLY(['b1']) }));
  assert.equal(noCtor.best, null);
  const regVsLit = await R.fromDirectory(tree({ 'packages/a/package.json': PKG('a'), 'packages/a/src/index.ts': REG_ONLY(['a1']), 'packages/b/package.json': PKG('b'), 'packages/b/src/tools.ts': CLIENT_LIT }));
  assert.deepEqual(names(regVsLit), ['a1']);
});

test('reader: of several committed lists the root-most (or the one in the server package) is used and the others named; --compare is never the list', async () => {
  const L = (n) => JSON.stringify({ tools: [{ name: n, inputSchema: { type: 'object' } }] });
  const root = await R.fromDirectory(tree({ 'tools.json': L('current'), 'release/tools.json': L('old') }));
  assert.equal(root.best.kind, 'committed');
  assert.deepEqual(names(root), ['current']);
  assert.deepEqual(root.best.notUsed, ['release/tools.json']);
  const inPkg = await R.fromDirectory(tree({ 'package.json': PKG('root'), 'packages/server/package.json': PKG('s'), 'packages/server/src/index.ts': SERVER(['add_note']), 'packages/server/tools.json': L('add_note'), 'packages/other/tools.json': L('other') }));
  assert.equal(inPkg.best.kind, 'committed');
  assert.equal(inPkg.best.path, 'packages/server/tools.json');
  const j = JSON.parse(cli(['--repo-dir', tree({ 'tools.json': L('current'), 'release/tools.json': L('old') }), '--format', 'json']).stdout);
  assert.match(j.source.provenance, /committed tool list tools\.json \(of 2 committed lists, the one nearest the server; not used: release\/tools\.json\)/);
  // --compare names a list inside the folder: it is left out of the reading, so the code is compared with it.
  const d = tree({ 'package.json': PKG('notes'), 'src/index.ts': SERVER(['add_note']), 'release/tools.json': L('add_note') });
  const cmp = cli(['--repo-dir', d, '--compare', join(d, 'release', 'tools.json'), '--format', 'json']);
  assert.equal(JSON.parse(cmp.stdout).source.from, 'source', cmp.stderr);
});
