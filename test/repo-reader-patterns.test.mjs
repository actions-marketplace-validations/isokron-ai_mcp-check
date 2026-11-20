// --repo / --repo-dir 1.2 reader patterns, each on a small synthetic source (no real server's text): tool names held in
// constants and imports, factories, keyed tables and classes, Python decorators, registries and low-level Tool(...),
// FastMCP mounts, unreadable parts skipped by the grader, the file pre-filter, subfolder listing, Go and Rust names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { analyseList, gradeFindings, UNKNOWN_MARK } from '../src/unreadable.js';
import { repoProvenance, scannedText } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const M = require('../engine/core.js');
const R = require('../src/inputs/repo-source.cjs');

const names = (r) => r.tools.map((x) => x.tool.name).sort();
const tool = (r, n) => (r.tools.find((x) => x.tool.name === n) || {}).tool;
const repo = (files) => R.analyseRepo(new Map(Object.entries(files)));

// ------------------------------------------------------------ TypeScript names (D1)
test('TS names: a constant of the file, an imported and a re-exported constant, X.name, an enum member, x || "default"', () => {
  const r = repo({
    'src/names.ts': 'export const SEARCH = "search_docs" as const;\nexport enum Tools { Fetch = "fetch_page" }\n',
    'src/index.ts': 'export * from "./names.js";\n',
    'src/a.ts': 'import { SEARCH } from "./index.js";\nexport function reg(server) { server.registerTool(SEARCH, { description: "Search the docs.", inputSchema: {} }, h); }\n',
    'src/b.ts': 'import { Tools } from "./names.js";\nconst name = "echo";\nconst config = { description: "Echo it.", inputSchema: {} };\nexport function reg(server) { server.registerTool(name, config, h); server.registerTool(Tools.Fetch, { description: "Fetch." }, h); }\n',
    'src/c.ts': 'export const dataTool = { name: "get_data", description: "Get data.", parametersSchema: {} };\nexport function reg(server) { server.registerTool(dataTool.name, { description: dataTool.description, inputSchema: {} }, h); }\n',
    'src/d.ts': 'export function reg(server, toolName) { const id = toolName || "web_search"; server.registerTool(id, { description: "Web." }, h); server.registerTool(toolName || "web_fetch", { description: "Fetch." }, h); }\n',
  });
  assert.deepEqual(names(r), ['echo', 'fetch_page', 'get_data', 'search_docs', 'web_fetch', 'web_search']);
  assert.equal(tool(r, 'get_data').description, 'Get data.');
  assert.deepEqual(tool(r, 'echo').inputSchema.type, 'object');
});

test('TS names that cannot be read are counted, not guessed; a parameter of a helper is not a registration', () => {
  const r = repo({
    'src/a.ts': 'export function reg(server) { server.registerTool(computeName(), { description: "d" }, h); server.registerTool("known", { description: "Known tool." }, h); }\n'
      + 'export function wrap(server, name, cfg) { server.registerTool(name, cfg, h); }\n',
  });
  assert.deepEqual(names(r), ['known']);
  assert.equal(r.unresolved, 1);
  assert.match(repoProvenance({ fidelity: 'derived', unresolvedNames: 1 }).provenance, /1 registration with a name the reader could not resolve, not listed/);
});

// ------------------------------------------------------------ factories, keyed tables, helpers, classes (D7)
test('TS factories: defineTool(() => ({ … })) with a template description keeps the tool; the description is partial and marked', () => {
  const r = repo({
    'src/tools/pages.ts': 'import { zod } from "../third_party/index.js";\nexport const newPage = defineTool((args) => {\n  return {\n    name: "new_page",\n    description: `Open a page.${args.bg ? " In the background." : ""}`,\n    annotations: { readOnlyHint: false },\n    schema: { url: zod.string().describe("URL") },\n    handler: async () => {},\n  };\n});\n',
  });
  const t = tool(r, 'new_page');
  assert.ok(t, 'found');
  assert.equal(t.description, 'Open a page.…');
  assert.deepEqual(t._unreadable, ['description']);
  assert.equal(t.inputSchema.properties.url.type, 'string', 'zod found by its import binding (zod re-exported by the repository)');
});

test('TS keyed tables: { name: tool({ ...defs.name, description: async () => … }) } names the tool by its key', () => {
  const r = repo({
    'src/tools/docs.ts': 'import { z } from "zod";\nexport const defs = { search_docs: { parameters: z.object({ q: z.string() }), annotations: { readOnlyHint: true } } };\n'
      + 'export function getDocsTools() { return { search_docs: tool({ ...defs.search_docs, description: async () => load(), execute: async () => 1 }) }; }\n',
  });
  const t = tool(r, 'search_docs');
  assert.ok(t);
  assert.equal(t.inputSchema.properties.q.type, 'string');
  assert.deepEqual(t.annotations, { readOnlyHint: true });
  assert.deepEqual(t._unreadable, ['description']);
});

test('TS helpers named like a tool call: context.accountTool("name", { description, inputSchema }) is a registration', () => {
  const r = repo({ 'src/tools/browser.tools.ts': 'import { z } from "zod";\nexport function reg(context) {\n\tcontext.accountTool(\n\t\t"get_html",\n\t\t{\n\t\t\tdescription: "Get page HTML",\n\t\t\tinputSchema: z.object({ url: z.string() }),\n\t\t},\n\t\tasync () => {}\n\t)\n}\n' });
  assert.deepEqual(names(r), ['get_html']);
  // a call that only looks like one (no config with a description or schema) is not
  assert.deepEqual(names(repo({ 'src/x.ts': 'logger.trackTool("x", { count: 1 });\n' })), []);
});

test('TS classes: subclasses of a base that registers this.name are tools; Error classes and test classes are not', () => {
  const r = repo({
    'package.json': '{"name":"srv"}',
    'src/BaseTool.ts': 'export abstract class BaseTool { installTo(server) { return server.registerTool(this.name, { description: this.description, inputSchema: this.inputSchema, annotations: this.annotations }, h); } }\n',
    'src/tools/AreaTool.ts': 'import { z } from "zod";\nimport { BaseTool } from "../BaseTool.js";\nexport class AreaTool extends BaseTool<typeof S> {\n  readonly name = "area_tool";\n  readonly description = "Area of a polygon.";\n  readonly annotations = { readOnlyHint: true };\n  constructor() { super({ inputSchema: z.object({ geometry: z.array(z.number()) }) }); }\n}\n',
    'src/tools/FindTool.ts': 'import { BaseTool } from "../BaseTool.js";\nexport class FindTool extends BaseTool {\n  static toolName = "find";\n  public description = "Find documents.";\n  public argsShape() { return shape(); }\n}\n',
    'src/errors.ts': 'export class NotFound extends Error { name = "NotFound"; }\n',
    'src/mocks/mockTools.ts': 'import { BaseTool } from "../BaseTool.js";\nexport class TestTool extends BaseTool { name = "test-tool"; description = "t"; }\n',
  });
  assert.deepEqual(names(r), ['area_tool', 'find']);
  assert.equal(tool(r, 'area_tool').inputSchema.properties.geometry.type, 'array');
  assert.deepEqual(tool(r, 'find')._unreadable, ['inputSchema', 'annotations']);
});

test('TS schemas: a raw shape held in a constant is wrapped; a shape with a property named "type" is a shape, not a schema', () => {
  const r = repo({
    'src/a.ts': 'import { z } from "zod";\nconst askShape = { messages: z.array(z.string()), mode: z.string().optional() };\n'
      + 'export function reg(server) {\n  server.registerTool("ask", { description: "Ask a question.", inputSchema: askShape }, h);\n  server.registerTool("nav", { description: "Navigate.", inputSchema: { type: z.enum(["url", "back"]), url: z.string().optional() } }, h);\n}\n',
  });
  const ask = tool(r, 'ask'); const nav = tool(r, 'nav');
  assert.equal(ask.inputSchema.type, 'object');
  assert.deepEqual(ask.inputSchema.required, ['messages']);
  assert.equal(nav.inputSchema.type, 'object');
  assert.deepEqual(nav.inputSchema.properties.type.enum, ['url', 'back']);
});

test('TS: a template expression holding a regular expression with a quote does not swallow the rest of the file', () => {
  const src = 'const s = `printf \'${x.replace(/\'/g, "\'\\\\\'\'")}\'`;\nexport function reg(server) { server.tool("after_regex", "A tool after the template.", {}, h); }\n';
  assert.deepEqual(R.extractJs(src).map((x) => x.tool.name), ['after_regex']);
});

test('TS: a literal tool object only counts where code hands it on (argument, element, return, a used constant) (D4)', () => {
  const r = repo({
    'src/a.ts': 'const TOOLS = [{ name: "listed", description: "d", inputSchema: { type: "object" } }];\nserver.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));\n'
      + 'export const spareSchema = { name: "spare", description: "d", inputSchema: { type: "object" } };\n',
  });
  assert.deepEqual(names(r), ['listed']);
  assert.deepEqual(r.excluded.map((x) => x.tool.name), ['spare']);
});

test('conditions: a flag declared with default: true does not leave the tool out; a deprecated flag in the definition does', () => {
  const r = repo({
    'src/config.ts': 'export const options = { jsEval: { type: "boolean", default: true }, slim: { type: "boolean", default: false } };\n',
    'src/tools.ts': 'defineTool({ name: "evaluate", description: "Evaluate a script.", annotations: { conditions: ["jsEval"] }, schema: {} });\n'
      + 'defineTool({ name: "slim_eval", description: "Slim.", annotations: { conditions: ["slim"] }, schema: {} });\n'
      + 'defineTool({ name: "old_search", description: "Old.", deprecated: { replacement: "search" }, inputSchema: {} });\n'
      + 'defineTool({ name: "search", description: "Search.", inputSchema: {} });\n',
  });
  assert.deepEqual(names(r), ['evaluate', 'search']);
  assert.deepEqual(r.excluded.map((x) => x.tool.name).sort(), ['old_search', 'slim_eval']);
});

// ------------------------------------------------------------ Python (D8, D9 and FastMCP decorators)
test('Python: comments inside a decorator and a signature, Enum member names, constants for descriptions', () => {
  const src = 'from enum import Enum\nfrom mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\nclass GitTools(str, Enum):\n    STATUS = "git_status"\n\nDESC = (\n    "Shows the "\n    "working tree."\n)\n\n'
    + '@mcp.tool(\n    name=GitTools.STATUS.value,  # the wire name (see #12)\n    description=DESC,\n)\n# strict: no coercion\nasync def status(\n    repo_path: str,  # path (absolute)\n    verbose: bool = False,\n) -> str:\n    return ""\n';
  const t = R.extractPy(src).map((x) => x.tool);
  assert.equal(t.length, 1);
  assert.equal(t[0].name, 'git_status');
  assert.equal(t[0].description, 'Shows the working tree.');
  assert.deepEqual(t[0].inputSchema.required, ['repo_path']);
});

test('Python low-level Tool(...): names, descriptions, literal inputSchema and annotations; self.name from the handler class', () => {
  const src = 'from mcp import types\nfrom mcp.types import Tool, ToolAnnotations\nTOOL_LIST = "vault_list"\n'
    + 'search_tool = types.Tool(\n    name="search_papers",\n    annotations=ToolAnnotations(readOnlyHint=True),\n    description=(\n        "Search papers. "\n        "Returns a page."\n    ),\n    inputSchema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},\n)\n'
    + 'class ListHandler(ToolHandler):\n    def __init__(self):\n        super().__init__(TOOL_LIST)\n    def get_tool_description(self):\n        return Tool(\n            name=self.name,\n            description="List files.",\n            inputSchema={"type": "object", "properties": {}},\n        )\n';
  const t = Object.fromEntries(R.extractPy(src).map((x) => [x.tool.name, x.tool]));
  assert.deepEqual(Object.keys(t).sort(), ['search_papers', 'vault_list']);
  assert.equal(t.search_papers.description, 'Search papers. Returns a page.');
  assert.deepEqual(t.search_papers.inputSchema.required, ['query']);
  assert.deepEqual(t.search_papers.annotations, { readOnlyHint: true });
  assert.equal(t.vault_list.description, 'List files.');
});

test('Python registries: @tools.reader("…") methods that register a tool, @x_tool(...) decorators, x.tool(fn, name=), ToolDefinition(fn=)', () => {
  const r = repo({
    'pkg/registry.py': 'class ToolRegistry:\n    def reader(self, title):\n        return self._register(title)\n    def _register(self, title):\n        def decorate(fn):\n            self.server.tool(fn)\n            return fn\n        return decorate\n',
    'pkg/data_tools.py': 'def register(tools, ws):\n    @tools.reader("Read range")\n    def read_range(path: str, sheet: str) -> str:\n        """Read cell values."""\n        return ""\n',
    'pkg/discovery.py': 'from mcp.server.fastmcp import FastMCP\n@dbt_mcp_tool(description="Get models.", title="Models")\nasync def get_all_models(limit: int = 10) -> list[str]:\n    return []\n',
    'pkg/server.py': 'from mcp.server.fastmcp import FastMCP\nclass S:\n    def setup_tools(self):\n        async def find(query: str) -> str:\n            return ""\n        self.tool(find, name="store-find", description=self.settings.find_description)\n'
      + '        self.tool(other_fn)\n',
    'pkg/cli_tools.py': 'def build(select: str | None = None) -> str:\n    """Run build."""\n    return ""\ndef tools():\n    return [ToolDefinition(fn=wrap(build), title="dbt build")]\n',
  });
  assert.deepEqual(names(r), ['build', 'get_all_models', 'read_range', 'store-find']);
  assert.deepEqual(tool(r, 'read_range')._unreadable, ['annotations']);
  assert.ok(tool(r, 'store-find')._unreadable.includes('description'));
  assert.equal(tool(r, 'get_all_models').title, 'Models');
});

test('Python: FastMCP mount(namespace=) and import_server(prefix, …) prefix the names; shared function names are not alternatives', () => {
  const r = repo({
    'src/app/servers/jira.py': 'from fastmcp import FastMCP\njira_mcp = FastMCP("jira")\n@jira_mcp.tool(tags={"jira"})\nasync def get_issue(key: str) -> str:\n    return ""\n@jira_mcp.tool()\nasync def search(q: str) -> str:\n    return ""\n',
    'src/app/servers/wiki.py': 'from fastmcp import FastMCP\nwiki_mcp = FastMCP("wiki")\n@wiki_mcp.tool()\nasync def search(q: str) -> str:\n    return ""\n@wiki_mcp.tool()\nasync def get_page(id: str) -> str:\n    return ""\n',
    'src/app/servers/main.py': 'from fastmcp import FastMCP\nfrom .jira import jira_mcp\nfrom .wiki import wiki_mcp\nmain = FastMCP("main")\nmain.mount(jira_mcp, namespace="jira")\nmain.import_server("wiki", wiki_mcp)\n',
  });
  assert.deepEqual(names(r), ['jira_get_issue', 'jira_search', 'wiki_get_page', 'wiki_search']);
  assert.equal(r.excluded.length, 0);
});

test('Python: SDK 2 lists snake_case ToolAnnotations fields in camelCase; a namespace prefix variable is left off the name', () => {
  const src = 'from mcp.server.mcpserver import MCPServer\nfrom mcp.types import ToolAnnotations\nRO = ToolAnnotations(read_only_hint=True, open_world_hint=False)\n'
    + '@server.tool(name=namespace_prefix + "read_cypher", annotations=RO)\nasync def read(query: str) -> str:\n    """Read."""\n    return ""\n';
  const [t] = R.extractPy(src, { sdk: { pyMajor: 2 } }).map((x) => x.tool);
  assert.equal(t.name, 'read_cypher');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(R.extractPy(src, { sdk: { pyMajor: 1 } })[0].tool.annotations, { read_only_hint: true, open_world_hint: false });
  assert.equal(R.detectSdk(new Map([['uv.lock', '[[package]]\nname = "mcp"\nversion = "2.3.0"\n']])).pyMajor, 2);
});

// ------------------------------------------------------------ the pre-filter and the file limits (D9)
test('files are pre-filtered by content: a tool deep in a large repository is read; constants come from files that define none', () => {
  const files = {};
  for (let i = 0; i < 700; i++) files['src/util/a' + String(i).padStart(3, '0') + '.ts'] = 'export const x' + i + ' = ' + i + ';\n';
  files['src/zz/deep/names.ts'] = 'export const LATE = "late_tool";\n';
  files['src/zz/deep/late.ts'] = 'import { LATE } from "./names.js";\nexport function reg(server) { server.registerTool(LATE, { description: "Late." }, h); }\n';
  const r = repo(files);
  assert.deepEqual(names(r), ['late_tool']);
  assert.equal(r.candidates, 1);
  assert.equal(r.read, 702);
  assert.match(scannedText({ scanned: { read: 702, sourceTotal: 702, source: 1, candidates: 1 } }), /^scanned 702 of 702 source files/);
  assert.match(scannedText({ scanned: { read: 1500, sourceTotal: 3000, source: 400, candidates: 650 } }), /650 files may define a tool and the first 400 were read for tools/);
});

// ------------------------------------------------------------ unreadable parts are not graded (D5, D6)
test('an unreadable schema, description or annotations: their checks are skipped and the sections regraded', () => {
  const list = { tools: [
    { name: 'search_items', title: 'Search items', description: 'Search the items of a project. Use this when looking for one by text.', inputSchema: { type: 'object', [UNKNOWN_MARK]: true }, annotations: { readOnlyHint: true } },
    { name: 'delete_item', title: 'Delete item', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Item id' } }, required: ['id'], additionalProperties: false } },
  ] };
  const parsed = M.parseInput(JSON.stringify(list));
  const plain = M.analyse(M.parseInput(JSON.stringify(list)));
  const r = analyseList(parsed, { description: ['delete_item'], annotations: ['delete_item'] });
  assert.equal(r.unreadable.regraded, true);
  assert.equal(r.unreadable.inputSchema, 1);
  const ids = (x, n) => x.tools.find((t) => t.name === n).findings.map((f) => f.id);
  assert.ok(ids(plain, 'search_items').some((id) => /^schema-/.test(id)), 'graded as {} without the reader\'s marks');
  assert.ok(!ids(r, 'search_items').some((id) => /^(schema-(?!output-schema)|spec-input-schema)/.test(id)));
  assert.ok(ids(plain, 'delete_item').includes('anthropic-description'));
  assert.ok(!ids(r, 'delete_item').some((id) => /description|hint/.test(id)));
  assert.equal(r.sections.anthropic.counts.blocking, 0);
  assert.ok(r.sections.anthropic.score >= plain.sections.anthropic.score);
});

test('the regrade mirrors the engine: on every test catalog it reproduces the engine\'s section grades, scores, counts and caps', () => {
  const dir = new URL('./catalogs/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const parsed = M.parseInput(readFileSync(new URL(f, dir), 'utf8'));
    if (parsed.error) continue;
    const r = M.analyse(parsed); const g = gradeFindings(r.tools, r.server);
    for (const s of ['spec', 'anthropic', 'openai', 'security', 'quality']) {
      assert.deepEqual([g[s].grade, g[s].score, g[s].counts, g[s].caps], [r.sections[s].grade, r.sections[s].score, r.sections[s].counts, r.sections[s].caps], f + ' ' + s);
    }
  }
});

test('repoProvenance names the parts that could not be read', () => {
  const p = repoProvenance({ fidelity: 'derived', unreadable: { inputSchema: ['a', 'b'], description: ['c'], annotations: ['a'] } }).provenance;
  assert.match(p, /not readable from source, so their checks are skipped: 2 input schemas, 1 description, 1 annotations/);
});

// ------------------------------------------------------------ catalog hash (D12) and subfolders (D10)
test('snapshots: the same files in any listing order give one list, so one catalog hash', async () => {
  const snap = (n) => JSON.stringify({ name: n, description: 'd', inputSchema: { type: 'object' } });
  const files = { 'pkg/a/__toolsnaps__/x.snap': snap('x1'), 'pkg/b/__toolsnaps__/x.snap': snap('x2'), 'pkg/a/__toolsnaps__/y.snap': snap('y') };
  const order = async (keys) => (await R.fromGitHub('github.com/o/r', { fetch: fakeGithub(files, keys) })).best.tools.map((t) => t.name);
  const a = await order(Object.keys(files)); const b = await order(Object.keys(files).reverse());
  assert.deepEqual(a, b);
});

test('fromGitHub with a subfolder lists that folder\'s own tree (a truncated repository listing does not hide it)', async () => {
  const files = { 'package.json': '{"dependencies":{"@modelcontextprotocol/sdk":"1.20.0"}}', 'services/mcp/src/index.ts': 'server.registerTool("exec", { description: "Run one command." }, h);\n' };
  const seen = [];
  const got = await R.fromGitHub('github.com/o/r/tree/main/services/mcp', { fetch: fakeGithub(files, null, seen) });
  assert.deepEqual(got.best.tools.map((t) => t.name), ['exec']);
  assert.ok(seen.some((u) => /git\/trees\/t-services\/mcp\?recursive=1$/.test(u)), seen.join('\n'));
  assert.ok(!seen.some((u) => /git\/trees\/main\?recursive=1$/.test(u)), 'the whole repository is not listed');
  assert.match(scannedText({ scanned: { read: 0, sourceTotal: 0, source: 0 }, truncated: true, via: 'github' }), /GitHub cut the repository listing short/);
});

// ------------------------------------------------------------ Go and Rust: names only, never graded (D11)
test('Go and Rust: tool names and descriptions are read for the refusal; schemas are not', () => {
  const go = 'package tools\nconst SearchName = "search_notes"\nvar T = mcp.NewTool(SearchName, mcp.WithDescription("Search notes."))\nvar L = mcpgrafana.MustTool(\n\t"list_teams",\n\t"List teams.",\n\tlistTeams,\n)\nvar S = &mcp.Tool{Name: "get_pod", Description: `Get a pod.`}\n';
  const c = R.namesFromOtherLanguage([['pkg/tools/notes.go', go]], 'Go');
  assert.equal(c.fidelity, 'names');
  assert.deepEqual(c.tools, [{ name: 'search_notes', description: 'Search notes.' }, { name: 'list_teams', description: 'List teams.' }, { name: 'get_pod', description: 'Get a pod.' }]);
  const rs = 'impl S {\n    #[tool(\n        description = "List all indices",\n        annotations(title = "List", read_only_hint = true)\n    )]\n    async fn list_indices(&self) -> R { }\n    #[tool(name = "es_search", description = r#"Search "docs"."#)]\n    pub async fn search(&self) -> R { }\n}\n';
  assert.deepEqual(R.namesFromOtherLanguage([['src/s.rs', rs]], 'Rust').tools, [{ name: 'list_indices', description: 'List all indices' }, { name: 'es_search', description: 'Search "docs".' }]);
});

// A fake GitHub API: the recursive listing in `order`, folder trees by "t-<path>" ids, raw files by path. `seen` collects URLs.
function fakeGithub(files, order, seen) {
  const sha = 'a'.repeat(40);
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
  const paths = order || Object.keys(files);
  const treeOf = (dir) => { // direct children of a folder
    const kids = new Map();
    paths.filter((p) => (dir ? p.startsWith(dir + '/') : true)).forEach((p) => { const rest = dir ? p.slice(dir.length + 1) : p; const seg = rest.split('/')[0]; kids.set(seg, rest.includes('/') ? 'tree' : 'blob'); });
    return Array.from(kids).map(([path, type]) => (type === 'tree' ? { type, path, sha: 't-' + (dir ? dir + '/' : '') + path } : { type, path, size: files[(dir ? dir + '/' : '') + path].length }));
  };
  return async (url) => {
    const u = String(url); if (seen) seen.push(u);
    if (/api\.github\.com\/repos\/o\/r$/.test(u)) return ok({ default_branch: 'main' });
    let m = /\/git\/trees\/t-([^?]+)(\?recursive=1)?$/.exec(u);
    if (m) { const dir = m[1]; return ok({ sha: 't-' + dir, truncated: false, tree: m[2] ? paths.filter((p) => p.startsWith(dir + '/')).map((p) => ({ type: 'blob', path: p.slice(dir.length + 1), size: files[p].length })) : treeOf(dir) }); }
    m = /\/git\/trees\/([^?]+)(\?recursive=1)?$/.exec(u);
    if (m) return ok({ sha, truncated: false, tree: m[2] ? paths.map((path) => ({ type: 'blob', path, size: files[path].length })) : treeOf('') });
    m = new RegExp('raw\\.githubusercontent\\.com/o/r/' + sha + '/(.+)$').exec(u);
    if (m && files[decodeURIComponent(m[1])] !== undefined) return ok(files[decodeURIComponent(m[1])]);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
}

// ------------------------------------------------------------ the command line
test('cli: --repo-dir says which parts were not readable, and the JSON report carries what was skipped', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-check-unreadable-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"name":"notes","dependencies":{"@modelcontextprotocol/sdk":"1.20.0"}}');
    writeFileSync(join(dir, 'src', 'index.ts'), 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst server = new McpServer({ name: "notes", version: "1" });\n'
      + 'server.registerTool("list_notes", { title: "List notes", description: "List the notes of a folder. Use this when browsing.", inputSchema: buildSchema(), annotations: { readOnlyHint: true } }, h);\n'
      + 'server.registerTool(nameFromConfig(), { description: "x" }, h);\n');
    const bin = new URL('../bin/mcp-check.js', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [bin, '--repo-dir', dir, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.source.unreadable, { inputSchema: ['list_notes'] });
    assert.equal(j.source.unresolved_names, 1);
    assert.match(j.source.provenance, /not readable from source, so their checks are skipped: 1 input schema; 1 registration with a name the reader could not resolve/);
    assert.equal(j.unreadable.regraded, true);
    assert.equal(j.tools[0].findings.filter((f) => /^(schema-(?!output)|spec-input-schema)/.test(f.id)).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
