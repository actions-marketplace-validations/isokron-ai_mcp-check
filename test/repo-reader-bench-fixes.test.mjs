// Source reader fixes for misses and false alarms the adversarial benchmark (bench/) and the review of the reader
// integration found (R-RD-07 to R-RD-24). Synthetic sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');
const G = require('../src/inputs/repo-go.cjs');
const core = require('../engine/core.js');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-check.js');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const tool = (an, n) => { const x = an.tools.find((y) => y.tool.name === n); assert.ok(x, 'no tool ' + n + ' in ' + an.tools.map((y) => y.tool.name).join(', ')); return x.tool; };
const names = (an) => an.tools.map((x) => x.tool.name);
const PYPROJECT = '[project]\nname = "x"\ndependencies = ["mcp>=1.20"]\n';
const PKG = '{"dependencies": {"@modelcontextprotocol/sdk": "1.20.0", "zod": "3.25.0"}}';
const TS_HEAD = "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { z } from 'zod';\nconst server = new McpServer({ name: 'x', version: '1.0.0' });\n";
const ts = (src) => read({ 'package.json': PKG, 'src/index.ts': TS_HEAD + src });
function tree(files) {
  const d = mkdtempSync(join(tmpdir(), 'mcpcheck-rd-'));
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), text); }
  return d;
}
const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

// ---------------------------------------------------------------- R-RD-07: Python escapes
test('R-RD-07: Python string escapes are decoded as Python decodes them (\\x, \\u, \\U, octal); an unknown escape keeps its backslash', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'srv.py': [
    'from mcp.server.fastmcp import FastMCP',
    'mcp = FastMCP("x")',
    '@mcp.tool(description="Colour: \\x1b[31mred\\x1b[0m, tag \\U000e0068, bidi \\u202e, octal \\101, digits \\d+, quote \\" and \\\\.")',
    'def a(text: str) -> str:',
    '    return text',
    '@mcp.tool(description=r"raw \\u202e stays")',
    'def b(text: str) -> str:',
    '    return text',
  ].join('\n') + '\n' });
  assert.equal(tool(an, 'a').description, 'Colour: \x1b[31mred\x1b[0m, tag \u{e0068}, bidi ‮, octal A, digits \\d+, quote " and \\.');
  assert.equal(tool(an, 'b').description, 'raw \\u202e stays');
});

test('R-RD-07: a docstring written with \\u escapes keeps the bidi characters they stand for, and the security check sees them', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'srv.py': 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\n\n@mcp.tool()\ndef list_folders(root: str) -> list[str]:\n    """Lists the folders under a root.\\u202eesrever\\u202c"""\n    return []\n' });
  const t = tool(an, 'list_folders');
  assert.equal(t.description, 'Lists the folders under a root.‮esrever‬');
  const r = core.analyse(core.parseData({ tools: [Object.assign({}, t, { _unreadable: undefined })] }), { ajv: false });
  assert.ok(core.allFindings(r).some((f) => f.id === 'sec-bidi-controls'), 'sec-bidi-controls not raised');
});

test('R-RD-07: a name= keyword is decoded, so a look-alike letter written as an escape is the name the server lists', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'srv.py': 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\n\n@mcp.tool(name="lookup_\\u0430ccount", description="Looks up an account.")\ndef lookup(number: str) -> dict:\n    return {}\n' });
  assert.deepEqual(names(an), ['lookup_аccount']);
});

// ---------------------------------------------------------------- R-RD-08: duplicates in one literal list
test('R-RD-08: a literal tools array that repeats a name keeps both entries, so spec-name-unique can fire', () => {
  const an = read({ 'package.json': PKG, 'src/index.ts': [
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "const server = new Server({ name: 'n', version: '1' }, { capabilities: { tools: {} } });",
    'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [',
    "  { name: 'list_alerts', description: 'Lists alerts.', inputSchema: { type: 'object', properties: {} } },",
    "  { name: 'lookup_city', description: 'Finds a city.', inputSchema: { type: 'object', properties: {} } },",
    "  { name: 'list_alerts', description: 'Lists alerts for a region.', inputSchema: { type: 'object', properties: { region: { type: 'string' } } } },",
    '] }));',
  ].join('\n') });
  assert.deepEqual(names(an), ['list_alerts', 'lookup_city', 'list_alerts']);
  const r = core.analyse(core.parseData({ tools: an.tools.map((x) => x.tool) }), { ajv: false });
  assert.ok(core.allFindings(r).some((f) => f.id === 'spec-name-unique'));
});

test('R-RD-08: the same name registered twice outside one literal array is still one tool (alternatives, not a list)', () => {
  const an = ts("if (process.env.A) server.registerTool('ping', { description: 'A.' }, async () => ({ content: [] }));\nelse server.registerTool('ping', { description: 'B.' }, async () => ({ content: [] }));\nconst t1 = { name: 'solo', description: 'S.', inputSchema: { type: 'object' } };\nconst t2 = { name: 'solo', description: 'S2.', inputSchema: { type: 'object' } };\nexport const all = [t1, t2];\n");
  assert.deepEqual(names(an).filter((n) => n === 'ping').length, 1);
  assert.deepEqual(names(an).filter((n) => n === 'solo').length, 1);
});

// ---------------------------------------------------------------- R-RD-09: committed lists with a bad entry
test('R-RD-09: a committed { tools: [...] } list with one entry missing inputSchema is read in full, the bad entry kept for its finding', () => {
  const list = { tools: [{ name: 'ping_host', description: 'Pings a host.' }, { name: 'trace_host', description: 'Traces.', inputSchema: { type: 'object', properties: {} } }] };
  const ts1 = R.toolsFromJson(JSON.stringify(list));
  assert.deepEqual(ts1.map((x) => x.name), ['ping_host', 'trace_host']);
  const r = core.analyse(core.parseData({ tools: ts1 }), { ajv: false });
  assert.ok(core.allFindings(r).some((f) => f.id === 'spec-input-schema-missing' && f.tool === 'ping_host'));
});

test('R-RD-09: the bare-array and { tools } forms accept the same entries (input_schema in either), and named objects without any schema are not a list', () => {
  const entries = [{ name: 'a', input_schema: { type: 'object' } }, { name: 'b', description: 'no schema' }];
  assert.deepEqual(R.toolsFromJson(JSON.stringify(entries)).map((x) => x.name), ['a', 'b']);
  assert.deepEqual(R.toolsFromJson(JSON.stringify({ tools: entries })).map((x) => x.name), ['a', 'b']);
  assert.equal(R.toolsFromJson(JSON.stringify([{ name: 'x' }, { name: 'y' }])), null);
  assert.equal(R.toolsFromJson(JSON.stringify({ tools: [{ name: 'x' }, 'y'] })), null);
});

// ---------------------------------------------------------------- R-RD-10: two ServerHandler modules in one crate
const RS_MOD = (T, tool) => `use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
#[derive(Clone)]
pub struct ${T} { tool_router: ToolRouter<${T}> }
#[tool_router]
impl ${T} {
    pub fn new() -> Self { Self { tool_router: Self::tool_router() } }
    #[tool(description = "Returns a status.")]
    async fn ${tool}(&self) -> Result<CallToolResult, McpError> { Ok(CallToolResult::success(vec![])) }
}
#[tool_handler]
impl ServerHandler for ${T} {}
`;
const CARGO = '[package]\nname = "pair"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nrmcp = { version = "0.9", features = ["server"] }\n';

test('R-RD-10: two modules of one crate that each implement ServerHandler are refused as two servers, not merged', () => {
  const d = tree({ 'Cargo.toml': CARGO, 'src/main.rs': 'mod alpha;\nmod beta;\nfn main() {}\n', 'src/alpha.rs': RS_MOD('Alpha', 'alpha_status'), 'src/beta.rs': RS_MOD('Beta', 'beta_status') });
  const r = cli(['--repo-dir', d]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /more than one server/);
  assert.match(r.stderr, /src\/alpha\.rs/);
  assert.match(r.stderr, /modules of one crate/);
  assert.doesNotMatch(r.stderr, /--repo-dir \S*alpha\.rs/);
});

test('R-RD-10: one ServerHandler module with its tools in another file of the crate is one server', () => {
  const tools = RS_MOD('Alpha', 'alpha_status').replace(/#\[tool_handler\][\s\S]*$/, '');
  const d = tree({ 'Cargo.toml': CARGO, 'src/main.rs': 'mod tools;\nmod server;\nfn main() {}\n', 'src/tools.rs': tools, 'src/server.rs': 'use rmcp::{tool_handler, ServerHandler};\nuse crate::tools::Alpha;\n#[tool_handler]\nimpl ServerHandler for Alpha {}\n' });
  const r = cli(['--repo-dir', d, '--format', 'json']);
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).tools.map((x) => x.name), ['alpha_status']);
});

// ---------------------------------------------------------------- R-RD-11: Go registration under an if
const MCPGO = 'package main\n\nimport (\n\t"context"\n\t"os"\n\n\t"github.com/mark3labs/mcp-go/mcp"\n\t"github.com/mark3labs/mcp-go/server"\n)\n\nfunc handle(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return nil, nil }\n\n';
const goRead = (src, extra) => G.analyse([['main.go', MCPGO + src]].concat(extra || []), { goMods: [['go.mod', 'module example.com/srv\n']] });
const marksOf = (r, n) => r.found.find((x) => x.tool.name === n).marks.map((m) => m.reason);

test('R-RD-11: a Go tool added under if os.Getenv(...) is marked conditional; one added unconditionally is not', () => {
  const r = goRead('func main() {\n\ts := server.NewMCPServer("admin", "1.0.0")\n\ts.AddTool(mcp.NewTool("list_tenants", mcp.WithDescription("Lists tenants.")), handle)\n\tif os.Getenv("ADMIN_WRITES") == "1" {\n\t\ts.AddTool(mcp.NewTool("suspend_tenant", mcp.WithDescription("Suspends a tenant.")), handle)\n\t} else {\n\t\ts.AddTool(mcp.NewTool("explain_writes", mcp.WithDescription("Explains.")), handle)\n\t}\n\t_ = server.ServeStdio(s)\n}\n');
  assert.deepEqual(marksOf(r, 'list_tenants'), []);
  assert.deepEqual(marksOf(r, 'suspend_tenant'), ['conditional-branch']);
  assert.equal(r.found.find((x) => x.tool.name === 'suspend_tenant').marks[0].detail, 'os.Getenv("ADMIN_WRITES") == "1"');
  assert.deepEqual(marksOf(r, 'explain_writes'), ['conditional-branch']);
});

// ---------------------------------------------------------------- R-RD-12: a tool factory with an annotation argument
const FACTORY = "function keyTool(name: string, description: string, readOnly: boolean) {\n  return { name, description, inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key name' } }, required: ['key'] }, annotations: { readOnlyHint: readOnly } };\n}\n";

test('R-RD-12: a tool factory called with an annotation argument keeps its literal inputSchema and the annotations it is given', () => {
  const an = ts(FACTORY + "export const tools = [keyTool('get_key', 'Returns a value.', true), keyTool('touch_key', 'Refreshes a key.', false)];\n");
  const g = tool(an, 'get_key');
  assert.deepEqual(Object.keys(g.inputSchema.properties), ['key']);
  assert.deepEqual(g.inputSchema.required, ['key']);
  assert.deepEqual(g.annotations, { readOnlyHint: true });
  assert.equal(g.description, 'Returns a value.');
  assert.deepEqual(tool(an, 'touch_key').annotations, { readOnlyHint: false });
  assert.equal(g._unreadable, undefined);
});

test('R-RD-12: an argument the reader cannot know marks that part unreadable instead of grading it as absent', () => {
  const an = ts(FACTORY + "export const tools = [keyTool('get_key', describe('x'), isReadOnly)];\n");
  const g = tool(an, 'get_key');
  assert.deepEqual(Object.keys(g.inputSchema.properties), ['key']);
  assert.deepEqual(g._unreadable.slice().sort(), ['annotations', 'description']);
});

test('R-RD-12: annotations with a hint held in a variable are marked unreadable in a plain registration too', () => {
  const an = ts("server.registerTool('a_tool', { description: 'A.', annotations: { readOnlyHint: isReadOnly } }, async () => ({ content: [] }));\n");
  assert.ok(tool(an, 'a_tool')._unreadable.includes('annotations'));
});

// ---------------------------------------------------------------- R-RD-13: registerTool.bind
test('R-RD-13: registerTool bound to its server under another name is read like registerTool', () => {
  const an = ts("const s = server;\nconst register = s.registerTool.bind(s);\nregister('ping_service', { description: 'Checks a service.', inputSchema: { service: z.string() }, annotations: { readOnlyHint: true } }, async () => ({ content: [] }));\n");
  const t = tool(an, 'ping_service');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['service']);
  assert.deepEqual(t.annotations, { readOnlyHint: true });
});

// ---------------------------------------------------------------- R-RD-14: resolve as a read
test('R-RD-14: resolve_names and resolve_library_id read; resolve_issue stays an update, and only the reads may be read-only', () => {
  assert.equal(core.kindOf('resolve_names'), 'read');
  assert.equal(core.kindOf('resolve-library-id'), 'read');
  assert.equal(core.kindOf('resolve_issue'), 'update');
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const r = core.analyse(core.parseData({ tools: [{ name: 'resolve_names', description: 'Resolves host names to addresses.', inputSchema: { type: 'object', properties: {} }, annotations: ro }, { name: 'resolve_issue', description: 'Marks an issue resolved.', inputSchema: { type: 'object', properties: {} }, annotations: ro }] }), { ajv: false });
  const hit = core.allFindings(r).filter((f) => f.id === 'annot-write-marked-readonly').map((f) => f.tool);
  assert.deepEqual(hit, ['resolve_issue']);
});

// ---------------------------------------------------------------- R-RD-15 / R-RD-16: loops over known collections
test('R-RD-15: a for-of loop over a table whose names are all read leaves no unresolved registration', () => {
  const an = ts("const pair = { a: z.number(), b: z.number() };\nconst TOOLS = [\n  { name: 'add_numbers', description: 'Adds.', schema: pair, run: (a, b) => a + b },\n  { name: 'multiply_numbers', description: 'Multiplies.', schema: pair, run: (a, b) => a * b },\n];\nfor (const t of TOOLS) {\n  server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async () => ({ content: [] }));\n}\n");
  assert.deepEqual(names(an), ['add_numbers', 'multiply_numbers']);
  assert.equal(an.unresolved, 0);
});

test('R-RD-15: a loop over a collection the reader does not know in full still counts its registration as unresolved', () => {
  assert.equal(ts("for (const n of loadNames()) server.registerTool(n, { description: 'P.' }, async () => ({ content: [] }));\n").unresolved, 1);
  assert.equal(ts("const L = ['a_one', ...MORE];\nfor (const n of L) server.registerTool(n, { description: 'P.' }, async () => ({ content: [] }));\n").unresolved, 1);
});

test('R-RD-16: tool names from Object.entries of a literal object are read, with each entry\'s config', () => {
  const an = ts("const TOOLS = {\n  get_forecast: { description: 'Returns the forecast.', inputSchema: { city: z.string() } },\n  get_alerts: { description: 'Returns alerts.', inputSchema: {} },\n};\nfor (const [name, def] of Object.entries(TOOLS)) {\n  server.registerTool(name, def, async () => ({ content: [] }));\n}\n");
  assert.deepEqual(names(an), ['get_forecast', 'get_alerts']);
  assert.deepEqual(Object.keys(tool(an, 'get_forecast').inputSchema.properties), ['city']);
  assert.equal(tool(an, 'get_alerts').description, 'Returns alerts.');
  assert.equal(an.unresolved, 0);
});

test('R-RD-16: Object.entries(...).forEach, Object.keys, an array literal and template names are read the same way', () => {
  const a = ts("const T = { one_x: { description: 'One.' }, two_x: { description: 'Two.' } };\nObject.entries(T).forEach(([n, d]) => server.registerTool(n, d, async () => ({ content: [] })));\n");
  assert.deepEqual(names(a), ['one_x', 'two_x']);
  const b = ts("const D = { a_tool: 'A.', b_tool: 'B.' };\nObject.keys(D).forEach((k) => { server.registerTool(k, { description: D[k] }, async () => ({ content: [] })); });\n");
  assert.deepEqual(names(b), ['a_tool', 'b_tool']);
  assert.ok(tool(b, 'a_tool')._unreadable.includes('description'));
  const c = ts("for (const entity of ['invoice', 'customer']) {\n  server.registerTool(`list_${entity}s`, { description: `Lists ${entity}s.` }, async () => ({ content: [] }));\n}\n");
  assert.deepEqual(names(c), ['list_invoices', 'list_customers']);
  assert.equal(tool(c, 'list_customers').description, 'Lists customers.');
});

test('R-RD-16: a config held in a constant keeps the optional keys of its raw shape (z.x().optional() is not required)', () => {
  const an = ts("const CFG = { description: 'D.', inputSchema: { region: z.string(), severe: z.boolean().optional() } };\nserver.registerTool('a_tool', CFG, async () => ({ content: [] }));\nconst T = { b_tool: { description: 'B.', inputSchema: { region: z.string(), severe: z.boolean().optional() } } };\nserver.registerTool('b_tool', T.b_tool, async () => ({ content: [] }));\n");
  assert.deepEqual(tool(an, 'a_tool').inputSchema.required, ['region']);
  assert.deepEqual(tool(an, 'b_tool').inputSchema.required, ['region']);
});

// ---------------------------------------------------------------- R-RD-17: JS escapes
test('R-RD-17: JavaScript \\xHH, \\u{…}, octal and line-continuation escapes are decoded as the engine decodes them', () => {
  const an = read({ 'package.json': PKG, 'index.js': TS_HEAD + "server.registerTool('t', { description: 'Tag \\u{E0068}\\u{E0069}, \\x1b[31mred\\x1b[0m, \\101, \\u0041, bad \\u{110000}, a\\\nb' }, async () => ({ content: [] }));\nserver.registerTool('u', { description: `tpl \\x41\\u{1F600}` }, async () => ({ content: [] }));\n" });
  assert.equal(tool(an, 't').description, 'Tag \u{E0068}\u{E0069}, \x1b[31mred\x1b[0m, A, A, bad u{110000}, ab');
  assert.equal(tool(an, 'u').description, 'tpl A\u{1F600}');
  const r = core.analyse(core.parseData({ tools: [tool(an, 't')] }), { ajv: false });
  const ids = core.allFindings(r).map((f) => f.id);
  assert.ok(ids.includes('sec-invisible-encoding') && ids.includes('sec-control-chars'));
});

// ---------------------------------------------------------------- R-RD-18: Go build tags met by default
test('R-RD-18: a Go file under a build tag the default build meets (//go:build !debugtools) is not conditional; a custom tag is left out, a platform tag is conditional', () => {
  const reg = (n) => 'package main\n\nimport (\n\t"github.com/mark3labs/mcp-go/mcp"\n\t"github.com/mark3labs/mcp-go/server"\n)\n\nfunc init() {\n\textra = append(extra, func(s *server.MCPServer) {\n\t\ts.AddTool(mcp.NewTool("' + n + '", mcp.WithDescription("D.")), handle)\n\t})\n}\n';
  const main = 'func main() {\n\ts := server.NewMCPServer("diag", "1.0.0")\n\tfor _, add := range extra {\n\t\tadd(s)\n\t}\n}\n\nvar extra []func(*server.MCPServer)\n';
  const r = goRead(main, [['neg.go', '//go:build !debugtools\n\n' + reg('dump_memory')], ['tag.go', '//go:build debugtools\n\n' + reg('hidden_tool')], ['lin.go', '//go:build linux\n\n' + reg('linux_tool')], ['ver.go', '//go:build go1.21 && !debugtools\n\n' + reg('ver_tool')]]);
  assert.deepEqual(marksOf(r, 'dump_memory'), []);
  assert.deepEqual(marksOf(r, 'ver_tool'), []);
  assert.deepEqual(marksOf(r, 'linux_tool'), ['conditional-build-tag']);
  assert.equal(r.found.some((x) => x.tool.name === 'hidden_tool'), false);
});

// ---------------------------------------------------------------- R-RD-19: linear time on runs of blank lines
test('R-RD-19: 100 KB of blank lines is read in linear time (no ^\\s*…/m regex crossing lines)', () => {
  const big = '\n'.repeat(100000);
  const time = (files) => { const t0 = performance.now(); R.analyseRepo(new Map(Object.entries(files))); return performance.now() - t0; };
  const ms = [
    time({ 'srv.py': 'x = 1' + big + 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\n@mcp.tool()\ndef a() -> str:\n    """A."""\n' }),
    time({ 'srv.py': big + 'TOOLS = [{"name": "a", "inputSchema": {}}]\n' }),
    time({ 'pyproject.toml': big + 'dependencies = ["mcp"]\n', 'srv.py': '@mcp.tool()\ndef a():\n    pass\n' }),
  ];
  const t0 = performance.now();
  G.analyse([['main.go', 'package main\n']], { goMods: [['go.mod', big + 'module example.com/x\n']] });
  require('../src/inputs/repo-rust.cjs').analyse([['src/main.rs', 'fn main() {}\n']], { cargo: [['Cargo.toml', '[features]\n' + 'x = [\n'.repeat(5000) + big]] });
  ms.push(performance.now() - t0);
  ms.forEach((m) => assert.ok(m < 1500, 'took ' + Math.round(m) + ' ms'));
});

// ---------------------------------------------------------------- R-RD-20 / R-RD-21: Python imports
test('R-RD-20: a bare registrar on a server object imported from another module (from app.server import mcp) is followed', () => {
  const an = read({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastmcp>=3"]\n',
    'app/server.py': 'from fastmcp import FastMCP\nmcp = FastMCP("x")\n',
    'app/tools/registry.py': 'from app.server import mcp\n\ndef create_tool(name, description):\n    def deco(fn):\n        mcp.tool(fn, name=name, description=description)\n        return fn\n    return deco\n',
    'app/tools/notes.py': 'from .registry import create_tool\n\n@create_tool("find_notes", "Finds notes.")\ndef find_notes(query: str) -> str:\n    return query\n',
  });
  assert.equal(tool(an, 'find_notes').description, 'Finds notes.');
  const rel = read({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastmcp>=3"]\n',
    'pkg/server.py': 'from fastmcp import FastMCP\nmcp = FastMCP("x")\n',
    'pkg/registry.py': 'from .server import mcp as srv\n\ndef create_tool(name, description):\n    def deco(fn):\n        srv.tool(fn, name=name, description=description)\n        return fn\n    return deco\n',
    'pkg/notes.py': 'from pkg.registry import create_tool\n\n@create_tool("list_notes", "Lists notes.")\ndef list_notes() -> str:\n    return ""\n',
  });
  assert.deepEqual(names(rel), ['list_notes']);
});

test("R-RD-20: a bare registrar's own registration is not an unresolved one, and annotations are known when its call is a plain statement", () => {
  const files = (body) => ({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastmcp>=3"]\n', 'app/server.py': 'from fastmcp import FastMCP\nmcp = FastMCP("x")\n\ndef create_tool(name, description):\n    def deco(fn):\n' + body + '        return fn\n    return deco\n\n@create_tool("find_notes", "Finds notes.")\ndef find_notes(query: str) -> str:\n    return query\n' });
  const plain = read(files('        mcp.tool(fn, name=name, description=description)\n'));
  assert.equal(plain.unresolved, 0);
  assert.equal(tool(plain, 'find_notes')._unreadable, undefined);
  const kept = read(files('        tool_obj = mcp.tool(fn, name=name, description=description)\n        REGISTRY.append(tool_obj)\n'));
  assert.ok(tool(kept, 'find_notes')._unreadable.includes('annotations'));
  const kw = read(files('        mcp.tool(fn, name=name, description=description, **EXTRA)\n'));
  assert.ok(tool(kw, 'find_notes')._unreadable.includes('annotations'));
});

test('R-RD-21: a parenthesized import over several lines (from fastmcp.tools import (\\n tool,\\n)) counts as the SDK\'s name', () => {
  const own = 'def tool(name, description):\n    return {"name": name, "description": description, "inputSchema": {"type": "object"}}\n';
  const sdk = 'from fastmcp import FastMCP\nfrom fastmcp.tools import (\n    tool,\n)\nmcp = FastMCP("x")\n\n@tool(name="search")\ndef search(q: str) -> str:\n    """Searches the index."""\n    return q\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastmcp>=3"]\n', 'x/helpers.py': own, 'x/server.py': sdk });
  const t = tool(an, 'search');
  assert.equal(t.description, 'Searches the index.');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['q']);
});

// ---------------------------------------------------------------- R-RD-22: importsMcpServer word boundaries
test('R-RD-22: the import check finds McpServer when a later name in the same import contains "var", "let" or "const"', () => {
  const src = (names) => "import { McpServer, " + names + " } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';\nconst s = new McpServer({ name: 'x', version: '1' });\ns.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));\n";
  assert.equal(R.customListHandler('src/s.ts', src('invariant')), 'replace');
  assert.equal(R.customListHandler('src/s.ts', src('outlet, constructorArgs')), 'replace');
});

// ---------------------------------------------------------------- R-RD-23: shadowAt linear
test('R-RD-23: one def with many tool dict lines is read in linear time', () => {
  const body = Array.from({ length: 6000 }, (_, i) => '    t' + i + ' = {"name": "tool_' + i + '", "inputSchema": {"type": "object"}}').join('\n');
  const src = 'import json\n\ndef handle(req):\n    if req["method"] == "tools/list":\n        pass\n' + body + '\n    return None\n';
  const t0 = performance.now();
  R.analyseRepo(new Map([['srv.py', src]]));
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, 'took ' + Math.round(ms) + ' ms');
});

// ---------------------------------------------------------------- R-RD-24: eval suites in compound folder names
test('R-RD-24: a folder with "evals" as a word of its name (mcp-server-evals) is not read; medieval or retrievals is', () => {
  const plan = (p) => R.planFiles([p]).src.length > 0;
  assert.equal(plan('packages/mcp-server-evals/src/bin/start-mock-stdio.ts'), false);
  assert.equal(plan('packages/evals-runner/index.ts'), false);
  assert.equal(plan('packages/mcp_server.evals/index.ts'), false);
  assert.equal(plan('packages/medieval/index.ts'), true);
  assert.equal(plan('packages/retrievals/index.ts'), true);
  assert.equal(plan('python-eval-mcp/server.py'), true);
});
