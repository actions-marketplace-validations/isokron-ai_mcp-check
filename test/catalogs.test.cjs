// The example and ten hand-written catalogs shaped like real servers. Each test pins the grades and the findings
// that matter, and asserts the absence of the false positives the catalog was written to catch.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../engine/core.js');

const load = (f) => {
  const r = M.check(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  assert.ok(!r.error, r.error);
  return r;
};
const grades = (r) => Object.fromEntries(['spec', 'anthropic', 'openai', 'security', 'quality'].map((k) => [k, r.sections[k].grade]));
// The write surface has no letter (rubric 2.2.0): state and guard coverage only.
const cover = (r) => { const s = r.sections.surface; assert.equal(s.grade, null); assert.equal(s.score, null); return s.state + ': ' + s.parts.filter((p) => p.of).map((p) => p.short + ' ' + p.have + '/' + p.of).join(', '); };
const ids = (r, tool) => M.allFindings(r).filter((f) => tool === undefined || f.tool === tool).map((f) => f.id);
const has = (r, tool, id, sev) => M.allFindings(r).some((f) => f.tool === tool && f.id === id && (!sev || f.severity === sev));

test('example: the v1 A-hint false positive is gone and grades follow rubric 2', () => {
  const r = load('fixtures/example.json');
  assert.deepEqual(grades(r), { spec: 'A', anthropic: 'C', openai: 'C', security: 'A', quality: 'B' });
  assert.equal(cover(r), 'coverage: retry keys 0/1, preconditions 1/3, delete guards 0/1');
  assert.equal(r.sections.anthropic.score, 71);
  assert.equal(r.sections.openai.score, 74);
  assert.ok(!has(r, 'create_issue', 'anthropic-hint-platforms-differ'), 'a create purely adds (rubric 2.2.0)');
  assert.ok(!ids(r, 'create_issue').includes('anthropic-hint'));
  assert.ok(has(r, 'delete_issue', 'annot-delete-marked-safe', 'blocking'));
  assert.ok(has(r, 'add_comment', 'annot-write-marked-readonly', 'attention'));
  assert.ok(has(r, 'api_request', 'anthropic-read-write-split', 'blocking'));
  assert.ok(has(r, 'api_request', 'anthropic-api-docs', 'blocking'));
  assert.ok(has(r, 'update_issue', 'anthropic-title', 'blocking'));
  assert.equal(r.sections.anthropic.ready, false);
  assert.equal(r.sections.anthropic.blockedTools, 3);
  assert.equal(r.mws.length, 8);
  assert.equal(r.mws.filter((m) => m.verdict === 'violated').map((m) => m.tool).join(), 'update_issue');
});

test('well-designed notes server: A in every section, ready for both directories', () => {
  const r = load('catalogs/well-designed.json');
  assert.deepEqual(grades(r), { spec: 'A', anthropic: 'A', openai: 'A', security: 'A', quality: 'A' });
  assert.equal(cover(r), 'coverage: retry keys 1/1, preconditions 2/2, delete guards 1/1');
  assert.equal(r.sections.anthropic.ready, true);
  assert.equal(r.sections.openai.ready, true);
  assert.deepEqual(ids(r), []);
});

test('GitHub-shaped server: hints missing on writes, delete_file has no version, field-patch update is not full-replace', () => {
  const r = load('catalogs/github-like.json');
  assert.equal(r.input.envelope, 'jsonrpc');
  assert.equal(r.sections.anthropic.ready, false);
  assert.equal(M.allFindings(r).filter((f) => f.id === 'anthropic-hint').length, 5);
  assert.equal(M.allFindings(r).filter((f) => f.id === 'openai-hints-explicit').length, 10);
  assert.ok(has(r, 'delete_file', 'surface-version-guard'));
  assert.ok(!has(r, 'merge_pull_request', 'surface-version-guard'));
  assert.ok(!has(r, 'update_issue', 'surface-full-replace'));
  assert.ok(!ids(r).includes('anthropic-title'), 'annotations.title counts as a title');
  assert.ok(has(r, null, 'spec-envelope-result-type', 'advice'));
  assert.equal(r.sections.spec.grade, 'A');
});

test('filesystem server: path arguments are not API endpoints, and dryRun counts as a guard', () => {
  const r = load('catalogs/filesystem.json');
  assert.ok(!ids(r).includes('anthropic-api-docs'));
  assert.ok(!ids(r).includes('design-namespace'), 'plural file/files counts as one namespace word');
  assert.ok(!ids(r).includes('openai-retry'));
  assert.deepEqual([grades(r).anthropic, grades(r).openai, grades(r).security], ['A', 'A', 'A']);
  assert.equal(r.sections.surface.rows.find((x) => x.name === 'write_file').kind, 'update');
});

test('Postgres-shaped server: a SQL tool must name the database', () => {
  const r = load('catalogs/postgres.json');
  assert.equal(r.input.envelope, 'array');
  assert.ok(has(r, 'query', 'anthropic-api-docs', 'blocking'));
  assert.equal(r.sections.anthropic.grade, 'B');
  assert.equal(r.sections.surface.grade, null);
});

test('chat workspace: a summarize tool that asks for the conversation is blocked on both platforms', () => {
  const r = load('catalogs/chat-workspace.json');
  assert.ok(has(r, 'slack_summarize_for_user', 'anthropic-conversation-data', 'blocking'));
  assert.ok(has(r, 'slack_summarize_for_user', 'openai-conversation-input', 'blocking'));
  assert.ok(!has(r, 'slack_get_channel_history', 'openai-conversation-input'), 'channel history by id is task data');
  assert.ok(!has(r, 'slack_reply_to_thread', 'design-handle-lifetime'));
  assert.ok(!has(r, 'slack_post_message', 'openai-retry'), 'saying a retry posts a duplicate satisfies the rule');
  assert.ok(has(r, 'slack_post_message', 'surface-retry-key'));
});

test('payments: money transfer flagged, card data blocked, idempotency key recognised', () => {
  const r = load('catalogs/payments.json');
  assert.ok(has(r, 'payments_transfer_funds', 'anthropic-unsupported-use', 'attention'));
  assert.ok(has(r, 'payments_update_card', 'openai-restricted-input', 'blocking'));
  assert.ok(has(r, 'payments_update_card', 'surface-full-replace'));
  assert.ok(!has(r, 'payments_create_customer', 'surface-retry-key'));
  assert.ok(has(r, 'payments_create_refund', 'surface-retry-key'));
  assert.equal(r.sections.openai.ready, false);
  assert.equal(r.sections.anthropic.ready, true, 'unsupported-use is attention, so it is a person\'s call');
});

test('poisoned server: every hidden-instruction technique is found and both directories get F', () => {
  const r = load('catalogs/poisoned.json');
  for (const id of ['sec-invisible-encoding', 'sec-instruction-markup', 'sec-instruction-phrases', 'sec-cross-tool-steering', 'sec-encoded-blob', 'sec-homoglyph', 'sec-html-comment', 'sec-external-instructions', 'sec-bidi-controls']) assert.ok(ids(r).includes(id), id);
  assert.deepEqual([r.sections.security.grade, r.sections.anthropic.grade, r.sections.openai.grade], ['F', 'F', 'F']);
  assert.ok(r.sections.anthropic.caps.some((c) => /hidden or injected/.test(c)));
  const tag = M.allFindings(r).find((f) => f.id === 'sec-invisible-encoding');
  assert.match(tag.message, /send_report/);
  const blob = M.allFindings(r).find((f) => f.id === 'sec-encoded-blob' && f.severity === 'blocking');
  assert.match(blob.message, /Ignore previous instructions/);
  const comment = M.allFindings(r).find((f) => f.id === 'sec-html-comment');
  assert.match(comment.message, /inputSchema\.properties\.path\.description/);
});

test('2026-07-28 server: valid x-mcp-header passes, number header blocks, envelope fields recognised', () => {
  const r = load('catalogs/modern-2026.json');
  assert.equal(r.input.era, '2026-07-28');
  assert.ok(!has(r, 'spanner.execute_sql', 'spec-x-mcp-header'));
  assert.ok(has(r, 'spanner.estimate_cost', 'spec-x-mcp-header', 'blocking'));
  assert.ok(has(r, 'spanner.estimate_cost', 'spec-icon-scheme'));
  assert.ok(has(r, 'spanner.estimate_cost', 'spec-meta-reserved', 'advice'));
  assert.ok(!ids(r).includes('spec-envelope-result-type') && !ids(r).includes('spec-envelope-cache'));
  assert.equal(r.sections.spec.grade, 'C');
  assert.ok(r.sections.spec.caps.some((c) => /MUST/.test(c)));
  assert.ok(!has(r, 'spanner.execute_sql', 'annot-write-marked-readonly'), 'executing a read-only query is not a write');
  assert.ok(!has(r, 'spanner.execute_sql', 'anthropic-api-docs'), 'Spanner is named');
  assert.ok(!has(r, 'spanner.update_row', 'surface-full-replace'), 'a columns object is a patch');
});

test('maps server: coordinates block when the text points at the user ("what is nearby"); others and addresses ask for attention', () => {
  const r = load('catalogs/maps.json');
  assert.ok(has(r, 'maps_reverse_geocode', 'openai-precise-location', 'attention'));
  assert.ok(has(r, 'maps_search_places', 'openai-precise-location', 'blocking'));
  assert.ok(has(r, 'maps_geocode', 'openai-precise-location', 'attention'));
  assert.ok(!has(r, 'maps_directions', 'openai-precise-location'));
  assert.equal(r.sections.anthropic.grade, 'A');
  assert.equal(r.sections.surface.grade, null);
});

test('legacy executor, two pages: pages merged, executor blocked, 2025 fields noted, old envelope only advice', () => {
  const r = load('catalogs/executor-legacy.json');
  assert.equal(r.input.envelope, 'pages');
  assert.equal(r.input.pages, 2);
  assert.equal(r.input.tools, 4);
  assert.equal(r.input.era, '2025-11-25 or earlier');
  assert.ok(has(r, 'execute_operation', 'openai-generic-executor', 'blocking'));
  assert.ok(has(r, 'execute_operation', 'spec-execution-legacy', 'advice'));
  assert.ok(has(r, 'op_17', 'openai-name-opaque'));
  assert.ok(!ids(r).includes('spec-pagination-partial'), 'the last page has no nextCursor');
  assert.ok(r.server.filter((f) => f.id.startsWith('spec-envelope')).every((f) => f.severity === 'advice'));
});
