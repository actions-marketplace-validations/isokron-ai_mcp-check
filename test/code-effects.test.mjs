// Code-derived annotation effects (src/inputs/repo-effects.cjs, src/code-effects.js): what a tool's handler touches,
// read from source, and the three checks that compare it with the declared hints. Nothing here runs a server or
// touches the network. The servers under bench/effects/cases are small and written for this; their labels are in
// bench/effects/truth.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODE_CHECKS, SEVERITY_CAP, codeEffectsReport, codeEffectsText } from '../src/code-effects.js';
import { parseList } from '../src/tools.js';
import { score } from '../bench/effects.mjs';
import { parseArgs } from '../src/cli.js';

const require = createRequire(import.meta.url);
const Repo = require('../src/inputs/repo-source.cjs');
const Fx = require('../src/inputs/repo-effects.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const cases = join(root, 'bench', 'effects', 'cases');
const cli = (args, opts = {}) => spawnSync(process.execPath, [join(root, 'bin', 'mcp-check.js'), ...args], { encoding: 'utf8', ...opts });

/** The reader's list and effects for one case folder. */
async function read(name, opts = {}) {
  const r = await Repo.fromDirectory(join(cases, name), { effects: true, ...opts });
  return { best: r.best, fx: r.best.effects, tools: r.best.tools, report: codeEffectsReport(parseList(r.best.tools, name).tools, r.best.effects) };
}
const kinds = (t, k) => t.effects[k].map((e) => e.sink);
/** Effects of one tool from a few inline files: a TypeScript or Python server written in the test. */
function snippet(files, tool, opts) {
  const map = new Map(Object.entries(files));
  const path = Object.keys(files).find((p) => /index\.(ts|js)$|server\.py$/.test(p)) || Object.keys(files)[0];
  return Fx.analyse(map, [{ path, line: 1, tool: { name: tool } }], opts).tools[tool];
}
const TS = (body, extra = '') => ({ 'index.ts': "import fs from 'node:fs';\nimport { execSync } from 'node:child_process';\n" + extra + "\nserver.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, async (a) => {\n" + body + "\n});\n" });
const PY = (body, head = '') => ({ 'server.py': 'import os\nimport shutil\nimport subprocess\nimport requests\n' + head + '\n@mcp.tool()\ndef t(p):\n' + body.split('\n').map((l) => '    ' + l).join('\n') + '\n' });

test('R-AE-01: handlers are found for inline functions, referenced functions, class methods, decorators and name switches', async () => {
  const ts = (await read('ts-mixed')).fx.tools;
  assert.equal(ts.read_note.handler.how, 'inline');
  assert.equal(ts.preview_note.handler.how, 'inline');
  const low = (await read('ts-lowlevel')).fx.tools;
  assert.equal(low.touch_item.handler.how, 'case', 'a switch case in index.ts, the list in tools.ts');
  const py = (await read('py-fastmcp')).fx.tools;
  assert.equal(py.get_user.handler.how, 'decorator');
  const pl = (await read('py-lowlevel')).fx.tools;
  assert.equal(pl.reset_job.handler.how, 'case', 'an elif branch of call_tool');
  const ref = snippet({ 'index.ts': "import fs from 'node:fs';\nasync function doIt() { fs.unlinkSync('x'); }\nserver.registerTool('t', { description: 'd', inputSchema: {} }, doIt);\n" }, 't');
  assert.equal(ref.handler.how, 'ref'); assert.deepEqual(kinds(ref, 'delete'), ['fs.unlinkSync']);
  const cls = snippet({ 'index.ts': "import fs from 'node:fs';\nclass T { name = 't'; async execute(a) { fs.writeFileSync('x', 'y'); } }\n" }, 't');
  assert.equal(cls.handler.how, 'method'); assert.deepEqual(kinds(cls, 'write'), ['fs.writeFileSync']);
  const konst = snippet({ 'index.ts': "import fs from 'node:fs';\nconst name = 't';\nserver.registerTool(name, {}, async (a): Promise<X> => { fs.rmSync('x'); return a; });\n" }, 't');
  assert.deepEqual(kinds(konst, 'delete'), ['fs.rmSync'], 'the name is a constant and the handler has a return type');
  const en = snippet({ 'server.py': 'from enum import Enum\nclass Tools(str, Enum):\n    A = "t"\n\n@server.call_tool()\nasync def call_tool(name, arguments):\n    match name:\n        case Tools.A.value:\n            os.remove("x")\n' }, 't');
  assert.equal(en.handler.how, 'case'); assert.deepEqual(kinds(en, 'delete'), ['fs.os.remove']);
});

test('R-AE-18: a handler found only by its function name is never definite', () => {
  const t = snippet({ 'index.ts': "import fs from 'node:fs';\nexport function purge_all() { fs.rmSync('x'); }\n" }, 'purge_all');
  assert.equal(t.handler.how, 'by-name');
  assert.deepEqual(t.effects.delete.map((e) => e.confidence), ['may']);
  const r = codeEffectsReport(parseList([{ name: 'purge_all', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }], 'x').tools, { tools: { purge_all: t }, limits: [], summary: {} });
  assert.deepEqual(r.findings.map((f) => f.severity), ['advice']);
});

test('R-AE-02: calls are followed through the repository, with evidence at file and line', async () => {
  const t = (await read('ts-mixed')).fx.tools.preview_note;
  assert.deepEqual(kinds(t, 'write'), ['fs.writeFile']);
  const ev = t.effects.write[0];
  assert.equal(ev.file, 'src/store.ts'); assert.equal(ev.line, 16); assert.equal(ev.confidence, 'definite');
  assert.deepEqual(ev.via.map((v) => v.split('@')[0]), ['<anonymous>', 'persist', 'writeNote'], 'the chain from the handler to the sink');
  const py = (await read('py-fastmcp')).fx.tools.remove_user;
  assert.deepEqual(kinds(py, 'delete'), ['sql.delete']); assert.equal(py.effects.delete[0].file, 'store.py');
});

test('R-AE-03: a read-only claim over a write is attention; honest read-only tools raise nothing', async () => {
  const { report } = await read('ts-mixed');
  const f = (n) => report.findings.filter((x) => x.tool === n);
  assert.deepEqual(f('preview_note').map((x) => [x.id, x.severity, x.confidence]), [['annot-code-writes-marked-readonly', 'attention', 'definite']]);
  assert.deepEqual(f('tidy_note').map((x) => [x.id, x.severity]), [['annot-code-deletes-marked-safe', 'attention']]);
  ['read_note', 'list_notes', 'git_status', 'save_note'].forEach((n) => assert.deepEqual(f(n), [], n));
  assert.match(f('preview_note')[0].message, /src\/store\.ts:16/);
});

test('R-AE-04: SQL writes are found in strings handed to a call; selects are reads; strings given to a logger are not queries', async () => {
  const t = (await read('ts-mixed')).fx.tools.top_notes;
  assert.deepEqual(kinds(t, 'write'), ['sql.update']); assert.deepEqual(kinds(t, 'read'), ['sql.select']);
  const log = snippet(TS("console.log('DELETE FROM users');\nthrow new Error('INSERT INTO x VALUES (1)');\nreturn 1;"), 't');
  assert.deepEqual(kinds(log, 'delete').concat(kinds(log, 'write')), []);
  const py = snippet(PY('log.info("DELETE FROM users")\nreturn "x"'), 't');
  assert.deepEqual(py.effects.delete, []);
  const local = snippet(PY('q = "DELETE FROM users WHERE id = 1"\ndb.execute(q)'), 't');
  assert.deepEqual(kinds(local, 'delete'), ['sql.delete']);
});

test('R-AE-05: HTTP is judged by its method; DELETE is also a delete; a POST to a query URL is only a may', async () => {
  const ts = (await read('ts-sinks')).fx.tools;
  assert.deepEqual(kinds(ts.fetch_put, 'unsafe_http'), ['http.PUT']);
  assert.deepEqual(kinds(ts.got_delete, 'delete'), ['http.DELETE']);
  assert.deepEqual(kinds(ts.fetch_get, 'unsafe_http'), []); assert.deepEqual(kinds(ts.fetch_get, 'read'), ['http.GET']);
  assert.equal(ts.fetch_post_search.effects.unsafe_http[0].confidence, 'may');
  const py = (await read('py-sinks')).fx.tools;
  assert.deepEqual(kinds(py.httpx_client_delete, 'delete'), ['http.DELETE'], 'a client made by httpx.AsyncClient()');
  assert.deepEqual(kinds(py.aiohttp_patch, 'unsafe_http'), ['http.PATCH']);
  assert.equal(py.requests_post_search.effects.unsafe_http[0].confidence, 'may');
  assert.equal(ts.fetch_put.effects.unsafe_http[0].confidence, 'may', 'PUT may be a read too: only DELETE, a mutation or a write URL is certain');
  assert.equal(ts.got_delete.effects.delete[0].confidence, 'definite');
  const gql = snippet(TS("await fetch(a.url, { method: 'POST', body: JSON.stringify({ query: 'mutation { drop(id: 1) { ok } }' }) });"), 't');
  assert.equal(gql.effects.unsafe_http[0].confidence, 'definite', 'a GraphQL mutation written in the call');
  const url = snippet(TS("await fetch('https://x/api/messages/send', { method: 'POST', body: a.b });"), 't');
  assert.equal(url.effects.unsafe_http[0].confidence, 'definite', 'a URL that names a write');
  const dyn = snippet(TS("await fetch('https://x', { method: m });"), 't');
  assert.equal(dyn.effects.unsafe_http[0].confidence, 'may', 'a method that is not a literal');
});

test('R-AE-06: an opaque client call is a may, worded "may write", and never attention', async () => {
  for (const name of ['ts-mixed', 'py-fastmcp']) {
    const { report } = await read(name);
    const f = report.findings.filter((x) => x.confidence === 'may');
    assert.ok(f.length >= 1, name);
    f.forEach((x) => { assert.equal(x.severity, 'advice'); assert.match(x.message, /reaches a possible (write|delete)/); assert.doesNotMatch(x.message, /^readOnlyHint is true but/); });
  }
  const tool = (await read('ts-mixed')).fx.tools.export_report;
  assert.equal(tool.effects.write[0].confidence, 'may'); assert.equal(tool.derived.readOnlyHint.value, null);
});

test('R-AE-07: FastMCP decorators and low-level call_tool branches resolve, with the name from the decorator or a constant', async () => {
  const py = await read('py-fastmcp');
  assert.deepEqual(py.report.findings.filter((x) => x.severity === 'attention').map((x) => x.tool).sort(), ['disk_usage', 'export_user', 'remove_user', 'sync_user']);
  const low = await read('py-lowlevel');
  assert.deepEqual(low.report.findings.map((x) => [x.tool, x.id]).sort(), [['clear_jobs', 'annot-code-deletes-marked-safe'], ['reset_job', 'annot-code-writes-marked-readonly']]);
  const named = snippet({ 'server.py': 'import os\n@mcp.tool(name="renamed")\ndef t():\n    os.remove("x")\n' }, 'renamed');
  assert.equal(named.handler.how, 'decorator'); assert.deepEqual(kinds(named, 'delete'), ['fs.os.remove']);
  const multi = snippet({ 'server.py': 'import os\n@mcp.tool(\n    name="m",\n    description="x",\n)\ndef a():\n    os.remove("x")\n\n@mcp.tool(\n    name="n",\n)\ndef b():\n    pass\n' }, 'n');
  assert.deepEqual(multi.effects.delete, [], 'a multi-line decorator belongs to its own function only');
});

test('R-AE-08: a switch on the tool name is resolved when the list and the dispatch are in different files', async () => {
  const low = (await read('ts-lowlevel')).fx.tools;
  assert.deepEqual(kinds(low.touch_item, 'write'), ['fs.writeFileSync']);
  assert.deepEqual(kinds(low.delete_item, 'delete'), ['fs.rmSync']);
  assert.deepEqual(kinds(low.get_item, 'write').concat(kinds(low.get_item, 'delete')), [], 'the next case is not part of this one');
  assert.equal(low.count_items.effects.read[0].sink, 'fs.readdirSync');
  const fall = snippet({ 'index.ts': "import fs from 'node:fs';\nswitch (name) {\n  case 'a':\n  case 't':\n    fs.rmSync('x');\n    break;\n  case 'b':\n    fs.writeFileSync('y', 'z');\n}\n" }, 't');
  assert.deepEqual(kinds(fall, 'delete'), ['fs.rmSync']); assert.deepEqual(kinds(fall, 'write'), [], 'a fall-through group, up to the next case');
});

test('R-AE-09: comments and the text of strings are not code', () => {
  const t = snippet(TS("// fs.unlinkSync('x');\n/* execSync('rm -rf /') */\nconst s = \"fs.rmSync('y')\";\nreturn s + `fs.writeFileSync('z', '')`;"), 't');
  ['write', 'delete', 'exec'].forEach((k) => assert.deepEqual(t.effects[k], [], k));
  const p = snippet(PY('# os.remove("x")\ns = "shutil.rmtree(y)"\nreturn s'), 't');
  ['write', 'delete', 'exec'].forEach((k) => assert.deepEqual(p.effects[k], [], k));
  const d = snippet(PY('"""Delete from the list: os.remove(x)."""\nreturn 1'), 't');
  assert.deepEqual(d.effects.delete, []);
});

test('R-AE-10: a temporary path is a may; a read-only command is a read; any other process is an exec', async () => {
  const tmp = (await read('ts-mixed')).fx.tools.render_preview;
  assert.equal(tmp.effects.write[0].confidence, 'may'); assert.match(tmp.effects.write[0].note, /temporary/);
  const ls = (await read('ts-sinks')).fx.tools;
  assert.deepEqual(kinds(ls.exec_ls, 'exec'), []); assert.deepEqual(kinds(ls.exec_ls, 'read'), ['exec.readonly']);
  assert.deepEqual(kinds(ls.exec_rm, 'exec'), ['exec.execSync']);
  const py = (await read('py-sinks')).fx.tools;
  assert.deepEqual(kinds(py.subprocess_ls, 'exec'), []); assert.deepEqual(kinds(py.subprocess_rm, 'exec'), ['exec.subprocess.run']);
  const regex = snippet(TS("const m = /a/.exec('b'); const r = pattern.exec('c'); return m;"), 't');
  assert.deepEqual(regex.effects.exec, [], 'RegExp.exec is not child_process.exec');
  const dangerous = snippet(TS("execSync('git status && rm -rf x');"), 't');
  assert.equal(dangerous.effects.exec.length, 1, 'a command line with && is not a read-only command');
});

test('R-AE-11: calls are followed to a set depth, and recursion ends', async () => {
  const shallow = (await read('ts-sinks')).fx.tools.deep_write;
  assert.deepEqual(shallow.effects.write, [], 'the write is four calls down: not seen at depth 3');
  const deep = (await read('ts-sinks', { effectsDepth: 5 })).fx.tools.deep_write;
  assert.deepEqual(kinds(deep, 'write'), ['fs.writeFileSync']);
  assert.equal((await read('py-sinks', { effectsDepth: 5 })).fx.tools.deep_write.effects.write.length, 1);
  const loop = snippet({ 'index.ts': "import fs from 'node:fs';\nfunction a() { b(); }\nfunction b() { a(); fs.rmSync('x'); }\nserver.registerTool('t', {}, async () => { a(); });\n" }, 't', { depth: 6 });
  assert.deepEqual(kinds(loop, 'delete'), ['fs.rmSync']);
  const none = snippet({ 'index.ts': "import fs from 'node:fs';\nfunction a() { fs.rmSync('x'); }\nserver.registerTool('t', {}, async () => { a(); });\n" }, 't', { depth: 0 });
  assert.deepEqual(none.effects.delete, [], 'depth 0 reads the handler only');
});

test('R-AE-19: a call the repository resolves is followed, not guessed from its name, and a function runs once', () => {
  const files = { 'service.ts': "export function create() { return 1; }\n", 'index.ts': "import * as service from './service.js';\nserver.registerTool('t', {}, async () => { service.create(); service.create(); service.create(); });\n" };
  const t = snippet(files, 't');
  assert.deepEqual(t.effects.write.concat(t.effects.delete, t.effects.unknown_call), [], 'service.create() is the repository\'s own function, which writes nothing');
  const out = Fx.analyse(new Map(Object.entries(files)), [{ path: 'index.ts', line: 2, tool: { name: 't' } }]);
  assert.ok(out.summary.calls_scanned <= 5, 'the helper is read once, not three times: ' + out.summary.calls_scanned);
  const opaque = snippet({ 'index.ts': "import * as service from 'some-package';\nserver.registerTool('t', {}, async () => { service.create(); });\n" }, 't');
  assert.equal(opaque.effects.write[0].confidence, 'may', 'the same call on a package is opaque');
});

test('R-AE-12: the feature is off unless asked for, and then sits in its own block that never changes a grade or the exit code', () => {
  const dir = join(cases, 'ts-mixed');
  const off = JSON.parse(cli(['--repo-dir', dir, '--format', 'json']).stdout);
  assert.equal('code_effects' in off, false);
  const on = JSON.parse(cli(['--repo-dir', dir, '--format', 'json', '--code-effects']).stdout);
  assert.equal(on.code_effects.experimental, true);
  assert.deepEqual(on.sections, off.sections, 'the grades are the same');
  assert.deepEqual(on.tools.map((t) => t.findings), off.tools.map((t) => t.findings), 'no finding is added to a tool');
  assert.equal(cli(['--repo-dir', dir, '--min-grade', 'F', '--code-effects']).status, cli(['--repo-dir', dir, '--min-grade', 'F']).status);
  const bad = cli(['--code-effects', 'x.json']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--code-effects goes with --repo or --repo-dir/);
  const text = cli(['--repo-dir', dir, '--code-effects']).stdout;
  assert.match(text, /Code-derived annotations \(experimental/);
  assert.match(text, /annot-code-writes-marked-readonly: readOnlyHint is true but the handler reaches fs\.writeFile at src\/store\.ts:16/);
  assert.equal(/Code-derived/.test(cli(['--repo-dir', dir]).stdout), false);
});

test('R-AE-13: severity is capped: nothing blocks, and only a definite sink is attention', async () => {
  assert.equal(SEVERITY_CAP, 'attention');
  CODE_CHECKS.forEach((c) => assert.notEqual(c.severity, 'blocking', c.id));
  for (const name of ['ts-mixed', 'ts-lowlevel', 'ts-sinks', 'py-fastmcp', 'py-lowlevel', 'py-sinks']) {
    const { report } = await read(name);
    for (const f of report.findings) {
      assert.ok(['attention', 'advice'].includes(f.severity), f.id);
      if (f.confidence !== 'definite') assert.equal(f.severity, 'advice', name + ' ' + f.tool);
      if (f.severity === 'attention') assert.ok(f.evidence.length && f.evidence.every((e) => e.confidence === 'definite'), name + ' ' + f.tool);
    }
  }
  assert.equal(codeEffectsText(null).length, 0);
  const noFx = codeEffectsReport(parseList([{ name: 'a', inputSchema: { type: 'object' } }], 'x').tools, null);
  assert.equal(noFx.summary.available, false);
});

test('R-AE-14: nothing is run and nothing outside the files given is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-pwn-'));
  const mark = join(dir, 'ran');
  try {
    const src = "import { execSync } from 'node:child_process';\nserver.registerTool('t', {}, async () => { execSync('touch " + mark + "'); });\n";
    const out = Fx.analyse(new Map([['index.ts', src]]), [{ path: 'index.ts', line: 2, tool: { name: 't' } }]);
    assert.equal(out.tools.t.effects.exec.length, 1);
    assert.equal(existsSync(mark), false);
    const py = Fx.analyse(new Map([['server.py', '@mcp.tool()\ndef t():\n    __import__("os").system("touch ' + mark + '")\n']]), [{ path: 'server.py', line: 1, tool: { name: 't' } }]);
    assert.equal(py.tools.t.status, 'analysed'); assert.equal(existsSync(mark), false);
    const lazy = Fx.analyse(new Map([['index.ts', 'x']]), [{ path: 'missing.ts', line: 1, tool: { name: 't' } }, { path: 'main.go', line: 1, tool: { name: 'g' } }]);
    assert.equal(lazy.tools.t.status, 'file_not_read'); assert.equal(lazy.tools.g.status, 'unsupported_language');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(/\b(eval|new Function|require\(|import\()/.test(readFileSync(join(root, 'src', 'inputs', 'repo-effects.cjs'), 'utf8').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"|\/(?:[^/\n\\]|\\.)+\/[gimsuy]*/g, '')), false, 'the analyser has no eval or dynamic loading');
});

test('R-AE-15: every sink family has a mutation check: switching the family off removes the effect', () => {
  const FAMILIES = [
    ['fs', TS("fs.writeFileSync('x', 'y');"), 'write'],
    ['fs', PY('os.remove("x")'), 'delete'],
    ['http', TS("await fetch('https://x/y', { method: 'DELETE' });"), 'delete'],
    ['http', PY('requests.put("https://x/y")'), 'unsafe_http'],
    ['sql', PY('db.execute("DELETE FROM t WHERE id = 1")'), 'delete'],
    ['sql', TS("await db.run('UPDATE t SET a = 1');"), 'write'],
    ['orm', TS("await prisma.user.delete({ where: { id: 1 } });"), 'delete'],
    ['orm', PY('session.add(x)', 'session = Session()'), 'write'],
    ['exec', TS("execSync('rm -rf x');"), 'exec'],
    ['exec', PY('subprocess.run(["rm", "x"])'), 'exec'],
    ['sdk', TS("await stripeClient.invoices.create({});"), 'write'],
  ];
  for (const [family, files, kind] of FAMILIES) {
    const on = snippet(files, 't'); const off = snippet(files, 't', { disable: [family] });
    assert.ok(on.effects[kind].length >= 1, family + ' ' + kind + ' is found');
    assert.equal(off.effects[kind].length, 0, family + ' ' + kind + ' is gone with the family off');
  }
});

test('R-AE-16: the first score on the labelled servers: nothing the check calls attention is wrong, and the misses are the known limits', async () => {
  const res = await score();
  const w = res.summary['annot-code-writes-marked-readonly'];
  assert.equal(w.code_lenient.fp, 0, 'no false attention on the labelled tools');
  assert.ok(w.code_lenient.tp >= 19 && w.code_lenient.recall.p >= 0.5, 'recall ' + JSON.stringify(w.code_lenient.recall));
  assert.equal(res.summary['annot-code-deletes-marked-safe'].code_lenient.fp, 0);
  const missed = res.rows.filter((r) => r.checks['annot-code-writes-marked-readonly'].positive && !r.checks['annot-code-writes-marked-readonly'].attention && !r.label.ambiguous).map((r) => r.key).sort();
  assert.deepEqual(missed, ['py-fastmcp/bill_user', 'py-sinks/aiohttp_patch', 'py-sinks/deep_write', 'py-sinks/httpx_put', 'py-sinks/open_append', 'py-sinks/requests_post', 'py-sinks/sdk_may', 'py-sinks/table_dispatch', 'ts-mixed/export_report', 'ts-sinks/axios_post', 'ts-sinks/callback_write', 'ts-sinks/deep_write', 'ts-sinks/exec_rm', 'ts-sinks/fetch_put', 'ts-sinks/fs_append', 'ts-sinks/fs_mkdir', 'ts-sinks/table_dispatch'], 'POST/PUT/PATCH and housekeeping-shaped writes and opaque clients (advice only), callbacks, depth, a table of functions, and a constant command no argument reaches (R-AE-31)');
  assert.deepEqual(res.summary.not_analysed, []);
});

test('R-AE-20: a POST, PUT or PATCH is "may" on its own: GraphQL, JSON-RPC, search and login calls are POSTs that read', async () => {
  const ts = (await read('fp-ts')).fx.tools; const py = (await read('fp-py')).fx.tools;
  for (const t of [ts.gql_query, ts.es, ts.rpc, py.post_search, py.sess]) {
    assert.equal(t.effects.unsafe_http.length, 1);
    assert.equal(t.effects.unsafe_http[0].confidence, 'may');
    assert.match(t.effects.unsafe_http[0].note, /may be a read/);
  }
  const del = snippet(PY('requests.delete("https://x/y/" + p)'), 't');
  assert.equal(del.effects.delete[0].confidence, 'definite', 'DELETE stays certain');
});

test('R-AE-21: housekeeping writes are "may": directories, logs, audit trails, metrics, state, caches, locks, temporary files, and appends to files the arguments do not name', async () => {
  const ts = (await read('fp-ts')).fx.tools; const py = (await read('fp-py')).fx.tools;
  assert.equal(ts.with_log.effects.write[0].confidence, 'may'); assert.match(ts.with_log.effects.write[0].note, /log/);
  assert.equal(ts.ensure.effects.write[0].confidence, 'may'); assert.match(ts.ensure.effects.write[0].note, /directory/);
  assert.equal(py.metrics.effects.write[0].confidence, 'may');
  for (const path of ['audit.log', 'metrics.json', 'app-state.json', 'cache/x', 'job.lock', 'x.pid', 'run/tmp.dat', 'historyFile', 'telemetry.ndjson']) {
    const t = snippet(TS("fs.writeFileSync(a.p + '" + path + "', 'x');"), 't');
    assert.equal(t.effects.write[0].confidence, 'may', path);
  }
  const plain = snippet(TS("fs.writeFileSync(a.p + 'notes.md', 'x');"), 't');
  assert.equal(plain.effects.write[0].confidence, 'definite', 'an ordinary data file stays certain');
  const stat = snippet(TS("fs.writeFileSync(a.p + 'status-report.md', 'x');"), 't');
  assert.equal(stat.effects.write[0].confidence, 'definite', '"state" inside another word is not a state file');
  const named = snippet({ 'index.ts': "import fs from 'node:fs';\nserver.registerTool('t', { description: 'd', inputSchema: {} }, async ({ file }) => { fs.appendFileSync(file, 'x'); });\n" }, 't');
  assert.equal(named.effects.write[0].confidence, 'definite', 'an append to the file the caller names is a write');
  const own = snippet(TS("fs.appendFileSync('visits.csv', 'x');"), 't');
  assert.equal(own.effects.write[0].confidence, 'may', 'an append to a fixed file');
});

test('R-AE-22: only the straight-line path is definite: a branch, a loop, a catch, a callback, a ternary or an argument-dependent helper is "may"', async () => {
  const ts = (await read('fp-ts')).fx.tools; const py = (await read('fp-py')).fx.tools;
  assert.equal(ts.deadbranch.effects.delete[0].confidence, 'may');
  assert.equal(ts.shared_read.effects.write[0].confidence, 'may', 'a helper branch that depends on an argument');
  assert.equal(py.err_path.effects.delete[0].confidence, 'may', 'an except block');
  const cases = {
    'if (a) { fs.rmSync(a.p); }': 'may', 'for (const x of a.list) { fs.rmSync(x); }': 'may', 'try { fs.rmSync(a.p); } catch (e) {}': 'definite',
    'try { f(); } catch (e) { fs.rmSync(a.p); }': 'may', 'try { f(); } finally { fs.rmSync(a.p); }': 'may', 'x && fs.rmSync(a.p);': 'may', 'const r = a ? fs.rmSync(a.p) : 1;': 'may',
    'p.then(() => fs.rmSync(a.p));': 'may', 'switch (a) { case 1: fs.rmSync(a.p); }': 'may', 'fs.rmSync(a.p);': 'definite', 'await new Promise((ok) => { fs.rmSync(a.p); ok(1); });': 'definite',
    'if (a) { x(); } else { fs.rmSync(a.p); }': 'may',
  };
  for (const [body, want] of Object.entries(cases)) assert.equal(snippet(TS(body), 't').effects.delete[0].confidence, want, body);
  const pyCases = { 'if a:\n    os.remove(p)': 'may', 'for i in p:\n    os.remove(i)': 'may', 'try:\n    os.remove(p)\nexcept Exception:\n    pass': 'definite', 'try:\n    f()\nexcept Exception:\n    os.remove(p)': 'may', 'with open("a") as f:\n    os.remove(p)': 'definite', 'x and os.remove(p)': 'may', 'os.remove(p)': 'definite' };
  for (const [body, want] of Object.entries(pyCases)) assert.equal(snippet(PY(body), 't').effects.delete[0].confidence, want, body);
  const viaHelper = snippet({ 'index.ts': "import fs from 'node:fs';\nfunction purge(p) { fs.rmSync(p); }\nserver.registerTool('t', {}, async (a) => { if (a.force) { purge(a.p); } });\n" }, 't');
  assert.equal(viaHelper.effects.delete[0].confidence, 'may', 'a callee reached from a branch is not certain either');
});

test('R-AE-23: the reviewer\'s repros give no attention, and every finding is worded as what it is', async () => {
  for (const name of ['fp-ts', 'fp-py']) {
    const { report } = await read(name);
    assert.deepEqual(report.findings.filter((f) => f.severity === 'attention').map((f) => f.tool), [], name + ': no attention');
    for (const f of report.findings.filter((x) => x.confidence === 'may')) assert.match(f.message, /reaches a possible (write|delete) \(.* at .*:\d+\)/, f.message);
    for (const f of report.findings.filter((x) => x.confidence === 'definite')) assert.doesNotMatch(f.message, /possible/);
  }
  const { fx } = await read('fp-ts');
  assert.deepEqual(['collide', 'sel_update', 'helpish', 'mapdel'].flatMap((n) => ['write', 'delete', 'unsafe_http', 'exec'].flatMap((k) => fx.tools[n].effects[k])), []);
});

test('R-AE-24: annotations the reader could not read are unknown, never "not declared"; a constant holding them is read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-ann-'));
  try {
    const mk = (ann, use) => ({ 'package.json': '{"name":"x","dependencies":{"@modelcontextprotocol/sdk":"^1.32.0","zod":"^4"}}', 'src/index.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport fs from 'node:fs';\nconst server = new McpServer({ name: 'x', version: '1' });\n" + ann + "server.registerTool('wipe', { description: 'Removes things.', inputSchema: {}, annotations: ANN }, async () => { fs.rmSync('data.txt'); return { content: [] }; });\n" });
    const run = async (files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); } const r = await Repo.fromDirectory(dir, { effects: true }); return codeEffectsReport(parseList(r.best.tools, 'x').tools, r.best.effects, { unreadable: r.best.unreadable }); };
    const known = await run(mk("const ANN = { readOnlyHint: true };\n"));
    assert.deepEqual(known.findings.map((f) => f.id), ['annot-code-writes-marked-readonly'], 'a constant in the same file');
    const unknown = await run(mk("const ANN = buildAnnotations();\n"));
    assert.deepEqual(unknown.findings, [], 'unreadable annotations: no finding, not even "not declared"');
    assert.equal(unknown.tools[0].annotations, 'unreadable');
    const none = codeEffectsReport(parseList([{ name: 'wipe', inputSchema: { type: 'object' } }], 'x').tools, { tools: { wipe: { status: 'analysed', effects: { read: [], write: [], delete: [{ file: 'a', line: 1, sink: 'fs.rmSync', kind: 'delete', confidence: 'definite', via: [] }], unsafe_http: [], exec: [], unknown_call: [] }, derived: {} } }, limits: [] });
    assert.deepEqual(none.findings.map((f) => f.id), ['annot-code-unmarked-write'], 'a tool with no annotations is "not declared"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-AE-25: the analysis has a time budget per repository; what is left is marked, not guessed', async () => {
  const r = await Repo.fromDirectory(join(cases, 'ts-sinks'), { effects: true });
  const found = r.best.where.map((w) => ({ path: w.path, line: w.line, tool: { name: w.name } }));
  const files = new Map(); for (const p of ['src/index.ts', 'src/helpers.ts', 'src/models.ts']) files.set(p, readFileSync(join(cases, 'ts-sinks', p), 'utf8'));
  const out = Fx.analyse(files, found, { timeBudgetMs: -1 });
  assert.ok(Object.values(out.tools).every((t) => t.status === 'time_budget'));
  assert.equal(out.summary.truncated, true); assert.equal(out.summary.time_budget_hit, true);
  const rep = codeEffectsReport(parseList(r.best.tools, 'x').tools, out);
  assert.deepEqual(rep.findings, []); assert.ok(rep.summary.other > 0);
  const fine = Fx.analyse(files, found, {});
  assert.equal(fine.summary.time_budget_hit, undefined);
});

test('R-AE-26: off by default everywhere but the CLI flag: the Action, the MCP server, the browser app and a loop run without the switch', async () => {
  assert.equal(parseArgs(['--repo-dir', '.']).codeEffects, false);
  const src = (f) => readFileSync(join(root, f), 'utf8');
  for (const f of ['action.yml', 'src/server.js', 'src/tools.js', 'src/report.js', 'src/engine.js', 'src/index.js']) assert.equal(/code-?effects|repo-effects/i.test(src(f)), false, f + ' does not know the feature');
  for (const f of readdirSync(join(root, '.github', 'workflows'))) assert.equal(/CODE_EFFECTS|code-effects/.test(src('.github/workflows/' + f)), false, f);
  assert.match(src('corpus/scan-static.mjs'), /codeEffects: env\.SCAN_STATIC_CODE_EFFECTS === '1'/, 'only the exact value 1 turns it on');
  assert.equal((src('src/inputs/collect.js').match(/effects: !!opt\.codeEffects/g) || []).length, 2, 'the collector asks only when the option is set');
  assert.equal('code_effects' in JSON.parse(cli(['--repo-dir', join(cases, 'ts-mixed'), '--format', 'json']).stdout), false);
  // a browser has no RepoEffects global: the reader loads, and asking for effects there changes nothing
  const ctx = vm.createContext({ TextDecoder, TextEncoder, URL, console });
  ctx.self = ctx;
  for (const f of ['repo-go.cjs', 'repo-rust.cjs', 'repo-csharp.cjs', 'repo-source.cjs']) vm.runInContext(readFileSync(join(root, 'src', 'inputs', f), 'utf8'), ctx, { filename: f });
  assert.equal(typeof ctx.RepoSource.extractFromFile, 'function');
  assert.equal(ctx.RepoEffects, undefined);
  assert.match(src('src/inputs/repo-source.cjs'), /if \(o\.effects && RepoEffects\)/, 'effects are asked for only when the module is there');
});

test('R-AE-27: an fs or HTTP sink is definite only when its target comes from the tool\'s arguments; a constant or server-internal target is "may"', async () => {
  const t = (await read('fp2-ts')).fx.tools;
  for (const n of ['upd_check', 'sync_status', 'evict', 'rmtemp', 'datacache', 'rmcache', 'gqlmut']) {
    const all = ['write', 'delete', 'unsafe_http', 'exec'].flatMap((k) => t[n].effects[k]);
    assert.ok(all.length >= 1, n); assert.ok(all.every((e) => e.confidence === 'may'), n + ' is may');
  }
  assert.match(t.evict.effects.delete[0].note, /does not come from the tool's arguments/);
  assert.equal(t.delete_file.effects.delete[0].confidence, 'definite', 'delete_file(path): unlink(path) on the straight-line path');
  assert.equal(t.delete_in_dir.effects.delete[0].confidence, 'definite', 'a path built from the argument and a constant');
  assert.equal(t.evict_user.effects.delete[0].confidence, 'definite', 'DELETE with the id from the arguments in the URL');
  const { report } = await read('fp2-ts');
  assert.deepEqual(report.findings.filter((f) => f.severity === 'attention').map((f) => f.tool).sort(), ['delete_file', 'delete_in_dir', 'evict_user']);
});

test('R-AE-28: the flow from an argument is followed through local variables, destructuring, loops and the parameters of callees', () => {
  const via = (body, extra = '') => snippet(TS(body, extra), 't').effects.delete[0].confidence;
  assert.equal(via("const target = a.dir + '/x'; fs.rmSync(target);"), 'definite', 'a local variable');
  assert.equal(via("const { dir: d } = a; const full = d + '/x'; fs.rmSync(full);"), 'definite', 'destructuring, then a second variable');
  assert.equal(via("fs.rmSync(pick(a));", "function pick(x) { return x.p; }"), 'definite', 'an argument inside the target expression');
  assert.equal(via("const t = 'fixed/x'; fs.rmSync(t);"), 'may', 'a constant held in a variable');
  assert.equal(via("go(a.p);", "function go(q) { fs.rmSync(q); }"), 'definite', 'a callee parameter that receives an argument');
  assert.equal(via("go('fixed');", "function go(q) { fs.rmSync(q); }"), 'may', 'a callee that receives a constant');
  assert.equal(via("go(a.p);", "function go(q) { fs.rmSync('fixed'); }"), 'may', 'a callee that ignores its parameter');
  const py = (body) => snippet(PY(body), 't').effects.delete[0].confidence;
  assert.equal(py('target = p + "/x"\nos.remove(target)'), 'definite');
  assert.equal(py('os.remove("/var/x")'), 'may');
  assert.equal(py('os.remove(os.path.join(os.getcwd(), "data", "r.json"))'), 'may', 'cwd-relative');
  const kw = snippet({ 'server.py': 'import os\ndef go(path=None):\n    os.remove(path)\n@mcp.tool()\ndef t(p):\n    go(path=p)\n' }, 't');
  assert.equal(kw.effects.delete[0].confidence, 'definite', 'a keyword argument');
  assert.equal(snippet(PY('requests.delete("https://x/session/ours")'), 't').effects.delete[0].confidence, 'may', 'DELETE with no argument in the URL or body');
  assert.equal(snippet(TS("await fetch('https://x/s/' + a.id, { method: 'DELETE' });"), 't').effects.delete[0].confidence, 'definite');
});

test('R-AE-29: a SQL or ORM write is definite only when an argument reaches the statement', () => {
  const w = (body, head = '') => snippet(TS(body, head), 't').effects.write[0].confidence;
  assert.equal(w("await db.run('UPDATE counters SET hits = hits + 1');"), 'may', 'a statement on a fixed table with no argument');
  assert.equal(w("await db.run('UPDATE counters SET hits = ? WHERE id = ?', [1, a.id]);"), 'definite');
  assert.equal(w("db.prepare('UPDATE counters SET hits = 1 WHERE id = ?').run(a.id);"), 'definite', 'an argument bound on the chained run');
  assert.equal(w("await prisma.audit.create({ data: { who: 'x' } });"), 'may', 'a create on constants');
  assert.equal(w("await prisma.user.update({ where: { id: a.id }, data: { n: 1 } });"), 'definite');
  const py = (body) => snippet(PY(body), 't').effects.write[0].confidence;
  assert.equal(py('db.execute("INSERT INTO visits VALUES (1)")'), 'may');
  assert.equal(py('db.execute("INSERT INTO visits VALUES (?)", (p,))'), 'definite');
});

test('R-AE-30: a process run through a guard wrapper takes its program and arguments from the callers; a command that is still not a literal and not from the arguments is "may"', () => {
  // QA-40 repro r1: runSafe(file, args) calls execFileSync(file, args); every caller passes "kubectl" and a literal sub-command.
  const wrap = "import { execFileSync } from 'child_process';\nfunction runSafe(file: string, args: string[]): string {\n  return execFileSync(file, args, { encoding: 'utf8' });\n}\n";
  const reg = (body) => ({ 'index.ts': wrap + "server.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, async ({ resource }) => {\n" + body + "\n});\n" });
  const ro = snippet(reg("const out = runSafe('kubectl', ['explain', resource]);\nreturn out;"), 't');
  assert.deepEqual(ro.effects.exec, [], 'kubectl explain through the wrapper is a read');
  assert.deepEqual(ro.effects.read.filter((e) => e.sink === 'exec.readonly').map((e) => e.note), ['kubectl explain']);
  // two wrappers deep, with the literals in local variables and flags pushed later (k8s-flux159 explain_resource)
  const deep = snippet({ 'index.ts': wrap + "const run = (command: string, args: string[]) => runSafe(command, args);\nserver.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, async (params) => {\n  const command = 'kubectl';\n  const args = ['api-resources'];\n  if (params.output) { args.push('-o', params.output); }\n  return run(command, args);\n});\n" }, 't');
  assert.deepEqual(deep.effects.exec, []);
  // positive controls: a literal sub-command that writes, with an argument in the argv, stays definite
  const w = snippet(reg("return runSafe('kubectl', ['delete', 'pod', resource]);"), 't');
  assert.deepEqual(w.effects.exec.map((e) => [e.sink, e.confidence]), [['exec.execFileSync', 'definite']]);
  // the command itself comes from the tool's arguments: definite
  const shell = snippet(TS("execSync(a.command);"), 't');
  assert.deepEqual(shell.effects.exec.map((e) => e.confidence), ['definite']);
  // a program nobody passes as a literal and the arguments do not name: may, worded as such
  const opaque = snippet({ 'index.ts': wrap + "server.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, async ({ resource }) => {\n  return runSafe(process.env.TOOL_BIN, ['x', resource]);\n});\n" }, 't');
  assert.deepEqual(opaque.effects.exec.map((e) => [e.confidence, e.note]), [['may', 'command is not a literal']]);
});

test('R-AE-31: an exec that no argument of the tool reaches is "may", and so is everything after an early return the arguments do not decide', () => {
  // QA-40 repro r2 (mysql-designcomputer get_schema_info, get_table_sample): an SSH tunnel built from the environment,
  // after `if not ssh: yield; return` in a context manager.
  const r2 = { 'server.py': 'import os\nimport subprocess\nfrom contextlib import contextmanager\n\n@contextmanager\ndef maybe_tunnel():\n    if os.getenv("USE_SSH", "false") != "true":\n        yield "127.0.0.1"\n        return\n    proc = subprocess.Popen(["ssh", "-N", "-L", "3330:localhost:3306", os.getenv("SSH_HOST")])\n    try:\n        yield "127.0.0.1"\n    finally:\n        proc.terminate()\n\n@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))\ndef t(table: str) -> str:\n    with maybe_tunnel() as host:\n        return f"SELECT * FROM {table} LIMIT 5 on {host}"\n' };
  const tun = snippet(r2, 't');
  assert.deepEqual(tun.effects.exec.map((e) => [e.sink, e.confidence]), [['exec.subprocess.Popen', 'may']]);
  assert.match(tun.effects.exec[0].note, /does not come from the tool's arguments/);
  // a literal command with no argument in it, on the straight-line path: may (TS and Python)
  assert.deepEqual(snippet(TS("execSync('git pull --rebase');"), 't').effects.exec.map((e) => e.confidence), ['may']);
  assert.deepEqual(snippet(PY('subprocess.run(["make", "clean"])'), 't').effects.exec.map((e) => e.confidence), ['may']);
  // positive controls: the tool's argument reaches the argv, directly or through a list built up with append/push
  assert.deepEqual(snippet(PY('subprocess.run(["git", "checkout", p])'), 't').effects.exec.map((e) => e.confidence), ['definite']);
  assert.deepEqual(snippet(PY('cmd = ["git", "branch", "-D"]\ncmd.append(p)\nsubprocess.run(cmd)'), 't').effects.exec.map((e) => e.confidence), ['definite']);
  assert.deepEqual(snippet(TS("const argv = ['rm'];\nargv.push(a.path);\nexecFileSync('rm', argv);", "import { execFileSync } from 'node:child_process';"), 't').effects.exec.map((e) => e.confidence), ['definite']);
  // early return: decided by the environment, the rest of the function is conditional; decided by an argument, it is not
  const envGuard = snippet(PY('if not os.getenv("ALLOW"):\n    return "off"\nos.remove(p)'), 't');
  assert.deepEqual(envGuard.effects.delete.map((e) => [e.confidence, e.note]), [['may', 'on a conditional path']]);
  const argGuard = snippet(PY('if not p:\n    return "no path"\nos.remove(p)'), 't');
  assert.deepEqual(argGuard.effects.delete.map((e) => e.confidence), ['definite']);
  const jsEnv = snippet(TS("if (!process.env.ALLOW) return 'off';\nfs.rmSync(a.path);"), 't');
  assert.deepEqual(jsEnv.effects.delete.map((e) => e.confidence), ['may']);
  const jsArg = snippet(TS("if (!a.path) { return 'no path'; }\nfs.rmSync(a.path);"), 't');
  assert.deepEqual(jsArg.effects.delete.map((e) => e.confidence), ['definite']);
});

test('R-AE-32: deleting a file the same function wrote, directly or through a callee given the same value, is housekeeping ("may"); so is a pending, spool, queue, outbox or staging path', () => {
  // QA-40 repro r3 (reg-fabric-verify-mcp record_action, record_event): write a pending record, POST it, remove it.
  const reg = (body, extra = '') => ({ 'index.ts': "import { writeFileSync, renameSync, rmSync } from 'fs';\nimport { join } from 'path';\nconst HOME = process.env.APP_HOME || '/var/lib/app';\n" + extra + "\nserver.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ key, text }) => {\n" + body + "\n});\n" });
  const r3 = snippet(reg("const pPath = join(HOME, 'pending', key + '.json');\nwriteFileSync(pPath, text);\nawait fetch('https://api.example.com/v1/log/append', { method: 'POST', body: text });\nrmSync(pPath, { force: true });"), 't');
  assert.deepEqual(r3.effects.delete.map((e) => e.confidence), ['may']);
  // the own-write rule alone, on a path with no housekeeping word, through a callee (writePrivate in fabric.js)
  const helper = "function writePrivate(path: string, data: string) {\n  const tmp = path + '.part';\n  writeFileSync(tmp, data);\n  renameSync(tmp, path);\n}\n";
  const own = snippet(reg("const out = join(HOME, key + '.json');\nwritePrivate(out, text);\nawait fetch('https://api.example.com/v1/append', { method: 'POST', body: text });\nrmSync(out, { force: true });", helper), 't');
  assert.deepEqual(own.effects.delete.map((e) => [e.confidence, e.note]), [['may', 'removes a file this function wrote']]);
  const direct = snippet(reg("const out = join(HOME, key + '.json');\nwriteFileSync(out, text);\nrmSync(out);"), 't');
  assert.deepEqual(direct.effects.delete.map((e) => e.confidence), ['may']);
  // positive controls: a file the function did not write stays definite, and so does a different path than the one written
  const other = snippet(reg("const out = join(HOME, key + '.json');\nconst old = join(HOME, key + '.bak');\nwriteFileSync(out, text);\nrmSync(old);"), 't');
  assert.deepEqual(other.effects.delete.map((e) => e.confidence), ['definite']);
  const plain = snippet(reg("rmSync(join(HOME, key));"), 't');
  assert.deepEqual(plain.effects.delete.map((e) => e.confidence), ['definite']);
  // the housekeeping words
  for (const w of ['pending', 'spool', 'queue', 'outbox', 'staging']) {
    const t = snippet(reg("rmSync(join(HOME, '" + w + "', key));"), 't');
    assert.deepEqual(t.effects.delete.map((e) => e.confidence), ['may'], w);
  }
});

test('R-AE-33: a client returned by a factory, held in an attribute or annotated is recognised; a Redis command is definite only when an argument reaches it, any other client verb is "may"', () => {
  // QA-40 repro r4 (redis-py delete): r = get_connection() from another module, which returns redis.Redis(...)
  const r4 = { 'conn.py': 'import redis\n\n\ndef get_connection():\n    return redis.Redis(host="localhost")\n', 'server.py': 'from mcp.server.fastmcp import FastMCP\n\nfrom .conn import get_connection\n\nmcp = FastMCP("r4")\n\n\n@mcp.tool()\ndef t(key: str) -> str:\n    r = get_connection()\n    return str(r.delete(key))\n' };
  const del = snippet(r4, 't');
  assert.deepEqual(del.effects.delete.map((e) => [e.sink, e.confidence]), [['client.redis.delete', 'definite']]);
  // a factory known only by its return annotation (a classmethod of a connection manager)
  const ann = { 'conn.py': 'from redis import Redis\n\nclass Manager:\n    _instance = None\n\n    @classmethod\n    def get_connection(cls) -> Redis:\n        return cls._instance\n', 'server.py': 'from .conn import Manager\n\n@mcp.tool()\ndef t(name: str, value: str) -> str:\n    r = Manager.get_connection()\n    return str(r.lpush(name, value))\n' };
  assert.deepEqual(snippet(ann, 't').effects.write.map((e) => [e.sink, e.confidence]), [['client.redis.lpush', 'definite']]);
  // an attribute: self.client = redis.Redis(...) in __init__
  const attr = { 'server.py': 'import redis\n\nclass Store:\n    def __init__(self):\n        self.client = redis.Redis()\n\n    def drop(self, key):\n        self.client.delete(key)\n\nstore = Store()\n\n@mcp.tool()\ndef t(key: str) -> str:\n    store.drop(key)\n    return "ok"\n' };
  assert.deepEqual(snippet(attr, 't').effects.delete.map((e) => [e.sink, e.confidence]), [['client.redis.delete', 'definite']]);
  // a key that does not come from the tool's arguments: may
  const fixed = { ...r4, 'server.py': r4['server.py'].replace('r.delete(key)', 'r.delete("session:last")') };
  assert.deepEqual(snippet(fixed, 't').effects.delete.map((e) => e.confidence), ['may']);
  // another library's client, from a factory with a return annotation, and an object obtained from it: may
  const dock = { 'server.py': 'import docker\n\ndef _client(ctx) -> docker.DockerClient:\n    return ctx.request_context.lifespan_context.docker\n\n@mcp.tool()\ndef t(ctx, volume_name: str) -> str:\n    volume = _client(ctx).volumes.get(volume_name)\n    volume.remove(force=True)\n    return "ok"\n' };
  assert.deepEqual(snippet(dock, 't').effects.delete.map((e) => [e.sink, e.confidence]), [['client.docker.remove', 'may']]);
  const aws = { 'utils.py': 'import boto3\nfrom botocore.client import BaseClient\n\ndef get_client(region) -> BaseClient:\n    return boto3.client("s3tables", region_name=region)\n', 'server.py': 'from .utils import get_client\n\n@mcp.tool()\ndef t(arn: str, ns: str) -> dict:\n    client = get_client(None)\n    return client.create_namespace(tableBucketARN=arn, namespace=[ns])\n' };
  assert.deepEqual(snippet(aws, 't').effects.write.map((e) => [e.sink, e.confidence]), [['client.aws.create_namespace', 'may']]);
  // not a client: a local dict, and a repository class imported by an absolute module path
  assert.deepEqual(snippet(PY('d = {}\nd.update(x=p)\nd.pop("x")'), 't').effects.write, []);
  const local = { 'pkg/store.py': 'class Store:\n    def delete(self, key):\n        return key\n', 'server.py': 'from pkg.store import Store\n\n@mcp.tool()\ndef t(key: str) -> str:\n    s = Store()\n    return s.delete(key)\n' };
  const lt = snippet(local, 't');
  assert.deepEqual(lt.effects.delete.filter((e) => /^client\./.test(e.sink)), [], 'a repository class is followed, not guessed');
});

test('R-AE-34: opening a file for append and writing nothing through it is a writability check, not a definite write; a keyword argument is not the mode', () => {
  // Found by the QA-40 re-run of this patch: word-gongrzhe check_file_writeable() does `with open(filepath, 'a'): pass`.
  const w = (body) => snippet(PY(body), 't').effects.write.map((e) => [e.confidence, e.note]);
  assert.deepEqual(w("try:\n    with open(p, 'a'):\n        pass\n    return True\nexcept IOError:\n    return False"), [['may', 'opens for append and writes nothing (a writability check)']]);
  assert.deepEqual(w("with open(p, 'a') as f:\n    n = 1\nreturn n"), [['may', 'opens for append and writes nothing (a writability check)']]);
  // positive controls: a write through the handle, print(file=f), truncation by 'w', and a handle kept open
  assert.deepEqual(w("with open(p, 'a') as f:\n    f.write('x')"), [['definite', 'mode a']]);
  assert.deepEqual(w("with open(p, 'a') as f:\n    print('x', file=f)"), [['definite', 'mode a']]);
  assert.deepEqual(w("with open(p, 'w'):\n    pass"), [['definite', 'mode w']]);
  assert.deepEqual(w("f = open(p, 'a')\nf.write('x')"), [['definite', 'mode a']]);
  // a keyword argument in second place is not the mode (jupyter-datalayer cell_ids.py: open(path, encoding="utf-8"))
  assert.deepEqual(w('with open(p, encoding="utf-8") as h:\n    return h.read()'), []);
  assert.deepEqual(w('with open(p, encoding="utf-8", mode="w") as h:\n    h.write("x")'), [['definite', 'mode w']]);
});

test('R-AE-35: from pkg import mod, then mod.fn(), is followed into pkg/mod.py when pkg/__init__.py does not define fn', () => {
  // QA-40 misses in aws-s3tables: server.py imports the submodule `namespaces` from its package and calls
  // namespaces.create_namespace(...); the call stopped at the package's __init__.py.
  const files = { 'pkg/__init__.py': '__version__ = "1"\n', 'pkg/ops.py': 'import os\n\ndef remove(path):\n    os.remove(path)\n', 'pkg/server.py': 'from pkg import ops\n\n@mcp.tool()\ndef t(path: str) -> str:\n    ops.remove(path)\n    return "ok"\n' };
  const t = Fx.analyse(new Map(Object.entries(files)), [{ path: 'pkg/server.py', line: 1, tool: { name: 't' } }]).tools.t;
  assert.deepEqual(t.effects.delete.map((e) => [e.sink, e.file, e.confidence]), [['fs.os.remove', 'pkg/ops.py', 'definite']]);
  // a function the package's __init__.py defines is still taken from there
  const init = { ...files, 'pkg/__init__.py': 'import shutil\n\ndef ops_remove(path):\n    shutil.rmtree(path)\n' };
  const t2 = Fx.analyse(new Map(Object.entries({ ...init, 'pkg/server.py': 'import pkg\n\n@mcp.tool()\ndef t(path: str) -> str:\n    pkg.ops_remove(path)\n    return "ok"\n' })), [{ path: 'pkg/server.py', line: 1, tool: { name: 't' } }]).tools.t;
  assert.deepEqual(t2.effects.delete.map((e) => e.sink), ['fs.shutil.rmtree']);
});
