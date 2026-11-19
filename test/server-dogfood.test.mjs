import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownToolsList } from '../scripts/dogfood.mjs';
import { checkToolsList } from '../src/tools.js';

test('dogfood: this server\'s own tools/list grades A in every graded section, with no findings', async () => {
  const list = await ownToolsList();
  assert.deepEqual(list.tools.map((t) => t.name), ['check_tools_list', 'explain_check', 'compare_tools_lists']);
  for (const t of list.tools) {
    assert.ok(t.title);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.ok(t.outputSchema);
    assert.equal(t.inputSchema.$schema, undefined);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  const { report } = checkToolsList({ tools_list: list });
  for (const s of report.sections) {
    if (s.id === 'surface') { assert.equal(s.grade, null, 'no write tools, so the write surface is not graded'); continue; }
    assert.equal(s.grade, 'A', s.id);
    assert.equal(s.score, 100, s.id);
  }
  assert.equal(report.findings.length, 0);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(report.input.catalog_hash), 'README dogfood section is stale: run npm run dogfood and paste the output');
});
