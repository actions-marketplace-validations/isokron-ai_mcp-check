// --repo: Python servers that write their tools out as dicts (a hand-rolled JSON-RPC server's tools/list answer)
// (R-RD-01). Synthetic sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const names = (an) => an.tools.map((x) => x.tool.name);
const tool = (an, n) => an.tools.find((x) => x.tool.name === n).tool;

const HANDROLLED = `
"""A stdio JSON-RPC server with two tools."""
import json, sys

LEVELS = ("low", "high")
LEVEL_SCHEMA = {"type": "string", "enum": list(LEVELS), "description": "How hard to look."}

TOOLS = [
    {
        "name": "scan_text",
        "title": "Scan a text",
        "description": (
            "Scores a text and lists what to fix. "
            "Read-only."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text"},
                "level": LEVEL_SCHEMA,
            },
            "required": ["text"],
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "compare_texts",
        "description": "Compares two texts.",
        "inputSchema": {"type": "object", "properties": {"before": {"type": "string"}, "after": {"type": "string"}}, "required": ["before", "after"], "additionalProperties": False},
    },
]


def handle(req):
    if req.get("method") == "tools/list":
        return {"tools": TOOLS}
`;

test('R-RD-01: a hand-rolled Python server: the tool dicts of its TOOLS list are its tools', () => {
  const an = read({ 'pyproject.toml': '[project]\nname = "demo"\n', 'demo/server.py': HANDROLLED });
  assert.deepEqual(names(an), ['scan_text', 'compare_texts']);
  const a = tool(an, 'scan_text');
  assert.equal(a.title, 'Scan a text');
  assert.equal(a.description, 'Scores a text and lists what to fix. Read-only.');
  assert.deepEqual(a.inputSchema.required, ['text']);
  assert.equal(a.inputSchema.properties.text.description, 'The text');
  assert.deepEqual(a.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(tool(an, 'compare_texts').inputSchema.additionalProperties, false);
  // the line of each dict, not of the logical line that holds the whole list
  const lines = an.tools.map((x) => x.line);
  assert.ok(lines[0] < lines[1], lines.join(','));
});

test('R-RD-01: the tool dicts in a module of their own, served by another module, are read the same way', () => {
  const tools = 'TOOLS: list[dict] = [\n    {"name": "list_projects", "description": "Lists projects.", "inputSchema": {"type": "object", "properties": {}}},\n]\n\ndef tools_list_payload():\n    return {"tools": TOOLS}\n';
  const server = 'from .tools import tools_list_payload\n\ndef handle(method):\n    if method == "tools/list":\n        return tools_list_payload()\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "cp"\n', 'cp/tools.py': tools, 'cp/server.py': server });
  assert.deepEqual(names(an), ['list_projects']);
});

test('R-RD-01: a dict whose name is a parameter or an attribute is not a tool (a template filled elsewhere, a copy of another server\'s tool)', () => {
  const src = 'def as_mcp(t):\n    return {"name": t.name, "description": t.description, "inputSchema": t.schema}\n\ndef make(name, description):\n    return {"name": name, "description": description, "inputSchema": {"type": "object"}}\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/adapt.py': src });
  assert.deepEqual(names(an), []);
});

test('R-RD-01: input_schema (the Anthropic API key) counts only in a file that speaks MCP', () => {
  const api = 'TOOLS = [{"name": "get_weather", "description": "Weather for a city.", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}}]\n\ndef ask(client):\n    return client.messages.create(tools=TOOLS)\n';
  assert.deepEqual(names(read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/agent.py': api })), []);
  const mcp = api + '\ndef handle(m):\n    if m == "tools/list":\n        return {"tools": TOOLS}\n';
  assert.deepEqual(names(read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/server.py': mcp })), ['get_weather']);
});

test('R-RD-01: a list that unpacks another ([*GENRES, None]) is not read as a shorter enum', () => {
  const src = 'from .markers import GENRES\n\nTOOLS = [{"name": "scan", "description": "Scans.", "inputSchema": {"type": "object", "properties": {"genre": {"type": ["string", "null"], "enum": [*GENRES, None]}}}}]\n\ndef handle(m):\n    if m == "tools/list":\n        return {"tools": TOOLS}\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/server.py': src });
  const g = tool(an, 'scan').inputSchema.properties.genre;
  assert.equal(g.enum, undefined, JSON.stringify(g));
  assert.deepEqual(g.type, ['string', 'null']);
});

test('R-RD-01: a tool dict whose schema is computed keeps its name and description, its schema marked not readable', () => {
  const src = 'TOOLS = [{"name": "run", "description": "Runs a job.", "inputSchema": build_schema("run")}]\n\ndef handle(m):\n    if m == "tools/list":\n        return {"tools": TOOLS}\n';
  const r = R.publicTools(read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/server.py': src }).tools.map((x) => x.tool));
  assert.deepEqual(r.tools.map((t) => t.name), ['run']);
  assert.deepEqual(r.unreadable.inputSchema, ['run']);
  assert.equal(r.tools[0].description, 'Runs a job.');
});
