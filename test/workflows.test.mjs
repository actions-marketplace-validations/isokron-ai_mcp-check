import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const wf = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('workflows: every third-party action pinned by full SHA; read-only default token; no pull_request_target', () => {
  assert.deepEqual(Object.keys(wf).sort(), ['ci.yml', 'corpus.yml', 'release.yml', 'scan-static.yml']);
  for (const [f, y] of Object.entries(wf)) {
    for (const m of y.replace(/^\s*#.*$/gm, '').matchAll(/uses:\s*(\S+)/g)) if (m[1] !== './') assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, f + ': ' + m[1]);
    // The loop worker grants nothing at the top; each of its jobs asks for contents: read.
    if (f === 'scan-static.yml') assert.match(y, /\npermissions: \{\}\n/, f + ': top-level permissions are {}');
    else assert.match(y, /\npermissions:\n  contents: read\n/, f + ': top-level permissions are contents: read');
    assert.ok(!/pull_request_target|workflow_run/.test(y.replace(/^#.*$/gm, '')), f);
    for (const m of y.matchAll(/persist-credentials:\s*(\S+)/g)) assert.equal(m[1], 'false', f);
  }
});

test('release: tag-triggered, npm publish only from the npm environment with OIDC and provenance; registry in its own job', () => {
  const y = wf['release.yml'];
  assert.match(y, /on:\n  push:\n    tags: \["v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\]/);
  assert.match(y, /npm install -g npm@11\.21\.3 /, 'npm pinned exactly');
  assert.match(y, /git merge-base --is-ancestor "\$SHA" origin\/main/, 'the tagged commit must be on main');
  assert.match(y, /fetch-depth: 0/);
  const jobs = y.split(/\n  (?=[a-z-]+:\n    )/);
  const job = (n) => jobs.find((j) => j.startsWith(n + ':'));
  assert.match(job('publish'), /environment:\n      name: npm/);
  assert.match(job('publish'), /id-token: write/);
  assert.match(job('publish'), /npm publish --provenance --access public/);
  assert.ok(!/npm (ci|install)(?! -g npm@)/.test(job('publish')), 'nothing but npm itself is installed in the publish job');
  assert.match(job('publish'), /--ignore-scripts/);
  assert.match(job('publish'), /package-manager-cache: false/);
  assert.ok(!/environment:/.test(job('registry')), 'the registry job runs without the npm environment');
  assert.match(job('registry'), /mcp-publisher login github-oidc/);
  assert.match(job('registry'), /sha256sum -c/);
  assert.ok(!/id-token/.test(job('check')), 'the test job gets no OIDC token');
  assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./.test(y), 'no stored npm token');
});

test('corpus: manual dispatch only, guarded to this repository and main, one secret in one step, hook required before decrypt', () => {
  const y = wf['corpus.yml'];
  assert.match(y, /\non:\n  workflow_dispatch:/);
  assert.ok(!/\n  (push|schedule|pull_request):/.test(y));
  assert.equal((y.match(/if: github\.repository == 'isokron-ai\/mcp-check' && github\.ref == 'refs\/heads\/main'/g) || []).length, 2);
  assert.equal((y.match(/secrets\./g) || []).length, 1);
  assert.match(y, /CORPUS_TARGETS_KEY: \$\{\{ secrets\.CORPUS_TARGETS_KEY \}\}\n        run: corpus\/decrypt-targets\.sh/);
  assert.ok(y.indexOf('--surface-only') < y.indexOf('Decrypt the target list'), 'the hook check comes before the decrypt step');
  assert.match(y, /environment: corpus/);
  assert.ok(!/tools\/call/.test(readFileSync(fileURLToPath(new URL('../corpus/run-surface-shard.sh', import.meta.url)), 'utf8')));
});

test('ci: the zero-config job runs the Action with no inputs, after a plain checkout, and is required by ci-ok', () => {
  const y = wf['ci.yml'];
  const job = y.slice(y.indexOf('\n  zero-config:\n'), y.indexOf('\n  ci-ok:'));
  assert.match(job, /- name: The zero-config workflow\n        id: zero\n        uses: \.\/\n      - name:/, 'uses: ./ with no with: block');
  assert.ok(!/setup-node|npm (ci|install)/.test(job), 'no setup-node or install, as in the documented workflow');
  assert.match(job, /\[ "\$SOURCE" = repo-static \]/);
  assert.match(y, /needs: \[test, action, zero-config\]/);
  assert.match(y, /\[ "\$n" -eq 3 \]/);
});

test('scan-static: dispatch only, the pump\'s three inputs, kill switch first, inputs checked whole, one pinned worker-kit step per item', () => {
  const y = wf['scan-static.yml'];
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.match(y, /\non:\n  workflow_dispatch:\n    inputs:\n/);
  assert.ok(!/\n  (push|schedule|pull_request|workflow_call):/.test(y));
  assert.deepEqual([...y.matchAll(/^      ([a-z_]+):\n        description:/gm)].map((m) => m[1]), ['shard_id', 'attempt_id', 'items'], 'exactly the inputs tool-qa\'s pump sends');
  assert.match(y, /\nrun-name: shard \$\{\{ inputs\.shard_id \}\}\n/);
  assert.match(y, /\nconcurrency:\n  group: scan-static-/);
  assert.ok(!/secrets\./.test(code), 'no secrets');
  assert.ok(!/github\.event\./.test(code));
  // No input is expanded inside a run: script; they reach steps through env.
  for (const m of code.matchAll(/run: \|?\n?((?:.*\n)*?)(?=      - |\n?$)/g)) assert.ok(!/\$\{\{\s*inputs\./.test(m[1]), 'an input expanded in a run: script');
  const jobs = code.split(/\n  (?=[a-z-]+:\n    )/);
  const job = (n) => jobs.find((j) => j.startsWith(n + ':'));
  for (const n of ['guard', 'scan']) {
    assert.match(job(n), /\n    timeout-minutes: \d+\n/, n);
    assert.match(job(n), /\n    permissions:\n      contents: read\n(?!      )/, n);
  }
  assert.match(job('guard'), /if: github\.repository == 'isokron-ai\/mcp-check' && github\.ref == 'refs\/heads\/main'/);
  const guardSteps = job('guard').split('\n      - ');
  assert.match(guardSteps[1], /^id: enabled\n.*\n        env:\n          LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n        run: \|\n          if \[\[ "\$LOOP_ENABLED" == "true" \]\]; then echo "on=true"/, 'the first step is the LOOP_ENABLED check');
  for (const s of guardSteps.slice(2)) assert.match(s, /if: steps\.enabled\.outputs\.on == 'true'/, 'later guard steps run only when the loop is on');
  assert.match(job('guard'), /LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n(?:.*\n)*?        run: node corpus\/loop-guard\.mjs --lane scan-static/);
  assert.match(job('scan'), /needs: guard\n    if: needs\.guard\.outputs\.proceed == 'true'/);
  const steps = job('scan').split('\n      - ');
  assert.match(steps[1], /^name: Check the inputs\n/, 'the inputs are checked before anything is checked out or read');
  assert.equal((steps[1].match(/\[\[ ! "\$[A-Z_]+" =~ \$[a-z_]+ \]\]/g) || []).length, 3, 'all three inputs, as whole strings');
  // The worker-kit: one step per item index 0..24, all at the same commit as WORKER_KIT_REF.
  const ref = /\n  WORKER_KIT_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  const kit = steps.filter((s) => /uses: isokron-ai\/tool-qa\/worker-kit@/.test(s));
  assert.equal(kit.length, 25);
  kit.forEach((s, i) => {
    assert.match(s, new RegExp('uses: isokron-ai/tool-qa/worker-kit@' + ref + '( #.*)?\\n'), 'item ' + i + ' names WORKER_KIT_REF');
    assert.match(s, new RegExp("steps\\.scan\\.outputs\\.has_" + i + " == 'true'"));
    assert.match(s, new RegExp("item-index: '" + i + "'\\n"));
    assert.match(s, new RegExp('fence: \\$\\{\\{ steps\\.scan\\.outputs\\.fence_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('run-key: \\$\\{\\{ steps\\.scan\\.outputs\\.run_key_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('/scan-static/' + i + '/bundle\\n'));
  });
});
