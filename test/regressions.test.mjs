// REGRESSIONS.md is the ledger of every problem found in the loop worker and the tests that pin it. This keeps the
// ledger and the suite in step: every test a row names must exist (in that file, under that exact name), and every
// test named after a row (R-SS-NN: ...) must be listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Rows of the ledger table: { id, tests: [{ file, name }], fix }. */
export function parseLedger(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\| R-[A-Z]+-\d+ \|/.test(line)) continue;
    const cells = line.split(' | ');
    const tests = [...(cells[2] || '').matchAll(/`([^`]+\.test\.c?m?js)` › `([^`]+)`/g)].map((m) => ({ file: m[1], name: m[2] }));
    rows.push({ id: cells[0].slice(2).trim(), tests, fix: (cells[3] || '').replace(/\|\s*$/, '').trim() });
  }
  return rows;
}

/** Titles of the test('...') calls in a test file's source. */
export function testNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\btest\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) names.add(m[2].replace(/\\(.)/g, '$1'));
  return names;
}

const ledger = () => parseLedger(readFileSync(join(root, 'REGRESSIONS.md'), 'utf8'));
const testFiles = () => readdirSync(join(root, 'test')).filter((f) => /\.test\.(c|m)?js$/.test(f)).map((f) => 'test/' + f);

test('every test the ledger names exists, under that name, in that file', () => {
  const rows = ledger();
  assert.ok(rows.length > 0);
  const seen = new Set();
  for (const row of rows) {
    assert.ok(!seen.has(row.id), row.id + ' is listed twice');
    seen.add(row.id);
    assert.ok(row.tests.length > 0, row.id + ' names no test');
    assert.match(row.fix, /\b[0-9a-f]{7,40}\b/, row.id + ' names no fix commit');
    for (const t of row.tests) {
      let src;
      try { src = readFileSync(join(root, t.file), 'utf8'); } catch { assert.fail(row.id + ': ' + t.file + ' does not exist'); }
      assert.ok(testNames(src).has(t.name), row.id + ': ' + t.file + ' has no test named "' + t.name + '"');
    }
  }
});

test('every test named after a ledger row is listed in that row', () => {
  const rows = ledger();
  const listed = new Set(rows.flatMap((r) => r.tests.map((t) => t.file + '\u0000' + t.name)));
  const ids = new Set(rows.map((r) => r.id));
  for (const file of testFiles()) {
    for (const name of testNames(readFileSync(join(root, file), 'utf8'))) {
      const m = /^(R-[A-Z]+-\d+):/.exec(name);
      if (!m) continue;
      assert.ok(ids.has(m[1]), file + ': "' + name + '" names ' + m[1] + ', which has no row in REGRESSIONS.md');
      assert.ok(listed.has(file + '\u0000' + name), file + ': "' + name + '" is not listed in REGRESSIONS.md');
    }
  }
});

test('the ledger check catches a missing test', () => {
  const rows = parseLedger('| R-SS-99 | x | `test/regressions.test.mjs` › `R-SS-99: no such test` | abcdef1 |\n');
  assert.deepEqual(rows, [{ id: 'R-SS-99', tests: [{ file: 'test/regressions.test.mjs', name: 'R-SS-99: no such test' }], fix: 'abcdef1' }]);
  assert.equal(testNames(readFileSync(fileURLToPath(import.meta.url), 'utf8')).has('R-SS-99: no such test'), false);
  assert.ok(testNames("test('it\\'s escaped', () => {})").has("it's escaped"));
});
