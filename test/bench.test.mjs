// The adversarial benchmark (bench/): its scorer, its gate, its faulty-oracle cases and its mutant pass.
// The full mutant pass runs in .github/workflows/bench-mutants.yml; here one planted bug is enough to show it is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../bench/lib/cases.mjs';
import { compareCase, scoreAll, wilson } from '../bench/lib/score.mjs';
import { compare } from '../bench/gate.mjs';
import { run } from '../bench/run.mjs';
import { buildCopy, disagreementSet, lostKills, observeChild, patchTruth, sampleOf, withKillList } from '../bench/mutate.mjs';
import { CORE_CHECKS, CORE_SERVER_CHECKS } from '../bench/lib/cases.mjs';
import { labelMap } from '../bench/lib/score.mjs';
import { observeAll } from '../bench/lib/observe.mjs';
import { caseSetHashes, fileHashes } from '../bench/lib/holdout-guard.mjs';
import { guard, LABEL } from '../bench/base-guard.mjs';
import { createHash } from 'node:crypto';
import { tmpdir as osTmp } from 'node:os';
import { TARGETS, mutantsOf } from '../bench/mutants/sites.mjs';
import { tokenize } from '../bench/mutants/lexer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const benchDir = join(root, 'bench');

test('Wilson 95% intervals match the published formula', () => {
  assert.equal(wilson(0, 0), null);
  const w = wilson(5, 10);
  assert.equal(w.p, 0.5); assert.equal(w.lo, 0.2366); assert.equal(w.hi, 0.7634);
  const z = wilson(0, 10); assert.equal(z.lo, 0); assert.equal(z.hi, 0.2775);
  const a = wilson(10, 10); assert.equal(a.lo, 0.7225); assert.equal(a.hi, 1);
});

test('every case has a valid truth file, no truth is orphaned, and no public truth is from the holdout', () => {
  const cases = loadCases(benchDir);
  assert.ok(cases.length >= 70, 'cases: ' + cases.length);
  for (const lang of ['typescript', 'javascript', 'python', 'go', 'rust', 'committed-list', 'csharp', 'java', 'kotlin', 'ruby', 'php', 'swift']) assert.ok(cases.some((c) => c.truth.language === lang), lang);
  assert.ok(cases.filter((c) => c.truth.faulty_oracle).length >= 5);
  for (const c of cases) assert.notEqual(c.truth.split, 'holdout', c.id + ' is a holdout case: it must never be committed here');
});

test('R-BENCH-01: the gate fails when a check\'s false negatives rise, or its recall drops below the baseline interval', async () => {
  const cell = (tp, fn, fp = 0) => ({ tp, fn, fp, tn: 0, recall: wilson(tp, tp + fn), precision: wilson(tp, tp + fp) });
  const score = (c) => ({ cases: 1, checks: { 'schema-x': { all: c, by_language: { go: c } } }, faulty_oracle: [{ id: 'f', caught: true }] });
  assert.deepEqual(compare(score(cell(10, 0)), score(cell(10, 0))).failures, []);
  const fnUp = compare(score(cell(10, 0)), score(cell(10, 1)));
  assert.ok(fnUp.failures.some((f) => /schema-x \(all languages\): false negatives rose from 0 to 1/.test(f)));
  assert.ok(fnUp.failures.some((f) => /schema-x \(go\): false negatives rose/.test(f)), 'per language too');
  // recall can fall without a rise in false negatives when positives are added: still a failure past the interval
  const drop = compare(score(cell(20, 0)), { ...score(cell(10, 0)), checks: { 'schema-x': { all: { ...cell(10, 0), recall: { p: 0.5, lo: 0.3, hi: 0.7 } }, by_language: {} } } });
  assert.ok(drop.failures.some((f) => /recall 0.5 is below the baseline interval/.test(f)));
  assert.deepEqual(compare(score(cell(100, 0, 0)), score(cell(100, 0, 1))).failures, [], 'a false positive within the interval of a non-security check warns');
  assert.equal(compare(score(cell(100, 0, 0)), score(cell(100, 0, 1))).warnings.length, 2);
  // the committed baseline holds for this checkout
  const { score: now } = await run({ root, cases: benchDir });
  const base = JSON.parse(readFileSync(join(benchDir, 'baseline.json'), 'utf8'));
  const r = compare(base, now);
  assert.deepEqual(r.failures, [], r.failures.join('\n'));
});

test('R-BENCH-02: a faulty-oracle label is reported as a disagreement, never echoed as a pass', async () => {
  const { score } = await run({ root, cases: benchDir });
  assert.ok(score.faulty_oracle.length >= 5);
  for (const f of score.faulty_oracle) assert.ok(f.caught && f.disagreements.length, f.id + ' was not caught');
  // a scorer that echoed labels would pass this observation; this one must not, and the gate then fails
  const truth = { id: 'faulty-oracle/x', language: 'go', idioms: ['x'], outcome: 'tools', tools: ['a', 'b'], faulty_oracle: 'b does not exist', expected_disagreement: 'reader-tools|fn|b' };
  const echo = { outcome: 'tools', tools: ['a', 'b'], findings: {}, server: {} };
  assert.equal(compareCase(truth, echo).disagreements.length, 0, 'an observation equal to the label agrees with it');
  const s = scoreAll([{ id: truth.id, truth }], { [truth.id]: echo });
  assert.equal(s.faulty_oracle[0].caught, false);
  assert.ok(compare({ checks: {}, faulty_oracle: [{}] }, s).failures.some((f) => /not caught/.test(f)));
});

test('R-BENCH-03: the mutant pass catches a planted check bug, and fails when a mutant on the kill list survives', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bench-test-'));
  try {
    const cases = loadCases(benchDir);
    const clean = buildCopy(base);
    assert.equal((await observeChild(clean, join(base, 'clean.json'), 120)).status, 'ok');
    const d0 = disagreementSet(cases, JSON.parse(readFileSync(join(base, 'clean.json'), 'utf8')));
    // the bug: the "ignore ... previous instructions" pattern weakened so that it no longer matches "ignore"
    const bad = buildCopy(base); const f = join(bad, 'engine', 'core.js');
    const src = readFileSync(f, 'utf8');
    const from = '/\\b(ignore|disregard|forget|override|bypass)\\b';
    assert.ok(src.includes(from), 'the planted bug still applies to engine/core.js');
    writeFileSync(f, src.replace(from, '/\\b(disregard|forget|override|bypass)\\b'));
    assert.equal((await observeChild(bad, join(base, 'bad.json'), 120)).status, 'ok');
    const d1 = disagreementSet(cases, JSON.parse(readFileSync(join(base, 'bad.json'), 'utf8')));
    const fresh = [...d1].filter((x) => !d0.has(x));
    assert.ok(fresh.some((x) => /sec-instruction-phrases missed/.test(x)), 'killed by a labelled case: ' + fresh.join('; '));
  } finally { rmSync(base, { recursive: true, force: true }); }
  assert.deepEqual(lostKills({ killed: ['a', 'b', 'c'] }, [{ id: 'a', status: 'killed' }, { id: 'b', status: 'survived' }]), ['b'], 'c did not run: not a loss');
  // the committed kill list names mutants this code can still produce or that were fixture mutants
  const exp = JSON.parse(readFileSync(join(benchDir, 'mutants', 'expected.json'), 'utf8'));
  assert.ok(exp.killed.length >= 40, 'kill list: ' + exp.killed.length);
});

test('mutation sites: every target tokenizes, every mutation kind has candidates, ids are unique', () => {
  const kinds = new Set(); const ids = new Set();
  for (const t of TARGETS) {
    const src = readFileSync(join(root, t), 'utf8');
    assert.ok(tokenize(src).length > 100, t);
    for (const m of mutantsOf(t, src)) { kinds.add(m.category); assert.ok(!ids.has(m.id), 'duplicate id ' + m.id); ids.add(m.id); }
  }
  for (const k of ['flip-condition', 'drop-registration-pattern', 'weaken-regex', 'off-by-one', 'swap-severity', 'flip-boolean', 'swap-some-every']) assert.ok(kinds.has(k), k);
});

test('fixture mutants: every find text occurs exactly once in its case, and truth edits apply', () => {
  const spec = JSON.parse(readFileSync(join(benchDir, 'mutants', 'fixture-mutants.json'), 'utf8')).mutants;
  const cases = new Map(loadCases(benchDir).map((c) => [c.id, c]));
  assert.ok(spec.length >= 40);
  for (const m of spec) {
    const c = cases.get(m.case); assert.ok(c, m.id + ': no case ' + m.case);
    assert.equal(readFileSync(join(c.dir, m.file), 'utf8').split(m.find).length, 2, m.id);
    const t = patchTruth(c.truth, m.truth);
    if (m.truth.rename_tool) assert.ok(t.tools.includes(m.truth.rename_tool[1]) && !t.tools.includes(m.truth.rename_tool[0]), m.id);
  }
});

test('the benchmark cases are not read as this repository\'s own server', async () => {
  // bench/ is a folder the reader sets aside, so --repo-dir and the zero-config Action on this repository still find
  // only src/server.js, however many servers the cases hold
  assert.ok(readdirSync(join(benchDir, 'cases')).length > 5);
  const { main } = await import('../src/cli.js');
  let out = ''; const sink = { write: (s) => { out += s; return true; } };
  const code = await main(['--repo-dir', root, '--format', 'json'], { stdout: sink, stderr: { write: () => true } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out).tools.map((t) => t.name).sort(), ['check_tools_list', 'compare_tools_lists', 'explain_check']);
});

const benchScore = async () => (await run({ root, cases: benchDir })).score;
const baseline = () => JSON.parse(readFileSync(join(benchDir, 'baseline.json'), 'utf8'));

test('R-BENCH-04: every core check has labelled positives: at least 3 in 2 languages for each security check, at least 1 for the others', () => {
  const cases = loadCases(benchDir).filter((c) => !c.truth.faulty_oracle && c.truth.outcome === 'tools' && c.truth.truth_level !== 'inferred');
  const count = (check, server) => {
    let n = 0; const langs = new Set();
    for (const c of cases) {
      const v = server ? (c.truth.server_findings || {})[check] : (c.truth.findings || {})[check];
      const k = server ? (v ? 1 : 0) : labelMap(v).size;
      if (k) { n += k; langs.add(c.truth.language); }
    }
    return { n, langs: langs.size };
  };
  for (const check of CORE_CHECKS) {
    const { n, langs } = count(check, false);
    if (check.startsWith('sec-')) assert.ok(n >= 3 && langs >= 2, check + ': ' + n + ' hand-labelled positives in ' + langs + ' languages');
    else assert.ok(n >= 1, check + ': no hand-labelled positive');
  }
  for (const check of CORE_SERVER_CHECKS) assert.ok(count(check, true).n >= 1, check);
});

test('R-BENCH-05: false-positive rises fail the gate (any for security, reader-tools and the cap; past the interval for the rest), and a planted false-alarm bug is a gate kill', async () => {
  const cell = (tp, fp) => ({ tp, fn: 0, fp, tn: 100, recall: wilson(tp, tp), precision: wilson(tp, tp + fp) });
  const sc = (check, c) => ({ cases: 1, checks: { [check]: { all: c, by_language: {} } }, faulty_oracle: [] });
  for (const check of ['sec-homoglyph', 'reader-tools', 'security-cap']) assert.ok(compare(sc(check, cell(100, 0)), sc(check, cell(100, 1))).failures.some((f) => /false positives rose from 0 to 1/.test(f)), check);
  assert.deepEqual(compare(sc('schema-x', cell(100, 0)), sc('schema-x', cell(100, 1))).failures, []);
  assert.ok(compare(sc('schema-x', cell(10, 0)), sc('schema-x', cell(10, 10))).failures.some((f) => /precision 0.5 below the baseline interval/.test(f)));
  // the reviewer's case: a bug that makes spec-name-charset fire on every name with an underscore
  const base = mkdtempSync(join(tmpdir(), 'bench-test-'));
  try {
    const bad = buildCopy(base); const f = join(bad, 'engine', 'core.js');
    const src = readFileSync(f, 'utf8'); const from = "if (name.length && !/^[A-Za-z0-9_.-]+$/.test(name)) push('spec-name-charset'";
    assert.ok(src.includes(from), 'the planted bug still applies');
    writeFileSync(f, src.replace(from, "if (name.length && !/^[A-Za-z0-9.-]+$/.test(name)) push('spec-name-charset'"));
    const now = (await run({ root: bad, cases: benchDir })).score;
    const g = compare(baseline(), now);
    assert.ok(g.failures.some((x) => /new false alarm spec-name-charset\|fp\|/.test(x)), 'named per case');
    assert.ok(g.failures.some((x) => /spec-name-charset \(all languages\): false positives rose/.test(x)), 'and in the totals');
  } finally { rmSync(base, { recursive: true, force: true }); }
  // the mutant pass decides kills with this same compare()
  assert.match(readFileSync(join(benchDir, 'mutate.mjs'), 'utf8'), /const gate = gateCompare\(S0, scoreAll\(cases, obs\)\);\n\s+if \(gate\.failures\.length\) return \{ \.\.\.m, status: 'killed', by: 'gate'/);
});

test('R-BENCH-06: one case getting worse fails the gate even when another case gets better', () => {
  const c = { tp: 5, fn: 1, fp: 0, tn: 0, recall: wilson(5, 6), precision: wilson(5, 5) };
  const base = { cases: 2, checks: { 'sec-x': { all: c, by_language: {} } }, disagreement_keys: { 'go/a': ['sec-x|fn|t1'] }, faulty_oracle: [] };
  // the totals are unchanged: case a was fixed, case b broke
  const now = { cases: 2, checks: { 'sec-x': { all: c, by_language: {} } }, disagreement_keys: { 'go/b': ['sec-x|fn|t9'] }, faulty_oracle: [] };
  const f = compare(base, now).failures;
  assert.ok(f.some((x) => x === 'go/b: new miss sec-x|fn|t9'), f.join('\n'));
  assert.ok(f.some((x) => /rebaseline: improvements not locked in: go\/a no longer has sec-x\|fn\|t1/.test(x)));
});

test('R-BENCH-07: lost coverage, a changed case set and unlocked improvements fail the gate', async () => {
  const now = await benchScore(); const base = baseline();
  assert.equal(now.case_set_hash, base.case_set_hash, 'the committed baseline was made from these cases: rebaseline with node bench/run.mjs --rebaseline');
  assert.deepEqual(compare(base, now).failures, []);
  const fewer = { ...now, cases: now.cases - 1 };
  assert.ok(compare(base, fewer).failures.some((x) => /cases fell/.test(x)));
  const rehash = { ...now, case_set_hash: '0'.repeat(64) };
  assert.ok(compare(base, rehash).failures.some((x) => /the cases or their truth changed/.test(x)));
  const k = Object.keys(now.checks).find((x) => now.checks[x].all.tp > 0);
  const lessTp = JSON.parse(JSON.stringify(now)); lessTp.checks[k].all.tp--;
  assert.ok(compare(base, lessTp).failures.some((x) => x.startsWith(k + ' (all languages): true positives fell')));
  // a better score than the baseline must be locked in
  const better = JSON.parse(JSON.stringify(now)); const id = Object.keys(better.disagreement_keys)[0]; better.disagreement_keys[id] = better.disagreement_keys[id].slice(1);
  assert.ok(compare(base, better).failures.some((x) => x.startsWith('rebaseline: improvements not locked in')));
  assert.match(readFileSync(join(benchDir, 'README.md'), 'utf8'), /node bench\/run\.mjs --rebaseline/);
});

test('R-BENCH-08: checks whose positives all come from inferred labels are reported apart, as self-consistency only', async () => {
  const s = await benchScore();
  const inferred = Object.entries(s.checks).filter(([, v]) => v.labels === 'inferred-only').map(([k]) => k);
  assert.ok(inferred.includes('openai-retry') && inferred.includes('schema-pagination'), inferred.join(' '));
  assert.ok(!inferred.includes('sec-instruction-phrases'));
  const md = readFileSync(join(benchDir, 'SCORE.md'), 'utf8');
  const hand = md.slice(md.indexOf('## Per check: measured against hand-written labels'), md.indexOf('## Per check: inferred labels, self-consistency only'));
  const inf = md.slice(md.indexOf('## Per check: inferred labels, self-consistency only'), md.indexOf('## Per check: no positive case'));
  for (const k of inferred) { assert.ok(inf.includes('| `' + k + '` |'), k); assert.ok(!hand.includes('| `' + k + '` |'), k); }
});

test('R-BENCH-09: a faulty-oracle case is caught only by the disagreement its truth names', () => {
  const truth = { id: 'faulty-oracle/y', language: 'go', idioms: ['x'], outcome: 'tools', tools: ['a', 'b'], faulty_oracle: 'b does not exist', expected_disagreement: 'reader-tools|fn|b' };
  // a disagreement, but not the one the wrong label causes
  const other = { outcome: 'tools', tools: ['a', 'b', 'c'], findings: {}, server: {} };
  assert.equal(scoreAll([{ id: truth.id, truth }], { [truth.id]: other }).faulty_oracle[0].caught, false);
  const right = { outcome: 'tools', tools: ['a'], findings: {}, server: {} };
  assert.equal(scoreAll([{ id: truth.id, truth }], { [truth.id]: right }).faulty_oracle[0].caught, true);
  for (const c of loadCases(benchDir).filter((x) => x.truth.faulty_oracle)) assert.match(c.truth.expected_disagreement, /^[a-z-]+\|(fn|fp)\|/);
});

test('R-BENCH-10: no public case or truth file matches a holdout file hash', () => {
  const list = JSON.parse(readFileSync(join(benchDir, 'holdout-hashes.json'), 'utf8'));
  assert.ok(list.hashes.length >= 60, 'hashes: ' + list.hashes.length);
  assert.ok(list.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), 'hashes only');
  const held = new Set(list.hashes);
  for (const x of caseSetHashes(benchDir)) assert.ok(!held.has(x.hash), x.path + ' matches a holdout file');
  // the guard compares whitespace-free text too, so reformatting a copied file does not get past it
  const dir = mkdtempSync(join(tmpdir(), 'bench-guard-'));
  try {
    const any = caseSetHashes(benchDir).find((x) => readFileSync(join(benchDir, x.path)).length >= 400);
    const text = readFileSync(join(benchDir, any.path), 'utf8');
    writeFileSync(join(dir, 'x'), text.replace(/\n/g, '\n\n  '));
    const h = createHash('sha256').update(readFileSync(join(dir, 'x'), 'utf8').replace(/\s+/g, '')).digest('hex');
    assert.ok(caseSetHashes(benchDir).some((y) => y.hash === h));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-BENCH-12: --sample runs a fixed subset of the full mutant set, as the header says', () => {
  const picked = Array.from({ length: 50 }, (_, i) => ({ id: 'm' + i }));
  const a = sampleOf(picked, 10, 's'); const b = sampleOf(picked.slice().reverse(), 10, 's');
  assert.equal(a.length, 10);
  assert.deepEqual(a.map((m) => m.id).sort(), b.map((m) => m.id).sort(), 'the same subset whatever the order');
  assert.ok(a.every((m) => picked.includes(m)));
  const head = readFileSync(join(benchDir, 'mutate.mjs'), 'utf8').split('import ')[0];
  assert.match(head, /--sample N runs a fixed subset of N of them/);
  assert.ok(!/the pull-request run/.test(head));
});

test('R-BENCH-13: the saved lists go in the run\'s own folder, which is removed, and nothing is left in the system temp folder', async () => {
  const before = new Set(readdirSync(osTmp()).filter((f) => f.startsWith('bench-save-')));
  const work = mkdtempSync(join(tmpdir(), 'bench-work-'));
  try {
    const cases = loadCases(benchDir).slice(0, 3);
    await observeAll(root, cases, { tmp: work });
    assert.deepEqual(readdirSync(work), [], 'the run removed its folder');
  } finally { rmSync(work, { recursive: true, force: true }); }
  const after = readdirSync(osTmp()).filter((f) => f.startsWith('bench-save-') && !before.has(f));
  assert.deepEqual(after, []);
  assert.match(readFileSync(join(benchDir, 'mutate.mjs'), 'utf8'), /'--tmp', dirname\(outFile\)/);
});

test('R-BENCH-14: a pull request cannot accept its own regressions: new misses, false alarms and kill-list removals against the base baseline fail without the bench-rebaseline label', () => {
  const c = { tp: 5, fn: 0, fp: 0, tn: 9, recall: wilson(5, 5), precision: wilson(5, 5) };
  const base = { case_set_hash: 'a', cases: 2, checks: { 'sec-zero-width': { all: c, by_language: {} } }, disagreement_keys: {}, faulty_oracle: [] };
  // the reviewer's case: sec-zero-width switched off, and the pull request's own baseline rewritten to match
  const worse = { tp: 0, fn: 5, fp: 0, tn: 9, recall: wilson(0, 5), precision: null };
  const now = { case_set_hash: 'b', cases: 2, checks: { 'sec-zero-width': { all: worse, by_language: {} } }, disagreement_keys: { 'go/x': ['sec-zero-width|fn|t'] }, faulty_oracle: [] };
  assert.deepEqual(compare(now, now).failures, [], 'against its own baseline it passes');
  const r = guard({ base, now, baseExpected: { killed: ['a', 'b'] }, expected: { killed: ['a'] }, guardChanged: ['bench/gate.mjs'] });
  assert.ok(r.findings.includes('go/x: new miss against the base: sec-zero-width|fn|t'));
  assert.ok(r.findings.some((f) => /sec-zero-width \(all languages\): false negatives rose from 0 to 5 \(against the base\)/.test(f)));
  assert.ok(r.findings.includes('removed from the kill list (bench/mutants/expected.json): b'));
  assert.ok(r.findings.includes('the gate or this guard changed: bench/gate.mjs'));
  assert.ok(!r.findings.some((f) => /case-set|cases or their truth changed|rebaseline: /.test(f)), 'a new case set and improvements are not regressions');
  // improvements only: nothing to report
  const better = { ...base, disagreement_keys: {} };
  assert.deepEqual(guard({ base: { ...base, disagreement_keys: { 'go/x': ['sec-zero-width|fn|t'] } }, now: better, baseExpected: null, expected: null }).findings, []);
  // the pull request that adds the benchmark: the base has none, so it passes
  assert.match(guard({ base: null, now }).skipped, /no bench\/baseline\.json/);
  assert.equal(LABEL, 'bench-rebaseline');
  // the step: base files read with git show, labels only through env, on pull requests, re-run on label changes
  const y = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const step = y.slice(y.indexOf("      - name: Against the base branch's baseline and kill list"), y.indexOf('\n  mutants:\n'));
  assert.match(step, /if: github\.event_name == 'pull_request'/);
  assert.match(step, /PR_LABELS: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/);
  assert.match(step, /git show "origin\/\$BASE_REF:bench\/baseline\.json"/);
  assert.match(step, /git show "origin\/\$BASE_REF:bench\/mutants\/expected\.json"/);
  assert.match(step, /node bench\/base-guard\.mjs --base base-baseline\.json --base-expected base-expected\.json --score bench-score\.json/);
  assert.ok(!/\$\{\{/.test(step.slice(step.indexOf('run: |'))), 'no expression inside the script');
  assert.match(y, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
});

test('R-BENCH-15: every mutant on the kill list runs in every pass, so the list only ratchets', () => {
  const all = [{ id: 'q1' }, { id: 'q2' }, { id: 'k1' }, { id: 'k2' }];
  const { extra, gone } = withKillList([{ id: 'q1' }], all, { killed: ['q1', 'k1', 'k2', 'k-gone', 'fx-ts-x'] });
  assert.deepEqual(extra.map((m) => m.id), ['k1', 'k2'], 'not picked by the quota, still run');
  assert.deepEqual(gone, ['k-gone'], 'reported, and the base-branch guard flags it when expected.json drops it');
  const src = readFileSync(join(benchDir, 'mutate.mjs'), 'utf8');
  assert.match(src, /const \{ extra, gone \} = withKillList\(picked, all, kill\);/);
  assert.match(src, /picked = picked\.concat\(extra\);/);
  assert.deepEqual(lostKills({ killed: ['k1'] }, [{ id: 'k1', status: 'survived', from_kill_list: true }]), ['k1']);
});

test('R-BENCH-16: the holdout hash list names no private path, and tiny files get only their byte hash', () => {
  const list = JSON.parse(readFileSync(join(benchDir, 'holdout-hashes.json'), 'utf8'));
  assert.ok(!/research\/|company-audit|benchmark-holdout/.test(list.about), list.about);
  assert.equal(fileHashes(Buffer.from('{ "name": "x" }\n')).length, 1);
  assert.equal(fileHashes(Buffer.alloc(300, 'a')).length, 2);
});
