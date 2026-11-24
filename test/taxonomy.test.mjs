// docs/taxonomy/owasp-mcp.json maps every check to the OWASP MCP Security Testing Guide tests and the OWASP MCP Top 10
// items it touches, against lists pinned by commit. These tests keep the mapping in step with the catalogue and the
// pinned lists, and docs/TAXONOMY.md in step with the mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MAP_PATH, DOC_PATH, validate, render } from '../scripts/gen-taxonomy.mjs';

const ids = createRequire(import.meta.url)('../engine/core.js').CHECKS.map((c) => c.id);
const load = () => JSON.parse(readFileSync(MAP_PATH, 'utf8'));

test('the committed mapping is sound against the catalogue and the pinned lists', () => {
  assert.deepEqual(validate(load(), ids), []);
});

test('R-TX-01: a check with no mapping entry, even an explicit none, fails', () => {
  const map = load();
  assert.ok(ids.length > 50);
  for (const id of [ids[0], ids[ids.length - 1], 'sec-shell-url']) {
    const m = load();
    delete m.checks[id];
    assert.ok(validate(m, ids).some((p) => p.includes(id) && /no mapping entry/.test(p)), id);
  }
  // an explicit "none" is accepted
  assert.deepEqual(validate({ ...map, checks: { ...map.checks, 'spec-name-length': { mstg: [], top10: [] } } }, ids), []);
});

test('R-TX-01: a mapping entry that names a check that does not exist fails', () => {
  const m = load();
  m.checks['sec-no-such-check'] = { mstg: [], top10: [] };
  assert.ok(validate(m, ids).some((p) => p.includes('sec-no-such-check') && /not a check/.test(p)));
});

test('R-TX-01: a test or item ID that is not in the pinned list fails', () => {
  for (const [list, bad] of [['mstg', 'TOOL-99'], ['mstg', 'MCPSTG-TOOL-01'], ['top10', 'MCP11'], ['top10', 'MCP1']]) {
    const m = load();
    m.checks['sec-shell-url'][list].push({ id: bad, level: 'related' });
    assert.ok(validate(m, ids).some((p) => p.includes(bad) && /not in the pinned/.test(p)), bad);
  }
  const m = load();
  m.other_tools['FAKE-01'] = [{ tool: 'live-probe', level: 'partial' }];
  assert.ok(validate(m, ids).some((p) => p.includes('FAKE-01')));
  const n = load();
  n.checks['sec-shell-url'].mstg.push({ id: 'TOOL-01', level: 'complete' });
  assert.ok(validate(n, ids).some((p) => /has level complete/.test(p)));
});

test('the pinned lists are the recorded size and the mapping claims no more than it should', () => {
  const m = load();
  assert.equal(m.taxonomies.mstg.tests.length, 81);
  assert.equal(m.taxonomies.mstg.test_count, 81);
  assert.equal(m.taxonomies.top10.items.length, 10);
  assert.match(m.taxonomies.mstg.commit, /^[0-9a-f]{40}$/);
  assert.match(m.taxonomies.top10.commit, /^[0-9a-f]{40}$/);
  assert.equal(m.rubric_version, createRequire(import.meta.url)('../engine/core.js').RUBRIC_VERSION);
  assert.equal(Object.values(m.checks).flatMap((e) => [...e.mstg, ...e.top10]).filter((x) => x.level === 'full').length, 0, 'a static check is never a full test');
});

test('docs/TAXONOMY.md is what the mapping produces', () => {
  assert.equal(readFileSync(DOC_PATH, 'utf8'), render(load()), 'run: node scripts/gen-taxonomy.mjs');
});
