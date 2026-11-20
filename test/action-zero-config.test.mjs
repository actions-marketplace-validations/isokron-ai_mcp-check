// The Action with neither tools-file nor command (it reads the source), the registry line (publish-hint) and the
// pull-request comment (pr-comment): input handling, gating, the fork skip, the comment body, and the comment step
// against a stand-in for the GitHub API (a mocked fetch, and a local HTTP server for the step run as a process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import M from '../src/engine.js';
import { LINK_TAGS } from '../src/links.js';
import { publishHint } from '../action/main.mjs';
import { MARKER, commentAction, explainFailure, prContext, renderComment, upsertComment } from '../action/pr-comment.mjs';

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
const REGISTRY_LINE = /\*\*\[List this server in the IsoKron MCP registry\]\(https:\/\/isokron\.ai\/mcp-check\/registry\/example\/notes\?utm_source=mcp-check-action&utm_medium=action\)\*\* \(free\): a public page with its CI-verified grade, and a README badge\./;

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
  assert.match(r.summary, /\*\*Source: repository code; nothing was run\.\*\* Derived: reproduced from SDK registrations in the source; schemas follow the SDK's output and may differ in detail\. For the exact list your server sends, set `command` .* or `tools-file` .*\[how\]\(https:\/\/github\.com\/isokron-ai\/mcp-check\/blob\/main\/docs\/github-action\.md#where-the-tool-list-comes-from\)/);
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
  assert.match(again.summary, /\*\*Source: repository code; nothing was run\.\*\* Derived/);
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
  assert.match(js.summary, /\*\*Source: repository code; nothing was run\.\*\* Literal: tool definitions written as literals in the source\./);
});

test('zero-config: no tool definitions fails the job, in the log and the summary, naming command and tools-file', () => {
  const ws = workspace(null);
  writeFileSync(join(ws, 'README.md'), '# a library\n');
  writeFileSync(join(ws, 'index.js'), 'module.exports = 1;\n');
  const r = act(ws, {});
  assert.equal(r.status, 1);
  assert.equal(r.outputs['exit-status'], '1');
  assert.match(r.stdout, /::error::mcp-check: no tool definitions found in the source in \. \(scanned 1 of 1 source files, .*\)\. Set command \(the command that starts the server, for example node dist\/index\.js\) or tools-file \(a saved tools\/list answer\)\./);
  assert.match(r.summary, /No tool definitions found in the repository code in `\.` \(1 source files read; nothing was run\)\. Set `command` .* or `tools-file`/);
  assert.match(act(ws, { 'working-directory': 'README.md' }).stdout, /working-directory is not a folder/);
  assert.match(act(ws, { 'working-directory': '../x' }).stdout, /working-directory must be a path inside the workspace/);
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
  assert.equal(on.outputs['pr-number'], '7');
  assert.equal(on.outputs['pr-comment-file'], 'mcp-check-results/pr-comment.md');
  const body = readFileSync(join(ws, 'mcp-check-results', 'pr-comment.md'), 'utf8');
  assert.ok(body.startsWith(MARKER + '\n### MCP check: passes min-grade B\n'));
  assert.match(body, /Source: repository code, nothing was run \(derived\)\./);
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
function fakeGitHub(initial = []) {
  const comments = initial.map((c, i) => ({ id: 100 + i, ...c }));
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    calls.push({ method, path: u.pathname + u.search, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (fake.status) return json(fake.status, { message: 'no' });
    let m;
    if (method === 'GET' && (m = /\/repos\/o\/r\/issues\/7\/comments$/.exec(u.pathname))) {
      const page = Number(u.searchParams.get('page')); const per = Number(u.searchParams.get('per_page'));
      return json(200, comments.slice((page - 1) * per, page * per));
    }
    if (method === 'POST' && /\/repos\/o\/r\/issues\/7\/comments$/.test(u.pathname)) { const c = { id: 900, body: JSON.parse(init.body).body, user: { login: 'github-actions[bot]' } }; comments.push(c); return json(201, c); }
    if (method === 'PATCH' && (m = /\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(u.pathname))) { const c = comments.find((x) => x.id === Number(m[1])); c.body = JSON.parse(init.body).body; return json(200, c); }
    return json(404, {});
  };
  const fake = { comments, calls, fetch, status: 0 };
  return fake;
}
const args = (gh, extra = {}) => ({ apiUrl: 'https://api.example.test', repo: 'o/r', number: 7, token: 't0ken', body: MARKER + '\nnew\n', fetch: gh.fetch, ...extra });

test('upsertComment: creates one comment, then updates the same one; update-only creates nothing; others\' comments are left alone', async () => {
  const gh = fakeGitHub([{ body: 'unrelated', user: { login: 'someone' } }, { body: 'quoting ' + MARKER, user: { login: 'someone' } }]);
  assert.deepEqual(await upsertComment(args(gh, { action: 'update' })), { done: 'none', id: null });
  assert.ok(!gh.calls.some((c) => c.method !== 'GET'));
  assert.deepEqual(await upsertComment(args(gh)), { done: 'created', id: 900 });
  assert.deepEqual(await upsertComment(args(gh, { body: MARKER + '\nnewer\n' })), { done: 'updated', id: 900 });
  assert.deepEqual(await upsertComment(args(gh, { body: MARKER + '\nnewer\n' })), { done: 'unchanged', id: 900 });
  assert.equal(gh.comments.filter((c) => c.body.startsWith(MARKER)).length, 1);
  assert.equal(gh.comments[1].body, 'quoting ' + MARKER, 'a comment that only mentions the marker is not ours');
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer t0ken' && c.path.startsWith('/repos/o/r/issues/')));
});

test('upsertComment: finds the marker past the first page, prefers github-actions[bot]; errors keep the status', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ body: 'c' + i, user: { login: 'u' } }));
  many.push({ body: MARKER + '\nby a person', user: { login: 'person' } }, { body: MARKER + '\nold', user: { login: 'github-actions[bot]' } });
  const gh = fakeGitHub(many);
  assert.deepEqual(await upsertComment(args(gh)), { done: 'updated', id: 251 });
  assert.deepEqual(gh.calls.filter((c) => c.method === 'GET').map((c) => c.path), ['/repos/o/r/issues/7/comments?per_page=100&page=1', '/repos/o/r/issues/7/comments?per_page=100&page=2']);
  gh.status = 403;
  await assert.rejects(upsertComment(args(gh)), (e) => e.status === 403 && !/t0ken/.test(e.message));
  assert.match(explainFailure({ status: 403, message: 'HTTP 403' }), /add permissions: pull-requests: write/);
  await assert.rejects(upsertComment(args(gh, { token: '' })), /github-token is empty/);
  await assert.rejects(upsertComment(args(gh, { repo: 'o/r/../x' })), /not owner\/repo/);
});

// ------------------------------------------------------------ the comment step as a process, against a local API
function runStep(env) {
  return new Promise((resolveRun) => {
    const p = spawn(process.execPath, [commentScript], { env: { PATH: process.env.PATH, ...env } });
    let stdout = ''; p.stdout.on('data', (c) => { stdout += c; });
    p.on('close', (code) => resolveRun({ code, stdout }));
  });
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
  const dir = mkdtempSync(join(tmpdir(), 'mcpcheck-step-'));
  writeFileSync(join(dir, 'c.md'), MARKER + '\nhello\n');
  const sum = join(dir, 'sum.md'); writeFileSync(sum, '');
  const env = { COMMENT_FILE: join(dir, 'c.md'), COMMENT_ACTION: 'upsert', PR_NUMBER: '7', GITHUB_TOKEN: 'secret-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'http://127.0.0.1:' + srv.address().port, GITHUB_STEP_SUMMARY: sum };
  const ok = await runStep(env);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /mcp-check: PR comment created \(5\)/);
  assert.deepEqual(seen.map((x) => x.method), ['GET', 'POST']);
  assert.equal(JSON.parse(seen[1].body).body, MARKER + '\nhello\n');
  assert.equal(seen[1].auth, 'Bearer secret-token');
  refuse = true;
  const bad = await runStep(env);
  assert.equal(bad.code, 0, 'a failed comment never fails the job');
  assert.match(bad.stdout, /::warning::mcp-check: PR comment not posted: the token may not write to pull requests: add permissions: pull-requests: write/);
  assert.match(readFileSync(sum, 'utf8'), /PR comment not posted: /);
  assert.ok(!/secret-token/.test(bad.stdout + readFileSync(sum, 'utf8')));
  const missing = await runStep({ ...env, COMMENT_FILE: join(dir, 'nope.md') });
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /::warning::/);
});

test('action.yml: the token reaches the comment step only; that step cannot fail the job', () => {
  const y = readFileSync(join(root, 'action.yml'), 'utf8');
  assert.equal((y.match(/inputs\.github-token/g) || []).length, 1);
  const step = y.slice(y.indexOf('- name: Comment on the pull request'), y.indexOf('- name: Set the job status'));
  assert.match(step, /GITHUB_TOKEN: \$\{\{ inputs\.github-token \}\}/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /if: \$\{\{ always\(\) && steps\.run\.outputs\.pr-comment-action != '' \}\}/);
  const run = y.slice(y.indexOf('- name: Grade the tool list'), y.indexOf('- name: Upload SARIF'));
  assert.ok(!/TOKEN/.test(run), 'the step that may start the server has no token');
  assert.match(y, /\n  github-token:\n[\s\S]*?default: \$\{\{ github\.token \}\}\n/);
  assert.match(y, /\n  pr-comment:\n[\s\S]*?default: 'off'\n/);
  assert.match(y, /\n  publish-hint:\n[\s\S]*?default: 'true'\n/);
});
