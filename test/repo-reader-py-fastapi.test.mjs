// Python reader: tools FastMCP derives from a FastAPI app (FastMCP.from_fastapi), R-RD-37. Fixtures under
// test/repos/fastapi/ are written in the shape of public repositories (README.md there names each repository and commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
