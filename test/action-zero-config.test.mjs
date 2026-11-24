// The Action with neither tools-file nor command (it reads the source), the registry line (publish-hint) and the
// pull-request comment (pr-comment): input handling, gating, the fork skip, the comment body, and the comment step
// against a stand-in for the GitHub API (a mocked fetch, and a local HTTP server for the step run as a process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import M from '../src/engine.js';
import { LINK_TAGS } from '../src/links.js';
import { publishHint, uriPath } from '../action/main.mjs';
import { serverEnv } from '../src/capture.js';
import { MARKER, commentAction, commentText, markerFor, explainFailure, isOwnComment, prContext, renderComment, stepPlan, tokenIdentity, upsertComment } from '../action/pr-comment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const main = join(root, 'action', 'main.mjs');
const commentScript = join(root, 'action', 'pr-comment.mjs');
const repos = join(root, 'test', 'repos');

const PUBLIC = { repository: { private: false, visibility: 'public', full_name: 'Example/Notes' } };
const pr = (head = 'Example/Notes') => ({ ...PUBLIC, pull_request: { number: 7, head: { repo: { full_name: head } }, base: { repo: { full_name: 'Example/Notes' } } } });

/** A workspace holding a copy of a fixture repository (or nothing). */
function workspace(fixture) {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-zc-'));
  if (fixture) cpSync(join(repos, fixture), ws, { recursive: true });
  return ws;
}
function act(ws, inputs, { event = PUBLIC, ...extra } = {}) {
  const base = join(ws, '..', 'zc-' + Math.random().toString(36).slice(2));
  const out = base + '.out', sum = base + '.md', ev = base + '.json';
  writeFileSync(out, ''); writeFileSync(sum, ''); writeFileSync(ev, JSON.stringify(event));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'Example/Notes', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', MCP_CHECK_DEFAULT_BRANCH: 'main', ...extra };
  for (const [k, v] of Object.entries(inputs)) env['INPUT_' + k.toUpperCase().replace(/-/g, '_')] = v;
  const r = spawnSync(process.execPath, [main], { cwd: ws, env, encoding: 'utf8' });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { ...r, outputs, summary: readFileSync(sum, 'utf8') };
}
const REGISTRY_LINE = /\*\*\[List this server in the IsoKron MCP registry \(beta\)\]\(https:\/\/isokron\.ai\/mcp-check\/registry\/example\/notes\?utm_source=mcp-check-action&utm_medium=action\)\*\* \(free\): a public page with its grades, and a README badge\./;

// ------------------------------------------------------------ zero-config
test('zero-config: no tools-file or command reads the source, says so, and points SARIF at the registering lines', () => {
  const ws = workspace('ts-zod');
  mkdirSync(join(ws, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'x', 'index.js'), 'server.registerTool("installed", { description: "x", inputSchema: {} }, () => {});\n');
  const r = act(ws, { 'min-grade': 'B' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.source, 'repo-static');
  assert.equal(r.outputs.passed, 'true');
  assert.match(r.stdout, /Reading the tool definitions from the source in \. \(nothing is run\)/);
  assert.match(r.summary, /2 tools from the repository code in `\.`\./);
  assert.match(r.summary, /^## MCP check \(approximate\)\n/);
  assert.equal(r.outputs.approximate, 'true');
  assert.match(r.stdout, /::warning::mcp-check: min-grade B is applied to approximate grades read from source, at your own risk/);
  assert.match(r.summary, /\*\*min-grade B is applied to approximate grades read from source, at your own risk/);
  assert.match(r.summary, /\*\*Approximate: read from source, not the server's live list\.\*\* Source: repository code; nothing was run\. Derived: reproduced from SDK registrations in the source; schemas follow the SDK's output and may differ in detail\. For exact grades of the list your server sends, set `command` .* or `tools-file` .*\[how\]\(https:\/\/github\.com\/isokron-ai\/mcp-check\/blob\/main\/docs\/github-action\.md#where-the-tool-list-comes-from\)/);
  const list = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'tools-list.json'), 'utf8'));
  assert.deepEqual(list.tools.map((t) => t.name), ['search_notes', 'delete_note'], 'node_modules is not read');
  const sarif = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'report.sarif'), 'utf8'));
  const locs = sarif.runs[0].results.map((x) => [x.locations[0].logicalLocations[0].name, x.locations[0].physicalLocation.artifactLocation.uri, x.locations[0].physicalLocation.region.startLine]);
  assert.ok(locs.length > 0);
  for (const [tool, uri, line] of locs) {
    if (tool === 'search_notes') assert.deepEqual([uri, line], ['src/tools/notes.ts', 5]);
    else if (tool === 'delete_note') assert.deepEqual([uri, line], ['src/tools/notes.ts', 12]);
  }
  // A second run in the same workspace does not take the first run's tools-list.json for a committed list.
  const again = act(ws, {});
  assert.equal(again.status, 0);
  assert.match(again.summary, /\*\*Approximate: read from source, not the server's live list\.\*\* Source: repository code; nothing was run\. Derived/);
  assert.ok(!/at your own risk/.test(again.summary + again.stdout), 'no gate, no risk note');
});

test('zero-config: a subfolder as working-directory; Python and JavaScript fixtures; SARIF paths keep the folder', () => {
  const ws = workspace(null);
  cpSync(join(repos, 'py-fastmcp'), join(ws, 'servers', 'py'), { recursive: true });
  cpSync(join(repos, 'js-literal'), join(ws, 'servers', 'js'), { recursive: true });
  const py = act(ws, { 'working-directory': 'servers/py', 'results-dir': 'out-py' });
  assert.equal(py.status, 0, py.stdout + py.stderr);
  assert.match(py.summary, /2 tools from the repository code in `servers\/py`\./);
  const sarif = JSON.parse(readFileSync(join(ws, 'out-py', 'report.sarif'), 'utf8'));
  assert.ok(sarif.runs[0].results.some((x) => x.locations[0].physicalLocation.artifactLocation.uri === 'servers/py/src/notes_server/server.py'));
  const js = act(ws, { 'working-directory': 'servers/js', 'results-dir': 'out-js' });
  assert.equal(js.status, 0);
  assert.match(js.summary, /\*\*Approximate: read from source, not the server's live list\.\*\* Source: repository code; nothing was run\. Literal: tool definitions written as literals in the source\./);
});

test('zero-config: no tool definitions ends neutral (a warning and the fix), or fails with fail-on-no-tools: true', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'README.md'), '# a library\n');
  writeFileSync(join(ws, 'index.js'), 'module.exports = 1;\n');
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs['exit-status'], '0');
  assert.equal(r.outputs.passed, '');
  assert.equal(r.outputs.source, 'repo-static');
  assert.equal(r.outputs['results-dir'], undefined, 'no artifact of an empty folder');
  assert.ok(!/::error::/.test(r.stdout));
  assert.match(r.stdout, /::warning::mcp-check: not graded: No tool definitions found in the source in \. \(scanned 1 of 1 source files, .*\)\. Set command \(the command that starts the server, for example node dist\/index\.js\) or tools-file \(a saved tools\/list answer\)\./);
  assert.match(r.summary, /^## MCP check: not graded\n\nNo tool definitions found in the source in \. \(scanned 1 of 1 source files.*\)\. Nothing was run\. Set `command` .* or `tools-file`/);
  assert.match(r.summary, /The job is not failed for this; set `fail-on-no-tools: true` to fail it\./);
  const strict = act(ws, { 'fail-on-no-tools': 'true' });
  assert.equal(strict.status, 1);
  assert.equal(strict.outputs['exit-status'], '1');
  assert.match(strict.stdout, /::error::mcp-check: No tool definitions found in the source in \. \(scanned 1 of 1 source files, .*\)\. Set command \(the command that starts the server, for example node dist\/index\.js\) or tools-file \(a saved tools\/list answer\)\./);
  assert.match(strict.summary, /The job fails because `fail-on-no-tools` is `true`\./);
  assert.match(act(ws, { 'fail-on-no-tools': 'maybe' }).stdout, /::error::mcp-check: fail-on-no-tools must be true or false/);
  assert.match(act(ws, { 'working-directory': 'README.md' }).stdout, /working-directory is not a folder/);
  assert.match(act(ws, { 'working-directory': '../x' }).stdout, /working-directory must be a path inside the workspace/);
});

test('zero-config: a Go server is read from its source and graded (approximate); a Swift server is not read yet: neutral, not a red job', () => {
  const ws = workspace(null);
  mkdirSync(join(ws, 'pkg', 'tools'), { recursive: true });
  writeFileSync(join(ws, 'go.mod'), 'module example.com/notes\n');
  writeFileSync(join(ws, 'main.go'), 'package main\nimport (\n\t"github.com/mark3labs/mcp-go/server"\n\t"example.com/notes/pkg/tools"\n)\nfunc main() { s := server.NewMCPServer("notes", "1.0"); s.AddTool(tools.T, nil) }\n');
  writeFileSync(join(ws, 'pkg', 'tools', 'notes.go'), 'package tools\nimport "github.com/mark3labs/mcp-go/mcp"\nvar T = mcp.NewTool("search_notes", mcp.WithDescription("Search notes by text. Use it to find a note before reading it."), mcp.WithTitleAnnotation("Search notes"), mcp.WithReadOnlyHintAnnotation(true), mcp.WithString("query", mcp.Required(), mcp.Description("Words to find")))\n');
  writeFileSync(join(ws, 'pkg', 'tools', 'notes_test.go'), 'package tools\nimport "github.com/mark3labs/mcp-go/mcp"\nvar X = mcp.NewTool("test_only")\n');
  writeFileSync(join(ws, 'scripts.js'), 'module.exports = 1;\n');
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.source, 'repo-static');
  assert.equal(r.outputs.approximate, 'true');
  assert.match(r.summary, /^## MCP check \(approximate\)\n/);
  assert.match(r.summary, /Derived: reproduced from Go SDK registrations in the source/);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'tools-list.json'), 'utf8')).tools.map((t) => t.name), ['search_notes']);
  // Swift is not read yet: neutral, the summary names the language
  const cs = workspace(null);
  writeFileSync(join(cs, 'main.swift'), 'print("hi")\n');
  const c = act(cs, { 'min-grade': 'A' });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(c.outputs.passed, '');
  assert.match(c.summary, /Swift source is not read yet/);
});

test('zero-config: tools of several servers are not merged or picked; the summary lists the folders to choose from', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }));
  for (const [pkg, tool] of [['notes', 'search_notes'], ['tickets', 'list_tickets']]) {
    mkdirSync(join(ws, 'packages', pkg, 'src'), { recursive: true });
    writeFileSync(join(ws, 'packages', pkg, 'package.json'), JSON.stringify({ name: pkg + '-mcp', dependencies: { '@modelcontextprotocol/sdk': '1.20.0', zod: '3.25.0' } }));
    writeFileSync(join(ws, 'packages', pkg, 'src', 'index.ts'), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst server = new McpServer({ name: '" + pkg + "', version: '1' });\nserver.registerTool('" + tool + "', { title: 'T', description: 'Does one thing.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [] }));\n");
  }
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs['exit-status'], '0');
  assert.ok(!existsSync(join(ws, 'mcp-check-results', 'tools-list.json')), 'nothing graded');
  assert.match(r.summary, /Tool definitions of more than one server were found in \.: packages\/notes \(server constructor, 1 tool\), packages\/tickets \(server constructor, 1 tool\)\. Nothing was merged or picked\./);
  assert.match(r.summary, /Set `working-directory` to one server's folder \(`packages\/notes`, `packages\/tickets`\), one job or matrix leg per server/);
  assert.match(act(ws, { 'fail-on-no-tools': 'true' }).stdout, /::error::mcp-check: Tool definitions of more than one server .* Set working-directory to one server's folder \(packages\/notes, packages\/tickets\)/);
  // Pointed at one package, it grades that one.
  const one = act(ws, { 'working-directory': 'packages/tickets', 'results-dir': 'out-tickets' });
  assert.equal(one.status, 0, one.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, 'out-tickets', 'tools-list.json'), 'utf8')).tools.map((t) => t.name), ['list_tickets']);
});

test('zero-config: a neutral run replaces an earlier PR verdict with "not graded on this run"', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'main.go'), 'package main\n');
  const ctx = { event: pr(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
  const auto = act(ws, { 'pr-comment': 'auto' }, ctx);
  assert.equal(auto.status, 0);
  assert.equal(auto.outputs['pr-comment-action'], 'update', 'auto only refreshes an existing comment');
  const body = readFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), 'utf8');
  assert.ok(body.startsWith(MARKER + '\n<!-- mcp-check-run: 42-1 -->\n### MCP check: not graded on this run\n'), body.slice(0, 120));
  assert.match(body, /No tool definitions found in the source/);
  assert.match(body, /Earlier grades on this pull request no longer apply\./);
  assert.equal(act(ws, { 'pr-comment': 'always' }, ctx).outputs['pr-comment-action'], 'upsert');
  assert.equal(act(ws, {}, ctx).outputs['pr-comment-action'], undefined, 'off: no comment');
  assert.match(act(ws, { 'pr-comment': 'always' }, { ...ctx, event: pr('fork/Notes') }).summary, /PR comment skipped: the pull request comes from a fork/);
});

test('zero-config: tools only in an admin, docs or eval package are not graded from the root as the server', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'mono', private: true }));
  mkdirSync(join(ws, 'packages', 'admin-mcp', 'src'), { recursive: true });
  mkdirSync(join(ws, 'packages', 'mcp', 'src'), { recursive: true });
  writeFileSync(join(ws, 'packages', 'admin-mcp', 'package.json'), JSON.stringify({ name: 'admin-mcp' }));
  writeFileSync(join(ws, 'packages', 'admin-mcp', 'src', 'index.ts'), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst s = new McpServer({ name: 'admin', version: '1' });\ns.registerTool('internal_stats', { description: 'Internal data.', inputSchema: {} }, async () => ({ content: [] }));\n");
  writeFileSync(join(ws, 'packages', 'mcp', 'package.json'), JSON.stringify({ name: 'public-mcp' }));
  writeFileSync(join(ws, 'packages', 'mcp', 'src', 'index.ts'), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { NAME } from './names.js';\nconst s = new McpServer({ name: 'public', version: '1' });\ns.registerTool(NAME, { description: 'Resolve.', inputSchema: {} }, async () => ({ content: [] }));\n");
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!existsSync(join(ws, 'mcp-check-results', 'tools-list.json')), 'the admin package is not graded as the repository');
  assert.match(r.summary, /Tool definitions were found only in folders that look like admin, console, docs, examples, evaluation or test code, which are not graded from a parent folder: packages\/admin-mcp \(1 tool\)/);
  assert.match(r.summary, /A server is constructed in packages\/mcp, but none of its tools could be read\./);
  const admin = act(ws, { 'working-directory': 'packages/admin-mcp', 'results-dir': 'out-admin' });
  assert.match(admin.summary, /1 tools from the repository code in `packages\/admin-mcp`/, 'pointed at it, it is graded');
});

test('zero-config: setting one of tools-file and command keeps the old behaviour; both is still an error', () => {
  const ws = workspace('ts-zod');
  writeFileSync(join(ws, 'tools.json'), readFileSync(join(root, 'test', 'fixtures', 'example.json')));
  const file = act(ws, { 'tools-file': 'tools.json' });
  assert.equal(file.outputs.source, 'tools-file');
  assert.ok(!/repository code/.test(file.summary));
  const both = act(ws, { 'tools-file': 'tools.json', command: 'node x.js' });
  assert.match(both.stdout, /::error::mcp-check: set one of tools-file and command, not both \(or neither, to read the tool definitions from the repository code\)/);
});

// ------------------------------------------------------------ publish-hint
test('publish-hint: one line on public github.com repositories only; no line when false, private, GHES or unknown', () => {
  const ws = workspace('js-literal');
  assert.match(act(ws, {}).summary, REGISTRY_LINE);
  const count = (s) => (s.match(/IsoKron MCP registry/g) || []).length;
  assert.equal(count(act(ws, {}).summary), 1);
  assert.equal(count(act(ws, { 'publish-hint': 'false' }).summary), 0);
  assert.equal(count(act(ws, {}, { event: { repository: { private: true, visibility: 'private' } } }).summary), 0);
  assert.equal(count(act(ws, {}, { event: { repository: { private: false, visibility: 'internal' } } }).summary), 0);
  assert.equal(count(act(ws, {}, { GITHUB_SERVER_URL: 'https://ghes.example.com' }).summary), 0);
  assert.equal(count(act(ws, {}, { event: {} }).summary), 0, 'a schedule event has no repository: no line');
  assert.match(act(ws, { 'publish-hint': 'maybe' }).stdout, /::error::mcp-check: publish-hint must be true or false/);
});

test('publishHint: builds the link from GITHUB_REPOSITORY only, lower-cased, with the surface tag; refuses odd names', () => {
  const e = { GITHUB_REPOSITORY: 'Owner-1/My.Server_x', GITHUB_SERVER_URL: 'https://github.com' };
  assert.match(publishHint(e, PUBLIC, 'action'), /\(https:\/\/isokron\.ai\/mcp-check\/registry\/owner-1\/my\.server_x\?utm_source=mcp-check-action&utm_medium=action\)/);
  assert.match(publishHint(e, PUBLIC, 'comment'), /\?utm_source=mcp-check-pr-comment&utm_medium=action\)/);
  for (const repo of ['a/..', 'a/b/c', 'a b/c', '-x/y', 'x/y?z', '']) assert.equal(publishHint({ ...e, GITHUB_REPOSITORY: repo }, PUBLIC, 'action'), null, repo);
  assert.equal(publishHint({ ...e, GITHUB_SERVER_URL: 'http://github.com' }, PUBLIC, 'action'), null);
});

// ------------------------------------------------------------ pr-comment: inputs and gating
test('pr-comment: off by default; always on a same-repository pull request renders the body and asks the step to post', () => {
  const ws = workspace('ts-zod');
  const off = act(ws, {}, { event: pr(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' });
  assert.equal(off.outputs['pr-comment-action'], '');
  assert.ok(!existsSync(join(ws, 'mcp-check-results', 'pr-comment.md')));
  const on = act(ws, { 'pr-comment': 'always', 'min-grade': 'B' }, { event: pr(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' });
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.equal(on.outputs['pr-comment-action'], 'upsert');
  assert.equal(on.outputs['pr-number'], undefined, 'the comment step reads the pull request from the event itself');
  const body = readFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), 'utf8');
  assert.ok(body.startsWith(MARKER + '\n<!-- mcp-check-run: 42-1 -->\n### MCP check (approximate): passes min-grade B\n'), body.slice(0, 120));
  assert.match(body, /\*\*Approximate: read from source, not the server's live list\*\* \(derived; nothing was run\)\. For exact grades, set `command` or `tools-file`\./);
  assert.match(body, /registry\/example\/notes\?utm_source=mcp-check-pr-comment&utm_medium=action/);
  assert.ok(!/GITHUB_TOKEN|ghp_|Bearer/.test(on.stdout + on.summary + body));
});

test('pr-comment: auto posts only below min-grade, otherwise only refreshes; forks and pushes are skipped; bad values refused', () => {
  const ws = workspace('ts-zod');
  const ctx = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
  assert.equal(act(ws, { 'pr-comment': 'auto', 'min-grade': 'A' }, { event: pr(), ...ctx }).outputs['pr-comment-action'], 'upsert');
  assert.equal(act(ws, { 'pr-comment': 'auto', 'min-grade': 'C' }, { event: pr(), ...ctx }).outputs['pr-comment-action'], 'update');
  assert.equal(act(ws, { 'pr-comment': 'auto' }, { event: pr(), ...ctx }).outputs['pr-comment-action'], 'update', 'no gate: nothing to warn about');
  const fork = act(ws, { 'pr-comment': 'always' }, { event: pr('someone/Notes'), ...ctx });
  assert.equal(fork.outputs['pr-comment-action'], '');
  assert.match(fork.summary, /PR comment skipped: the pull request comes from a fork, and its token cannot write comments\./);
  assert.equal(act(ws, { 'pr-comment': 'always' }).outputs['pr-comment-action'], '', 'a push run has no pull request');
  assert.equal(act(ws, { 'pr-comment': 'always' }, { event: pr(), GITHUB_EVENT_NAME: 'pull_request_target' }).outputs['pr-comment-action'], '');
  assert.match(act(ws, { 'pr-comment': 'yes' }).stdout, /::error::mcp-check: pr-comment must be off, auto or always/);
});

test('prContext and commentAction', () => {
  assert.equal(prContext('push', pr()), null);
  assert.deepEqual(prContext('pull_request', pr()), { number: 7 });
  assert.deepEqual(prContext('pull_request', pr('example/notes')), { number: 7 }, 'names compare without case');
  assert.equal(prContext('pull_request', pr('fork/Notes')).fork, true);
  assert.equal(prContext('pull_request', { pull_request: { number: 7, head: { repo: null }, base: { repo: { full_name: 'a/b' } } } }).fork, true, 'a deleted fork');
  assert.match(prContext('pull_request', {}).skip, /no pull request number/);
  assert.equal(commentAction('off', true), null);
  assert.equal(commentAction('always', false), 'upsert');
  assert.equal(commentAction('auto', true), 'upsert');
  assert.equal(commentAction('auto', false), 'update');
});

// ------------------------------------------------------------ the comment body
const tag = (s) => [...s].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');

test('renderComment: marker first, grades, gate, high-risk change, at most five findings linked with the comment tag, text escaped', () => {
  const list = { tools: Array.from({ length: 8 }, (_, i) => ({ name: 'tool_' + i + (i === 0 ? '`![x](https://evil.example/i.png)' : ''), description: i === 1 ? 'Short <img src=x> [l](https://evil.example)' + tag('[c](https://evil.example/a)') : 'x', inputSchema: { type: 'object' } })) };
  const r = M.analyse(M.parseInput(JSON.stringify(list)));
  const body = renderComment(r, { sections: ['spec', 'anthropic', 'openai', 'security'], minGrade: 'A', diff: { highRisk: ['tool_3'] }, sourceNote: 'Source: x.', runUrl: 'https://github.com/a/b/actions/runs/1', hint: '**hint**' });
  assert.ok(body.startsWith(MARKER + '\n### MCP check: needs attention\n'));
  assert.doesNotMatch(body, /Write-surface|Write surface/, 'the write surface has no grade and is not in the comment (rubric 2.2.0)');
  assert.match(body, /\n\| MCP spec 2026-07-28 \| Anthropic directory \| OpenAI directory \| Poisoning and hidden text \| Schema and description quality \|\n/);
  assert.match(body, /\*\*Below min-grade A:\*\* /);
  assert.match(body, /\*\*High-risk annotation change\*\* against the baseline .*`tool_3`/);
  const items = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(items.length, 5);
  for (const l of items) assert.match(l, /\]\(https:\/\/isokron\.ai\/mcp-check\/checks\/[a-z0-9-]+\?utm_source=mcp-check-pr-comment&utm_medium=action\)/);
  assert.match(body, /\d+ more in the job summary of \[this run\]\(https:\/\/github\.com\/a\/b\/actions\/runs\/1\)\./);
  const outside = body.replace(/(?<![`\\])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m) => m.replace(/[!\[\]()<>]/g, ''));
  assert.ok(!/(^|[^\\])!\[/.test(outside), 'no image');
  assert.ok(!/(^|[^\\])\[[^\]]*\]\(https:\/\/evil/.test(outside), 'no link');
  assert.ok(!/(^|[^\\])<img/i.test(outside), 'no HTML');
  assert.ok(body.endsWith('Set pr-comment: off to stop.</sub>\n'));
  assert.equal(LINK_TAGS.comment.source, 'mcp-check-pr-comment');

  const good = M.analyse(M.parseInput(readFileSync(join(root, 'test', 'catalogs', 'well-designed.json'), 'utf8')));
  const ok = renderComment(good, { sections: ['spec'], minGrade: null });
  assert.match(ok, /^<!-- isokron-mcp-check -->\n### MCP check\n/);
  assert.match(ok, /No min-grade gate is set\./);
  assert.ok(!/IsoKron MCP registry/.test(ok), 'no hint when none is given');
});

// ------------------------------------------------------------ upsert, with a mocked fetch
function fakeGitHub(initial = [], { me = null } = {}) {
  const comments = initial.map((c, i) => ({ id: 100 + i, ...c }));
  const calls = [];
  const bot = { login: me || 'github-actions[bot]', type: me ? 'User' : 'Bot' };
  const fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    calls.push({ method, path: u.pathname + u.search, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (fake.status) return json(fake.status, { message: 'no' });
    let m;
    if (method === 'GET' && u.pathname === '/user') return me ? json(200, { login: me }) : json(403, { message: 'Resource not accessible by integration' });
    if (method === 'GET' && (m = /\/repos\/o\/r\/issues\/7\/comments$/.exec(u.pathname))) {
      const page = Number(u.searchParams.get('page')); const per = Number(u.searchParams.get('per_page'));
      return json(200, comments.slice((page - 1) * per, page * per));
    }
    if (method === 'POST' && /\/repos\/o\/r\/issues\/7\/comments$/.test(u.pathname)) { const c = { id: 900 + comments.length, body: JSON.parse(init.body).body, user: bot }; comments.push(c); return json(201, c); }
    if (method === 'PATCH' && (m = /\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(u.pathname))) { const c = comments.find((x) => x.id === Number(m[1])); if (c.user.login !== bot.login) return json(403, {}); c.body = JSON.parse(init.body).body; return json(200, c); }
    return json(404, {});
  };
  const fake = { comments, calls, fetch, status: 0 };
  return fake;
}
const args = (gh, extra = {}) => ({ apiUrl: 'https://api.example.test', repo: 'o/r', number: 7, token: 't0ken', body: MARKER + '\nnew\n', fetch: gh.fetch, ...extra });
const ACTIONS_BOT = { login: 'github-actions[bot]', type: 'Bot' };

test('upsertComment: creates one comment, then updates the same one; update-only creates nothing', async () => {
  const gh = fakeGitHub([{ body: 'unrelated', user: { login: 'someone', type: 'User' } }, { body: 'quoting ' + MARKER, user: { login: 'someone', type: 'User' } }]);
  assert.deepEqual(await upsertComment(args(gh, { action: 'update' })), { done: 'none', id: null });
  assert.ok(!gh.calls.some((c) => c.method !== 'GET'));
  const made = await upsertComment(args(gh));
  assert.equal(made.done, 'created');
  assert.deepEqual(await upsertComment(args(gh, { body: MARKER + '\nnewer\n' })), { done: 'updated', id: made.id });
  assert.deepEqual(await upsertComment(args(gh, { body: MARKER + '\nnewer\n' })), { done: 'unchanged', id: made.id });
  assert.equal(gh.comments.filter((c) => c.body.startsWith(MARKER)).length, 1);
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer t0ken' && (c.path.startsWith('/repos/o/r/issues/') || c.path === '/user')));
});

test('upsertComment: a marker comment by someone else, there before the first run, is never edited; ours is made beside it', async () => {
  const planted = { body: MARKER + '\nMCP check: all A, merge away', user: { login: 'drive-by-user', type: 'User' } };
  for (const action of ['upsert', 'update']) {
    const gh = fakeGitHub([planted]);
    const got = await upsertComment(args(gh, { action }));
    assert.ok(!gh.calls.some((c) => c.method === 'PATCH'), action + ': no edit of the planted comment');
    assert.equal(gh.comments[0].body, planted.body);
    if (action === 'upsert') { assert.equal(got.done, 'created'); assert.equal(gh.comments.length, 2); } else assert.deepEqual(got, { done: 'none', id: null });
  }
  // A personal token: its own login, from GET /user; a bot's marker comment is not ours then.
  const gh = fakeGitHub([{ body: MARKER + '\nold', user: ACTIONS_BOT }, { body: MARKER + '\nmine', user: { login: 'maintainer', type: 'User' } }], { me: 'maintainer' });
  assert.deepEqual(await upsertComment(args(gh)), { done: 'updated', id: 101 });
  assert.equal(gh.comments[0].body, MARKER + '\nold');
  assert.deepEqual(await tokenIdentity(gh.fetch, 'https://api.example.test', 't'), { login: 'maintainer' });
  assert.deepEqual(await tokenIdentity(fakeGitHub().fetch, 'https://api.example.test', 't'), { bot: true });
  assert.equal(isOwnComment({ body: MARKER, user: { login: 'other-app[bot]', type: 'Bot' } }, { bot: true }), true, 'an App token writes as its own bot');
  assert.equal(isOwnComment({ body: MARKER, user: { login: 'x', type: 'User' } }, { bot: true }), false);
});

test('upsertComment: finds its comment past the first page, github-actions[bot] first; errors keep the status', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ body: 'c' + i, user: { login: 'u', type: 'User' } }));
  many.push({ body: MARKER + '\nby a person', user: { login: 'person', type: 'User' } }, { body: MARKER + '\nold', user: ACTIONS_BOT });
  const gh = fakeGitHub(many);
  assert.deepEqual(await upsertComment(args(gh)), { done: 'updated', id: 251 });
  assert.deepEqual(gh.calls.filter((c) => c.method === 'GET').map((c) => c.path), ['/repos/o/r/issues/7/comments?per_page=100&page=1', '/repos/o/r/issues/7/comments?per_page=100&page=2', '/user']);
  gh.status = 403;
  await assert.rejects(upsertComment(args(gh)), (e) => e.status === 403 && !/t0ken/.test(e.message));
  assert.match(explainFailure({ status: 403, message: 'HTTP 403' }), /add permissions: pull-requests: write/);
  await assert.rejects(upsertComment(args(gh, { token: '' })), /github-token is empty/);
  await assert.rejects(upsertComment(args(gh, { repo: 'o/r/../x' })), /not owner\/repo/);
});

// ------------------------------------------------------------ the comment step as a process, against a local API
function runStep(env) {
  return new Promise((resolveRun) => {
    const p = spawn(process.execPath, [commentScript], { env });
    let stdout = ''; p.stdout.on('data', (c) => { stdout += c; });
    p.on('close', (code) => resolveRun({ code, stdout }));
  });
}
const STAMP = '<!-- mcp-check-run: 42-1 -->';
function stepWorkspace(body = MARKER + '\n' + STAMP + '\nhello\n', event = pr()) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcheck-step-')));
  mkdirSync(join(ws, 'mcp-check-results'));
  if (body !== null) writeFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), body);
  writeFileSync(join(ws, 'event.json'), JSON.stringify(event));
  const sum = join(ws, 'sum.md'); writeFileSync(sum, '');
  return { ws, sum, env: { GITHUB_WORKSPACE: ws, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(ws, 'event.json'), INPUT_PR_COMMENT: 'always', INPUT_RESULTS_DIR: 'mcp-check-results', COMMENT_ACTION: 'upsert', GITHUB_TOKEN: 'secret-token', GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: sum, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'check' } };
}
test('the comment step posts through GITHUB_API_URL, and a refusal is a warning with exit 0', async (t) => {
  const seen = [];
  let refuse = false;
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b });
      if (refuse) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'GET' ? '[]' : JSON.stringify({ id: 5 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { sum, env: base } = stepWorkspace();
  const env = { ...base, GITHUB_API_URL: 'http://127.0.0.1:' + srv.address().port };
  const ok = await runStep(env);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /mcp-check: PR comment created \(5\)/);
  assert.deepEqual(seen.map((x) => x.method + ' ' + x.url), ['GET /repos/o/r/issues/7/comments?per_page=100&page=1', 'POST /repos/o/r/issues/7/comments'], 'the number comes from the event payload');
  assert.equal(JSON.parse(seen[1].body).body, MARKER + '\nhello\n');
  assert.equal(seen[1].auth, 'Bearer secret-token');
  refuse = true;
  const bad = await runStep(env);
  assert.equal(bad.code, 0, 'a failed comment never fails the job');
  assert.match(bad.stdout, /::warning::mcp-check: PR comment not posted: the token may not write to pull requests: add permissions: pull-requests: write/);
  assert.match(readFileSync(sum, 'utf8'), /PR comment not posted: /);
  assert.ok(!/secret-token/.test(bad.stdout + readFileSync(sum, 'utf8')));
});

test('the comment step trusts the event and the results folder, not the run step: forks, missing or foreign bodies, odd paths', () => {
  const s1 = stepWorkspace();
  assert.deepEqual(stepPlan({ ...s1.env, COMMENT_FILE: '/etc/passwd', PR_NUMBER: '999' }), { number: 7, file: join(s1.ws, 'mcp-check-results', 'pr-comment.md'), body: MARKER + '\nhello\n', marker: MARKER, action: 'upsert' });
  assert.equal(stepPlan({ ...s1.env, INPUT_PR_COMMENT: 'auto', COMMENT_ACTION: 'update' }).action, 'update');
  assert.equal(stepPlan({ ...s1.env, INPUT_PR_COMMENT: 'auto', COMMENT_ACTION: 'whatever' }).action, 'update');
  assert.match(stepPlan({ ...s1.env, INPUT_PR_COMMENT: 'off' }).skip, /off/);
  assert.match(stepPlan(stepWorkspace(undefined, pr('fork/Notes')).env).skip, /fork/);
  assert.match(stepPlan({ ...s1.env, GITHUB_EVENT_NAME: 'push' }).skip, /not a pull_request event/);
  assert.match(stepPlan(stepWorkspace(null).env).skip, /no comment for this run/);
  assert.match(stepPlan({ ...s1.env, INPUT_RESULTS_DIR: '../elsewhere' }).skip, /not inside the workspace/);
  assert.match(stepPlan({ ...s1.env, INPUT_RESULTS_DIR: '.' }).skip, /not inside the workspace/);
  const s2 = stepWorkspace(null);
  symlinkSync('/etc/hosts', join(s2.ws, 'mcp-check-results', 'pr-comment.md'));
  assert.throws(() => stepPlan(s2.env), /not a regular file/);
});

test('the comment step refuses a body that does not start with the marker, or that another run or job wrote', async () => {
  const s = stepWorkspace('just some file\n');
  const r = await runStep({ ...s.env, GITHUB_API_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /::warning::mcp-check: PR comment not posted: the comment file was not written by this action for this job/);
  const s2 = stepWorkspace();
  assert.throws(() => stepPlan({ ...s2.env, GITHUB_RUN_ATTEMPT: '2' }), /written by another run \(expected mcp-check-run: 42-2\)/);
  assert.throws(() => stepPlan({ ...s2.env, GITHUB_RUN_ID: '43' }), /written by another run/);
  assert.throws(() => stepPlan({ ...s2.env, INPUT_PR_COMMENT_KEY: 'node22' }), /not written by this action for this job/, 'a keyed job does not post an unkeyed body');
  assert.match(stepPlan({ ...s2.env, INPUT_PR_COMMENT_KEY: 'bad key!' }).skip, /pr-comment-key is not valid/);
});

test('action.yml: the token reaches the comment step only; that step cannot fail the job', () => {
  const y = readFileSync(join(root, 'action.yml'), 'utf8');
  assert.equal((y.match(/inputs\.github-token/g) || []).length, 1);
  const step = y.slice(y.indexOf('- name: Comment on the pull request'), y.indexOf('- name: Set the job status'));
  assert.match(step, /GITHUB_TOKEN: \$\{\{ inputs\.github-token \}\}/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /if: \$\{\{ always\(\) && inputs\.pr-comment != 'off' && github\.event_name == 'pull_request' \}\}/);
  assert.match(step, /NODE_BIN: \$\{\{ steps\.node\.outputs\.path \}\}/);
  assert.match(step, /exec \/usr\/bin\/env -i \\\n/, 'a clean environment: no NODE_OPTIONS or anything else a server may have set');
  assert.match(step, /"\$NODE_BIN" "\$GITHUB_ACTION_PATH\/action\/pr-comment\.mjs"/);
  assert.ok(!/PR_NUMBER|COMMENT_FILE|pr-comment-file|pr-number/.test(step), 'no pull request number or file path from the run step');
  assert.ok(y.indexOf('- name: Locate Node.js') < y.indexOf('- name: Grade the tool list'), 'node is located before any repository code runs');
  const run = y.slice(y.indexOf('- name: Grade the tool list'), y.indexOf('- name: Upload SARIF'));
  assert.ok(!/TOKEN/.test(run), 'the step that may start the server has no token');
  assert.match(y, /\n  github-token:\n[\s\S]*?default: \$\{\{ github\.token \}\}\n/);
  assert.match(y, /\n  pr-comment:\n[\s\S]*?default: 'off'\n/);
  assert.match(y, /\n  publish-hint:\n[\s\S]*?default: 'true'\n/);
});

// ------------------------------------------------------------ second review: baseline, committed lists, names, limits
const LOOSENED = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'n', version: '1' });
server.registerTool('delete_note', { title: 'Delete note', description: 'Delete a note by id.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } }, async () => ({ content: [] }));
`;
const RELEASED = { tools: [{ name: 'delete_note', title: 'Delete note', description: 'Delete a note by id.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } }] };

test('zero-config + baseline: the code is compared with the baseline, never the baseline with itself', () => {
  const ws = workspace(null);
  mkdirSync(join(ws, 'src')); mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@modelcontextprotocol/sdk': '1.20.0', zod: '3.25.0' } }));
  writeFileSync(join(ws, 'src', 'server.ts'), LOOSENED);
  writeFileSync(join(ws, 'release', 'tools.json'), JSON.stringify(RELEASED));
  const r = act(ws, { baseline: 'release/tools.json' });
  assert.equal(r.outputs.passed, 'false', r.summary);
  assert.equal(r.outputs['exit-status'], '1');
  assert.match(r.summary, /from the repository code in `\.`/);
  assert.match(r.summary, /\*\*High risk\*\*.*`delete_note`/);
  assert.match(r.stdout, /::error::mcp-check: high-risk annotation change against release\/tools\.json: delete_note/);

  // The same with the baseline at the root as tools.json, and as one snapshot of a __toolsnaps__ folder (refused).
  const ws2 = workspace(null);
  mkdirSync(join(ws2, 'src'));
  writeFileSync(join(ws2, 'src', 'server.ts'), LOOSENED);
  writeFileSync(join(ws2, 'tools.json'), JSON.stringify(RELEASED));
  assert.match(act(ws2, { baseline: 'tools.json' }).summary, /\*\*High risk\*\*/);
  mkdirSync(join(ws2, '__toolsnaps__'));
  writeFileSync(join(ws2, '__toolsnaps__', 'delete_note.snap'), JSON.stringify(RELEASED.tools[0]));
  writeFileSync(join(ws2, '__toolsnaps__', 'other.snap'), JSON.stringify({ ...RELEASED.tools[0], name: 'other' }));
  const snap = act(ws2, { baseline: '__toolsnaps__/delete_note.snap' });
  assert.match(snap.stdout, /::error::mcp-check: the tool list found in the source is the baseline __toolsnaps__\/delete_note\.snap itself; set command or tools-file/);
});

test('zero-config: a committed list is graded only with a clear label, and SARIF points into it', () => {
  const ws = workspace('ts-zod');
  writeFileSync(join(ws, 'tools.json'), JSON.stringify({ tools: [{ name: 'old_tool', description: 'From an old release.', inputSchema: { type: 'object' } }] }, null, 2));
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.summary, /1 tools from the committed list `tools\.json`\./);
  assert.match(r.summary, /\*\*Graded the committed list `tools\.json`, not the code; it may be stale\.\*\* Nothing was run\./);
  const sarif = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'report.sarif'), 'utf8'));
  for (const x of sarif.runs[0].results.filter((x) => x.locations[0].logicalLocations[0].name === 'old_tool')) assert.deepEqual(x.locations[0].physicalLocation, { artifactLocation: { uri: 'tools.json' }, region: { startLine: 4 } });

  const cat = workspace('catalog-snap');
  const c = act(cat, { 'pr-comment': 'always' }, { event: pr(), GITHUB_EVENT_NAME: 'pull_request' });
  assert.match(c.summary, /\*\*Graded the committed list `\.mcp-catalog\/tickets\.json`, not the code; it may be stale\.\*\*/);
  assert.match(readFileSync(join(cat, 'mcp-check-results', 'pr-comment.md'), 'utf8'), /Source: the committed list `\.mcp-catalog\/tickets\.json`, not the code; it may be stale\./);
  const asBaseline = act(cat, { baseline: '.mcp-catalog/tickets.json' });
  assert.match(asBaseline.summary, /from the repository code in `\.`/, 'the snapshot used as the baseline is not also the list');
});

test('zero-config: names without schemas (an MCPB manifest) are not graded, even under min-grade: neutral, or red with fail-on-no-tools', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'manifest.json'), JSON.stringify({ manifest_version: '0.2', name: 'x', server: { type: 'node', entry_point: 'server/index.js' }, tools: [{ name: 'search', description: 'Searches.' }, { name: 'delete_all' }] }));
  const r = act(ws, { 'min-grade': 'B' });
  assert.equal(r.status, 0);
  assert.equal(r.outputs['exit-status'], '0');
  assert.match(r.stdout, /::warning::mcp-check: not graded: Only tool names were found in the source in \. \(manifest\.json lists names and descriptions without schemas\), which cannot be graded\. Set command .* or tools-file/);
  assert.match(r.summary, /Only tool names were found .* Set `command` .* or `tools-file`/);
  assert.ok(!existsSync(join(ws, 'mcp-check-results', 'report.json')));
  const strict = act(ws, { 'min-grade': 'B', 'fail-on-no-tools': 'true' });
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /::error::mcp-check: Only tool names were found in the source/);
});

test('zero-config: a folder over the listing limit says so in the summary', () => {
  const ws = workspace('ts-zod');
  mkdirSync(join(ws, 'zz-data'));
  for (let i = 0; i <= 20000; i++) writeFileSync(join(ws, 'zz-data', i + '.txt'), '');
  const r = act(ws, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.summary, /\*\*The folder holds more files than the listing limit \(20,000\); the deepest were not read\.\*\* Set `working-directory` to the server's folder\./);
  assert.match(r.summary, /2 tools from the repository code/, 'src/ was still read');
});

test('command: the server does not get the runner\'s file-command paths', () => {
  const ws = workspace(null);
  const srv = join(ws, 'srv.cjs');
  writeFileSync(srv, `
const leaked = ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'].filter((k) => process.env[k]);
process.stdin.on('data', (c) => { for (const l of String(c).split('\\n').filter(Boolean)) { const m = JSON.parse(l);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } }) + '\\n');
  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: leaked.length ? 'leaked_' + leaked.join('_') : 'clean', inputSchema: { type: 'object' } }] } }) + '\\n'); } });`);
  const r = act(ws, { command: process.execPath + ' srv.cjs', timeout: '20' }, { GITHUB_ENV: join(ws, 'env-file'), GITHUB_PATH: join(ws, 'path-file'), GITHUB_STATE: join(ws, 'state-file') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const list = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'tools-list.json'), 'utf8'));
  assert.deepEqual(list.tools.map((t) => t.name), ['clean']);
  assert.deepEqual(serverEnv({ A: '1', GITHUB_ENV: 'x', GITHUB_OUTPUT: 'y' }, { B: '2', GITHUB_PATH: 'z' }), { A: '1', B: '2' });
});

test('PR comment: text from the tool list cannot @mention; SARIF paths are percent-encoded', () => {
  const r = M.analyse(M.parseInput(JSON.stringify({ tools: [{ name: 'x', description: 'Ping @octocat and @org/team now', inputSchema: { type: 'object' } }] })));
  const body = renderComment(r, { sections: ['spec', 'anthropic', 'openai', 'security', 'quality'], minGrade: null });
  assert.ok(!/@octocat|@org/.test(body.replace(/@&#8203;/g, '')) || !/(^|[^;])@(octocat|org)/.test(body));
  assert.equal(commentText('hi @octocat'), 'hi @&#8203;octocat');
  assert.equal(uriPath('my tools/a b#1.ts'), 'my%20tools/a%20b%231.ts');
  const ws = workspace(null);
  cpSync(join(repos, 'ts-zod'), join(ws, 'my server'), { recursive: true });
  const a = act(ws, { 'working-directory': 'my server' });
  const sarif = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'report.sarif'), 'utf8'));
  assert.ok(sarif.runs[0].results.some((x) => x.locations[0].physicalLocation.artifactLocation.uri === 'my%20server/src/tools/notes.ts'), a.stdout);
});

// ------------------------------------------------------------ third review: stale bodies, keys, snapshot ownership
test('a body left by an earlier run is deleted first thing, even when this run stops at input validation', () => {
  const ws = workspace(null);
  mkdirSync(join(ws, 'mcp-check-results'));
  writeFileSync(join(ws, 'mcp-check-results', '.mcp-check-results'), 'x');
  writeFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), MARKER + '\nSTALE from an earlier run: all A\n');
  const r = act(ws, { 'min-grade': 'Z', 'pr-comment': 'always' }, { event: pr(), GITHUB_EVENT_NAME: 'pull_request' });
  assert.match(r.stdout, /::error::mcp-check: min-grade must be one of/);
  assert.ok(!existsSync(join(ws, 'mcp-check-results', 'pr-comment.md')));
  // A folder this action did not make is left as it is.
  const ws2 = workspace(null);
  mkdirSync(join(ws2, 'mcp-check-results'));
  writeFileSync(join(ws2, 'mcp-check-results', 'pr-comment.md'), 'someone else\'s file');
  act(ws2, { 'min-grade': 'Z' });
  assert.ok(existsSync(join(ws2, 'mcp-check-results', 'pr-comment.md')));
});

test('pr-comment-key: each key has its own marker with the job id; no key keeps the plain marker', async () => {
  assert.equal(markerFor('', 'check'), MARKER);
  assert.equal(markerFor('node22', 'check'), '<!-- isokron-mcp-check key=node22 job=check -->');
  assert.equal(markerFor('a', 'x y<!--'), '<!-- isokron-mcp-check key=a job=xy- -->');
  assert.equal(markerFor('a', 'zero-config'), '<!-- isokron-mcp-check key=a job=zero-config -->');
  const ws = workspace('ts-zod');
  const ctx = { event: pr(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_JOB: 'check', GITHUB_RUN_ATTEMPT: '3' };
  act(ws, { 'pr-comment': 'always', 'pr-comment-key': 'node22' }, ctx);
  const body = readFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), 'utf8');
  assert.ok(body.startsWith('<!-- isokron-mcp-check key=node22 job=check -->\n<!-- mcp-check-run: 42-3 -->\n'));
  assert.match(act(ws, { 'pr-comment': 'always', 'pr-comment-key': 'no spaces' }, ctx).stdout, /::error::mcp-check: pr-comment-key may hold only/);
  assert.match(act(ws, { 'pr-comment': 'always', 'pr-comment-key': 'a--b' }, ctx).stdout, /::error::mcp-check: pr-comment-key may hold only/);
  // Two keys on one pull request: two comments; the unkeyed marker is not mistaken for a keyed one, nor the reverse.
  const gh = fakeGitHub([{ body: MARKER + '\nsingle job', user: ACTIONS_BOT }]);
  const k1 = markerFor('a', 'check'); const k2 = markerFor('b', 'check');
  assert.equal((await upsertComment(args(gh, { marker: k1, body: k1 + '\none\n' }))).done, 'created');
  assert.equal((await upsertComment(args(gh, { marker: k2, body: k2 + '\ntwo\n' }))).done, 'created');
  assert.equal((await upsertComment(args(gh, { marker: k1, body: k1 + '\nonce more\n' }))).done, 'updated');
  assert.equal((await upsertComment(args(gh, { body: MARKER + '\nsingle again\n' }))).id, 100);
  assert.deepEqual(gh.comments.map((c) => c.body.split('\n')[1]), ['single again', 'once more', 'two']);
});

test('zero-config: a snapshot of another server is not graded instead of the code, and is labelled when it is the only list', () => {
  const ws = workspace(null);
  mkdirSync(join(ws, 'src')); mkdirSync(join(ws, '.mcp-catalog'));
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'my-server', dependencies: { '@modelcontextprotocol/sdk': '1.20.0', zod: '3.25.0' } }));
  writeFileSync(join(ws, 'src', 'server.ts'), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst server = new McpServer({ name: 'my-server', version: '1' });\nserver.registerTool('my_tool', { title: 'Mine', description: 'My own tool.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [] }));\n");
  const up = { capturedWith: 'mcp-catalog-snap/0.1.0', server: { name: 'github' }, catalog: { prompts: [], resourceTemplates: [], tools: [0, 1, 2].map((i) => ({ name: 'upstream_' + i, description: 'x', inputSchema: { type: 'object' } })) } };
  writeFileSync(join(ws, '.mcp-catalog', 'github.json'), JSON.stringify(up));
  const r = act(ws, { 'min-grade': 'B' });
  assert.match(r.summary, /1 tools from the repository code in `\.`\./);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'tools-list.json'), 'utf8')).tools.map((t) => t.name), ['my_tool']);

  const only = workspace(null);
  mkdirSync(join(only, '.mcp-catalog'));
  writeFileSync(join(only, '.mcp-catalog', 'github.json'), JSON.stringify(up));
  const o = act(only, {});
  assert.match(o.summary, /\*\*Graded a committed snapshot of `github` \(`\.mcp-catalog\/github\.json`\); it may not be this repository's server, and it may be stale\.\*\*/);

  writeFileSync(join(only, '.mcp-catalog', 'slack.json'), JSON.stringify({ ...up, server: { name: 'slack' } }));
  const two = act(only, {});
  assert.equal(two.outputs['exit-status'], '0', 'nothing to grade is neutral');
  assert.match(two.stdout, /No tool definitions found .* Not used: 2 mcp-catalog-snap snapshots of other servers \(\.mcp-catalog\/github\.json: github, \.mcp-catalog\/slack\.json: slack\)\./);
});

test('zero-config: parts of a source read that are not readable are named in the summary and the PR comment', () => {
  const ws = workspace(null);
  mkdirSync(join(ws, 'src'));
  writeFileSync(join(ws, 'package.json'), '{"name":"notes","dependencies":{"@modelcontextprotocol/sdk":"1.20.0"}}');
  writeFileSync(join(ws, 'src', 'index.ts'), 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst server = new McpServer({ name: "notes", version: "1" });\n'
    + 'server.registerTool("list_notes", { title: "List notes", description: "List the notes of a folder. Use this when browsing.", inputSchema: buildSchema(), annotations: { readOnlyHint: true } }, h);\n');
  const ctx = { event: pr(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
  const r = act(ws, { 'pr-comment': 'always' }, ctx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.summary, /Not readable from source: 1 input schema; \d+ checks? of those parts skipped, and the grades use the rest\./);
  const body = readFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), 'utf8');
  assert.match(body, /Not readable from source: 1 input schema/);
});
