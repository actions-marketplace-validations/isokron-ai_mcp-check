#!/usr/bin/env node
// The mutant pass: does the benchmark notice when mcp-check is broken, and does mcp-check notice when a case changes?
//
// Source mutants: one small change to mcp-check's reader or check code (flip a condition, drop a registration pattern,
// weaken a regular expression, an off-by-one in a number, swap a severity, flip a boolean, some<->every), made in a
// temp copy of the build, never in this checkout. The benchmark cases are read with each mutant, and the mutant's score is
// put through the release gate (bench/gate.mjs) against the unmutated build's score: a mutant is KILLED when the gate
// would fail it (or the build crashes or hangs), and SURVIVES when the gate would pass it. A survivor is a test gap: a
// pull request with that bug would pass CI. The report also counts the mutants that caused a new disagreement with
// the truth in any case; under the gate's per-case rule every such mutant is also a gate kill.
// Mutants are drawn from sites the benchmark's cases execute (V8 block coverage of an unmutated run), with a fixed
// quota per kind and a fixed seed, so the same source gives the same mutants. How many sites lie in code no case runs
// is reported beside the kill rate.
//
// Fixture mutants: a small edit to one case that changes its true answer (bench/mutants/fixture-mutants.json). KILLED
// when mcp-check's output changes and agrees with the edited truth at least as well as with the original.
//
//   node bench/mutate.mjs [--source 170] [--sample N] [--seed s] [--jobs 4] [--no-fixtures] [--only-fixtures]
//                         [--json out.json] [--md out.md] [--write-expected]
// --source N scales the per-kind quotas to about N source mutants. --sample N runs a fixed subset of N of them (the
// same N for the same seed and source), for a quick local check; CI runs the full set, on pull requests that touch
// src/, engine/ or bench/ (the mutants job of ci.yml, required by ci-ok) and weekly (bench-mutants.yml).
// Exit 0 when it ran; 1 when a mutant that the committed list says is killed now survives (bench/mutants/expected.json),
// so the kill rate cannot quietly fall; 2 on bad usage.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from './lib/cases.mjs';
import { compareCase, scoreAll } from './lib/score.mjs';
import { compare as gateCompare } from './gate.mjs';
import { observeAll } from './lib/observe.mjs';
import { CATEGORIES, TARGETS, applyMutant, mutantsOf, seededShuffle } from './mutants/sites.mjs';
import { escapeInvisible, wilson } from './lib/score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** How many source mutants of each kind make up the default set (about 170, plus the fixture mutants: about 210). */
export const QUOTA = { 'flip-condition': 60, 'drop-registration-pattern': 20, 'weaken-regex': 35, 'off-by-one': 25, 'swap-severity': 12, 'flip-boolean': 12, 'swap-some-every': 6 };

function parseArgs(argv) {
  const o = { source: null, sample: null, seed: 'mcp-check-bench-1', jobs: Math.max(1, Math.min(4, cpus().length - 1)), fixtures: true, sourceOn: true, json: null, md: null, timeout: 90, expected: join(here, 'mutants', 'expected.json'), writeExpected: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(a + ' needs a value'); return x; };
    if (a === '--source') o.source = Number(v());
    else if (a === '--sample') o.sample = Number(v());
    else if (a === '--seed') o.seed = v();
    else if (a === '--jobs') o.jobs = Number(v());
    else if (a === '--no-fixtures') o.fixtures = false;
    else if (a === '--only-fixtures') o.sourceOn = false;
    else if (a === '--json') o.json = v();
    else if (a === '--md') o.md = v();
    else if (a === '--timeout') o.timeout = Number(v());
    else if (a === '--write-expected') o.writeExpected = true;
    else throw new Error('unknown argument ' + a);
  }
  return o;
}

/** A copy of the build (the files the CLI loads) with node_modules linked, in a temp folder. */
export function buildCopy(base) {
  const dir = mkdtempSync(join(base, 'build-'));
  for (const d of ['src', 'engine', 'bin']) cpSync(join(repoRoot, d), join(dir, d), { recursive: true });
  cpSync(join(repoRoot, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Disagreements of every trusted case, as a set of "case: text" strings. */
export function disagreementSet(cases, obs) {
  const s = new Set();
  for (const c of cases) {
    if (c.truth.faulty_oracle) continue;
    for (const d of compareCase(c.truth, obs[c.id]).disagreements) s.add(c.id + ': ' + d);
  }
  return s;
}

/** Runs the observer on a build folder in a child process, with a time limit. */
export function observeChild(root, outFile, timeoutS) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['--max-old-space-size=1024', join(here, 'run.mjs'), '--root', root, '--observe-only', '--observations', outFile, '--tmp', dirname(outFile)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); res({ status: 'timeout', err }); }, timeoutS * 1000);
    p.on('close', (code) => { clearTimeout(t); res({ status: code === 0 ? 'ok' : 'crash', code, err }); });
  });
}

/** V8 block coverage of an unmutated observe run: per target file, a function telling whether an offset ran. */
function coverage(base, root) {
  const covDir = join(base, 'coverage');
  mkdirSync(covDir, { recursive: true });
  const r = spawnSync(process.execPath, [join(here, 'run.mjs'), '--root', root, '--observe-only', '--observations', join(base, 'cov-obs.json'), '--tmp', base], { env: { ...process.env, NODE_V8_COVERAGE: covDir }, stdio: 'ignore' });
  if (r.status !== 0) throw new Error('the coverage run failed');
  const ranges = {};
  for (const f of readdirSync(covDir)) {
    const j = JSON.parse(readFileSync(join(covDir, f), 'utf8'));
    for (const s of j.result) {
      const m = TARGETS.find((t) => s.url.endsWith('/' + t));
      if (!m || !s.url.includes(root)) continue;
      (ranges[m] = ranges[m] || []).push(...s.functions.flatMap((fn) => fn.ranges));
    }
  }
  const ran = {};
  for (const t of TARGETS) {
    const rs = (ranges[t] || []).slice().sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    // the innermost range holding an offset decides its count
    ran[t] = (off) => { for (const x of rs) if (x.startOffset <= off && off < x.endOffset) return x.count > 0; return false; };
  }
  return ran;
}

/** Picks the source mutants: covered sites only, a quota per kind, spread over the files. Each candidate is ranked by a
 *  hash of the seed and its id (file, line text, change), so an edit elsewhere in a file does not reshuffle the set:
 *  the same unchanged lines give the same mutants from run to run. */
export function pickSourceMutants(all, ran, { total = null, seed }) {
  const scale = total ? total / Object.values(QUOTA).reduce((a, b) => a + b, 0) : 1;
  const rank = (m) => createHash('sha256').update(seed + '\0' + m.id).digest('hex');
  const picked = [];
  const stats = { sites: all.length, covered: 0, by_file: {} };
  const covered = all.filter((m) => { const ok = ran[m.file](m.start); const f = (stats.by_file[m.file] = stats.by_file[m.file] || { sites: 0, covered: 0 }); f.sites++; if (ok) { f.covered++; stats.covered++; } return ok; });
  for (const [cat, n] of Object.entries(QUOTA)) {
    const want = Math.round(n * scale);
    const byFile = new Map();
    covered.filter((m) => m.category === cat).map((m) => [rank(m), m]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([, m]) => { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); });
    // round-robin over the files, so a big file does not take the whole quota
    const files = [...byFile.keys()].sort();
    let got = 0; let k = 0;
    while (got < want && files.some((f) => byFile.get(f).length)) {
      const q = byFile.get(files[k++ % files.length]);
      if (q.length) { picked.push(q.shift()); got++; }
    }
  }
  return { picked, stats };
}

/** The kill-list mutants to run beside the picked ones: every id in expected.json that this source can still produce
 *  (`extra`), and the ids it can no longer produce because their line changed (`gone`, reported). Fixture ids (fx-)
 *  always run with the fixture mutants. */
export function withKillList(picked, all, expected) {
  const have = new Set(picked.map((m) => m.id)); const byId = new Map(all.map((m) => [m.id, m]));
  const extra = []; const gone = [];
  for (const id of (expected && expected.killed) || []) {
    if (id.startsWith('fx-') || have.has(id)) continue;
    if (byId.has(id)) extra.push(byId.get(id)); else gone.push(id);
  }
  return { extra, gone };
}

/** --sample: a fixed subset of n of the picked mutants (the same n for the same seed and the same picked set). */
export function sampleOf(picked, n, seed) {
  const keep = new Set(seededShuffle(picked.map((m) => m.id).sort(), seed + ':sample').slice(0, n));
  return picked.filter((m) => keep.has(m.id));
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: jobs }, async (_, w) => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], w); } }));
  return out;
}

const sameObs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runSourceMutants(o, cases, base) {
  const clean = buildCopy(base);
  const cleanObsFile = join(base, 'clean-obs.json');
  const c0 = await observeChild(clean, cleanObsFile, o.timeout * 2);
  if (c0.status !== 'ok') throw new Error('the unmutated build did not run: ' + c0.err);
  const cleanObs = JSON.parse(readFileSync(cleanObsFile, 'utf8'));
  const D0 = disagreementSet(cases, cleanObs);
  const S0 = scoreAll(cases, cleanObs);
  const ran = coverage(base, clean);
  const all = TARGETS.flatMap((t) => mutantsOf(t, readFileSync(join(clean, t), 'utf8')));
  let { picked, stats } = pickSourceMutants(all, ran, { total: o.source, seed: o.seed });
  const full = picked.length;
  if (o.sample && o.sample < picked.length) picked = sampleOf(picked, o.sample, o.seed);
  // every mutant on the kill list runs too, picked by the quota or not, so the list can only ratchet
  const kill = existsSync(o.expected) ? JSON.parse(readFileSync(o.expected, 'utf8')) : { killed: [] };
  const { extra, gone } = withKillList(picked, all, kill);
  const quotaIds = new Set(picked.map((m) => m.id));
  picked = picked.concat(extra);
  const slots = Array.from({ length: o.jobs }, () => buildCopy(base));
  const results = await pool(picked, o.jobs, async (m, w) => {
    const dir = slots[w]; const file = join(dir, m.file);
    const orig = readFileSync(file, 'utf8');
    const mutated = applyMutant(orig, m);
    writeFileSync(file, mutated);
    try {
      const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (chk.status !== 0) return { ...m, status: 'invalid', why: 'does not parse' };
      const outFile = join(base, 'obs-' + w + '.json');
      rmSync(outFile, { force: true });
      const r = await observeChild(dir, outFile, o.timeout);
      if (r.status === 'timeout') return { ...m, status: 'killed', by: 'timeout' };
      if (r.status !== 'ok') return { ...m, status: 'killed', by: 'crash', detail: r.err.split('\n').find((l) => /Error/.test(l)) || '' };
      const obs = JSON.parse(readFileSync(outFile, 'utf8'));
      const D = disagreementSet(cases, obs);
      const fresh = [...D].filter((x) => !D0.has(x));
      const fixed = [...D0].filter((x) => !D.has(x));
      // the same rule as the release gate: would a pull request with this bug fail CI?
      const gate = gateCompare(S0, scoreAll(cases, obs));
      if (gate.failures.length) return { ...m, status: 'killed', by: 'gate', ground_truth: fresh.length > 0, evidence: gate.failures.slice(0, 3) };
      const changed = cases.filter((c) => !sameObs(obs[c.id], cleanObs[c.id])).map((c) => c.id);
      return { ...m, status: 'survived', ground_truth: fresh.length > 0, output_changed_in: changed, ...(fixed.length ? { fixes: fixed.slice(0, 3) } : {}) };
    } finally { writeFileSync(file, orig); }
  });
  results.forEach((r) => { if (!quotaIds.has(r.id)) r.from_kill_list = true; });
  return { results, stats, full, clean_disagreements: D0.size, kill_list_gone: gone };
}

/** Applies a fixture mutant's truth edit to a copy of the truth. Findings labels may be lists or { tool: severity }. */
export function patchTruth(t, p) {
  const x = JSON.parse(JSON.stringify(t));
  const asObj = (v) => (Array.isArray(v) ? Object.fromEntries(v.map((n) => [n, null])) : { ...(v || {}) });
  const back = (o) => (Object.values(o).every((s) => s === null) ? Object.keys(o) : o);
  if (p.rename_tool) {
    const [a, b] = p.rename_tool;
    const ren = (arr) => (arr || []).map((n) => (n === a ? b : n));
    x.tools = ren(x.tools); if (x.optional_tools) x.optional_tools = ren(x.optional_tools);
    for (const k of Object.keys(x.findings || {})) x.findings[k] = back(Object.fromEntries(Object.entries(asObj(x.findings[k])).map(([n, s]) => [n === a ? b : n, s])));
    if (x.details && x.details[a]) { x.details[b] = x.details[a]; delete x.details[a]; }
  }
  for (const [k, v] of Object.entries(p.add_findings || {})) {
    const o = asObj((x.findings || {})[k]);
    for (const [n, s] of Object.entries(asObj(v))) o[n] = s;
    x.findings = { ...(x.findings || {}), [k]: back(o) };
  }
  for (const [k, v] of Object.entries(p.remove_findings || {})) if (x.findings && x.findings[k]) { const o = asObj(x.findings[k]); for (const n of Object.keys(asObj(v))) delete o[n]; x.findings[k] = back(o); }
  if (p.add_tools) { x.tools = [...new Set([...(x.tools || []), ...p.add_tools])]; if (x.optional_tools) x.optional_tools = x.optional_tools.filter((n) => !p.add_tools.includes(n)); }
  for (const [n, a] of Object.entries(p.set_annotations || {})) if (x.details && x.details[n]) x.details[n].annotations = { ...(x.details[n].annotations || {}), ...a };
  if (p.outcome) x.outcome = p.outcome;
  if (p.tools) x.tools = p.tools;
  // a description edited by the mutant is no longer labelled
  const touched = new Set([...Object.values(p.add_findings || {}), ...Object.values(p.remove_findings || {})].flatMap((v) => Object.keys(asObj(v))));
  if (p.edits_description !== false) for (const n of touched) if (x.details && x.details[n]) delete x.details[n].description;
  return x;
}

export async function runFixtureMutants(cases, base) {
  const spec = JSON.parse(readFileSync(join(here, 'mutants', 'fixture-mutants.json'), 'utf8')).mutants;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const { main } = await import(new URL('../src/cli.js', import.meta.url).href);
  const { observeCase } = await import('./lib/observe.mjs');
  const out = [];
  for (const m of spec) {
    const c = byId.get(m.case);
    if (!c) { out.push({ ...m, status: 'invalid', why: 'no such case' }); continue; }
    const dir = mkdtempSync(join(base, 'fx-'));
    cpSync(c.dir, dir, { recursive: true });
    const f = join(dir, m.file);
    const text = existsSync(f) ? readFileSync(f, 'utf8') : null;
    if (text === null || text.split(m.find).length !== 2) { out.push({ id: m.id, case: m.case, status: 'invalid', why: 'find text not found exactly once' }); continue; }
    writeFileSync(f, text.replace(m.find, () => m.replace));
    const work = mkdtempSync(join(base, 'fx-save-'));
    const before = await observeCase(main, c.dir, work);
    const after = await observeCase(main, dir, work);
    const t2 = patchTruth(c.truth, m.truth);
    const d0 = compareCase(c.truth, before).disagreements;
    const d1 = compareCase(t2, after).disagreements;
    const strip = (o) => JSON.stringify({ ...o, message: undefined });
    const noticed = strip(before) !== strip(after);
    const killed = noticed && d1.length <= d0.length;
    out.push({ id: m.id, case: m.case, status: killed ? 'killed' : 'survived', ...(killed ? {} : { why: !noticed ? 'output did not change' : 'output changed but disagrees with the edited truth', disagreements: d1.slice(0, 4) }) });
  }
  return out;
}

/** Ids on the kill list that ran and survived. A mutant that did not run this time (its line changed) is not a loss. */
export function lostKills(expected, results) {
  const now = new Map(results.map((x) => [x.id, x.status]));
  return (expected.killed || []).filter((id) => now.get(id) === 'survived');
}

export function mutantMarkdown(r) {
  const L = ['# Mutant pass', ''];
  if (r.source) {
    const s = r.source; const valid = s.results.filter((x) => x.status !== 'invalid' && !x.from_kill_list);
    const fromList = s.results.filter((x) => x.from_kill_list);
    const killed = valid.filter((x) => x.status === 'killed');
    const w = wilson(killed.length, valid.length);
    L.push('## Source mutants', '');
    const gt = valid.filter((x) => x.ground_truth || x.by === 'timeout' || x.by === 'crash');
    L.push(valid.length + ' mutants ran' + (s.full > s.results.length ? ' (a sample of the full ' + s.full + ')' : '') + '; ' + killed.length + ' killed, ' + (valid.length - killed.length) + ' survived: **gate-level kill rate ' + (w ? (w.p * 100).toFixed(1) + '% [' + (w.lo * 100).toFixed(1) + '–' + (w.hi * 100).toFixed(1) + ']' : 'n/a') + '**. A mutant is killed when the required CI gate (bench/gate.mjs) fails it, or the build crashes or hangs. ' + (s.results.length - valid.length) + ' did not parse and are not counted.', '');
    L.push('Every mutant on the kill list (`mutants/expected.json`) runs as well, picked by the quota or not: ' + fromList.length + ' more ran this time (' + fromList.filter((x) => x.status === 'killed').length + ' killed, ' + fromList.filter((x) => x.status === 'survived').length + ' survived)' + ((s.kill_list_gone || []).length ? '; ' + s.kill_list_gone.length + ' kill-list ids can no longer be made because their line changed: ' + s.kill_list_gone.join(', ') : '') + '. The rates above are of the quota set.', '');
    L.push('Of these, ' + gt.length + ' caused a new disagreement with the truth in some case, or crashed or hung; ' + gt.filter((x) => x.status === 'killed').length + ' of those are gate kills (the gate fails on any new per-case disagreement, so this should be all of them).', '');
    L.push('Mutants are drawn from code the cases execute: ' + s.stats.covered + ' of ' + s.stats.sites + ' candidate sites (' + (100 * s.stats.covered / s.stats.sites).toFixed(1) + '%) ran in an unmutated pass. Sites the cases never reach can hide any bug; per file:', '');
    L.push('| File | Candidate sites | Executed by the cases |', '|---|---:|---:|');
    for (const [f, x] of Object.entries(s.stats.by_file)) L.push('| `' + f + '` | ' + x.sites + ' | ' + x.covered + ' (' + (100 * x.covered / x.sites).toFixed(1) + '%) |');
    L.push('', '| Kind | Ran | Killed | Survived |', '|---|---:|---:|---:|');
    for (const cat of Object.keys(CATEGORIES)) { const xs = valid.filter((x) => x.category === cat); if (xs.length) L.push('| ' + cat + ' | ' + xs.length + ' | ' + xs.filter((x) => x.status === 'killed').length + ' | ' + xs.filter((x) => x.status === 'survived').length + ' |'); }
    L.push('', '| File | Ran | Killed | Survived |', '|---|---:|---:|---:|');
    for (const f of TARGETS) { const xs = valid.filter((x) => x.file === f); if (xs.length) L.push('| `' + f + '` | ' + xs.length + ' | ' + xs.filter((x) => x.status === 'killed').length + ' | ' + xs.filter((x) => x.status === 'survived').length + ' |'); }
    L.push('', '### Surviving source mutants (test gaps)', '');
    const sv = s.results.filter((x) => x.status === 'survived'); // the quota set, and any kill-list mutant that survived
    if (!sv.length) L.push('None.');
    else { L.push('"Output changed" names cases whose output moved without crossing a label: a label there would kill the mutant.', '', '| Mutant | Line | Change | Output changed |', '|---|---:|---|---|'); }
    const code = (x) => '`' + String(x).replace(/`/g, "'").slice(0, 110).replace(/\|/g, '\\|') + '`';
    for (const x of sv) L.push('| ' + x.id + ' | ' + x.line + ' | ' + code(x.change) + ' | ' + (x.output_changed_in.length ? x.output_changed_in.slice(0, 3).join(', ') + (x.output_changed_in.length > 3 ? ' and ' + (x.output_changed_in.length - 3) + ' more' : '') : 'no') + ' |');
  }
  if (r.fixtures) {
    const v = r.fixtures.filter((x) => x.status !== 'invalid'); const k = v.filter((x) => x.status === 'killed');
    L.push('', '## Fixture mutants', '', v.length + ' ran; ' + k.length + ' killed (the reader noticed the edit), ' + (v.length - k.length) + ' survived.' + (r.fixtures.length - v.length ? ' ' + (r.fixtures.length - v.length) + ' invalid (their find text no longer matches).' : ''), '');
    const sv = r.fixtures.filter((x) => x.status !== 'killed');
    if (sv.length) { L.push('| Mutant | Case | Status | Why |', '|---|---|---|---|'); for (const x of sv) L.push('| ' + x.id + ' | ' + x.case + ' | ' + x.status + ' | ' + (x.why || '') + (x.disagreements && x.disagreements.length ? ': ' + x.disagreements.join('; ').replace(/\|/g, '\\|') : '') + ' |'); }
  }
  return escapeInvisible(L.join('\n') + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write('mutate: ' + e.message + '\n'); process.exit(2); }
  const cases = loadCases(here);
  const base = mkdtempSync(join(tmpdir(), 'mcp-check-mutants-'));
  const report = { seed: o.seed };
  try {
    if (o.sourceOn) report.source = await runSourceMutants(o, cases, base);
    if (o.fixtures) report.fixtures = await runFixtureMutants(cases, base);
  } finally { rmSync(base, { recursive: true, force: true }); }
  const md = mutantMarkdown(report);
  if (o.json) writeFileSync(o.json, escapeInvisible(JSON.stringify(report, null, 1)) + '\n');
  if (o.md) writeFileSync(o.md, md); else process.stdout.write(md);
  // the kill list: every mutant once killed must stay killed
  let fail = false;
  if (existsSync(o.expected) && !o.writeExpected) {
    const lost = lostKills(JSON.parse(readFileSync(o.expected, 'utf8')), [...(report.source ? report.source.results : []), ...(report.fixtures || [])]);
    if (lost.length) { fail = true; process.stderr.write('mutate: mutants the benchmark used to kill now survive (a case or a label stopped catching them):\n  ' + lost.join('\n  ') + '\n'); }
  }
  if (o.writeExpected) {
    const killed = [...(report.source ? report.source.results : []), ...(report.fixtures || [])].filter((x) => x.status === 'killed').map((x) => x.id).sort();
    writeFileSync(o.expected, JSON.stringify({ about: 'Mutants the benchmark kills. bench/mutate.mjs fails when one of these survives. Rewrite with --write-expected after adding cases; never remove an id by hand to make a run pass.', seed: o.seed, killed }, null, 1) + '\n');
  }
  process.exit(fail ? 1 : 0);
}
