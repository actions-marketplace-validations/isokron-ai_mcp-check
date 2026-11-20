// --repo-dir and RepoSource.fromDirectory: the --repo reading from a local folder, on the small server repositories in
// test/repos (TypeScript with zod, plain JavaScript literals, Python with the standalone fastmcp). No network, nothing run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.equal(unguarded.best.kind, 'committed', 'without the guards, a tools-list.json counts as a committed list (it ranks first)');
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
