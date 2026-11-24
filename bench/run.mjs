#!/usr/bin/env node
// Runs the benchmark: reads every case with an mcp-check build, scores what it said against the ground truth,
// and writes the score as JSON and Markdown.
//
//   node bench/run.mjs                                   this checkout, the public cases; prints the Markdown
//   node bench/run.mjs --root <mcp-check folder>         another build (a release candidate, a mutant copy)
//   node bench/run.mjs --cases <folder>                  another case set with cases/ and truth/ (the private holdout)
//   --json <file>  --md <file>  --observations <file>    where to write the score, the tables, the raw observations
//   --observe-only                                       write the observations and stop (the mutant runner uses this)
//   --tmp <folder>                                       where the saved lists go while it runs (removed at the end)
//   --rebaseline                                         write bench/baseline.json and bench/SCORE.md from this run:
//                                                        the only way to accept a change in the score (bench/README.md)
//
// Exit 0 when it ran (the gate is bench/gate.mjs), 2 on bad usage, 1 when a faulty-oracle case was not caught:
// a scorer that agrees with a label known to be wrong is broken, whatever the rest says.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseSetHash, loadCases } from './lib/cases.mjs';
import { observeAll } from './lib/observe.mjs';
import { escapeInvisible, scoreAll, scoreMarkdown } from './lib/score.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { root: resolve(here, '..'), cases: here, json: null, md: null, observations: null, observeOnly: false, title: null, tmp: null, rebaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => { const x = argv[++i]; if (!x) throw new Error(a + ' needs a value'); return x; };
    if (a === '--root') o.root = resolve(v());
    else if (a === '--cases') o.cases = resolve(v());
    else if (a === '--json') o.json = v();
    else if (a === '--md') o.md = v();
    else if (a === '--observations') o.observations = v();
    else if (a === '--observe-only') o.observeOnly = true;
    else if (a === '--title') o.title = v();
    else if (a === '--tmp') o.tmp = resolve(v());
    else if (a === '--rebaseline') o.rebaseline = true;
    else throw new Error('unknown argument ' + a);
  }
  return o;
}

export async function run(o) {
  const cases = loadCases(o.cases);
  const obs = await observeAll(o.root, cases, { tmp: o.tmp });
  if (o.observations) writeFileSync(o.observations, JSON.stringify(obs, null, 1) + '\n');
  if (o.observeOnly) return { obs };
  const score = { case_set_hash: caseSetHash(o.cases), ...scoreAll(cases, obs) };
  return { obs, score };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write('bench: ' + e.message + '\n'); process.exit(2); }
  const { score } = await run(o);
  if (score) {
    if (o.rebaseline) { if (o.cases !== here) { process.stderr.write('bench: --rebaseline is for the public cases; the holdout has run-holdout.sh --update-baseline\n'); process.exit(2); } o.json = join(here, 'baseline.json'); o.md = join(here, 'SCORE.md'); }
    const md = scoreMarkdown(score, { title: o.title || 'mcp-check benchmark score' });
    if (o.json) writeFileSync(o.json, escapeInvisible(JSON.stringify(score, null, 1)) + '\n');
    if (o.md) writeFileSync(o.md, md); else if (!o.json) process.stdout.write(md);
    const missed = score.faulty_oracle.filter((f) => !f.caught);
    if (missed.length) { process.stderr.write('bench: faulty-oracle cases not caught (the scorer echoed a wrong label): ' + missed.map((f) => f.id).join(', ') + '\n'); process.exit(1); }
  }
  // the CLI's main() may leave handles open (none expected for --repo-dir); do not wait on them
  process.exit(0);
}
