// Which list the reader takes for the server's tools/list when a committed catalog, an internal registry and the
// source registrations disagree (R-RD-41). The fixtures are trimmed to the shape of public repositories, credited per
// test (repository@commit). Live tools/list of those servers (the loop's live-probe lane, 26-27 Nov 2026):
// Panelica 37 tools (3 gateway tools plus a toolset of the catalogue picked at run time), maplestats 3
// (search_tools, call_tool, plan_query).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { usableList, incompleteText } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-rank-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const catalogue = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: 'panelica_domains_get_v1_domains_' + i, description: 'Catalogue tool ' + i + '.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, metadata: { method: 'GET', path: '/v1/domains/' + i } })), null, 1);

// Panelica/panelica-mcp@88a96e95159d5428f5720bb799675c8a7b29282b: package.json, src/index.ts, src/toolsets.ts,
// src/catalog.ts, tools/tools.json (the committed catalogue snapshot the server loads, 490 tools there)
const PANELICA = {
  'package.json': JSON.stringify({ name: 'panelica-mcp', type: 'module', dependencies: { '@modelcontextprotocol/sdk': '^1.20.0' } }),
  'src/index.ts': `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { metaTools, selectTools } from "./toolsets.js";
const snapshotPath = new URL("../tools/tools.json", import.meta.url);
const tools = JSON.parse(readFileSync(snapshotPath, "utf8"));
const registered = selectTools(tools, process.env.PANELICA_TOOLSETS);
const exposed = [...metaTools(tools.length, registered.length), ...registered];
const server = new Server({ name: "panelica", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed.map(({ metadata, ...t }) => t) }));
`,
  'src/toolsets.ts': `export const META_FIND = "panelica_find_tools";
export const META_DESCRIBE = "panelica_describe_tool";
export const META_CALL = "panelica_call";
export function selectTools(tools, sets) { return tools.filter((t) => (sets || "").includes(t.metadata.category)); }
/** The meta tools (find / describe / call), as MCP tool definitions. */
export function metaTools(catalogueSize: number, registered: number) {
    return [
        {
            name: META_FIND,
            description: "Search the full Panelica tool catalogue. Read-only.",
            inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords" } }, required: ["query"], additionalProperties: false },
            annotations: { title: "Find Panelica tools", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
            name: META_DESCRIBE,
            description: "Describe one Panelica catalogue tool by name. Read-only.",
            inputSchema: { type: "object", properties: { tool: { type: "string", description: "Catalogue tool name" } }, required: ["tool"], additionalProperties: false },
            annotations: { title: "Describe a Panelica tool", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
            name: META_CALL,
            description: "Run any Panelica catalogue tool by name with its arguments.",
            inputSchema: { type: "object", properties: { tool: { type: "string", description: "Catalogue tool name" }, arguments: { type: "object", description: "Arguments for that tool", additionalProperties: true } }, required: ["tool"], additionalProperties: false },
            annotations: { title: "Call a Panelica tool", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
    ];
}
`,
  'src/catalog.ts': `function slugify(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_"); }
function toolName(method: string, path: string, category: string | undefined): string {
    const cat = slugify(category || "misc");
    const m = String(method || "get").toLowerCase();
    let name = \`panelica_\${cat}_\${m}_\${slugify(path)}\`;
    return name;
}
export function buildTools(spec) {
    const tools = [];
    for (const ep of spec.endpoints) {
        let name = toolName(ep.method, ep.path, ep.category);
        tools.push({
            name,
            description: ep.summary,
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: ep.method === "GET" },
        });
    }
    return tools;
}
`,
  'tools/tools.json': catalogue(40),
};

test('R-RD-41: a committed catalogue that leaves out the tools the source registers is not graded as the list (Panelica/panelica-mcp shape)', async () => {
  const r = await R.fromDirectory(repo(PANELICA));
  assert.equal(r.best.kind, 'source', 'the 40-tool committed catalogue does not outrank the registrations');
  assert.deepEqual(r.best.tools.map((t) => t.name), ['panelica_find_tools', 'panelica_describe_tool', 'panelica_call']);
  const list = r.candidates.find((c) => c.kind === 'committed');
  assert.equal(list.path, 'tools/tools.json');
  assert.equal(list.notServerList, true);
  assert.equal(r.candidates.indexOf(list), r.candidates.length - 1, 'it ranks after the source list');
  assert.deepEqual(r.hints.listNotUsed, { path: 'tools/tools.json', tools: 40, sourceTools: 3, missing: 3 });
  assert.ok(r.best.notes.some((n) => n.startsWith('committed list tools/tools.json (40 tools) not used: it does not list 3 of the 3 tools the source registers (panelica_find_tools, panelica_describe_tool, panelica_call)')), r.best.notes.join('\n'));
  assert.deepEqual(usableList(r).candidate, r.best);
});

test('R-RD-41: a tool name with a part the reader could not work out is never listed; it counts as unresolved', async () => {
  const r = await R.fromDirectory(repo(PANELICA));
  assert.ok(!r.candidates.some((c) => c.tools.some((t) => /…/.test(t.name))), 'no "panelica_…_…_…" tool');
  assert.ok(r.best.unresolved.some((u) => u.path === 'src/catalog.ts'), JSON.stringify(r.best.unresolved));
  assert.deepEqual(R.analyseRepo(new Map([['src/catalog.ts', PANELICA['src/catalog.ts']]])).tools, []);
});

test('R-RD-41: a committed list that lists every registered tool is still the exact list, larger or not', async () => {
  const files = Object.assign({}, PANELICA, { 'tools/tools.json': JSON.stringify(JSON.parse(catalogue(40)).concat(['panelica_find_tools', 'panelica_describe_tool', 'panelica_call'].map((name) => ({ name, description: 'Meta.', inputSchema: { type: 'object' } })))) });
  const r = await R.fromDirectory(repo(files));
  assert.equal(r.best.kind, 'committed');
  assert.equal(r.best.tools.length, 43);
  assert.equal(r.hints.listNotUsed, undefined);
  // and with no registration read at all, the committed list is what there is
  const only = await R.fromDirectory(repo({ 'package.json': PANELICA['package.json'], 'tools/tools.json': catalogue(5) }));
  assert.equal(only.best.kind, 'committed');
  assert.equal(only.best.tools.length, 5);
});

// dsanchezp18/maplestats-mcp@d20a8a6fa1e9887a99abadf757a08f1e3bc97a81: pyproject.toml (fastmcp>=4.0.3,<4.3),
// src/maplestats_mcp/server.py (mcp.add_transform(AnnotatedBM25SearchTransform(...)), a subclass of fastmcp's
// BM25SearchTransform), src/maplestats_mcp/modules/*/tools.py (514 standalone @tool functions there)
const MODULE = (prefix) => `from typing import Literal

from fastmcp.tools import tool


@tool
async def ${prefix}_list_indicators(lang: Literal["en", "fr"] = "en") -> dict:
    """List the indicators of the ${prefix} source."""
    return {}


@tool
async def ${prefix}_get_data(indicator: str, lang: Literal["en", "fr"] = "en") -> dict:
    """Get one indicator's data."""
    return {}
`;
const MAPLE_SERVER = `"""The FastMCP server instance: module auto-registration + tool search."""
from fastmcp import FastMCP
from fastmcp.server.providers.local_provider import LocalProvider
from fastmcp.server.transforms.search import (
    BM25SearchTransform,
    SearchResultSerializer,
)
from fastmcp.tools import Tool

SEARCH_ALWAYS_VISIBLE = ("search_tools", "plan_query")


class AnnotatedBM25SearchTransform(BM25SearchTransform):
    """search_tools and call_tool, built here from public fastmcp APIs only."""


def build_server() -> FastMCP:
    provider = LocalProvider()
    mcp = FastMCP("maplestats", providers=[provider])
    mcp.add_transform(
        AnnotatedBM25SearchTransform(
            max_results=5,
            always_visible=list(SEARCH_ALWAYS_VISIBLE),
            search_tool_name="search_tools",
            call_tool_name="call_tool",
        )
    )
    return mcp
`;
const MAPLE = {
  'pyproject.toml': '[project]\nname = "maplestats-mcp"\ndependencies = [\n    "mcp",\n    "fastmcp>=4.0.3,<4.3",\n]\n',
  'src/maplestats_mcp/__init__.py': '',
  'src/maplestats_mcp/server.py': MAPLE_SERVER,
  'src/maplestats_mcp/modules/__init__.py': '',
  'src/maplestats_mcp/modules/ab_economic/__init__.py': '',
  'src/maplestats_mcp/modules/ab_economic/tools.py': MODULE('ab_economic'),
  'src/maplestats_mcp/modules/statcan/__init__.py': '',
  'src/maplestats_mcp/modules/statcan/tools.py': MODULE('statcan'),
};

test('R-RD-41: tools behind a FastMCP tool search transform are not graded as the list; the scan is refused with the reason (dsanchezp18/maplestats-mcp shape)', async () => {
  const r = await R.fromDirectory(repo(MAPLE));
  assert.equal(r.best.kind, 'source');
  assert.equal(r.best.tools.length, 4, 'the registrations are read');
  const u = usableList(r);
  assert.equal(u.problem, 'incomplete');
  assert.deepEqual(r.hints.incomplete.files, ['src/maplestats_mcp/server.py']);
  assert.match(incompleteText(r), /a FastMCP tool search transform \(AnnotatedBM25SearchTransform, line 2\d\) lists search tools, not these/);
  // the same server without the transform lists its tools: graded
  const plain = await R.fromDirectory(repo(Object.assign({}, MAPLE, { 'src/maplestats_mcp/server.py': MAPLE_SERVER.replace(/    mcp\.add_transform\([\s\S]*?\n    \)\n/, '') })));
  assert.equal(usableList(plain).problem, undefined);
  assert.equal(plain.best.tools.length, 4);
  // a transform class imported and never applied is not a transform of the server
  const unused = await R.fromDirectory(repo(Object.assign({}, MAPLE, { 'src/maplestats_mcp/server.py': MAPLE_SERVER.replace(/    mcp\.add_transform\([\s\S]*?\n    \)\n/, '').replace('class AnnotatedBM25SearchTransform(BM25SearchTransform):', 'class Unused(BM25SearchTransform):') })));
  assert.equal(usableList(unused).problem, undefined);
});
