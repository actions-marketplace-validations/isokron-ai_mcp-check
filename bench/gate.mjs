#!/usr/bin/env node
// The release gate: compares a fresh score with the committed baseline (bench/baseline.json).
//
//   node bench/gate.mjs [--baseline bench/baseline.json] [--score score.json]   (without --score it runs the benchmark)
//
// The same rule decides whether the mutant pass (bench/mutate.mjs) has killed a mutant. Fails (exit 1) when:
//   - any case has a disagreement with its truth that the baseline does not have (a new miss or a new false alarm,
//     named by case, check and tool): one case getting worse is never hidden by another getting better;
//   - for any check, overall or in any one language: false negatives rose; true positives fell; recall fell below
//     the baseline's Wilson 95% interval; false positives rose at all for a security check (sec-*), reader-tools or
//     security-cap; for any other check, precision fell below the baseline's interval;
//   - a faulty-oracle case was not caught with the disagreement its truth names, or there are fewer of them;
//   - the number of cases fell, or the case set (every case and truth file) is not the one the baseline was made from;
//   - the score is better than the baseline ("rebaseline: improvements not locked in"), so a gain cannot be lost later
//     without failing.
// Other false-positive rises are warnings. Exit 0 otherwise; 2 on bad usage.
// To accept a change on purpose, rebaseline in the same pull request and explain the diff in it:
//   node bench/run.mjs --rebaseline        (writes bench/baseline.json and bench/SCORE.md)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Checks whose false positives may not rise at all: a false alarm there grades a server F or invents a tool. */
export const STRICT_FP = (check) => check.startsWith('sec-') || check === 'reader-tools' || check === 'security-cap';

const REBASELINE = 'rebaseline: improvements not locked in';

/** Compares two scores; returns { failures: [...], warnings: [...] } as sentences. */
export function compare(base, now) {
  const failures = []; const warnings = [];
  const cells = (s) => {
    const out = new Map();
    for (const [k, v] of Object.entries(s.checks || {})) {
      out.set(k + ' (all languages)', { check: k, c: v.all });
      for (const [l, x] of Object.entries(v.by_language || {})) out.set(k + ' (' + l + ')', { check: k, c: x });
    }
    return out;
  };
  if (base.case_set_hash && now.case_set_hash !== base.case_set_hash) failures.push('the cases or their truth changed since the baseline was made (case-set hash ' + String(now.case_set_hash).slice(0, 12) + ', baseline ' + String(base.case_set_hash).slice(0, 12) + '): rebaseline with node bench/run.mjs --rebaseline and explain the diff');
  if ((now.cases || 0) < (base.cases || 0)) failures.push('cases fell from ' + base.cases + ' to ' + now.cases);
  // per case: every disagreement is named by a stable key (check|fn-or-fp|subject)
  const bk = base.disagreement_keys || {}; const nk = now.disagreement_keys || {};
  for (const id of new Set([...Object.keys(bk), ...Object.keys(nk)])) {
    const was = new Set(bk[id] || []); const is = new Set(nk[id] || []);
    for (const k of is) if (!was.has(k)) failures.push(id + ': new ' + (k.split('|')[1] === 'fp' ? 'false alarm' : 'miss') + ' ' + k);
    for (const k of was) if (!is.has(k)) failures.push(REBASELINE + ': ' + id + ' no longer has ' + k);
  }
  const b = cells(base); const n = cells(now);
  for (const [key, { check, c: was }] of b) {
    const got = n.get(key);
    if (!got) { if (was.tp + was.fn + was.fp > 0) failures.push(key + ': no longer scored (its labels or cases were removed)'); continue; }
    const is = got.c;
    if (is.fn > was.fn) failures.push(key + ': false negatives rose from ' + was.fn + ' to ' + is.fn);
    if (is.tp < was.tp) failures.push(key + ': true positives fell from ' + was.tp + ' to ' + is.tp);
    if (was.recall && is.recall && is.recall.p < was.recall.lo) failures.push(key + ': recall ' + is.recall.p + ' is below the baseline interval [' + was.recall.lo + ', ' + was.recall.hi + ']');
    if (is.fp > was.fp) {
      if (STRICT_FP(check)) failures.push(key + ': false positives rose from ' + was.fp + ' to ' + is.fp);
      else if (was.precision && is.precision && is.precision.p < was.precision.lo) failures.push(key + ': false positives rose from ' + was.fp + ' to ' + is.fp + ', precision ' + is.precision.p + ' below the baseline interval [' + was.precision.lo + ', ' + was.precision.hi + ']');
      else warnings.push(key + ': false positives rose from ' + was.fp + ' to ' + is.fp);
    }
    if (is.fn < was.fn || is.fp < was.fp || is.tp > was.tp) failures.push(REBASELINE + ': ' + key + ' (TP ' + was.tp + '->' + is.tp + ', FP ' + was.fp + '->' + is.fp + ', FN ' + was.fn + '->' + is.fn + ')');
  }
  for (const [key] of n) if (!b.has(key)) warnings.push(key + ': newly scored');
  const bf = new Map((base.faulty_oracle || []).map((f) => [f.id, f]));
  for (const f of now.faulty_oracle || []) if (!f.caught) failures.push('faulty-oracle case ' + f.id + ' was not caught with ' + f.expected_disagreement + ': the scorer agreed with a label known to be wrong');
  if ((now.faulty_oracle || []).length < bf.size) failures.push('faulty-oracle cases went from ' + bf.size + ' to ' + (now.faulty_oracle || []).length);
  return { failures: [...new Set(failures)], warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
  const basePath = opt('--baseline', join(here, 'baseline.json'));
  if (!existsSync(basePath)) { process.stderr.write('gate: no baseline at ' + basePath + '\n'); process.exit(2); }
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  let now;
  if (opt('--score')) now = JSON.parse(readFileSync(opt('--score'), 'utf8'));
  else { const { run } = await import('./run.mjs'); now = (await run({ root: resolve(here, '..'), cases: here })).score; }
  const { failures, warnings } = compare(base, now);
  for (const w of warnings) process.stdout.write('::warning::bench: ' + w + '\n');
  for (const f of failures) process.stdout.write('::error::bench: ' + f + '\n');
  process.stdout.write('bench gate: ' + (failures.length ? failures.length + ' failure(s)' : 'pass') + ', ' + warnings.length + ' warning(s); ' + now.cases + ' cases, ' + Object.keys(now.checks).length + ' scored checks\n');
  process.exit(failures.length ? 1 : 0);
}
