// Python reader: tools FastMCP derives from a FastAPI app (FastMCP.from_fastapi), R-RD-37. Fixtures under
// test/repos/fastapi/ are written in the shape of public repositories (README.md there names each repository and commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'mcp-check.js');
const FIX = join(HERE, 'repos', 'fastapi');

// the CLI on a folder: { status, stderr, tools (by name, as saved), report }
function run(dir) {
  const save = join(mkdtempSync(join(tmpdir(), 'mcpc-fa-')), 'saved.json');
  const r = spawnSync(process.execPath, [BIN, '--repo-dir', dir, '--format', 'json', '--save', save], { encoding: 'utf8' });
  let tools = {};
  try { tools = Object.fromEntries(JSON.parse(readFileSync(save, 'utf8')).tools.map((t) => [t.name, t])); } catch (e) { tools = {}; }
  let report = null; try { report = JSON.parse(r.stdout); } catch (e) { report = null; }
  return { status: r.status, stderr: r.stderr, tools, report };
}
const UNKNOWN = { type: 'object', 'x-mcp-check-unknown': true };
const noTitles = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'title' && typeof x === 'string' ? undefined : x)));

test('R-RD-37: route_maps by tag (QueryWeaver shape): only routes the first matching RouteMap makes tools are listed, with router prefixes, docstrings and flattened bodies', () => {
  const r = run(join(FIX, 'queryweaver'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.tools).sort(), ['audited_query', 'connect_database', 'database_schema', 'list_databases', 'nested_query', 'query_database']);
  // excluded by the last map (untagged), and a resource: not tools
  assert.equal(r.tools.delete_database, undefined);
  assert.equal(r.tools.get_rules, undefined);
  // a router included into the app after from_fastapi is not part of the MCP server
  assert.equal(r.tools.late_tool, undefined);
  const t = r.tools;
  assert.equal(t.list_databases.description, 'List the databases of the signed-in user.\nRequires authentication.');
  assert.deepEqual(t.list_databases.inputSchema, { type: 'object', properties: {}, required: [] });
  // inspect.cleandoc keeps the deeper indent of the Args block
  assert.equal(t.database_schema.description, 'Return the schema of one database.\nRequires authentication.\n\n    args:\n        graph_id (str): The database name.');
  assert.deepEqual(noTitles(t.database_schema.inputSchema), { type: 'object', properties: { graph_id: { type: 'string' } }, required: ['graph_id'] });
  // the body model's properties merged in; None defaults dropped; path params first in required
  assert.deepEqual(noTitles(t.query_database.inputSchema), { type: 'object', properties: {
    graph_id: { type: 'string' }, chat: { type: 'array', items: { type: 'string' } },
    result: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    instructions: { anyOf: [{ type: 'string' }, { type: 'null' }] }, use_memory: { type: 'boolean', default: true },
  }, required: ['graph_id', 'chat'] });
  assert.deepEqual(noTitles(t.connect_database.inputSchema), { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] });
  assert.equal(t.connect_database.description, 'Connect to a database by URL.\nStreams progress.');
});

test('R-RD-37: what cannot be typed is marked, never guessed: a decorator without functools.wraps, a nested model, a dependency with parameters', () => {
  const q = run(join(FIX, 'queryweaver'));
  assert.deepEqual(q.tools.audited_query.inputSchema, UNKNOWN);
  assert.deepEqual(q.tools.nested_query.inputSchema, UNKNOWN);
  assert.deepEqual(q.report.source.unreadable, { inputSchema: ['audited_query', 'nested_query'], description: ['audited_query'] });
  // @wraps(func) decorators (token_required) keep the endpoint's docstring and signature
  assert.notDeepEqual(q.tools.query_database.inputSchema, UNKNOWN);
  const t = run(join(FIX, 'tavily'));
  assert.deepEqual(t.tools.tavily_scoped.inputSchema, UNKNOWN);
  assert.deepEqual(t.report.source.unreadable, { inputSchema: ['tavily_scoped'] });
});

test('R-RD-37: route_map_fn keeping a list of operation ids (ensk.is shape): listed ids are tools; include_in_schema=False and other routes are not', () => {
  const r = run(join(FIX, 'ensk'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.tools).sort(), ['get_metadata', 'lookup_many_words_parsed', 'search_for_word']);
  assert.equal(r.tools.get_metadata.description, 'Return metadata about the dictionary.');
  assert.deepEqual(noTitles(r.tools.search_for_word.inputSchema), { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  assert.deepEqual(noTitles(r.tools.lookup_many_words_parsed.inputSchema), { type: 'object', properties: { q: { type: 'string' }, strip_parentheses: { type: 'integer', default: 0 } }, required: ['q'] });
  assert.equal(r.tools.lookup_many_words_parsed.description, 'Return several entries with\nparsed definitions. The q parameter is a comma-separated list.\nOptionally, strip text within parentheses.');
  // a decorator with @overload stubs: the last definition (which uses functools.wraps) is the one read
  assert.equal(r.report.source.unreadable, undefined);
});

test('R-RD-37: no route maps (Tavily shape, fastmcp 2.x): every route of routers included in a loop over an imported list is a tool; header alias, Field constraints, generated summary and operation id', () => {
  const r = run(join(FIX, 'tavily'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.tools).sort(), ['read_item_items', 'tavily_get_pricing', 'tavily_scoped', 'tavily_search']);
  const s = r.tools.tavily_search;
  assert.equal(s.description, 'Tavily Search'); // no docstring: FastAPI's summary from the function name
  assert.deepEqual(s.inputSchema, { type: 'object', properties: {
    'Tavily-Api-Key': { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Tavily-Api-Key', description: "Tavily API key for this request. Optional: the server's own key is used otherwise." },
    query: { title: 'Query', type: 'string', minLength: 1, maxLength: 512, description: 'The search query' },
    max_results: { title: 'Max Results', anyOf: [{ type: 'integer', minimum: 1, maximum: 50 }, { type: 'null' }], description: 'Most results to return' },
    search_depth: { title: 'Search Depth', type: 'string', pattern: '^(basic|advanced)$', description: 'basic or advanced', default: 'basic' },
  }, required: ['query'] });
  // FastAPI's generated operation id read_item_items__item_id__get, cut at "__"
  assert.equal(r.tools.read_item_items.description, 'Read Item');
  assert.deepEqual(noTitles(r.tools.read_item_items.inputSchema), { type: 'object', properties: { item_id: { type: 'integer' }, verbose: { type: 'boolean', default: false } }, required: ['item_id'] });
  // routers included into another app after from_fastapi (prefix /hybrid) are not the MCP app's
  assert.equal(Object.keys(r.tools).some((n) => /hybrid/.test(n)), false);
});

function server(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-fa-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const ROUTES = `from fastapi import APIRouter
router = APIRouter(prefix="/v1")

@router.get("/a", operation_id="tool_a")
async def a(x: int):
    """Tool A."""
    return x

@router.get("/b", operation_id="tool_b", tags=["mcp"])
async def b(y: str):
    """Tool B."""
    return y
`;
const APP = (call, extra) => `from fastapi import FastAPI
from fastmcp import FastMCP
from fastmcp.server.openapi import RouteMap, MCPType
from routes import router
${extra || ''}
app = FastAPI()
app.include_router(router)
mcp = ${call}
`;

test('R-RD-37: a route map the reader cannot decide leaves the routes out and says why; it never guesses which are tools', () => {
  const cases = [
    ['FastMCP.from_fastapi(app, route_map_fn=pick)', 'def pick(route, mcp_type):\n    if route.path.startswith("/a"):\n        return MCPType.TOOL\n    return MCPType.EXCLUDE\n', /route_map_fn pick not read, so which routes are tools is not known; none listed/],
    ['FastMCP.from_fastapi(app, route_maps=MAPS)', 'MAPS = build_maps()\n', /route_maps not read, so which routes are tools is not known; none listed/],
    ['FastMCP.from_fastapi(app, mcp_names={"tool_a": "a"})', '', /passes mcp_names, which the reader does not apply/],
  ];
  for (const [call, extra, why] of cases) {
    const r = run(server({ 'app.py': APP(call, extra), 'routes.py': ROUTES }));
    assert.equal(r.status, 3, call);
    assert.deepEqual(r.tools, {}, call);
  }
  // with another server's tools beside it, the reason is in the provenance
  const tools = 'from fastmcp import FastMCP\nother = FastMCP("x")\n\n@other.tool\ndef ping() -> str:\n    """Ping."""\n    return "pong"\n';
  for (const [call, extra, why] of cases) {
    const r = run(server({ 'app.py': APP(call, extra), 'routes.py': ROUTES, 'tools.py': tools }));
    assert.equal(r.status, 0, call + r.stderr);
    assert.deepEqual(Object.keys(r.tools), ['ping'], call);
    assert.match(r.stderr, why, call);
  }
});

test('R-RD-37: a route map by tag and method decides per route; a router the reader cannot find is named, its routes left out', () => {
  const r = run(server({ 'app.py': APP('FastMCP.from_fastapi(app, route_maps=[RouteMap(methods=["GET"], tags={"mcp"}, mcp_type=MCPType.TOOL), RouteMap(pattern=r"^/api/v1/a$", mcp_type=MCPType.EXCLUDE)])').replace('app.include_router(router)', 'app.include_router(router, prefix="/api")'), 'routes.py': ROUTES }));
  assert.deepEqual(Object.keys(r.tools), ['tool_b']); // the pattern is matched against the full path, prefixes included
  const missing = APP('FastMCP.from_fastapi(app)').replace('app.include_router(router)', 'app.include_router(router)\napp.include_router(admin_router, prefix="/admin")').replace('from routes import router', 'from routes import router\nfrom admin.views import admin_router');
  const m = run(server({ 'app.py': missing, 'routes.py': ROUTES, 'pyproject.toml': '[project]\nname = "x"\n' }));
  assert.deepEqual(Object.keys(m.tools).sort(), ['tool_a', 'tool_b']);
  assert.match(m.stderr, /routes not listed because the reader could not resolve router admin_router imported from admin\.views, not found in the repository/);
});

// ---------------------------------------------------------------- second review: versions, patterns, package roots
// Synthetic, in the shape of the Tavily fixture (a described path parameter, a POST route) with the FastMCP pin varied.
const ANALYSE = createRequire(import.meta.url)('../src/inputs/repo-source.cjs').analyseRepo;
const scan = (files) => { const an = ANALYSE(new Map(Object.entries(files))); return { tools: Object.fromEntries(an.tools.map((x) => [x.tool.name, x.tool])), notes: an.notes || [] }; };
const VAPP = (maps) => `from fastapi import FastAPI, Path
from fastmcp import FastMCP
from fastmcp.server.openapi import RouteMap, MCPType
app = FastAPI()

@app.get("/items/{item_id}")
def read_item(item_id: int = Path(description="The item id")):
    """Read one item."""
    return {}

@app.post("/internal")
def reindex():
    """Rebuild the index."""
    return {}

mcp = FastMCP.from_fastapi(app=app${maps ? ', route_maps=[' + maps + ']' : ''})
`;
const pin = (dep, extra) => Object.assign({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastapi", ' + JSON.stringify(dep) + ']\n', 'server.py': VAPP() }, extra || {});

test('R-RD-37: tool names are certain only under the FastMCP versions the fixtures checked; otherwise they are marked and the reason noted', () => {
  for (const v of ['2.14.5', '4.1.6', '4.1.7']) {
    const r = scan(pin('fastmcp==' + v));
    assert.deepEqual(Object.keys(r.tools).sort(), ['read_item_items', 'reindex_internal_post'], v);
    assert.equal((r.tools.reindex_internal_post._unreadable || []).includes('name'), false, v);
    assert.equal(r.notes.some((n) => /may differ/.test(n)), false, v);
  }
  for (const [dep, says] of [['fastmcp', 'pins no fastmcp version'], ['fastmcp==4.2.0', 'pins fastmcp 4.2.0'], ['fastmcp>=2.14', 'allows fastmcp from 2.14.0']]) {
    const r = scan(pin(dep));
    assert.deepEqual(Object.keys(r.tools).sort(), ['read_item_items', 'reindex_internal_post'], dep);
    assert.ok(r.tools.reindex_internal_post._unreadable.includes('name'), dep);
    assert.ok(r.notes.some((n) => n.includes(says) && /2 tool names may differ/.test(n)), dep + ': ' + r.notes.join(' | '));
  }
});

test('R-RD-37: with no FastMCP version known, a described path parameter leaves the description unread (2.x adds it to the description)', () => {
  const none = scan(pin('fastmcp'));
  assert.ok(none.tools.read_item_items._unreadable.includes('description'));
  assert.equal(none.tools.read_item_items.inputSchema.properties.item_id.description, 'The item id');
  const v4 = scan(pin('fastmcp==4.1.7'));
  assert.equal(v4.tools.read_item_items._unreadable, undefined, '4.x lists the parameter description in the schema only');
  const v2 = scan(pin('fastmcp==2.14.5'));
  assert.deepEqual(v2.tools.read_item_items._unreadable, ['description']);
});

test('R-RD-37: a range that allows FastMCP before 2.8.0 leaves out GET routes no route map decides (resources there), and says so', () => {
  const r = scan(pin('fastmcp>=2.3'));
  assert.deepEqual(Object.keys(r.tools), ['reindex_internal_post']);
  assert.ok(r.notes.some((n) => /1 GET route no route map decides not listed: the package allows fastmcp from 2\.3\.0, and before 2\.8\.0/.test(n)), r.notes.join(' | '));
  // a map that decides the GET route decides it in every version
  const m = scan(pin('fastmcp>=2.3', { 'server.py': VAPP('RouteMap(methods=["GET"], mcp_type=MCPType.TOOL)') }));
  assert.deepEqual(Object.keys(m.tools).sort(), ['read_item_items', 'reindex_internal_post']);
  assert.deepEqual(Object.keys(scan(pin('fastmcp>=2.8')).tools).sort(), ['read_item_items', 'reindex_internal_post']);
});

test('R-RD-37: a route map pattern JavaScript would read differently, or that may backtrack without end, leaves the routes out; a plain one is applied', () => {
  for (const p of ['^/internal\\Z', '\\A/internal', '(?i)^/INTERNAL', '(?P<x>a)(?P=x)', '^/inter++nal', '^/a{,3}', '(a+)+$', '(?#note)/internal', 'x'.repeat(201)]) {
    const r = scan(pin('fastmcp==4.1.7', { 'server.py': VAPP('RouteMap(pattern=r"' + p + '", mcp_type=MCPType.EXCLUDE)') }));
    assert.deepEqual(r.tools, {}, p);
    assert.ok(r.notes.some((n) => /route_maps not read/.test(n)), p);
  }
  for (const [p, want] of [['^/internal$', ['read_item_items']], ['^/(?P<area>internal)$', ['read_item_items']], ['^/items/\\d*', ['reindex_internal_post']], ['^/(?:v\\d+/)?internal', ['read_item_items']]]) {
    const r = scan(pin('fastmcp==4.1.7', { 'server.py': VAPP('RouteMap(pattern=r"' + p + '", mcp_type=MCPType.EXCLUDE)') }));
    assert.deepEqual(Object.keys(r.tools), want, p);
  }
});

test('R-RD-37: imports resolve only inside the server\'s own package: a module of another package with the same name is not followed', () => {
  const APPR = 'from fastapi import FastAPI\nfrom fastmcp import FastMCP\nfrom routes import router\napp = FastAPI()\napp.include_router(router)\nmcp = FastMCP.from_fastapi(app=app)\n';
  const files = {
    'servers/a/pyproject.toml': '[project]\nname = "a"\ndependencies = ["fastmcp==4.1.7"]\n',
    'servers/a/server.py': APPR,
    'servers/b/pyproject.toml': '[project]\nname = "b"\ndependencies = ["fastmcp==4.1.7"]\n',
    'servers/b/routes.py': ROUTES,
  };
  const r = scan(files);
  assert.deepEqual(r.tools, {});
  assert.ok(r.notes.some((n) => /router router imported from routes, not found in the repository/.test(n)), r.notes.join(' | '));
  // the same layout with routes.py in the server's own package is read
  const own = scan(Object.assign({}, files, { 'servers/a/routes.py': ROUTES }));
  assert.deepEqual(Object.keys(own.tools).sort(), ['tool_a', 'tool_b']);
});
