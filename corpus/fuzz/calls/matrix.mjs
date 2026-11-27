#!/usr/bin/env node
/**
 * The tools/call fuzz stage over every fixture, as a T0 worker (tool-qa lane t0-fuzz): run, compare with what each
 * fixture is known to break, and write the result bundle (worker-kit meta file and a report).
 *
 *   node corpus/fuzz/calls/matrix.mjs --out <dir> [--only id,id]      env: TINY_TRACKER_DIR, GITHUB_SHA, GITHUB_REPOSITORY
 *
 * Every fixture has a known answer (fixtures.json `expect`): the invariants it is known to break. So a known fault the
 * stage does not find, or a finding on a build that expects none, is a defect of OUR stage (or of our fixture), never of a
 * third-party server: no third-party server is ever run. The bundle carries two controls and tool-qa's ingest rejects it as
 * control_failed when either did not hold:
 *   known_good  expected no_extra   no fixture shows a finding it does not expect (no false positive)
 *   known_bad   expected all_found  every invariant a fixture is known to break was found (no miss)
 * A fixture that could not run is `incomplete`, never counted as passing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INVARIANTS } from './invariants.mjs';
import { fixtureIds, getFixture } from './fixtures.mjs';
import { fuzzFixture } from './run.mjs';

export const SUBJECT_ID = 'isokron-ai/mcp-check.fuzz-calls';

/** What one fixture's run says against its known answer. */
export function verdict(fixture, result) {
  const expect = [...fixture.expect].sort();
  if (result.status !== 'ran') return { id: fixture.id, status: 'incomplete', reason: result.reason ?? 'not_run', expect, found: [], missed: [], unexpected: [] };
  const found = [...result.found].sort();
  const missed = expect.filter((x) => !found.includes(x));
  const unexpected = found.filter((x) => !expect.includes(x));
  return { id: fixture.id, status: 'done', expect, found, missed, unexpected, calls: result.calls, tools: result.tools, restarts: result.restarts, inconclusive: result.inconclusive.length };
}

export async function runMatrix({ ids = fixtureIds(), tinyDir, requestMs } = {}) {
  const out = [];
  for (const id of ids) {
    const f = getFixture(id);
    const result = await fuzzFixture(id, { tinyDir, requestMs });
    out.push({ ...verdict(f, result), findings: result.findings.slice(0, 40).map(({ id: inv, kind, tool, case: c }) => ({ id: inv, kind, tool, case: c })) });
  }
  return out;
}

/** The two controls from the verdicts. */
export function controls(verdicts) {
  const incomplete = verdicts.some((v) => v.status === 'incomplete');
  const good = incomplete ? 'incomplete' : verdicts.every((v) => v.unexpected.length === 0) ? 'no_extra' : 'extra';
  const bad = incomplete ? 'incomplete' : verdicts.every((v) => v.missed.length === 0) ? 'all_found' : 'missed';
  return [{ kind: 'known_good', expected: 'no_extra', observed: good }, { kind: 'known_bad', expected: 'all_found', observed: bad }];
}

export function build({ verdicts, env = process.env, now = new Date() }) {
  const sha = /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null;
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : 'isokron-ai/mcp-check';
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    report: {
      lane: 't0-fuzz', invariants: INVARIANTS, fixtures: verdicts,
      missed: verdicts.filter((v) => v.missed.length || v.status === 'incomplete').map((v) => ({ id: v.id, missed: v.missed, reason: v.reason })),
      unexpected: verdicts.filter((v) => v.unexpected.length).map((v) => ({ id: v.id, unexpected: v.unexpected })),
    },
    meta: {
      subject: { id: SUBJECT_ID, repo, sha },
      tools: [{ name: repo.split('/')[1], version: sha ?? 'unknown' }],
      oracles: [],
      settings_manifest_digest: createHash('sha256').update(JSON.stringify(verdicts.map((v) => [v.id, v.expect]))).digest('hex'),
      started_at: at, finished_at: at, skips: [],
      controls: controls(verdicts),
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg('--out');
  if (!out) { process.stderr.write('usage: matrix.mjs --out <dir> [--only id,id]\n'); process.exit(2); }
  const only = arg('--only');
  const verdicts = await runMatrix({ ids: only ? only.split(',') : undefined, tinyDir: process.env.TINY_TRACKER_DIR });
  const { report, meta } = build({ verdicts });
  mkdirSync(join(out, 'bundle', 'results'), { recursive: true });
  writeFileSync(join(out, 'bundle', 'results', 'fuzz-calls.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${verdicts.length} fixtures: ${meta.controls.map((c) => `${c.kind} ${c.observed}`).join(', ')}\n`);
  for (const v of verdicts) process.stdout.write(`  ${v.id}: ${v.status}${v.missed.length ? ` MISSED ${v.missed.join(',')}` : ''}${v.unexpected.length ? ` UNEXPECTED ${v.unexpected.join(',')}` : ''}\n`);
}
