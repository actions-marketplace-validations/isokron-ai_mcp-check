#!/usr/bin/env node
// The base-branch guard: a pull request cannot accept its own regressions.
//
// The gate (gate.mjs) compares a run with the baseline committed in the same pull request, so a pull request that
// breaks a check and rebaselines passes it. This guard compares the same run with the BASE branch's baseline and kill
// list, and lists what got worse against them:
//   - per-case disagreement keys that are new against the base (new misses and new false alarms; improvements and the
//     case-set hash are not counted), and other losses the gate names (true positives or cases falling, a faulty-oracle
//     case not caught, a check no longer scored);
//   - mutant ids removed from bench/mutants/expected.json (a kill list may only grow);
//   - changes to the gate or to this guard.
// Everything found goes to the job summary. It fails (exit 1) when anything is found, unless the pull request has
// the label bench-rebaseline, which only someone with write access can set: that label is the reviewed acceptance.
// When the base branch has no bench/ yet (the pull request that adds it), there is nothing to compare and it passes.
//
//   node bench/base-guard.mjs --base <base baseline.json, may be empty> --base-expected <file, may be empty>
//                            --score <this run's score.json> [--expected bench/mutants/expected.json]
//                            [--guard-changed "<files>"]
// The labels come from the environment variable PR_LABELS (a JSON array of names); the summary goes to
// $GITHUB_STEP_SUMMARY when it is set.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LABEL = 'bench-rebaseline';

const readJson = (p) => { if (!p || !existsSync(p)) return null; const t = readFileSync(p, 'utf8').trim(); return t ? JSON.parse(t) : null; };

/** What got worse against the base. base: the base baseline (null when the base has no bench/). */
export function guard({ base, now, baseExpected, expected, guardChanged = [] }) {
  if (!base) return { skipped: 'the base branch has no bench/baseline.json: nothing to compare (the pull request that adds the benchmark)', findings: [] };
  const findings = [];
  const bk = base.disagreement_keys || {}; const nk = now.disagreement_keys || {};
  for (const [id, keys] of Object.entries(nk)) {
    const was = new Set(bk[id] || []);
    for (const k of keys) if (!was.has(k)) findings.push(id + ': new ' + (k.split('|')[1] === 'fp' ? 'false alarm' : 'miss') + ' against the base: ' + k);
  }
  // the gate's other losses (the per-case ones are above; improvements and the hash are not regressions)
  for (const f of compare(base, now).failures) {
    if (/^rebaseline: |the cases or their truth changed| new (miss|false alarm) /.test(f)) continue;
    findings.push(f + ' (against the base)');
  }
  const now_ = new Set((expected && expected.killed) || []);
  for (const id of (baseExpected && baseExpected.killed) || []) if (!now_.has(id)) findings.push('removed from the kill list (bench/mutants/expected.json): ' + id);
  for (const f of guardChanged) findings.push('the gate or this guard changed: ' + f);
  return { skipped: null, findings: [...new Set(findings)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  if (!opt('--score')) { process.stderr.write('base-guard: --score is required\n'); process.exit(2); }
  let labels = [];
  try { labels = JSON.parse(process.env.PR_LABELS || '[]'); } catch { labels = []; }
  if (!Array.isArray(labels)) labels = [];
  const r = guard({
    base: readJson(opt('--base')), now: readJson(opt('--score')), baseExpected: readJson(opt('--base-expected')),
    expected: readJson(opt('--expected', join(here, 'mutants', 'expected.json'))),
    guardChanged: String(opt('--guard-changed', '')).split(/\s+/).filter(Boolean),
  });
  const accepted = labels.includes(LABEL);
  const lines = ['## Benchmark against the base branch', ''];
  if (r.skipped) lines.push('Skipped: ' + r.skipped + '.');
  else if (!r.findings.length) lines.push('Nothing got worse against the base branch\'s baseline and kill list.');
  else {
    lines.push(r.findings.length + ' thing(s) got worse against the base branch' + (accepted ? ', accepted by the `' + LABEL + '` label:' : '. Fix them, or have a maintainer review the baseline diff and add the `' + LABEL + '` label:'), '');
    for (const f of r.findings) lines.push('- `' + f.replace(/`/g, "'") + '`');
  }
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (r.findings.length && !accepted) { for (const f of r.findings) process.stdout.write('::error::bench (against base): ' + f + '\n'); process.exit(1); }
  process.exit(0);
}
