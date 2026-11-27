// Python reader: the wire keys of ToolAnnotations hints written in snake_case (R-RD-40). The fixtures are trimmed to
// the shape of public repositories, credited per test (repository@commit). The rule comes from the Python SDK's own
// source: under 1.x (v1.30.0 src/mcp/types.py) ToolAnnotations has camelCase fields and extra="allow", so
// read_only_hint=True stays "read_only_hint" on the wire; under 2.x (v2.0.0 mcp_types/_v2025_11_25) the fields are
// snake_case with camelCase aliases (populate_by_name, serialised by alias) and extra="ignore". fastmcp 4.x needs
// mcp>=2 (fastmcp_slim/pyproject.toml at v4.0.0 to v4.2.6), fastmcp 3.x and 2.x need mcp<2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import M from '../src/engine.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { readerNotes } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-annkeys-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
// the checks that fire on a candidate, graded the way scan-static and the CLI grade a source list
const fired = (c) => new Set(M.allFindings(analyseList(parseList(c.tools, 'source'), readerNotes(c))).map((f) => f.id));
const CAMEL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// KallistoX/mcp-unifi-applications@cec2194a8a86d9160bd2d5657476a5ff93d0f075 (pyproject.toml, src/mcp_unifi_applications/server.py)
const UNIFI_SERVER = `from fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("unifi-applications")

READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)


@mcp.tool(annotations=READ_ONLY)
def list_endpoints(method: str = "", app: str = "") -> str:
    """Browse the endpoint catalogue: one line per endpoint."""
    return ""


@mcp.tool(annotations=READ_ONLY)
def search_endpoints(query: str, method: str = "") -> str:
    """Find endpoints by name, path fragment, method or description."""
    return ""
`;
const UNIFI_PYPROJECT = `[project]
name = "mcp-unifi-applications"
keywords = ["mcp", "unifi", "ubiquiti"]
dependencies = [
    "fastmcp>=4.1",
    "rapidfuzz>=3.0",
]
`;

test('R-RD-40: fastmcp>=4.1 installs SDK 2.x, so ToolAnnotations(read_only_hint=...) is listed camelCase (KallistoX/mcp-unifi-applications shape)', async () => {
  const r = await R.fromDirectory(repo({ 'pyproject.toml': UNIFI_PYPROJECT, 'src/mcp_unifi_applications/__init__.py': '', 'src/mcp_unifi_applications/server.py': UNIFI_SERVER }));
  assert.equal(r.best.kind, 'source');
  assert.equal(r.best.sdk.pyMajor, 2);
  const t = byName(r.best.tools);
  assert.deepEqual(Object.keys(t).sort(), ['list_endpoints', 'search_endpoints']);
  assert.deepEqual(t.list_endpoints.annotations, CAMEL);
  assert.deepEqual(t.search_endpoints.annotations, CAMEL);
  assert.deepEqual(r.best.unreadable, {});
  const f = fired(r.best);
  assert.ok(!f.has('spec-annotation-key-case'), 'no key-case finding against a server whose wire keys are camelCase');
  assert.ok(!f.has('anthropic-hint'), 'the hints are read');
});

// Thecimal/quantified-self-mcp@54197267034c5c1acc7efb1b73e2f47181f97dae (pyproject.toml, requirements.txt, server.py)
test('R-RD-40: a bare mcp next to fastmcp>=4.0.3,<5.0 is SDK 2.x; inline ToolAnnotations(title=..., *_hint=...) is camelCase (Thecimal/quantified-self-mcp shape)', async () => {
  const server = `from fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("quantified-self")


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get metric history",
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    )
)
def get_metric_history(metric: str, start_date: str | None = None) -> str:
    """
    One metric's day-by-day values only.
    """
    return ""
`;
  const r = await R.fromDirectory(repo({
    'pyproject.toml': '[project]\nname = "quantified-self-mcp"\ndependencies = [\n    "mcp",\n    "fastmcp>=4.0.3,<5.0",\n]\n',
    'requirements.txt': 'fastmcp>=4.0.3,<5.0\n',
    'server.py': server,
  }));
  assert.equal(r.best.sdk.pyMajor, 2);
  assert.deepEqual(r.best.tools[0].annotations, Object.assign({ title: 'Get metric history' }, CAMEL));
  assert.ok(!fired(r.best).has('spec-annotation-key-case'));
});

// alexgaoth/escalate-anything@847cf77f2e021c2c92ce87be8c0fc5845508f752 (pyproject.toml mcp>=1.9, uv.lock mcp 2.3.0, src/escalate_anything/server.py)
test('R-RD-40: the uv.lock entry for mcp decides over a range in pyproject.toml, whatever the file order (alexgaoth/escalate-anything shape)', async () => {
  const server = `from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)


def build():
    mcp = MCPServer(name="escalate-anything", version="0.3.0")

    @mcp.tool(title="Find a company", annotations=READ)
    def find_company(query: str = "") -> dict:
        """Find a company by name."""
        return {}

    return mcp
`;
  const lock = 'version = 1\n\n[[package]]\nname = "anyio"\nversion = "4.6.0"\n\n[[package]]\nname = "mcp"\nversion = "2.3.0"\nsource = { registry = "https://pypi.org/simple" }\n';
  const files = { 'pyproject.toml': '[project]\nname = "escalate-anything"\ndependencies = [\n    "mcp>=1.9",\n]\n', 'uv.lock': lock, 'src/escalate_anything/__init__.py': '', 'src/escalate_anything/server.py': server };
  const r = await R.fromDirectory(repo(files));
  assert.equal(r.best.sdk.pyMajor, 2);
  assert.equal(r.best.sdk.pyMajorFrom, 'lock');
  assert.deepEqual(r.best.tools[0].annotations, { readOnlyHint: true, openWorldHint: false });
  // the same lock pinning 1.x keeps the keys as written: that is what SDK 1.x puts on the wire
  const r1 = await R.fromDirectory(repo(Object.assign({}, files, { 'uv.lock': lock.replace('"2.3.0"', '"1.27.0"'), 'src/escalate_anything/server.py': server.replace('mcp.server.mcpserver import MCPServer', 'mcp.server.fastmcp import FastMCP').replace('MCPServer(', 'FastMCP(') })));
  assert.equal(r1.best.sdk.pyMajor, 1);
  assert.deepEqual(r1.best.tools[0].annotations, { read_only_hint: true, open_world_hint: false });
  assert.ok(fired(r1.best).has('spec-annotation-key-case'), 'under 1.x the snake_case keys are on the wire, and the finding is right');
});

test('R-RD-40: with no knowable SDK major, snake_case hints are left out and the annotations marked not readable, with the reason; camelCase keys stay', async () => {
  // no manifest says which mcp is installed, and the source imports neither SDK-major-specific module
  const server = UNIFI_SERVER.replace('READ_ONLY = ToolAnnotations(', 'TITLED = ToolAnnotations(title="Endpoints", readOnlyHint=True)\nREAD_ONLY = ToolAnnotations(')
    .replace('@mcp.tool(annotations=READ_ONLY)\ndef search_endpoints', '@mcp.tool(annotations=TITLED)\ndef search_endpoints');
  const r = await R.fromDirectory(repo({ 'server.py': server }));
  assert.equal(r.best.sdk.pyMajor, undefined);
  assert.match(r.best.sdk.pyMajorUnknown, /no requirement on mcp or fastmcp/);
  const t = byName(r.best.tools);
  assert.equal(t.list_endpoints.annotations, undefined, 'no key the server could list is invented');
  assert.deepEqual(t.search_endpoints.annotations, { title: 'Endpoints', readOnlyHint: true }, 'camelCase kwargs are camelCase under every major');
  assert.deepEqual(r.best.unreadable.annotations, ['list_endpoints']);
  assert.ok(r.best.notes.some((n) => /snake_case ToolAnnotations hints .* left out where they are set \(1 place\).*no requirement on mcp or fastmcp/.test(n)), r.best.notes.join('\n'));
  const f = fired(r.best);
  assert.ok(!f.has('spec-annotation-key-case'));
});

test('R-RD-40: requirement specifiers: the highest major every requirement allows; keywords and classifiers are not requirements', () => {
  const sdk = (files) => R.detectSdk(new Map(Object.entries(files)));
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp>=1.9,<2"]\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp[cli]~=1.9"]\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp>=1.9"]\n' }).pyMajor, 2, 'an unbounded range installs the newest major');
  assert.equal(sdk({ 'requirements.txt': 'mcp==2.1.0 ; python_version >= "3.10"\n' }).pyMajor, 2);
  assert.equal(sdk({ 'requirements.txt': 'fastmcp>=2.10,<3  # pinned\n' }).pyMajor, 1, 'fastmcp 2.x needs SDK 1.x');
  assert.equal(sdk({ 'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\nmcp = { version = "^1.9", extras = ["cli"] }\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\nkeywords = ["mcp"]\nclassifiers = ["Framework :: mcp"]\n' }).pyMajor, undefined);
  assert.match(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp<2", "fastmcp>=4"]\n' }).pyMajorUnknown, /allow no Python SDK major/);
  assert.equal(sdk({ 'server.py': 'from mcp.server.fastmcp import FastMCP\n' }).pyMajor, 1, 'mcp.server.fastmcp exists only in 1.x');
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp"]\n', 'server.py': 'from mcp.server.fastmcp import FastMCP\n' }).pyMajor, 1);
  assert.equal(sdk({ 'package.json': '{}' }).pyMajorUnknown, undefined, 'a repository with no Python says nothing about Python');
});

test('R-RD-40: under SDK 2.x a ToolAnnotations keyword that is not a field is dropped, as extra="ignore" drops it', () => {
  const src = 'from mcp.server.mcpserver import MCPServer\nfrom mcp.types import ToolAnnotations\nmcp = MCPServer("x")\n@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, readonly=True))\ndef a() -> str:\n    """A."""\n    return ""\n';
  assert.deepEqual(R.extractPy(src, {})[0].tool.annotations, { readOnlyHint: true });
  assert.deepEqual(R.extractPy(src, { sdk: { pyMajor: 1 } })[0].tool.annotations, { read_only_hint: true, readonly: true });
});
