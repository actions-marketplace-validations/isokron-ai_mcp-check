// Code-derived annotation effects (src/inputs/repo-effects.cjs, src/code-effects.js): what a tool's handler touches,
// read from source, and the three checks that compare it with the declared hints. Nothing here runs a server or
// touches the network. The servers under bench/effects/cases are small and written for this; their labels are in
// bench/effects/truth.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODE_CHECKS, SEVERITY_CAP, codeEffectsReport, codeEffectsText } from '../src/code-effects.js';
import { parseList } from '../src/tools.js';
import { score } from '../bench/effects.mjs';

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
const TS = (body, extra = '') => ({ 'index.ts': "import fs from 'node:fs';\nimport { execSync } from 'node:child_process';\n" + extra + "\nserver.registerTool('t', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {\n" + body + "\n});\n" });
const PY = (body, head = '') => ({ 'server.py': 'import os\nimport shutil\nimport subprocess\nimport requests\n' + head + '\n@mcp.tool()\ndef t():\n' + body.split('\n').map((l) => '    ' + l).join('\n') + '\n' });

test('AE-01: handlers are found for inline functions, referenced functions, class methods, decorators and name switches', async () => {
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

test('AE-01b: a handler found only by its function name is never definite', () => {
  const t = snippet({ 'index.ts': "import fs from 'node:fs';\nexport function purge_all() { fs.rmSync('x'); }\n" }, 'purge_all');
  assert.equal(t.handler.how, 'by-name');
  assert.deepEqual(t.effects.delete.map((e) => e.confidence), ['may']);
  const r = codeEffectsReport(parseList([{ name: 'purge_all', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }], 'x').tools, { tools: { purge_all: t }, limits: [], summary: {} });
  assert.deepEqual(r.findings.map((f) => f.severity), ['advice']);
});

test('AE-02: calls are followed through the repository, with evidence at file and line', async () => {
  const t = (await read('ts-mixed')).fx.tools.preview_note;
  assert.deepEqual(kinds(t, 'write'), ['fs.writeFile']);
  const ev = t.effects.write[0];
  assert.equal(ev.file, 'src/store.ts'); assert.equal(ev.line, 16); assert.equal(ev.confidence, 'definite');
  assert.deepEqual(ev.via.map((v) => v.split('@')[0]), ['<anonymous>', 'persist', 'writeNote'], 'the chain from the handler to the sink');
  const py = (await read('py-fastmcp')).fx.tools.remove_user;
  assert.deepEqual(kinds(py, 'delete'), ['sql.delete']); assert.equal(py.effects.delete[0].file, 'store.py');
});

test('AE-03: a read-only claim over a write is attention; honest read-only tools raise nothing', async () => {
  const { report } = await read('ts-mixed');
  const f = (n) => report.findings.filter((x) => x.tool === n);
  assert.deepEqual(f('preview_note').map((x) => [x.id, x.severity, x.confidence]), [['annot-code-writes-marked-readonly', 'attention', 'definite']]);
  assert.deepEqual(f('tidy_note').map((x) => [x.id, x.severity]), [['annot-code-deletes-marked-safe', 'attention']]);
  ['read_note', 'list_notes', 'git_status', 'save_note'].forEach((n) => assert.deepEqual(f(n), [], n));
  assert.match(f('preview_note')[0].message, /src\/store\.ts:16/);
});

test('AE-04: SQL writes are found in strings handed to a call; selects are reads; strings given to a logger are not queries', async () => {
  const t = (await read('ts-mixed')).fx.tools.top_notes;
  assert.deepEqual(kinds(t, 'write'), ['sql.update']); assert.deepEqual(kinds(t, 'read'), ['sql.select']);
  const log = snippet(TS("console.log('DELETE FROM users');\nthrow new Error('INSERT INTO x VALUES (1)');\nreturn 1;"), 't');
  assert.deepEqual(kinds(log, 'delete').concat(kinds(log, 'write')), []);
  const py = snippet(PY('log.info("DELETE FROM users")\nreturn "x"'), 't');
  assert.deepEqual(py.effects.delete, []);
  const local = snippet(PY('q = "DELETE FROM users WHERE id = 1"\ndb.execute(q)'), 't');
  assert.deepEqual(kinds(local, 'delete'), ['sql.delete']);
});

test('AE-05: HTTP is judged by its method; DELETE is also a delete; a POST to a query URL is only a may', async () => {
  const ts = (await read('ts-sinks')).fx.tools;
  assert.deepEqual(kinds(ts.fetch_put, 'unsafe_http'), ['http.PUT']);
  assert.deepEqual(kinds(ts.got_delete, 'delete'), ['http.DELETE']);
  assert.deepEqual(kinds(ts.fetch_get, 'unsafe_http'), []); assert.deepEqual(kinds(ts.fetch_get, 'read'), ['http.GET']);
  assert.equal(ts.fetch_post_search.effects.unsafe_http[0].confidence, 'may');
  const py = (await read('py-sinks')).fx.tools;
  assert.deepEqual(kinds(py.httpx_client_delete, 'delete'), ['http.DELETE'], 'a client made by httpx.AsyncClient()');
  assert.deepEqual(kinds(py.aiohttp_patch, 'unsafe_http'), ['http.PATCH']);
  assert.equal(py.requests_post_search.effects.unsafe_http[0].confidence, 'may');
  const dyn = snippet(TS("await fetch('https://x', { method: m });"), 't');
  assert.equal(dyn.effects.unsafe_http[0].confidence, 'may', 'a method that is not a literal');
});

test('AE-06: an opaque client call is a may, worded "may write", and never attention', async () => {
  for (const name of ['ts-mixed', 'py-fastmcp']) {
    const { report } = await read(name);
    const f = report.findings.filter((x) => x.confidence === 'may');
    assert.ok(f.length >= 1, name);
    f.forEach((x) => { assert.equal(x.severity, 'advice'); assert.match(x.message, /may write/); });
  }
  const tool = (await read('ts-mixed')).fx.tools.export_report;
  assert.equal(tool.effects.write[0].confidence, 'may'); assert.equal(tool.derived.readOnlyHint.value, null);
});

test('AE-07: FastMCP decorators and low-level call_tool branches resolve, with the name from the decorator or a constant', async () => {
  const py = await read('py-fastmcp');
  assert.deepEqual(py.report.findings.filter((x) => x.severity === 'attention').map((x) => x.tool).sort(), ['disk_usage', 'export_user', 'remove_user', 'sync_user']);
  const low = await read('py-lowlevel');
  assert.deepEqual(low.report.findings.map((x) => [x.tool, x.id]).sort(), [['clear_jobs', 'annot-code-deletes-marked-safe'], ['reset_job', 'annot-code-writes-marked-readonly']]);
  const named = snippet({ 'server.py': 'import os\n@mcp.tool(name="renamed")\ndef t():\n    os.remove("x")\n' }, 'renamed');
  assert.equal(named.handler.how, 'decorator'); assert.deepEqual(kinds(named, 'delete'), ['fs.os.remove']);
  const multi = snippet({ 'server.py': 'import os\n@mcp.tool(\n    name="m",\n    description="x",\n)\ndef a():\n    os.remove("x")\n\n@mcp.tool(\n    name="n",\n)\ndef b():\n    pass\n' }, 'n');
  assert.deepEqual(multi.effects.delete, [], 'a multi-line decorator belongs to its own function only');
});

test('AE-08: a switch on the tool name is resolved when the list and the dispatch are in different files', async () => {
  const low = (await read('ts-lowlevel')).fx.tools;
  assert.deepEqual(kinds(low.touch_item, 'write'), ['fs.writeFileSync']);
  assert.deepEqual(kinds(low.delete_item, 'delete'), ['fs.rmSync']);
  assert.deepEqual(kinds(low.get_item, 'write').concat(kinds(low.get_item, 'delete')), [], 'the next case is not part of this one');
  assert.equal(low.count_items.effects.read[0].sink, 'fs.readdirSync');
  const fall = snippet({ 'index.ts': "import fs from 'node:fs';\nswitch (name) {\n  case 'a':\n  case 't':\n    fs.rmSync('x');\n    break;\n  case 'b':\n    fs.writeFileSync('y', 'z');\n}\n" }, 't');
  assert.deepEqual(kinds(fall, 'delete'), ['fs.rmSync']); assert.deepEqual(kinds(fall, 'write'), [], 'a fall-through group, up to the next case');
});

test('AE-09: comments and the text of strings are not code', () => {
  const t = snippet(TS("// fs.unlinkSync('x');\n/* execSync('rm -rf /') */\nconst s = \"fs.rmSync('y')\";\nreturn s + `fs.writeFileSync('z', '')`;"), 't');
  ['write', 'delete', 'exec'].forEach((k) => assert.deepEqual(t.effects[k], [], k));
  const p = snippet(PY('# os.remove("x")\ns = "shutil.rmtree(y)"\nreturn s'), 't');
  ['write', 'delete', 'exec'].forEach((k) => assert.deepEqual(p.effects[k], [], k));
  const d = snippet(PY('"""Delete from the list: os.remove(x)."""\nreturn 1'), 't');
  assert.deepEqual(d.effects.delete, []);
});

test('AE-10: a temporary path is a may; a read-only command is a read; any other process is an exec', async () => {
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

test('AE-11: calls are followed to a set depth, and recursion ends', async () => {
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

test('AE-11b: a call the repository resolves is followed, not guessed from its name, and a function runs once', () => {
  const files = { 'service.ts': "export function create() { return 1; }\n", 'index.ts': "import * as service from './service.js';\nserver.registerTool('t', {}, async () => { service.create(); service.create(); service.create(); });\n" };
  const t = snippet(files, 't');
  assert.deepEqual(t.effects.write.concat(t.effects.delete, t.effects.unknown_call), [], 'service.create() is the repository\'s own function, which writes nothing');
  const out = Fx.analyse(new Map(Object.entries(files)), [{ path: 'index.ts', line: 2, tool: { name: 't' } }]);
  assert.ok(out.summary.calls_scanned <= 5, 'the helper is read once, not three times: ' + out.summary.calls_scanned);
  const opaque = snippet({ 'index.ts': "import * as service from 'some-package';\nserver.registerTool('t', {}, async () => { service.create(); });\n" }, 't');
  assert.equal(opaque.effects.write[0].confidence, 'may', 'the same call on a package is opaque');
});

test('AE-12: the feature is off unless asked for, and then sits in its own block that never changes a grade or the exit code', () => {
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

test('AE-13: severity is capped: nothing blocks, and only a definite sink is attention', async () => {
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

test('AE-14: nothing is run and nothing outside the files given is read', () => {
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

test('AE-15: every sink family has a mutation check: switching the family off removes the effect', () => {
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

test('AE-16: the first score on the labelled servers: nothing the check calls attention is wrong, and the misses are the known limits', async () => {
  const res = await score();
  const w = res.summary['annot-code-writes-marked-readonly'];
  assert.equal(w.code_lenient.fp, 0, 'no false attention on the labelled tools');
  assert.ok(w.code_lenient.tp >= 25 && w.code_lenient.recall.p >= 0.75, 'recall ' + JSON.stringify(w.code_lenient.recall));
  assert.ok(w.name_based.tp < w.code_lenient.tp, 'the code check sees more than the name-based one on these tools');
  assert.equal(res.summary['annot-code-deletes-marked-safe'].code_lenient.fp, 0);
  const missed = res.rows.filter((r) => r.checks['annot-code-writes-marked-readonly'].positive && !r.checks['annot-code-writes-marked-readonly'].attention).map((r) => r.key).sort();
  assert.deepEqual(missed, ['py-fastmcp/bill_user', 'py-sinks/deep_write', 'py-sinks/sdk_may', 'py-sinks/table_dispatch', 'ts-mixed/export_report', 'ts-sinks/deep_write', 'ts-sinks/table_dispatch'], 'opaque clients (advice only), depth, and a table of functions');
  assert.deepEqual(res.summary.not_analysed, []);
});
