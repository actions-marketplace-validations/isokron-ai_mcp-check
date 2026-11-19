import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('vendor: engine files match the SHA-256 recorded in engine/VENDORED.json', () => {
  const m = json('../engine/VENDORED.json');
  for (const f of m.files) {
    const h = createHash('sha256').update(readFileSync(new URL('../engine/' + f.path, import.meta.url))).digest('hex');
    assert.equal(h, f.sha256, f.path + ' drifted from VENDORED.json; re-run npm run vendor');
  }
  assert.match(readFileSync(new URL('../engine/core.js', import.meta.url), 'utf8'), new RegExp("RUBRIC_VERSION = '" + m.rubric_version.replace(/\./g, '\\.') + "'"));
});

test('release metadata: one version across package.json, package-lock.json, server.json and CHANGELOG.md', () => {
  const pkg = json('../package.json');
  const lock = json('../package-lock.json');
  const srv = json('../server.json');
  assert.equal(pkg.name, '@isokron/mcp-check');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.mcpName, srv.name);
  assert.equal(srv.name, 'io.github.isokron-ai/mcp-check');
  assert.equal(srv.version, pkg.version);
  assert.equal(srv.packages.length, 1);
  const p = srv.packages[0];
  assert.equal(p.registryType, 'npm');
  assert.equal(p.identifier, pkg.name);
  assert.equal(p.version, pkg.version);
  assert.deepEqual(p.transport, { type: 'stdio' });
  assert.deepEqual(p.packageArguments, [{ type: 'positional', value: 'serve' }], 'clients start the server with: npx @isokron/mcp-check serve');
  assert.ok(srv.description.length <= 100, 'the registry caps description at 100 characters');
  assert.ok(pkg.files.includes('server.json'));
  assert.deepEqual(pkg.publishConfig, { access: 'public' }, 'provenance comes from trusted publishing in release.yml; a provenance key here would break a publish from a laptop');
  assert.equal(pkg.repository.url, 'git+https://github.com/isokron-ai/mcp-check.git');
  assert.equal(pkg.bugs.url, 'https://github.com/isokron-ai/mcp-check/issues');
  assert.equal(srv.repository.url, 'https://github.com/isokron-ai/mcp-check');
  assert.equal(pkg.license, 'MIT');
  assert.ok(!pkg.private);
  for (const f of ['test/', 'corpus/', 'scripts/', '.github/', 'docs/', 'PUBLISH-CHECKLIST.md']) assert.ok(!pkg.files.some((x) => x.startsWith(f)), f + ' is not published');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, new RegExp('^## ' + pkg.version.replace(/\./g, '\\.') + ' ', 'm'), 'CHANGELOG.md has a section for ' + pkg.version);
});
