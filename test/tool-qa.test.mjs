// test/tool-qa/ holds tool-qa's result contract and ingest checks, copied at the commit WORKER_KIT_REF pins. This
// keeps the copy honest: unedited, and at the same commit as the worker-kit the workflow uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendored = JSON.parse(readFileSync(join(root, 'test', 'tool-qa', 'VENDORED.json'), 'utf8'));

test('the vendored tool-qa files are unedited copies', () => {
  assert.match(vendored.commit, /^[0-9a-f]{40}$/);
  assert.ok(vendored.files.length >= 5);
  for (const f of vendored.files) {
    const sha = createHash('sha256').update(readFileSync(join(root, 'test', 'tool-qa', f.path))).digest('hex');
    assert.equal(sha, f.sha256, f.path + ' differs from the copy recorded in VENDORED.json');
  }
});

test('the vendored copy is at the commit WORKER_KIT_REF pins', () => {
  const y = readFileSync(join(root, '.github', 'workflows', 'scan-static.yml'), 'utf8');
  const ref = /\n  WORKER_KIT_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  assert.equal(vendored.commit, ref);
});

test('the vendored contract has the skip codes and the retryable flag scan-static records', async () => {
  const { SKIP_REASONS, loadSchema } = await import('./tool-qa/worker-kit/contract.mjs');
  for (const r of ['no_runnable_artifact', 'rate_limited', 'upstream_unavailable']) assert.ok(SKIP_REASONS.includes(r), r);
  assert.deepEqual(loadSchema().properties.skips.items.properties.retryable, { type: 'boolean' });
});
