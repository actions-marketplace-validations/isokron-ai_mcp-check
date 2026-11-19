import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkToolsList, explainCheck, compareToolsLists } from '../src/tools.js';

const ex = readFileSync(new URL('./fixtures/example.json', import.meta.url), 'utf8');
const good = readFileSync(new URL('./catalogs/well-designed.json', import.meta.url), 'utf8');

test('check_tools_list: grades, findings with docs URLs, fixes', () => {
  const { report, text } = checkToolsList({ tools_list: ex });
  assert.equal(report.rubric_version, '2.1.0');
  assert.deepEqual(report.sections.map((s) => s.id), ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface']);
  const g = Object.fromEntries(report.sections.map((s) => [s.id, s.grade]));
  assert.equal(g.anthropic, 'C');
  assert.equal(g.openai, 'C');
  assert.ok(report.findings.length > 0);
  for (const f of report.findings) assert.equal(f.docs, 'https://isokron.ai/mcp-check/checks/' + f.id);
  assert.equal(report.findings[0].severity, 'blocking');
  assert.ok(report.findings.some((f) => f.fix_snippet));
  assert.ok(report.suggested_fixes.changes.length > 0);
  assert.equal(report.suggested_fixes.tools_list.tools.length, 8);
  assert.equal(report.tool_hashes.length, 8);
  assert.match(text, /anthropic C/);
});

test('check_tools_list: accepts an object as well as JSON text, same result', () => {
  const a = checkToolsList({ tools_list: ex }).report;
  const b = checkToolsList({ tools_list: JSON.parse(ex) }).report;
  assert.equal(a.input.catalog_hash, b.input.catalog_hash);
});

test('check_tools_list: min_grade, sections, limit, include_fixed_list', () => {
  const r = checkToolsList({ tools_list: ex, min_grade: 'B', sections: ['anthropic', 'security'], limit: 2, include_fixed_list: false }).report;
  assert.deepEqual(r.sections.map((s) => s.id), ['anthropic', 'security']);
  assert.equal(r.passed, false);
  assert.deepEqual(r.below_min_grade, ['anthropic C']);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings_truncated, true);
  assert.equal(r.suggested_fixes.tools_list, null);
  const ok = checkToolsList({ tools_list: good, min_grade: 'A' }).report;
  assert.equal(ok.passed, true);
});

test('explain_check: returns the catalog entry; unknown ids suggest close matches', () => {
  const { report } = explainCheck({ check_id: 'anthropic-title' });
  assert.equal(report.severity, 'blocking');
  assert.ok(report.source_quote.length > 10);
  assert.equal(report.docs, 'https://isokron.ai/mcp-check/checks/anthropic-title');
  assert.throws(() => explainCheck({ check_id: 'anthropic-titel' }), /Close matches: anthropic-title/);
});

test('compare_tools_lists: identical lists, then a high-risk annotation flip', () => {
  assert.equal(compareToolsLists({ before: ex, after: ex }).report.identical, true);
  const flipped = JSON.parse(ex);
  flipped.tools.find((t) => t.name === 'close_issue').annotations.readOnlyHint = true;
  const { report, text } = compareToolsLists({ before: ex, after: flipped });
  assert.equal(report.identical, false);
  assert.deepEqual(report.high_risk, ['close_issue']);
  assert.equal(report.changed[0].changes[0].risk, 'high');
  assert.match(text, /HIGH RISK/);
});
