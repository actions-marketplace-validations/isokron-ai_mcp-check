#!/usr/bin/env node
// The release gate: compares a fresh score with the committed baseline (bench/baseline.json).
//
//   node bench/gate.mjs [--baseline bench/baseline.json] [--score score.json]   (without --score it runs the benchmark)
//
// Fails (exit 1) when, for any check, overall or in any one language:
//   - its false negatives rose (a planted problem or a real tool that used to be found is now missed), or
//   - its recall fell below the lower end of the baseline's Wilson 95% interval, or
//   - a faulty-oracle case was not caught (the scorer agreed with a label known to be wrong).
// A rise in false positives is reported as a warning. Exit 0 otherwise; 2 on bad usage.
// To accept a change on purpose (a new case the reader misses, a fixed label), regenerate the baseline in the same
// pull request: node bench/run.mjs --json bench/baseline.json. The diff is the record of what was accepted.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Compares two scores; returns { failures: [...], warnings: [...] } as sentences. */
export function compare(base, now) {
  const failures = []; const warnings = [];
  const cells = (s) => {
    const out = new Map();
    for (const [k, v] of Object.entries(s.checks || {})) {
      out.set(k + ' (all languages)', v.all);
      for (const [l, x] of Object.entries(v.by_language || {})) out.set(k + ' (' + l + ')', x);
    }
    return out;
  };
  const b = cells(base); const n = cells(now);
  for (const [key, was] of b) {
    const is = n.get(key);
    if (!is) { if (was.tp + was.fn > 0) warnings.push(key + ': no longer scored (its labels or cases were removed)'); continue; }
    if (is.fn > was.fn) failures.push(key + ': false negatives rose from ' + was.fn + ' to ' + is.fn);
    if (was.recall && is.recall && is.recall.p < was.recall.lo) failures.push(key + ': recall ' + is.recall.p + ' is below the baseline interval [' + was.recall.lo + ', ' + was.recall.hi + ']');
    if (is.fp > was.fp) warnings.push(key + ': false positives rose from ' + was.fp + ' to ' + is.fp);
  }
  for (const f of now.faulty_oracle || []) if (!f.caught) failures.push('faulty-oracle case ' + f.id + ' was not caught: the scorer agreed with a label known to be wrong');
  if ((now.faulty_oracle || []).length < (base.faulty_oracle || []).length) failures.push('faulty-oracle cases went from ' + base.faulty_oracle.length + ' to ' + now.faulty_oracle.length);
  return { failures, warnings };
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
