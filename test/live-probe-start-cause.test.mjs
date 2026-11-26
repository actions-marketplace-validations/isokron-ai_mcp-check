// Why a live-probe start failed (corpus/live-probe.mjs failureDetail), R-LP-59..65: a server is blamed (start_failed,
// fault subject) only for a crash in its own code. The stderr below is real, trimmed, from the 26 Nov 2026 review of
// every recorded start failure (each credits the package and version it came from); in that review 37 of the 38
// PyPI start_failed results were our environment, an extra we did not install, or a dependency that changed after
// the release.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as LP from '../corpus/live-probe.mjs';
import { pypiDeps, requirementOf } from '../corpus/pypi-entry.mjs';

const rec = (o = {}) => ({ install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false, ...o });
const exit1 = (stderr, ms = 1500) => ({ initialize: null, era: null, error: null, initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { first_byte_ms: null, total_ms: ms }, stderr });
const py = (pkg, version, entry, pydeps = null) => ({ launch: { kind: 'pypi', package: pkg, version, entry }, argsUnfilled: 0, pydeps });
const detail = (stderr, ctx, r = rec()) => LP.failureDetail(r, exit1(stderr), null, ctx);
const tb = (...lines) => ['Traceback (most recent call last):', '  File "/work/venv/bin/x", line 5, in <module>', ...lines].join('\n');

// --- fixtures (trimmed stderr; package@version they came from)

// blockchain-ai-mcp@1.0.12 (CSOAI-ORG): declares mcp>=1.0.0, no upper bound; the venv resolved mcp 2.x.
const FASTMCP_2X = tb('    from server import main', '    from mcp.server.fastmcp import FastMCP', '    raise ModuleNotFoundError(_MESSAGE, name=__name__)',
  "ModuleNotFoundError: No module named 'mcp.server.fastmcp'. This is mcp 2.x, where FastMCP was renamed to MCPServer (from mcp.server.mcpserver import MCPServer) and other APIs changed");
const BLOCKCHAIN = { top: ['server', 'blockchain-ai-mcp'], base: ['mcp', 'httpx'], uncapped: ['mcp', 'httpx'], extra_only: [], extras: [] };
// mcp-weather-server@0.6.1: McpError became MCPError in mcp 2.x.
const MCPERROR = tb('    from mcp import McpError', "ImportError: cannot import name 'McpError' from 'mcp' (/work/venv/lib/python3.13/site-packages/mcp/__init__.py). Did you mean: 'MCPError'?");
const WEATHER = { top: ['mcp-weather-server'], base: ['mcp', 'httpx'], uncapped: ['mcp'], extra_only: [], extras: [] };
// better-jupyter-mcp-server@1.1.0: a sibling dependency dropped a name.
const KERNEL = tb('    from jupyter_kernel_client import KernelClient', "ImportError: cannot import name 'KernelClient' from 'jupyter_kernel_client' (/work/venv/lib/python3.13/site-packages/jupyter_kernel_client/__init__.py)");
const JUPYTER = { top: ['better-jupyter-mcp-server'], base: ['mcp', 'jupyter-kernel-client'], uncapped: ['mcp', 'jupyter-kernel-client'], extra_only: [], extras: [] };
// deadsimple-email (teamspend-cli@0.2.6 and dns-aid@0.28.1 alike): mcp (or typer) comes only with an extra.
const NO_MCP = tb('    from deadsimple.mcp import main', '    from mcp.types import ToolAnnotations', "ModuleNotFoundError: No module named 'mcp'");
const DEADSIMPLE = { top: ['deadsimple'], base: ['httpx'], uncapped: ['httpx'], extra_only: ['mcp'], extras: ['mcp'] };
const NO_TYPER = tb('    from dns_aid.cli.main import app', '    import typer', "ModuleNotFoundError: No module named 'typer'");
const DNSAID = { top: ['dns-aid'], base: ['dnspython'], uncapped: ['dnspython'], extra_only: ['typer', 'mcp'], extras: ['cli', 'mcp'] };
// arcaeon (and lium.io, grc-lake, pardesline alike): the server names the extra itself.
const EXTRA_HINT = 'arcaeon needs the MCP Python SDK: pip install \'arcaeon[mcp]\'';
// midos-mcp@2026.2.23.1 and codex-control-plane-mcp@0.2.1: the server writes into its own site-packages, which our run mounts read-only.
const RO_FS = tb('    L1_MEMORY.mkdir(parents=True, exist_ok=True)', '    os.mkdir(self, mode)', "OSError: [Errno 30] Read-only file system: '/work/venv/lib/python3.13/site-packages/knowledge'");
// plantcv-mcp@1.20.0: OpenCV needs libGL, which python:3.13-slim lacks.
const LIBGL = tb('    native_module = importlib.import_module("cv2")', 'ImportError: libGL.so.1: cannot open shared object file: No such file or directory');
// mcpbridge-wrapper@0.1.6: wraps Xcode's bridge, macOS only.
const XCRUN = tb('    raise child_exception_type(errno_num, err_msg, err_filename)', "FileNotFoundError: [Errno 2] No such file or directory: 'xcrun'");
// mcp-snowflake-server-nsp@0.14.5: a configuration request, raised with a traceback.
const SNOWFLAKE = tb('    raise ValueError(msg)', 'ValueError: Missing required connection parameter \'database\'. Provide via "--database" argument, "SNOWFLAKE_DATABASE" env var, or TOML file.');
// stratevo@6.0.3: the wheel lacks a subpackage its own entry imports. The one real crash of the 38.
const STRATEVO = tb('    from stratevo.cli.main import main', '    from stratevo.cli.commands.backtest import (cmd_backtest, cmd_compare)', "ModuleNotFoundError: No module named 'stratevo.cli.commands'");
const STRATEVO_DEPS = { top: ['stratevo'], base: ['numpy', 'pandas'], uncapped: ['numpy', 'pandas'], extra_only: [], extras: [] };
// ghcr.io/wyre-technology/sentinelone-mcp:v1.0.6 (and four more OCI images): our --workdir /tmp hid the image's WORKDIR.
const WORKDIR_NODE = "node:internal/modules/cjs/loader:1252\n  throw err;\n  ^\n\nError: Cannot find module '/tmp/dist/index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1249:15)\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v22.11.0";
// ghcr.io/akira231097/artha-council-mcp:1.4.0: SQLite cannot create its database file under the read-only root.
const SQLITE = tb('    conn = sqlite3.connect(self.db_path)', 'sqlite3.OperationalError: unable to open database file');
// mcp-registry-mcp (npm): registers the same tool twice. A real crash: stays the server's.
const DUP_TOOL = 'file:///work/pkg/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:713\n            throw new Error(`Tool ${name} is already registered`);\n                  ^\n\nError: Tool health_check is already registered\n    at McpServer._createRegisteredTool (file:///work/pkg/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:713:19)\n\nNode.js v24.22.3';

// The cases the rules must never blame, with the detail each gets. Every one was start_failed (subject) before.
const NOT_THE_SERVER = [
  ['FASTMCP_2X', FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', BLOCKCHAIN), 'start_dependency_drift', 'drift'],
  ['MCPERROR', MCPERROR, py('mcp-weather-server', '0.6.1', 'mcp_weather_server', WEATHER), 'start_dependency_drift', 'drift'],
  ['KERNEL', KERNEL, py('better-jupyter-mcp-server', '1.1.0', 'better-jupyter-mcp-server', JUPYTER), 'start_dependency_drift', 'drift'],
  ['NO_MCP', NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp', DEADSIMPLE), 'start_needs_extra', 'extra'],
  ['NO_TYPER', NO_TYPER, py('dns-aid', '0.28.1', 'dns-aid', DNSAID), 'start_needs_extra', 'extra'],
  ['EXTRA_HINT', tb('    raise SystemExit(msg)', 'RuntimeError: ' + EXTRA_HINT), py('arcaeon', '0.1.0', 'arcaeon'), 'start_needs_extra', 'extra'],
  ['RO_FS', RO_FS, py('midos-mcp', '2026.2.23.1', 'midos-mcp'), 'start_env_limited', 'env'],
  ['LIBGL', LIBGL, py('plantcv-mcp', '1.20.0', 'plantcv-mcp'), 'start_env_limited', 'env'],
  ['SQLITE', SQLITE, { launch: { kind: 'docker', image: 'ghcr.io/akira231097/artha-council-mcp:1.4.0' }, argsUnfilled: 0 }, 'start_env_limited', 'env'],
  ['WORKDIR_NODE', WORKDIR_NODE, { launch: { kind: 'docker', image: 'ghcr.io/wyre-technology/sentinelone-mcp:v1.0.6' }, argsUnfilled: 0 }, 'start_env_limited', 'env'],
  ['EXCEL', 'Error: ExcelMcp is Windows only\n    at main (/work/pkg/dist/index.js:4:9)', { launch: { kind: 'npm', package: 'excel-mcp' }, argsUnfilled: 0 }, 'unsupported_platform', 'platform'],
  ['XCRUN', XCRUN, py('mcpbridge-wrapper', '0.1.6', 'mcpbridge-wrapper'), 'unsupported_platform', 'platform'],
  ['SNOWFLAKE', SNOWFLAKE, py('mcp-snowflake-server-nsp', '0.14.5', 'mcp_snowflake_server'), 'start_needs_config', 'config'],
];

test('R-LP-59: of the 26 Nov PyPI start_failed results, only the crash in the server\'s own code is blamed on it', () => {
  for (const [name, stderr, ctx, want] of NOT_THE_SERVER) {
    assert.match(stderr, LP.CRASH_TEXT, name + ': the old rule saw a crash here');
    const d = detail(stderr, ctx);
    assert.equal(d, want, name);
    assert.equal(LP.DETAILS[d][3], 'tool', name + ': fault tool, never subject');
  }
  // stratevo: its own wheel lacks the subpackage its entry imports. Still the server's.
  assert.equal(detail(STRATEVO, py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS)), 'start_failed');
  assert.equal(detail(STRATEVO, py('stratevo', '6.0.3', 'stratevo')), 'start_failed', 'without the wheel facts, a module named like the package is its own');
  assert.equal(detail(DUP_TOOL, { launch: { kind: 'npm', package: 'mcp-registry-mcp' }, argsUnfilled: 0 }), 'start_failed', 'a real crash in its own code');
  // The other guards still hold for a crash of its own.
  assert.equal(LP.failureDetail(rec(), exit1(STRATEVO, LP.START_QUICK_MS), null, py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS)), 'start_env_limited', 'a late exit');
});

test('R-LP-60: a read-only root, a refused write, a missing shared library or executable, or our /tmp workdir is start_env_limited (tool)', () => {
  for (const s of [RO_FS, LIBGL, SQLITE, WORKDIR_NODE, "python: can't open file '/tmp/server.py': [Errno 2] No such file or directory",
    "Error: EACCES: permission denied, mkdir '/data/logs'", "PermissionError: [Errno 13] Permission denied: '/config'", "Error: EROFS: read-only file system, open '/app/cache.json'",
    'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file',
    // nano-pdf-mcp's image (an arm64 image on our amd64 runner) and neo4j-mcp-canary's bundled binary: a binary for another CPU.
    '[FATAL tini (2)] exec python failed: Exec format error', "OSError: [Errno 8] Exec format error: '/work/venv/lib/python3.13/site-packages/neo4j_mcp_canary/neo4j-mcp-canary.exe'"]) {
    assert.match(s, LP.ENV_TEXT, s);
  }
  for (const s of ['Error: spawn git ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)', "FileNotFoundError: [Errno 2] No such file or directory: 'uvx'", '/bin/sh: 1: java: not found', 'exec: "docker": executable file not found in $PATH']) {
    assert.equal(detail(s, py('x-mcp', '1.0.0', 'x-mcp')), 'start_env_limited', s);
  }
  // A declared env var does not turn our environment into the server's needs_credentials.
  assert.equal(detail(RO_FS, py('midos-mcp', '2026.2.23.1', 'midos-mcp'), rec({ env: { names: { registry: ['API_KEY'] }, secret_named: ['API_KEY'] } })), 'start_env_limited');
  // A file path or a data file is not an executable.
  assert.doesNotMatch("FileNotFoundError: [Errno 2] No such file or directory: 'config.json'", LP.ENV_TEXT);
});

test('R-LP-61: a module only an extra brings, or a server naming the extra to install, is start_needs_extra (tool)', () => {
  assert.deepEqual(LP.DETAILS.start_needs_extra, ['timeout_start', false, 'start', 'tool']);
  assert.equal(detail(NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp', DEADSIMPLE)), 'start_needs_extra');
  assert.equal(detail(NO_TYPER, py('dns-aid', '0.28.1', 'dns-aid', DNSAID)), 'start_needs_extra');
  // A missing module we cannot place (no wheel facts, or not declared at all: a stdlib module the slim image lacks, a
  // name that differs from its distribution) is not the server's either.
  assert.equal(detail(NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp')), 'start_env_limited');
  assert.equal(detail(tb("ModuleNotFoundError: No module named 'distutils'"), py('x', '1', 'x', { ...DEADSIMPLE, extra_only: [] })), 'start_env_limited');
  // The release's facts, as the planner records them from PyPI's JSON and the wheel.
  const deps = pypiDeps({ requires_dist: ['httpx>=0.27', 'mcp>=1.2; extra == "mcp"', 'typer[all]>=0.9 ; extra == \'cli\'', 'pydantic>=2,<3', 'anyio~=4.0', 'rich (>=13)'], provides_extra: ['mcp', 'cli'] }, ['deadsimple/__init__.py', 'deadsimple/mcp.py', 'deadsimple-1.0.dist-info/METADATA', 'helper.py']);
  assert.deepEqual(deps, { top: ['deadsimple', 'helper'], base: ['httpx', 'pydantic', 'anyio', 'rich'], uncapped: ['httpx', 'rich'], extra_only: ['mcp', 'typer'], extras: ['mcp', 'cli'] });
  assert.deepEqual(requirementOf('Foo_Bar[x] ==1.*; python_version < "3.12"'), { name: 'foo-bar', extra: null, capped: true });
  assert.equal(pypiDeps(null, null).top, null, 'no wheel read: own modules unknown');
});

test('R-LP-62: a dependency that changed after the release is start_dependency_drift, and a macOS- or Windows-only server is unsupported_platform (both tool)', () => {
  assert.deepEqual(LP.DETAILS.start_dependency_drift, ['timeout_start', false, 'start', 'tool']);
  assert.deepEqual(LP.DETAILS.unsupported_platform, ['timeout_start', false, 'start', 'tool']);
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', BLOCKCHAIN)), 'start_dependency_drift');
  assert.equal(detail(MCPERROR, py('mcp-weather-server', '0.6.1', 'mcp_weather_server', WEATHER)), 'start_dependency_drift');
  // Drift needs the dependency declared with no upper bound; a capped one, or no facts at all, is not ours to tell:
  // start_env_limited, still never the server's.
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', { ...BLOCKCHAIN, uncapped: ['httpx'] })), 'start_env_limited');
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp')), 'start_env_limited');
  // Node: an export a dependency no longer has.
  const esm = "file:///work/pkg/dist/index.js:1\nimport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n         ^^^^^^^^^\nSyntaxError: The requested module '@modelcontextprotocol/sdk/server/mcp.js' does not provide an export named 'McpServer'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)";
  assert.equal(detail(esm, { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 }), 'start_dependency_drift');
  assert.equal(detail("SyntaxError: The requested module './tools.js' does not provide an export named 'x'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)", { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 }), 'start_failed', 'its own module');
  // Platform: the server says so, or needs an executable only macOS or Windows has.
  assert.equal(detail('Error: ExcelMcp is Windows only\n    at main (/work/pkg/dist/index.js:4:9)', { launch: { kind: 'npm', package: 'excel-mcp' }, argsUnfilled: 0 }), 'unsupported_platform');
  assert.equal(detail(XCRUN, py('mcpbridge-wrapper', '0.1.6', 'mcpbridge-wrapper')), 'unsupported_platform');
  for (const s of ['This server only runs on macOS', 'RuntimeError: requires Windows', 'Error: not supported on Linux', 'macOS-only: uses AppleScript']) assert.match(s, LP.PLATFORM_TEXT, s);
  for (const s of ['Running on Windows, macOS and Linux', 'windows path detected']) assert.doesNotMatch(s, LP.PLATFORM_TEXT, s);
});

test('R-LP-63: configuration requests the first patterns missed are start_needs_config (tool), traceback or not', () => {
  const msgs = ['Missing required setting(s): OITC_APIKEY', 'Configuration error: AXE_API_KEY, AXE_URL', '{"error":{"code":"configuration_path_required"}}', 'Pass --project <path>', 'Error: Factory is not configured', 'No Telegram credentials configured', 'Run the pipeline first', 'Invalid configuration', SNOWFLAKE];
  for (const s of msgs) {
    assert.match(s, LP.CONFIG_TEXT, s);
    assert.equal(detail(s, { launch: { kind: 'npm', package: 'x' }, argsUnfilled: 0 }), 'start_needs_config', s);
  }
  for (const s of ['missing field in response', 'run the server', 'Configured 3 tools']) assert.doesNotMatch(s, LP.CONFIG_TEXT, s);
});

test('R-LP-64: a server that went to the network is start_needs_network whether or not a variable is declared, from telemetry or its own stderr', () => {
  const dns = { v: 1, type: 'dns_query', subject: 's001', source: 'netlog', role: 'server', qname: 'api.example.com', qtype: 'A', answer: 'sinkhole' };
  // Was start_env_limited with no variable declared (code at 1177): the cause is known, so it is named.
  assert.equal(LP.failureDetail(rec(), exit1('panic: x\n\ngoroutine 1 [running]:'), null, { launch: { kind: 'npm' }, argsUnfilled: 0, records: [dns] }), 'start_needs_network');
  for (const s of [tb('httpx.ConnectError: [Errno -3] Temporary failure in name resolution'), 'Error: getaddrinfo ENOTFOUND api.github.com\n    at GetAddrInfoReqWrap.onlookup (node:dns:120:26)', tb('requests.exceptions.ConnectionError: HTTPSConnectionPool(host=\'x\', port=443): Failed to establish a new connection')]) {
    assert.match(s, LP.NETWORK_TEXT, s);
    assert.equal(detail(s, py('x-mcp', '1', 'x-mcp')), 'start_needs_network', s);
  }
  assert.equal(LP.DETAILS.start_needs_network[3], 'tool');
});

test('R-LP-65: mutation check: with a start rule switched off its fixture gets another detail, and with all of them off every fixture is blamed on the server again', () => {
  const cases = [...NOT_THE_SERVER,
    ['NETWORK', tb('httpx.ConnectError: [Errno -3] Temporary failure in name resolution'), py('x-mcp', '1', 'x-mcp'), 'start_needs_network', 'network'],
    ['FASTMCP_NO_FACTS', FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp'), 'start_env_limited', 'import']];
  const rules = new Set();
  try {
    for (const [name, stderr, ctx, want, rule] of cases) {
      rules.add(rule);
      LP.setStartMutation(null);
      assert.equal(detail(stderr, ctx), want, name + ' with every rule on');
      LP.setStartMutation(rule);
      assert.notEqual(detail(stderr, ctx), want, name + ': switching ' + rule + ' off changed nothing, so its test does not depend on it');
      LP.setStartMutation('all');
      assert.equal(detail(stderr, ctx), 'start_failed', name + ': without the start rules the server is blamed, which is what they prevent');
    }
  } finally { LP.setStartMutation(null); }
  assert.deepEqual([...rules].sort(), ['config', 'drift', 'env', 'extra', 'import', 'network', 'platform']);
});
