import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as dirnamePath, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitCommand } from '../action/main.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const main = join(root, 'action', 'main.mjs');
const ex = join(root, 'test', 'fixtures', 'example.json');
const good = join(root, 'test', 'catalogs', 'well-designed.json');

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcheck-ws-'));
  mkdirSync(join(ws, 'mcp'));
  copyFileSync(ex, join(ws, 'mcp', 'tools.json'));
  copyFileSync(good, join(ws, 'mcp', 'good.json'));
  return ws;
}
function act(ws, inputs, extra = {}) {
  const out = join(ws, '..', 'out-' + Math.random().toString(36).slice(2));
  const sum = out + '.md';
  writeFileSync(out, ''); writeFileSync(sum, '');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_REPOSITORY: 'example/server', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', MCP_CHECK_DEFAULT_BRANCH: 'main', ...extra };
  for (const [k, v] of Object.entries(inputs)) env['INPUT_' + k.toUpperCase().replace(/-/g, '_')] = v;
  const r = spawnSync(process.execPath, [main], { cwd: ws, env, encoding: 'utf8' });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { ...r, outputs, summary: readFileSync(sum, 'utf8') };
}

test('action: tools-file, grades as outputs, job summary, reports and SARIF with file locations', () => {
  const ws = workspace();
  const r = act(ws, { 'tools-file': 'mcp/tools.json', 'min-grade': 'B' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs['grade-anthropic'], 'C');
  assert.equal(r.outputs['grade-spec'], 'A');
  assert.equal(r.outputs.passed, 'false');
  assert.equal(r.outputs['exit-status'], '1');
  assert.match(r.stdout, /::error::mcp-check: below min-grade B: anthropic C, openai C/);
  assert.match(r.summary, /\| Anthropic directory \| C \| 70 \|/);
  assert.match(r.summary, /\*\*Below the minimum grade B:\*\* anthropic C, openai C/);
  assert.match(r.summary, /\[anthropic-title\]\(https:\/\/isokron\.ai\/mcp-check\/checks\/anthropic-title\?utm_source=mcp-check-action&utm_medium=action\)/);
  assert.match(r.summary, /\[Open this report in the web checker\]\(https:\/\/isokron\.ai\/mcp-check#r=2\.1\.0&z=/);
  for (const f of ['report.md', 'report.json', 'report.sarif']) assert.ok(existsSync(join(ws, 'mcp-check-results', f)), f);
  const sarif = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'report.sarif'), 'utf8'));
  assert.ok(sarif.runs[0].results.every((x) => x.locations[0].physicalLocation.artifactLocation.uri === 'mcp/tools.json'));
  assert.equal(r.outputs['sarif-file'], 'mcp-check-results/report.sarif');
  assert.equal(r.outputs['badge-changed'], 'false');
});

test('action: a well-designed list passes min-grade A on every section', () => {
  const ws = workspace();
  const r = act(ws, { 'tools-file': 'mcp/good.json', 'min-grade': 'A', sections: 'spec,anthropic,openai,security,quality,surface' });
  assert.equal(r.outputs.passed, 'true');
  assert.equal(r.outputs['exit-status'], '0');
  assert.match(r.summary, /Every gated section meets the minimum grade A/);
});

test('action: command starts a stdio server and reads tools/list only', () => {
  const ws = workspace();
  const cmd = JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(root, 'bin', 'mcp-check-server.js'));
  const r = act(ws, { command: cmd, 'min-grade': 'A', timeout: '30' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.passed, 'true');
  assert.equal(r.outputs['tools-list'], 'mcp-check-results/tools-list.json');
  const list = JSON.parse(readFileSync(join(ws, 'mcp-check-results', 'tools-list.json'), 'utf8'));
  assert.equal(list.tools.length, 3);
  assert.match(r.summary, /from the server started by `command` \(`mcp-check /);
});

test('action: badge written on the default branch only, and not rewritten when nothing changed', () => {
  const ws = workspace();
  const pr = act(ws, { 'tools-file': 'mcp/tools.json', badge: 'true' }, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' });
  assert.equal(pr.outputs['badge-changed'], 'false');
  assert.ok(!existsSync(join(ws, '.github', 'mcp-check', 'badge.json')));
  assert.match(pr.summary, /Badge not updated/);
  assert.match(pr.summary, /\[!\[MCP check\]\(https:\/\/img\.shields\.io\/endpoint\?url=https:\/\/raw\.githubusercontent\.com\/example\/server\/main\/\.github\/mcp-check\/badge\.json\)\]\(https:\/\/github\.com\/example\/server\/blob\/main\/\.github\/mcp-check\/report\.md\)/);

  const first = act(ws, { 'tools-file': 'mcp/tools.json', badge: 'true' });
  assert.equal(first.outputs['badge-changed'], 'true');
  const badge = JSON.parse(readFileSync(join(ws, '.github', 'mcp-check', 'badge.json'), 'utf8'));
  assert.equal(badge.schemaVersion, 1);
  assert.equal(badge.label, 'MCP check');
  assert.equal(badge.message, 'Claude C · ChatGPT C · spec A');
  assert.equal(badge.color, 'yellow');
  assert.equal(badge.rubric_version, '2.1.0');
  assert.match(badge.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(badge.grades.anthropic, 'C');
  assert.equal(badge.report, 'https://github.com/example/server/blob/main/.github/mcp-check/report.md');
  assert.equal(badge.run, 'https://github.com/example/server/actions/runs/42');
  const report = readFileSync(join(ws, '.github', 'mcp-check', 'report.md'), 'utf8');
  assert.match(report, /^# MCP check report\n\nCommit `a{40}`, \[workflow run\]/);

  assert.equal(first.outputs['badge-branch'], 'main');
  writeFileSync(join(ws, '.github', 'mcp-check', 'badge.json'), JSON.stringify({ ...badge, date: '2026-01-01' }));
  const again = act(ws, { 'tools-file': 'mcp/tools.json', badge: 'true' });
  assert.equal(again.outputs['badge-changed'], 'false');
  assert.match(again.summary, /Badge unchanged/);
  assert.equal(JSON.parse(readFileSync(join(ws, '.github', 'mcp-check', 'badge.json'), 'utf8')).date, '2026-01-01', 'an unchanged grade keeps its date');

  // A schedule event has no repository object; it runs on the default branch, named by GITHUB_REF_NAME.
  const ws2 = workspace();
  const sched = act(ws2, { 'tools-file': 'mcp/tools.json', badge: 'true' }, { GITHUB_EVENT_NAME: 'schedule', MCP_CHECK_DEFAULT_BRANCH: '', GITHUB_REF_NAME: 'main' });
  assert.equal(sched.outputs['badge-changed'], 'true');
  const unknown = act(workspace(), { 'tools-file': 'mcp/tools.json', badge: 'true' }, { GITHUB_EVENT_NAME: 'push', MCP_CHECK_DEFAULT_BRANCH: '' });
  assert.match(unknown.summary, /default branch is not known/);
});

test('action: baseline comparison fails on a high-risk annotation flip', () => {
  const ws = workspace();
  const flipped = JSON.parse(readFileSync(ex, 'utf8'));
  flipped.tools.find((t) => t.name === 'close_issue').annotations.readOnlyHint = true;
  writeFileSync(join(ws, 'mcp', 'new.json'), JSON.stringify(flipped, null, 2));
  const r = act(ws, { 'tools-file': 'mcp/new.json', baseline: 'mcp/tools.json' });
  assert.equal(r.outputs['exit-status'], '1');
  assert.match(r.summary, /\*\*High risk\*\*.*`close_issue`/);
});

test('action: input errors fail the step with an error annotation', () => {
  const ws = workspace();
  const both = act(ws, { 'tools-file': 'mcp/tools.json', command: 'node x.js' });
  assert.equal(both.status, 1);
  assert.match(both.stdout, /::error::mcp-check: set exactly one of tools-file and command/);
  assert.equal(both.outputs['exit-status'], '1');
  assert.match(act(ws, { 'tools-file': '../etc/passwd' }).stdout, /must be a path inside the workspace/);
  assert.match(act(ws, { 'tools-file': 'mcp/tools.json', 'results-dir': '/tmp/x' }).stdout, /results-dir must be a path inside the workspace/);
  symlinkSync(tmpdir(), join(ws, 'escape'));
  assert.match(act(ws, { 'tools-file': 'escape/x.json' }).stdout, /resolves outside the workspace/);
  assert.match(act(ws, { 'tools-file': 'mcp/tools.json', 'min-grade': 'Z' }).stdout, /min-grade must be one of/);
  assert.match(act(ws, { command: process.execPath + ' -e "process.exit(4)"', timeout: '10' }).stdout, /could not read tools\/list from the server: the server exited before answering \(exit 4/);
});

test('action: splitCommand splits words and quotes without a shell', () => {
  assert.deepEqual(splitCommand('node dist/index.js --flag "a b" \'c d\' e\\ f'), ['node', 'dist/index.js', '--flag', 'a b', 'c d', 'e f']);
  assert.deepEqual(splitCommand('npx -y "" x'), ['npx', '-y', '', 'x']);
  assert.deepEqual(splitCommand('echo $HOME; rm -rf /'), ['echo', '$HOME;', 'rm', '-rf', '/'], 'no expansion, no command separators');
  assert.throws(() => splitCommand('node "x'), /unclosed/);
});

test('action.yml: every uses is pinned by full SHA, inputs reach run steps only through env', () => {
  const y = readFileSync(join(root, 'action.yml'), 'utf8');
  const uses = [...y.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  // Inside run: blocks no ${{ }} expression appears (inputs are passed as env).
  const lines = y.split('\n');
  let inRun = -1, checked = 0;
  for (const l of lines) {
    const ind = l.length - l.trimStart().length;
    if (inRun >= 0 && l.trim() && ind <= inRun) inRun = -1;
    if (inRun >= 0) { assert.ok(!l.includes('${{'), 'expression inside a run block: ' + l.trim()); checked++; }
    if (/^\s+run: \|\s*$/.test(l)) inRun = ind;
  }
  assert.ok(checked > 10, 'run blocks were found and checked');
  for (const k of ['tools-file', 'command', 'min-grade', 'sections', 'badge', 'upload-sarif', 'baseline']) assert.match(y, new RegExp('\\n  ' + k + ':'), k);
});

function runStep(name) {
  const y = readFileSync(join(root, 'action.yml'), 'utf8');
  const part = y.slice(y.indexOf('- name: ' + name));
  const lines = part.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  const ind = lines[at].length - lines[at].trimStart().length;
  const body = [];
  for (const l of lines.slice(at + 1)) { if (l.trim() && l.length - l.trimStart().length <= ind) break; body.push(l.slice(ind + 2)); }
  return body.join('\n');
}

test('action.yml: the badge commit step commits badge.json and report.md only, and pushes to the default branch', () => {
  const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  const base = mkdtempSync(join(tmpdir(), 'mcpcheck-git-'));
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(base, 'clone', '-q', join(base, 'origin.git'), 'ws');
  const ws = join(base, 'ws');
  git(ws, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(ws, 'push', '-q', 'origin', 'HEAD:main');
  mkdirSync(join(ws, '.github', 'mcp-check'), { recursive: true });
  writeFileSync(join(ws, '.github', 'mcp-check', 'badge.json'), '{}\n');
  writeFileSync(join(ws, '.github', 'mcp-check', 'report.md'), '# r\n');
  writeFileSync(join(ws, 'unrelated.txt'), 'not committed\n');
  const r = spawnSync('bash', ['-c', runStep('Commit the badge')], { cwd: ws, encoding: 'utf8', env: { ...process.env, BADGE_DIR: '.github/mcp-check', BRANCH: 'main' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const files = git(base, '--git-dir', join(base, 'origin.git'), 'show', '--name-only', '--format=%s%n%an', 'main');
  assert.deepEqual(files.split('\n').filter(Boolean), ['mcp-check: update badge [skip ci]', 'github-actions[bot]', '.github/mcp-check/badge.json', '.github/mcp-check/report.md']);
  const again = spawnSync('bash', ['-c', runStep('Commit the badge')], { cwd: ws, encoding: 'utf8', env: { ...process.env, BADGE_DIR: '.github/mcp-check', BRANCH: 'main' } });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /badge unchanged/);
});

const tag = (s) => [...s].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');

test('action: hostile text in the list or the server cannot form links, images or HTML in the job summary', () => {
  const ws = workspace();
  const list = { tools: [
    { name: 'x`![img](https://evil.example/p.png)', title: 'X', description: 'Gets a thing. Use this when needed.' + tag('[click](https://evil.example/a)'), inputSchema: { type: 'object' } },
    { name: 'get_thing', description: 'Short <img src=x onerror=alert(1)> ![i](https://evil.example/i.png) [l](https://evil.example)', inputSchema: { type: 'object' } },
  ] };
  writeFileSync(join(ws, 'mcp', 'hostile.json'), JSON.stringify(list, null, 2));
  const r = act(ws, { 'tools-file': 'mcp/hostile.json' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Outside code spans, no unescaped link, image or tag may remain.
  const outside = r.summary.replace(/(?<![`\\])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m) => m.replace(/[!\[\]()<>]/g, ''));
  assert.ok(!/(^|[^\\])!\[/.test(outside), 'an image');
  assert.ok(!/(^|[^\\])\[[^\]]*\]\(https:\/\/evil/.test(outside), 'a link');
  assert.ok(!/(^|[^\\])<img/i.test(outside), 'HTML');
  assert.match(r.summary, /\\\[click\\\]\(https:\/\/evil\.example\/a\)/, 'the decoded hidden text is shown, escaped');
  assert.match(r.summary, /`` x`!\[img\]\(https:\/\/evil\.example\/p\.png\) ``/, 'a name with a backtick stays inside its code span');

  // A server whose serverInfo.name and stderr are hostile.
  const srv = join(ws, 'srv.cjs');
  writeFileSync(srv, `
process.stderr.write('::set-output name=passed::true\\n::add-mask::x\\n');
process.stdin.on('data', (c) => { for (const l of String(c).split('\\n').filter(Boolean)) { const m = JSON.parse(l);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: '![x](https://evil.example/s.png) <b>', version: '1' } } }) + '\\n');
  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'get_thing', inputSchema: { type: 'object' } }] } }) + '\\n'); } });`);
  const s = act(ws, { command: process.execPath + ' srv.cjs', timeout: '20' }, { GITHUB_ACTIONS: 'true' });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.summary, /from the server started by `command` \(`!\[x\]\(https:\/\/evil\.example\/s\.png\) <b> 1`\)/);
  const fence = /^::stop-commands::([0-9a-f]{32})$/m.exec(s.stderr);
  assert.ok(fence, 'server stderr is fenced');
  const inside = s.stderr.slice(fence.index, s.stderr.indexOf('::' + fence[1] + '::'));
  assert.match(inside, /::set-output name=passed::true/);
  assert.ok(s.stderr.indexOf('::' + fence[1] + '::') > fence.index);
});

test('action: never writes through a symlink planted in the repository', () => {
  const outside = mkdtempSync(join(tmpdir(), 'mcpcheck-outside-'));
  const target = join(outside, 'victim.txt');
  writeFileSync(target, 'original\n');

  // A results file that is a symlink, in a results-dir the action made earlier.
  const ws = workspace();
  mkdirSync(join(ws, 'mcp-check-results'));
  writeFileSync(join(ws, 'mcp-check-results', '.mcp-check-results'), 'x');
  symlinkSync(target, join(ws, 'mcp-check-results', 'report.md'));
  const a = act(ws, { 'tools-file': 'mcp/tools.json' });
  assert.equal(a.status, 1);
  assert.match(a.stdout, /::error::mcp-check: mcp-check-results\/report\.md exists and is not a regular file \(a symlink\)/);
  assert.equal(readFileSync(target, 'utf8'), 'original\n');

  // A results-dir that already holds files and was not made by this action.
  const ws2 = workspace();
  mkdirSync(join(ws2, 'out')); writeFileSync(join(ws2, 'out', 'keep.txt'), 'x');
  assert.match(act(ws2, { 'tools-file': 'mcp/tools.json', 'results-dir': 'out' }).stdout, /out already exists and was not made by this action/);

  // A results-dir that is a symlink (inside the workspace) is refused too.
  const ws3 = workspace();
  mkdirSync(join(ws3, 'real'));
  symlinkSync(join(ws3, 'real'), join(ws3, 'linked'));
  assert.match(act(ws3, { 'tools-file': 'mcp/tools.json', 'results-dir': 'linked' }).stdout, /results-dir exists and is not a folder \(a symlink\)/);

  // A fork-planted badge.json symlink on the default branch.
  const ws4 = workspace();
  mkdirSync(join(ws4, '.github', 'mcp-check'), { recursive: true });
  symlinkSync(target, join(ws4, '.github', 'mcp-check', 'badge.json'));
  const b = act(ws4, { 'tools-file': 'mcp/tools.json', badge: 'true' });
  assert.equal(b.status, 1);
  assert.match(b.stdout, /badge\.json is not a regular file/);
  assert.equal(readFileSync(target, 'utf8'), 'original\n');

  // A planted report.md symlink beside a real badge.json.
  const ws5 = workspace();
  mkdirSync(join(ws5, '.github', 'mcp-check'), { recursive: true });
  symlinkSync(target, join(ws5, '.github', 'mcp-check', 'report.md'));
  const c = act(ws5, { 'tools-file': 'mcp/tools.json', badge: 'true' });
  assert.equal(c.status, 1);
  assert.match(c.stdout, /report\.md exists and is not a regular file \(a symlink\)/);
  assert.equal(readFileSync(target, 'utf8'), 'original\n');

  // A tools-file that is a symlink inside the workspace, or a FIFO, is not read.
  const ws6 = workspace();
  symlinkSync(join(ws6, 'mcp', 'tools.json'), join(ws6, 'mcp', 'link.json'));
  assert.match(act(ws6, { 'tools-file': 'mcp/link.json' }).stdout, /tools-file mcp\/link\.json is not a regular file \(a symlink\)/);
});

test('action: limits, input validation and plain error messages', () => {
  const ws = workspace();
  writeFileSync(join(ws, 'mcp', 'many.json'), JSON.stringify({ tools: Array.from({ length: 2001 }, (_, i) => ({ name: 't' + i, inputSchema: { type: 'object' } })) }));
  assert.match(act(ws, { 'tools-file': 'mcp/many.json' }).stdout, /::error::mcp-check: the tool list has 2001 tools; the limit is 2000\./);
  let deep = {}; for (let i = 0; i < 100; i++) deep = { a: deep };
  writeFileSync(join(ws, 'mcp', 'deep.json'), JSON.stringify({ tools: [{ name: 'x', inputSchema: deep }] }));
  assert.match(act(ws, { 'tools-file': 'mcp/deep.json' }).stdout, /nests deeper than 64 levels/);
  assert.match(act(ws, { command: 'node x.js', shell: 'yes' }).stdout, /::error::mcp-check: shell must be true or false/);
  // An unexpected error (here: the output file is a folder) gives one plain line, no stack trace in the log.
  const out = join(ws, '..', 'outdir-' + Math.random().toString(36).slice(2)); mkdirSync(out);
  const r = spawnSync(process.execPath, [main], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, INPUT_TOOLS_FILE: 'mcp/tools.json' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::mcp-check: unexpected error: .*please report it/m);
  assert.ok(!/\n\s+at /.test(r.stdout), 'no stack trace in the log');
});

test('action: main.mjs and everything it imports use only node: built-ins and files in this repository (no npm install)', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return; seen.add(file);
    if (file.includes(join('engine', 'vendor'))) return; // the self-contained Ajv bundle (names its own internal modules); hashed in engine/VENDORED.json
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), file + ' imports ' + spec);
      walk(resolvePath(dirnamePath(file), spec));
    }
  };
  walk(fileURLToPath(new URL('../action/main.mjs', import.meta.url)));
  assert.ok(seen.size > 5, 'walked ' + seen.size + ' files');
});
