// R-LP-48..53: a PyPI launch runs the console script its wheel declares, not a guess from the package name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as PE from '../corpus/pypi-entry.mjs';
import * as LP from '../corpus/live-probe.mjs';

// A minimal zip writer: [{ name, data, deflate }].
function zip(entries) {
  const locals = []; const cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const raw = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(raw) : raw; const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(e.csize ?? body.length, 20); ch.writeUInt32LE(e.usize ?? raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(e.offset ?? off, 42);
    locals.push(lh, name, body); cds.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cds); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const EP = (lines) => '[console_scripts]\n' + lines.join('\n') + '\n\n[other]\nnot-a-script = x:y\n';
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) });
function pypiFetch({ pkg = 'widget-mcp', version = '1.0.0', wheel, files, status = 200 } = {}) {
  const url = 'https://files.pythonhosted.org/packages/aa/widget_mcp-1.0.0-py3-none-any.whl';
  const calls = [];
  const f = async (u) => {
    calls.push(String(u));
    if (String(u).startsWith('https://pypi.org/pypi/' + pkg)) return status === 200 ? res(200, { info: { version }, urls: files ?? [{ packagetype: 'bdist_wheel', url, filename: 'widget_mcp-1.0.0-py3-none-any.whl', size: wheel ? wheel.length : 0 }] }) : res(status, {});
    if (String(u) === url) return res(200, wheel);
    throw new Error('unexpected fetch ' + u);
  };
  f.calls = calls; return f;
}

test('R-LP-48: the console script the wheel declares becomes the launch entry', async () => {
  const wheel = zip([{ name: 'widget_mcp/__init__.py', data: '' }, { name: 'widget_mcp-1.0.0.dist-info/entry_points.txt', data: EP(['widget-server = widget_mcp.server:main']), deflate: true }]);
  const e = await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ wheel }) });
  assert.deepEqual(e, { entry: 'widget-server', entry_source: 'console_script', script_count: 1 });
  // Through resolveSubject: the launch carries the entry, so failureDetail no longer treats it as a guess.
  const server = { name: 'io.github.acme/widget', repository: { url: 'https://github.com/acme/widget' }, packages: [{ registryType: 'pypi', identifier: 'widget-mcp', version: '1.0.0', transport: { type: 'stdio' } }] };
  const pf = pypiFetch({ wheel });
  const f = async (u, init) => (new URL(u).hostname === 'registry.modelcontextprotocol.io' ? res(200, { servers: [{ server }] }) : pf(u, init));
  const r = await LP.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget' }, { fetch: f });
  assert.equal(r.status, 'runnable');
  assert.deepEqual(r.launch, { kind: 'pypi', package: 'widget-mcp', version: '1.0.0', entry: 'widget-server' });
  assert.equal(r.choice.entry_source, 'console_script');
});

test('R-LP-49: which script among several: named like the package, the only one, the only "mcp" one, else none', () => {
  assert.equal(PE.pickScript([['other', 'a:b'], ['Widget_MCP', 'a:c']], 'widget-mcp'), 'Widget_MCP');
  assert.equal(PE.pickScript([['serve', 'a:b']], 'widget-mcp'), 'serve');
  assert.equal(PE.pickScript([['widget-cli', 'a:b'], ['widget-mcp-server', 'a:c']], 'widget'), 'widget-mcp-server');
  assert.equal(PE.pickScript([['a-mcp', 'a:b'], ['b-mcp', 'a:c']], 'widget'), null);
  // Several mcp scripts: the one named <package>-mcp (seen in production: financetoolkit).
  assert.equal(PE.pickScript([['financetoolkit-mcp', 'a:b'], ['financetoolkit-mcp-inspector', 'a:c'], ['financetoolkit-mcp-setup', 'a:d']], 'financetoolkit'), 'financetoolkit-mcp');
  // The CSOAI shape: the script uses underscores where the package uses hyphens; the exact declared name wins.
  assert.equal(PE.pickScript([['validator_ai_mcp', 'm:f']], 'validator-ai-mcp'), 'validator_ai_mcp');
  assert.equal(PE.pickScript([], 'widget'), null);
  assert.deepEqual(PE.consoleScripts('[console_scripts]\nok = m:f\nbad name = m:f\n$(x) = m:f\n\n[gui_scripts]\ngui = m:g\n'), [['ok', 'm:f']]);
});

test('R-LP-50: an ambiguous or missing declaration leaves the run on the guess, which stays our limit', async () => {
  const amb = zip([{ name: 'w-1.0.dist-info/entry_points.txt', data: EP(['a-mcp = m:f', 'b-mcp = m:g']) }]);
  assert.deepEqual(await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ wheel: amb }) }), { entry_source: 'ambiguous', script_count: 2 });
  const none = zip([{ name: 'widget_mcp/server.py', data: 'x' }]);
  assert.deepEqual(await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ wheel: none }) }), { entry_source: 'no_entry_point', script_count: 0 });
  assert.deepEqual(await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ files: [{ packagetype: 'sdist', url: 'https://files.pythonhosted.org/x.tar.gz' }] }) }), { entry_source: 'no_wheel' });
  assert.deepEqual(await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ status: 503 }) }), { entry_source: 'lookup_failed' });
  // With no entry the launch stays a guess, which failureDetail never blames on the server (R-LP-39).
});

test('R-LP-51: no console script but a top-level __main__.py runs as python -m <module>', async () => {
  const wheel = zip([{ name: 'widget_mcp/__init__.py', data: '' }, { name: 'widget_mcp/__main__.py', data: 'main()' }, { name: 'tests/__main__.py', data: '' }]);
  assert.deepEqual(await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ wheel }) }), { entry: 'python', args_prefix: ['-m', 'widget_mcp'], entry_source: 'module_main', script_count: 0 });
  assert.equal(PE.pickMainModule(['a/__main__.py', 'b/__main__.py'], 'widget'), null, 'two candidates, neither named like the package');
  assert.equal(PE.pickMainModule(['a/b/__main__.py'], 'widget'), null, 'only top-level modules');
});

test('R-LP-52: a hostile or broken wheel is never trusted and never throws', async () => {
  const fetchW = (wheel) => pypiFetch({ wheel });
  // Not a zip at all.
  assert.equal((await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: fetchW(Buffer.from('not a zip')) })).entry_source, 'wheel_unreadable');
  // A member whose local offset points outside the file.
  const bad = zip([{ name: 'w-1.0.dist-info/entry_points.txt', data: EP(['x = m:f']), offset: 1 << 30 }]);
  assert.equal(PE.zipRead(bad, PE.zipMembers(bad)[0]), null);
  // A deflate bomb: declares a small size, inflates far past the member cap.
  const bomb = zip([{ name: 'w-1.0.dist-info/entry_points.txt', data: '[console_scripts]\n' + 'a'.repeat(4 * 1024 * 1024), deflate: true, usize: 100 }]);
  assert.equal(PE.zipRead(bomb, PE.zipMembers(bomb)[0]), null);
  // Two dist-info entry_points files: not a wheel we trust.
  const two = zip([{ name: 'a-1.dist-info/entry_points.txt', data: EP(['x = m:f']) }, { name: 'b-1.dist-info/entry_points.txt', data: EP(['y = m:f']) }]);
  assert.equal((await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: fetchW(two) })).entry_source, 'wheel_unreadable');
  // A zip64 marker in the end record.
  const z = zip([{ name: 'a', data: 'b' }]); z.writeUInt16LE(0xffff, z.length - 22 + 10);
  assert.equal(PE.zipMembers(z), null);
  assert.equal(PE.zipMembers(Buffer.alloc(10)), null);
});

test('R-LP-53: only wheels on files.pythonhosted.org, under the size cap, are downloaded', async () => {
  const off = await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: pypiFetch({ files: [{ packagetype: 'bdist_wheel', url: 'https://evil.example/w-1.0-py3-none-any.whl', filename: 'w-1.0-py3-none-any.whl', size: 10 }] }) });
  assert.equal(off.entry_source, 'no_wheel');
  const f = pypiFetch({ files: [{ packagetype: 'bdist_wheel', url: 'https://files.pythonhosted.org/big-py3-none-any.whl', filename: 'big-py3-none-any.whl', size: PE.WHEEL_CAP + 1 }] });
  assert.equal((await PE.pypiEntry('widget-mcp', '1.0.0', { fetch: f })).entry_source, 'wheel_unreadable');
  assert.equal(f.calls.length, 1, 'the oversized wheel is never fetched');
  assert.equal(PE.pickWheel([{ packagetype: 'bdist_wheel', url: 'https://files.pythonhosted.org/a-cp313-linux.whl', filename: 'a-cp313-linux.whl', size: 5 }, { packagetype: 'bdist_wheel', url: 'https://files.pythonhosted.org/a-py3-none-any.whl', filename: 'a-py3-none-any.whl', size: 50 }]).filename, 'a-py3-none-any.whl');
  assert.equal(PE.pickWheel([{ packagetype: 'bdist_wheel', url: 'https://files.pythonhosted.org/a-py3-none-any.whl', filename: 'a-py3-none-any.whl', yanked: true }]), null);
});
