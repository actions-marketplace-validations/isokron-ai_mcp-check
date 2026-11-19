// Live and static inputs: HTTP (both protocol eras), stdio, client configs, repository extraction, the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../src/capture.js';
import { parseList } from '../src/tools.js';
import { collect, sourceLine, expandEnv, InputFailure } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const M = require('../engine/core.js');
const C = require('../src/inputs/mcp-client.cjs');
const Cfg = require('../src/inputs/mcp-config.cjs');
const R = require('../src/inputs/repo-source.cjs');
const F = require('./fake/servers.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'mcp-check.js');
const stdioFake = join(root, 'test', 'fake', 'stdio-server.cjs');
const src = (f) => readFileSync(join(root, 'test', 'sources', f), 'utf8');
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {}) : v);
// async CLI run (spawnSync would block the in-process fake HTTP servers)
function runCli(args, opts) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli].concat(args), Object.assign({ env: process.env }, opts || {}));
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'mcpcheck-in-'));

// ------------------------------------------------------------ HTTP client
test('http: modern 2026-07-28 server, stateless, two pages, _meta and Mcp-Method sent, no initialize', async (t) => {
  const s = F.modern(); const url = await F.listen(s); t.after(() => s.srv.close());
  const r = await C.listToolsHttp(url);
  assert.equal(r.era, 'modern'); assert.equal(r.protocolVersion, '2026-07-28');
  assert.equal(r.pages.length, 2); assert.deepEqual(r.serverInfo, { name: 'fake-modern', version: '1.0.0' });
  assert.ok(s.log.every((l) => l.method === 'tools/list' && l.headers['mcp-method'] === 'tools/list'));
  const parsed = M.parseData(r.pages);
  assert.equal(parsed.tools.length, 3); assert.equal(parsed.envelope.kind, 'pages');
});

test('http: legacy server, initialize + session id + SSE answers + pagination, session closed', async (t) => {
  const s = F.legacy(); const url = await F.listen(s); t.after(() => s.srv.close());
  const r = await C.listToolsHttp(url);
  assert.equal(r.era, 'legacy'); assert.equal(r.protocolVersion, '2025-06-18'); assert.equal(r.session, true);
  assert.equal(M.parseData(r.pages).tools.length, 3);
  assert.deepEqual(s.log.map((l) => l.method), ['tools/list', 'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  assert.ok(s.log.slice(1).filter((l) => l.headers).every((l) => !l.headers['mcp-method']));
  assert.ok(!s.log.some((l) => l.method === 'tools/call'), 'no tool is called');
});

test('http: --protocol legacy skips the modern probe; 401 reports auth; size limit; bad URLs refused', async (t) => {
  const s = F.legacy({ noSession: true }); const url = await F.listen(s); t.after(() => s.srv.close());
  const r = await C.listToolsHttp(url, { protocol: 'legacy' });
  assert.equal(r.era, 'legacy'); assert.equal(s.log[0].method, 'initialize');
  const a = F.modern({ auth: true }); const aurl = await F.listen(a); t.after(() => a.srv.close());
  await assert.rejects(C.listToolsHttp(aurl), (e) => e.code === 'auth' && /oauth-protected-resource/.test(e.resourceMetadata));
  assert.equal((await C.listToolsHttp(aurl, { headers: { Authorization: 'Bearer s3cret' } })).pages.length, 2);
  await assert.rejects(C.listToolsHttp(aurl, { maxBytes: 100, headers: { Authorization: 'Bearer s3cret' } }), (e) => e.code === 'too_large');
  await assert.rejects(C.listToolsHttp('file:///etc/passwd'), (e) => e.code === 'bad_url');
  await assert.rejects(C.listToolsHttp('https://user:pw@example.com/mcp'), (e) => e.code === 'bad_url');
  const m = C.parseSse(': keep-alive\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{}}\r\n\r\n');
  assert.deepEqual(m, [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

// ------------------------------------------------------------ stdio (one implementation: capture)
test('stdio: legacy server (initialize), stray stdout line skipped, pagination', async () => {
  const r = await capture([process.execPath, stdioFake, 'legacy'], { timeoutMs: 10000, stderr: null });
  assert.equal(r.era, 'legacy'); assert.equal(r.serverInfo.name, 'fake-stdio'); assert.equal(r.protocolVersion, '2025-06-18');
  assert.equal(M.parseData(r.answers).tools.length, 3);
});
test('stdio: modern server refuses initialize -> tools/list with _meta', async () => {
  const r = await capture([process.execPath, stdioFake, 'modern'], { timeoutMs: 10000, stderr: null });
  assert.equal(r.era, 'modern'); assert.equal(r.protocolVersion, '2026-07-28'); assert.equal(M.parseData(r.answers).tools.length, 3);
});
test('stdio: extra env reaches the server; an early exit is reported with its stderr; fence under Actions', async () => {
  const r = await capture([process.execPath, stdioFake], { extraEnv: { FAKE_REQUIRE_ENV: '1', FAKE_TOKEN: 'abc' }, timeoutMs: 10000, stderr: null });
  assert.equal(r.pages, 2);
  await assert.rejects(capture([process.execPath, '-e', 'console.error("boom: missing API key"); process.exit(1)'], { timeoutMs: 10000, stderr: null }), (e) => e.code === 'exited' && /missing API key/.test(e.stderr));
  let out = '';
  const sink = { write: (c) => { out += c; } };
  await capture([process.execPath, stdioFake, 'legacy'], { timeoutMs: 10000, stderr: sink, fence: true });
  const tok = /^::stop-commands::([0-9a-f]{32})$/m.exec(out);
  assert.ok(tok && out.indexOf('fake legacy ready') > tok.index && out.lastIndexOf('::' + tok[1] + '::') > out.indexOf('fake legacy ready'));
});

// ------------------------------------------------------------ config import
test('config: mcpServers (Claude Desktop, Cursor, Claude Code), env and http entries, disabled', () => {
  const c = Cfg.parseConfig(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x', '/tmp'], env: { KEY: '${env:MY_KEY}' } }, remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, off: { command: 'x', disabled: true } } }), { env: { MY_KEY: 'k1', TOKEN: 't1' } });
  assert.equal(c.format, 'mcpServers');
  assert.deepEqual(c.servers[0].env, { KEY: 'k1' });
  assert.equal(c.servers[1].transport, 'http'); assert.equal(c.servers[1].headers.Authorization, 'Bearer t1');
  assert.equal(c.servers[2].disabled, true);
});
test('config: VS Code JSONC with ${input:} left unresolved and sse type; VS Code settings; Zed; known paths', () => {
  const vs = Cfg.parseConfig('{\n // comment\n "inputs": [{"id":"key","type":"promptString","password":true}],\n "servers": {\n  "gh": {"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${input:key}"}},\n  "old": {"type":"sse","url":"https://x/sse"},\n  "py": {"type":"stdio","command":"uvx","args":["mcp-server-time"],},\n }\n}');
  assert.equal(vs.format, 'vscode');
  assert.deepEqual(vs.servers[0].unresolved, ['input:key']);
  assert.equal(vs.servers[1].transport, 'sse'); assert.equal(vs.servers[2].command, 'uvx');
  assert.equal(Cfg.parseConfig(JSON.stringify({ mcp: { servers: { a: { command: 'node' } } } })).format, 'vscode-settings');
  const zed = Cfg.parseConfig(JSON.stringify({ context_servers: { t: { command: { path: 'node', args: ['s.js'], env: {} } } } }));
  assert.equal(zed.format, 'zed'); assert.equal(zed.servers[0].command, 'node');
  assert.match(Cfg.parseConfig('{"x":1}').error, /No MCP servers/);
  const paths = Cfg.knownConfigPaths('/Users/a', 'darwin', null, '/proj').map((p) => p.path);
  assert.ok(paths.includes('/Users/a/Library/Application Support/Claude/claude_desktop_config.json'));
  assert.ok(paths.includes('/Users/a/.codeium/windsurf/mcp_config.json'));
  assert.ok(paths.includes('/proj/.mcp.json') && paths.includes('/proj/.vscode/mcp.json'));
});

// ------------------------------------------------------------ CLI
test('cli: --url checks a live modern server and prints the Source line', async (t) => {
  const s = F.modern(); const url = await F.listen(s); t.after(() => s.srv.close());
  const r = await runCli(['--url', url]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP check .*rubric .* \(3 tools/);
  assert.match(r.stdout, /Source: live server http:\/\/127\.0\.0\.1:\d+\/mcp \(modern, protocol 2026-07-28, fake-modern 1\.0\.0\)/);
  const md = await runCli(['--url', url, '--format', 'md']);
  assert.match(md.stdout, /^# MCP tool list check\n\nSource: live server/);
});
test('cli: --header reads $VAR; the value is never printed; --save writes the pages; no token -> exit 3', async (t) => {
  const s = F.modern({ auth: true }); const url = await F.listen(s); t.after(() => s.srv.close());
  const out = join(tmp(), 'tools.json');
  const r = await runCli(['--url', url, '--header', 'Authorization: Bearer $FAKE_TOKEN_X', '--save', out, '--format', 'json'], { env: { ...process.env, FAKE_TOKEN_X: 's3cret' } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout); assert.equal(j.input.tools, 3); assert.equal(j.source.era, 'modern');
  assert.ok(!r.stdout.includes('s3cret') && !r.stderr.includes('s3cret'), 'the token is never printed');
  assert.equal(M.parseInput(readFileSync(out, 'utf8')).tools.length, 3);
  const bad = await runCli(['--url', url]);
  assert.equal(bad.status, 3); assert.match(bad.stderr, /needs authorization/);
  assert.equal((await runCli(['--url', 'http://127.0.0.1:9/mcp', '--timeout', '5'])).status, 3, 'unreachable');
  assert.equal(expandEnv('Bearer ${A_B}', { A_B: 'x' }), 'Bearer x');
});
test('cli: with headers set, a redirect is refused so the header never reaches another host', async (t) => {
  const http = await import('node:http');
  let hits = 0;
  const target = http.createServer((req, res) => { hits++; res.end('{}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redir = http.createServer((req, res) => { res.writeHead(307, { Location: 'http://localhost:' + target.address().port + '/mcp' }); res.end(); });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r));
  t.after(() => { target.close(); redir.close(); });
  const r = await runCli(['--url', 'http://127.0.0.1:' + redir.address().port + '/mcp', '--header', 'X-Api-Key: k123', '--timeout', '10']);
  assert.equal(r.status, 3);
  assert.equal(hits, 0, 'the redirect target was never contacted');
  assert.ok(!r.stderr.includes('k123'));
});
test('cli: -- <command> and --command run a stdio server', async () => {
  const r = await runCli(['--sections', 'spec', '--', process.execPath, stdioFake, 'legacy']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Source: local server .*stdio-server\.cjs legacy \(legacy, protocol 2025-06-18, fake-stdio 2\.0\.0\)/);
  const c = await runCli(['--command', JSON.stringify(process.execPath) + ' ' + JSON.stringify(stdioFake), '--env', 'FAKE_REQUIRE_ENV=1', '--env', 'FAKE_TOKEN=abc']);
  assert.equal(c.status, 0, c.stderr);
  const gone = await runCli(['--', process.execPath, '-e', 'process.exit(2)']);
  assert.equal(gone.status, 3);
});
test('cli: --config checks every server, reports the ones it cannot run, never prints header values', async (t) => {
  const s = F.legacy(); const url = await F.listen(s); t.after(() => s.srv.close());
  const cfg = join(tmp(), 'claude_desktop_config.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [stdioFake, 'modern'] }, remote: { url, headers: { 'X-Team': 'team-secret-value' } }, needsKey: { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${input:k}' } }, off: { command: 'nope', disabled: true } } }));
  const r = await runCli(['--config', cfg, '--format', 'json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.map((x) => x.label), ['config / local', 'config / remote', 'config / needsKey']);
  assert.equal(j[0].source.era, 'modern'); assert.equal(j[1].source.era, 'legacy'); assert.match(j[2].error, /input:k/);
  assert.match(r.stderr, /config \/ remote: http:\/\/127\.0\.0\.1:\d+\/mcp \(headers: X-Team\)/);
  assert.ok(!r.stderr.includes('team-secret-value') && !r.stdout.includes('team-secret-value'));
  const one = await runCli(['--config', cfg, '--server', 'local']);
  assert.match(one.stdout, /== config \/ local/);
  assert.equal((await runCli(['--config', cfg, '--server', 'nope'])).status, 2);
  const saved = join(tmp(), 'saved.json');
  const kept = await runCli(['--config', cfg, '--server', 'local', '--save', saved]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(parseList(readFileSync(saved, 'utf8'), 'saved').tools.length, 3, '--save works with --config --server');
  assert.equal((await runCli(['--config', cfg, '--save', saved])).status, 2, '--save needs one server');
  const allBad = join(tmp(), 'bad.json');
  writeFileSync(allBad, JSON.stringify({ mcpServers: { a: { url: 'http://127.0.0.1:9/mcp' } } }));
  assert.equal((await runCli(['--config', allBad, '--timeout', '5'])).status, 3, 'nothing could be listed');
});
test('cli: one input only; --header only with --url', async () => {
  const r = await runCli(['x.json', '--url', 'https://x']); assert.equal(r.status, 2); assert.match(r.stderr, /give one input/);
  assert.match((await runCli(['--repo', 'o/r', '--header', 'A: b'])).stderr, /--header goes with --url only/);
});

// ------------------------------------------------------------ static extraction (ground truth from the real SDKs)
test('extract: TS registerTool / server.tool with zod == what TS SDK 1.32 lists', () => {
  // SDK 1.32 adds { taskSupport: 'forbidden' } to every McpServer tool; the version is known from the manifest (detectSdk).
  const got = R.extractFromFile('src/index.ts', src('register-tool.ts'), { sdk: { kind: 'v1', version: '1.32.2' } }).map((x) => x.tool);
  assert.deepEqual(sortKeys(got), sortKeys(JSON.parse(src('register-tool.ts.truth.json'))));
  // With no SDK version known the reader does not invent the field (see test/repo-reader.test.mjs).
  const bare = R.extractFromFile('src/index.ts', src('register-tool.ts')).map((x) => x.tool);
  const truth = JSON.parse(src('register-tool.ts.truth.json')); truth.forEach((x) => { delete x.execution; });
  assert.deepEqual(sortKeys(bare), sortKeys(truth));
});
test('extract: Python @mcp.tool == what the Python SDK lists; its snake_case hints trip spec-annotation-key-case', () => {
  const got = R.extractFromFile('server.py', src('server.py')).map((x) => x.tool);
  assert.deepEqual(sortKeys(got), sortKeys(JSON.parse(src('server.py.truth.json'))));
  assert.deepEqual(got[2].annotations, { destructive_hint: true, read_only_hint: false });
  const r = M.analyse(M.parseData(got));
  const hits = M.allFindings(r).filter((f) => f.id === 'spec-annotation-key-case');
  assert.deepEqual(hits.map((f) => f.path).sort(), ['annotations.destructive_hint', 'annotations.read_only_hint']);
});
test('extract: low-level literals, TS syntax tolerance, plan files, MCPB manifests, repo refs', () => {
  const got = R.extractFromFile('server.js', src('low-level.js'));
  assert.deepEqual(got.map((x) => [x.tool.name, x.fidelity]), [['query', 'literal'], ['drop_table', 'literal']]);
  const ts = 'const re = /[{}]/g; type X = { a: string };\nexport const tools: Tool[] = [{ name: "a" as const, description: `x ${y}`, inputSchema: { type: "object", properties: {} } satisfies JSONSchema, ...extra }];';
  assert.equal(R.extractFromFile('t.ts', ts)[0].tool.name, 'a');
  const p = R.planFiles(['README.md', 'pkg/__toolsnaps__/get_me.snap', 'src/tools.ts', 'node_modules/x/index.js', 'test/a.test.ts', 'manifest.json', 'tools.json']);
  assert.deepEqual(p.exact, ['pkg/__toolsnaps__/get_me.snap', 'tools.json']);
  const mcpb = { manifest_version: '0.3', name: 'x', server: { type: 'node' }, tools: [{ name: 'a', description: 'A' }], _meta: { w: { static_responses: { 'tools/list': { tools: [{ name: 'a', inputSchema: { type: 'object' } }] } } } } };
  assert.equal(R.fromMcpbManifest(JSON.stringify(mcpb)).fidelity, 'exact');
  delete mcpb._meta; assert.equal(R.fromMcpbManifest(JSON.stringify(mcpb)).fidelity, 'names');
  assert.deepEqual(R.parseRepoRef('https://github.com/o/r/tree/main/packages/srv'), { owner: 'o', repo: 'r', ref: 'main', subdir: 'packages/srv' });
});

// ------------------------------------------------------------ repo + registry through collect(), with a mocked network
function mockFetch(routes, log) {
  return async (url, init) => {
    if (log) log.push({ url, headers: (init && init.headers) || {} });
    const k = Object.keys(routes).find((p) => url === p || url.startsWith(p));
    if (!k) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => '' };
    const v = routes[k];
    if (typeof v === 'number') return { ok: false, status: v, headers: new Headers(), json: async () => ({}), text: async () => '' };
    const body = typeof v === 'string' ? v : JSON.stringify(v);
    return { ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(body), text: async () => body };
  };
}
async function withFetch(f, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}
const opt = (o) => ({ timeout: 30, protocol: 'auto', headers: {}, env: {}, ...o });

test('repo: snapshots win over source; provenance label on the Source line', async () => {
  const snap = (n) => JSON.stringify({ name: n, description: n + ' tool', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  const raw = 'https://raw.githubusercontent.com/o/r/abc123/';
  const f = mockFetch({
    'https://api.github.com/repos/o/r/git/trees/': { sha: 'abc123', truncated: false, tree: [{ type: 'blob', path: 'pkg/__toolsnaps__/get_me.snap', size: 10 }, { type: 'blob', path: 'pkg/__toolsnaps__/list_issues.snap', size: 10 }, { type: 'blob', path: 'src/index.ts', size: 10 }] },
    'https://api.github.com/repos/o/r': { default_branch: 'main' },
    [raw + 'pkg/__toolsnaps__/get_me.snap']: snap('get_me'),
    [raw + 'pkg/__toolsnaps__/list_issues.snap']: snap('list_issues'),
    [raw + 'src/index.ts']: src('register-tool.ts'),
  });
  const notes = [];
  const [item] = await withFetch(f, () => collect(opt({ repo: 'github.com/o/r' }), (n) => notes.push(n)));
  assert.equal(item.data.length, 2);
  assert.equal(item.source.fidelity, 'exact');
  assert.equal(sourceLine(item.source), 'Source: o/r@abc123 (github), exact: committed tool snapshots');
  assert.match(notes[0], /found 2 tools in o\/r@abc123/);
});
test('repo: GitHub refused (403) -> jsDelivr; derived fidelity; an oversized file is not read', async () => {
  const log = [];
  const big = 'x'.repeat(1600 * 1024);
  const f = mockFetch({
    'https://api.github.com/': 403,
    'https://data.jsdelivr.com/v1/packages/gh/o/r@HEAD': { version: 'deadbeef', files: [{ name: '/server.py', size: 10 }, { name: '/huge.py', size: 10 }, { name: '/tests/test_x.py', size: 5 }] },
    'https://cdn.jsdelivr.net/gh/o/r@deadbeef/server.py': src('server.py'),
    'https://cdn.jsdelivr.net/gh/o/r@deadbeef/huge.py': big,
  }, log);
  const [item] = await withFetch(f, () => collect(opt({ repo: 'o/r' })));
  assert.equal(item.source.via, 'jsdelivr'); assert.equal(item.source.fidelity, 'derived');
  assert.deepEqual(item.data.map((x) => x.name), ['add', 'search', 'delete_note']);
  assert.match(sourceLine(item.source), /derived: reproduced from SDK registrations/);
  assert.ok(!log.some((u) => /test_x/.test(u.url)), 'tests are not fetched');
});
test('registry: remote tried first (https only, no user headers), then the GitHub source with the registry named', async () => {
  const log = [];
  const f = mockFetch({
    'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.o%2Fr': { servers: [{ server: { name: 'io.github.o/r-extra' } }, { server: { name: 'io.github.o/r', version: '1.2.0', repository: { url: 'https://github.com/o/r', source: 'github' }, remotes: [{ type: 'streamable-http', url: 'http://plain.example/mcp' }, { type: 'streamable-http', url: 'https://{tenant}.o.dev/mcp' }], packages: [{ registryType: 'npm', identifier: '@o/r', version: '1.2.0', transport: { type: 'stdio' } }] } }] },
    'https://api.github.com/repos/o/r/git/trees/': { sha: 'cafe01', truncated: false, tree: [{ type: 'blob', path: 'server.py', size: 10 }] },
    'https://api.github.com/repos/o/r': { default_branch: 'main' },
    'https://raw.githubusercontent.com/o/r/cafe01/server.py': src('server.py'),
  }, log);
  const notes = [];
  const [item] = await withFetch(f, () => collect(opt({ registry: 'io.github.o/r' }), (n) => notes.push(n)));
  assert.ok(!log.some((x) => /plain\.example|tenant/.test(x.url)), 'the http and templated remotes are not contacted');
  assert.match(notes.join('\n'), /only https URLs from the registry are used/);
  assert.deepEqual(item.source.registry, { name: 'io.github.o/r', version: '1.2.0' });
  assert.match(sourceLine(item.source), /^Source: o\/r@cafe01 \(github\), derived: .* via MCP Registry io\.github\.o\/r 1\.2\.0$/);
  await assert.rejects(withFetch(mockFetch({ 'https://registry.modelcontextprotocol.io/': { servers: [{ server: { name: 'io.github.o/zzz-x' } }] } }), () => collect(opt({ registry: 'io.github.o/zzz' }))),
    (e) => e instanceof InputFailure && e.code === 'unreachable' && /Similar: io\.github\.o\/zzz-x/.test(e.message));
});
test('sourceLine: server-supplied names cannot add lines', () => {
  const l = sourceLine({ kind: 'stdio', command: 'x', era: 'legacy', protocolVersion: '2025-11-25', serverInfo: { name: 'evil\n::error::x', version: '1\r\n' } });
  assert.ok(!/[\r\n]/.test(l));
});
