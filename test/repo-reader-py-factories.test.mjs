// --repo: Python tools made by the repository's own factories (R-RD-02): a registrar used as a bare decorator
// (@create_tool("x", "X") whose body calls add_tool), and a factory that builds the tool dict from its parameters
// (a hand-rolled server's @tool("name", "Title", "…", properties=…), or TOOLS = [tool("a", …)]). Synthetic sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const names = (an) => an.tools.map((x) => x.tool.name).sort();
const tool = (an, n) => an.tools.find((x) => x.tool.name === n).tool;
const PY = '[project]\nname = "demo"\ndependencies = ["fastmcp>=3"]\n';

const REGISTRAR = `
from fastmcp import FastMCP
from functools import wraps

mcp = FastMCP(name="Notes")
_registry = []

def with_errors(op):
    def deco(fn):
        @wraps(fn)
        async def wrapper(*a, **k):
            return await fn(*a, **k)
        return wrapper
    return deco

def create_tool(tool_name: str, operation_name: str):
    def decorator(func):
        wrapped = with_errors(operation_name)(func)
        tool_obj = mcp.local_provider.add_tool(wrapped)
        _registry.append((tool_name, tool_obj))
        return tool_obj
    return decorator

@create_tool("ping_notes", "Ping")
async def ping_notes() -> str:
    """Checks the connection to the notes app."""
    return "ok"
`;
const MORE = `
from .server import create_tool

@create_tool("get_note", "Get note")
async def get_note(note_id: str, limit: int = 10) -> str:
    """Gets one note.

    Args:
        note_id: The note to get.
    """
    return ""
`;

test('R-RD-02: a registrar used as a bare decorator (@create_tool("x", "X") calling add_tool): each decorated function is a tool, named after the function', () => {
  const an = read({ 'pyproject.toml': PY, 'notes/server.py': REGISTRAR, 'notes/tools.py': MORE });
  assert.deepEqual(names(an), ['get_note', 'ping_notes']);
  assert.equal(tool(an, 'ping_notes').description, 'Checks the connection to the notes app.');
  const g = tool(an, 'get_note');
  assert.deepEqual(Object.keys(g.inputSchema.properties), ['note_id', 'limit']);
  assert.deepEqual(g.inputSchema.required, ['note_id']);
});

test('R-RD-02: a bare registrar that passes one of its parameters on as the name: the name comes from that argument', () => {
  const src = 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\n\ndef expose(label, summary=None):\n    def deco(fn):\n        mcp.add_tool(fn, name=label, description=summary)\n        return fn\n    return deco\n\n@expose("search_items", "Searches the items.")\ndef do_search(q: str) -> str:\n    return q\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["mcp"]\n', 'x/server.py': src });
  assert.deepEqual(names(an), ['search_items']);
  assert.equal(tool(an, 'search_items').description, 'Searches the items.');
});

const FACTORY = `
"""A hand-rolled stdio server: tools stored by a decorator factory."""
TOOLS = {}

def tool(name, title, description, properties=None, required=(), write=False):
    def deco(fn):
        schema = {"type": "object", "properties": properties or {}, "additionalProperties": False}
        if required:
            schema["required"] = list(required)
        ann = {"title": title, "readOnlyHint": not write}
        TOOLS[name] = {"def": {"name": name, "title": title, "description": description,
                               "inputSchema": schema, "annotations": ann}, "fn": fn}
        return fn
    return deco


@tool("get_status", "Status",
      "What the terminal is connected to. "
      "Call this first.")
def get_status(args):
    return {}


@tool("open_trade", "Open a trade", "Opens a paper trade.",
      {"symbol": {"type": "string", "description": "Ticker"}}, required=("symbol",), write=True)
def open_trade(args):
    return {}


def handle(method):
    if method == "tools/list":
        return {"tools": [t["def"] for t in TOOLS.values()]}
`;

test('R-RD-02: a decorator factory that builds the tool dict from its parameters: name, title and description from the arguments', () => {
  const an = read({ 'pyproject.toml': '[project]\nname = "term"\n', 'term/mcp.py': FACTORY });
  assert.deepEqual(names(an), ['get_status', 'open_trade']);
  const s = tool(an, 'get_status');
  assert.equal(s.title, 'Status');
  assert.equal(s.description, 'What the terminal is connected to. Call this first.');
  // the schema and annotations are built in the factory's body (locals): not readable, never made up
  const r = R.publicTools(an.tools.map((x) => x.tool));
  assert.deepEqual(r.unreadable.inputSchema.sort(), ['get_status', 'open_trade']);
  assert.deepEqual(r.unreadable.annotations.sort(), ['get_status', 'open_trade']);
  // the other arguments' text (the properties) is kept for the poisoning scan; the description is not repeated there
  assert.match(r.unreadable.text.open_trade, /Ticker/);
  assert.equal(r.unreadable.text.get_status, undefined);
});

test('R-RD-02: a helper that returns the tool dict: each call is a tool, the schema filled from the arguments', () => {
  const src = 'def tool(name, description, properties, required=()):\n    return {"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties, "required": list(required)}}\n\nTOOLS = [\n    tool("x_tap", "Taps.", {"target": {"type": "string"}}),\n    tool("x_apps", "Lists the apps.", {}),\n]\n\ndef handle(m):\n    if m == "tools/list":\n        return {"tools": TOOLS}\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/server.py': src });
  assert.deepEqual(names(an), ['x_apps', 'x_tap']);
  assert.deepEqual(tool(an, 'x_tap').inputSchema.properties, { target: { type: 'string' } });
  // list(required) is a call the reader does not evaluate: the schema keeps what it can read, nothing made up
  assert.equal(tool(an, 'x_tap').inputSchema.required, undefined);
});

test('R-RD-02: a factory call whose name the reader cannot work out is counted as unresolved, never invented', () => {
  const src = 'def tool(name, description):\n    return {"name": name, "description": description, "inputSchema": {"type": "object"}}\n\nTOOLS = [tool(n, "Generated.") for n in load_names()] + [tool("fixed", "Fixed.")]\n\ndef handle(m):\n    if m == "tools/list":\n        return {"tools": TOOLS}\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/server.py': src });
  assert.deepEqual(names(an), ['fixed']);
  assert.equal(an.unresolved, 1);
});

test('R-RD-02: a function of the same name defined twice in the repository is not used as a factory', () => {
  const a = 'def tool(name, description):\n    return {"name": name, "description": description, "inputSchema": {"type": "object"}}\nT = [tool("one", "One.")]\n';
  const b = 'def tool(name, description):\n    return {"name": name + "_v2", "description": description, "inputSchema": {"type": "object"}}\nU = [tool("two", "Two.")]\n';
  const an = read({ 'pyproject.toml': '[project]\nname = "x"\n', 'x/a.py': a, 'x/b.py': b });
  assert.deepEqual(names(an), []);
});
