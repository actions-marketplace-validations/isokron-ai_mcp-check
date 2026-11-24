// Scores observations against ground truth: per check and per language, precision, recall, abstention and
// unsupported rates, each with a Wilson 95% interval. Every disagreement is listed by name, so a change in the
// score can always be traced to the cases that moved.
import { ABSTAIN, CORE_CHECKS, CORE_SERVER_CHECKS, UNSUPPORTED } from './cases.mjs';

const Z = 1.959963984540054;

/** Invisible and direction-changing characters written as \\uXXXX, so a committed score or report never carries them raw. */
export const escapeInvisible = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, (c) => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));

/** Wilson score interval for k successes in n trials (95%). null when n is 0. */
export function wilson(k, n, z = Z) {
  if (!n) return null;
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
  const r = (x) => Math.round(x * 10000) / 10000;
  return { k, n, p: r(p), lo: r(Math.max(0, centre - half)), hi: r(Math.min(1, centre + half)) };
}

const cell = () => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
const add = (a, b) => { a.tp += b.tp; a.fp += b.fp; a.fn += b.fn; a.tn += b.tn; };
export function rates(c) {
  return { ...c, precision: wilson(c.tp, c.tp + c.fp), recall: wilson(c.tp, c.tp + c.fn) };
}

/** A findings label as a map tool -> labelled severity (null: any severity): a list of tool names, or { tool: severity }. */
export function labelMap(v) {
  if (Array.isArray(v)) return new Map(v.map((n) => [n, null]));
  return new Map(Object.entries(v || {}));
}

/** The checks scored on a case: the core list (unless the truth turns it off) and every check its truth labels. */
export function scoredChecks(truth) {
  return [...new Set([...(truth.core === false ? [] : CORE_CHECKS), ...Object.keys(truth.findings || {})])].sort();
}

/**
 * Compares one case's observation with its truth. Returns { units, disagreements } where units are
 * { check, tp|fp|fn|tn } increments (check 'reader-tools' for the tool list, 'outcome' for what the reader decided).
 */
export function compareCase(truth, obs) {
  const units = []; const dis = [];
  const u = (check, kind, why) => { units.push({ check, kind }); if (why) dis.push(why); };
  const exp = truth.outcome;
  if (obs.outcome === exp) u('outcome', 'tp');
  else u('outcome', 'fn', 'outcome: expected ' + exp + ', got ' + obs.outcome + (obs.message ? ' (' + obs.message.slice(0, 160) + ')' : ''));
  // abstention as its own decision: refusing to grade (several servers, names only, incomplete)
  const ea = ABSTAIN.has(exp); const oa = ABSTAIN.has(obs.outcome);
  u('abstain', ea && oa ? 'tp' : ea ? 'fn' : oa ? 'fp' : 'tn', !ea && oa ? 'abstained (' + obs.outcome + ') on a case with a list to grade' : null);
  const truthTools = new Set(truth.outcome === 'tools' ? truth.tools : []);
  const optional = new Set(truth.optional_tools || []);
  const seen = new Set(obs.tools || []);
  for (const n of truthTools) u('reader-tools', seen.has(n) ? 'tp' : 'fn', seen.has(n) ? null : 'missed tool ' + n);
  for (const n of seen) if (!truthTools.has(n) && !optional.has(n)) u('reader-tools', 'fp', 'phantom tool ' + n);
  if (truth.outcome !== 'tools') return { units, disagreements: dis };
  const pos = truth.findings || {};
  // an exhaustive truth labels every check: anything raised on its tools that it does not list is a false positive
  const extra = truth.exhaustive ? [...truthTools, ...optional].flatMap((n) => Object.keys((obs.findings || {})[n] || {})) : [];
  const notScored = new Set(truth.not_scored || []);
  for (const check of [...new Set([...scoredChecks(truth), ...extra])].filter((c) => !notScored.has(c)).sort()) {
    const want = labelMap(pos[check]);
    for (const n of [...truthTools, ...optional]) {
      if (optional.has(n) && !seen.has(n)) continue; // an optional tool not listed is neither right nor wrong
      const sev = seen.has(n) ? (obs.findings[n] || {})[check] : undefined;
      const got = !!sev;
      if (want.has(n)) {
        u(check, got ? 'tp' : 'fn', got ? null : check + ' missed on ' + n);
        // a labelled severity is part of the answer: a blocking item reported as advice misleads as much as a miss
        if (got && want.get(n)) u('severity', sev === want.get(n) ? 'tp' : 'fn', sev === want.get(n) ? null : check + ' on ' + n + ' raised as ' + sev + ', truth ' + want.get(n));
      } else u(check, got ? 'fp' : 'tn', got ? check + ' raised on ' + n + ' (truth: not this check)' : null);
    }
  }
  // checks of the whole list (duplicate names): truth in server_findings, "not raised" by default
  const wantS = truth.server_findings || {};
  const gotS = obs.server || {};
  const serverChecks = new Set([...(truth.core === false ? [] : CORE_SERVER_CHECKS), ...Object.keys(wantS), ...(truth.exhaustive ? Object.keys(gotS) : [])]);
  for (const check of [...serverChecks].filter((c) => !notScored.has(c)).sort()) {
    const w = wantS[check]; const g = gotS[check];
    if (w) {
      u(check, g ? 'tp' : 'fn', g ? null : check + ' missed on the list');
      if (g && typeof w === 'string') u('severity', g === w ? 'tp' : 'fn', g === w ? null : check + ' on the list raised as ' + g + ', truth ' + w);
    } else u(check, g ? 'fp' : 'tn', g ? check + ' raised on the list (truth: not this check)' : null);
  }
  // the rubric's cap: a blocking security finding grades security, Anthropic and OpenAI F
  const capWanted = Object.entries(pos).some(([k, v]) => k.startsWith('sec-') && [...labelMap(v).values()].includes('blocking'));
  const labelledSec = Object.entries(pos).some(([k, v]) => k.startsWith('sec-') && labelMap(v).size && [...labelMap(v).values()].every(Boolean)) || truth.core !== false;
  if (labelledSec && obs.grades) {
    const capped = ['security', 'anthropic', 'openai'].every((k) => obs.grades[k] === 'F');
    u('security-cap', capWanted === capped ? (capWanted ? 'tp' : 'tn') : capWanted ? 'fn' : 'fp', capWanted === capped ? null : (capWanted ? 'blocking security finding labelled, but the grades are not capped at F' : 'grades capped at F with no blocking security finding labelled') + ' (' + ['security', 'anthropic', 'openai'].map((k) => k + ' ' + obs.grades[k]).join(', ') + ')');
  }
  // a tool registered under a condition (optional in the truth) is listed as conditional, and no other tool is
  for (const n of seen) {
    if (!truthTools.has(n) && !optional.has(n)) continue;
    const marked = (obs.conditional || []).includes(n);
    if (optional.has(n)) u('reader-conditional', marked ? 'tp' : 'fn', marked ? null : n + ' is registered under a condition but not marked conditional');
    else if (marked) u('reader-conditional', 'fp', n + ' marked conditional, but it is always registered');
  }
  // parts the reader cannot know statically are marked unreadable (their checks skipped), and only those
  const wantU = truth.unreadable || {};
  for (const n of seen) {
    if (!truthTools.has(n) && !optional.has(n)) continue;
    for (const part of ['description', 'inputSchema', 'annotations']) {
      const w = (wantU[n] || []).includes(part); const g = ((obs.unreadable || {})[part] || []).includes(n);
      if (w || g) u('reader-unreadable', w && g ? 'tp' : w ? 'fn' : 'fp', w && g ? null : w ? n + ' ' + part + ' is built at run time but was read as if known' : n + ' ' + part + ' marked unreadable, but it is in the source');
    }
  }
  // what the reader made of each tool: its description, argument names, required arguments and annotations
  for (const [n, want] of Object.entries(truth.details || {})) {
    if (optional.has(n) && !seen.has(n)) continue;
    const got = (obs.details || {})[n];
    if (!got) continue; // a tool not listed at all is already a miss of reader-tools
    for (const k of ['description', 'params', 'required', 'annotations']) {
      if (want[k] === undefined) continue;
      let ok;
      if (!got) ok = false;
      else if (k === 'annotations') ok = Object.entries(want.annotations).every(([a, v]) => got.annotations[a] === v);
      else ok = JSON.stringify(k === 'description' ? got[k] : got[k]) === JSON.stringify(k === 'description' ? want[k] : want[k].slice().sort());
      u('reader-' + k, ok ? 'tp' : 'fn', ok ? null : 'reader ' + k + ' of ' + n + ': expected ' + JSON.stringify(want[k]).slice(0, 120) + ', got ' + (got ? JSON.stringify(got[k]).slice(0, 120) : 'no tool'));
    }
  }
  return { units, disagreements: dis };
}

/** Scores every case. `cases`: [{ id, truth }], `obs`: { id: observation }. */
export function scoreAll(cases, obs) {
  const checks = {}; const byLang = {}; const idioms = {}; const outcomes = {};
  const disagreements = {}; const faulty = []; const gaps = [];
  const get = (o, k, d) => (o[k] || (o[k] = d()));
  for (const c of cases) {
    const o = obs[c.id] || { outcome: 'error', message: 'no observation', tools: [], findings: {}, server: [] };
    const { units, disagreements: dis } = compareCase(c.truth, o);
    if (c.truth.faulty_oracle) { faulty.push({ id: c.id, label_is_wrong_because: c.truth.faulty_oracle, caught: dis.length > 0, disagreements: dis }); continue; }
    if (dis.length) disagreements[c.id] = dis;
    if (c.truth.known_gap) gaps.push({ id: c.id, gap: c.truth.known_gap, reproduces: c.truth.reproduces || null, disagreements: dis, observed: { outcome: o.outcome, tools: o.tools, findings: o.findings } });
    const lang = c.truth.language;
    for (const x of units) {
      const inc = { tp: 0, fp: 0, fn: 0, tn: 0 }; inc[x.kind] = 1;
      add(get(checks, x.check, cell), inc);
      add(get(get(byLang, x.check, () => ({})), lang, cell), inc);
      if (x.check === 'reader-tools') for (const id of c.truth.idioms) add(get(idioms, id, cell), inc);
    }
    const oc = get(outcomes, lang, () => ({ cases: 0, abstain: 0, unsupported: 0, expected_abstain: 0, expected_unsupported: 0, correct: 0 }));
    oc.cases++;
    if (ABSTAIN.has(o.outcome)) oc.abstain++;
    if (UNSUPPORTED.has(o.outcome)) oc.unsupported++;
    if (ABSTAIN.has(c.truth.outcome)) oc.expected_abstain++;
    if (UNSUPPORTED.has(c.truth.outcome)) oc.expected_unsupported++;
    if (o.outcome === c.truth.outcome) oc.correct++;
  }
  const outCheck = {};
  for (const [k, v] of Object.entries(checks)) {
    outCheck[k] = { all: rates(v), by_language: Object.fromEntries(Object.entries(byLang[k]).sort().map(([l, x]) => [l, rates(x)])) };
  }
  const outLang = Object.fromEntries(Object.entries(outcomes).sort().map(([l, x]) => [l, {
    cases: x.cases, expected_abstain: x.expected_abstain, expected_unsupported: x.expected_unsupported,
    abstention: wilson(x.abstain, x.cases), unsupported: wilson(x.unsupported, x.cases), outcome_accuracy: wilson(x.correct, x.cases),
  }]));
  return {
    cases: cases.filter((c) => !c.truth.faulty_oracle).length,
    faulty_oracle_cases: faulty.length,
    checks: Object.fromEntries(Object.entries(outCheck).sort()),
    reader_tools_by_idiom: Object.fromEntries(Object.entries(idioms).sort().map(([k, v]) => [k, rates(v)])),
    languages: outLang,
    faulty_oracle: faulty,
    known_gaps: gaps,
    disagreements,
  };
}

const pct = (w) => (w ? (w.p * 100).toFixed(1) + '% [' + (w.lo * 100).toFixed(1) + '–' + (w.hi * 100).toFixed(1) + ']' : 'n/a');

/** The score as Markdown tables. */
export function scoreMarkdown(s, { title = 'Benchmark score' } = {}) {
  const L = [];
  L.push('# ' + title, '');
  L.push(s.cases + ' cases with trusted labels, plus ' + s.faulty_oracle_cases + ' faulty-oracle cases (labels deliberately wrong, scored apart). Intervals are Wilson 95%.', '');
  L.push('## Per check', '', '| Check | TP | FP | FN | TN | Precision | Recall |', '|---|---:|---:|---:|---:|---|---|');
  for (const [k, v] of Object.entries(s.checks)) L.push('| `' + k + '` | ' + v.all.tp + ' | ' + v.all.fp + ' | ' + v.all.fn + ' | ' + v.all.tn + ' | ' + pct(v.all.precision) + ' | ' + pct(v.all.recall) + ' |');
  L.push('', '## Per check and language', '', '| Check | Language | TP | FP | FN | Precision | Recall |', '|---|---|---:|---:|---:|---|---|');
  for (const [k, v] of Object.entries(s.checks)) for (const [l, x] of Object.entries(v.by_language)) {
    if (!x.tp && !x.fp && !x.fn) continue; // a check with nothing to find and nothing raised in this language: no row
    L.push('| `' + k + '` | ' + l + ' | ' + x.tp + ' | ' + x.fp + ' | ' + x.fn + ' | ' + pct(x.precision) + ' | ' + pct(x.recall) + ' |');
  }
  L.push('', 'Rows with no positive and no finding in a language are left out of this table; the JSON has every cell.', '');
  L.push('## Per language: what the reader decided', '', '| Language | Cases | Outcome right | Abstained (observed) | Abstain expected | Unsupported or none (observed) | Unsupported expected |', '|---|---:|---|---|---:|---|---:|');
  for (const [l, x] of Object.entries(s.languages)) L.push('| ' + l + ' | ' + x.cases + ' | ' + pct(x.outcome_accuracy) + ' | ' + pct(x.abstention) + ' | ' + x.expected_abstain + ' | ' + pct(x.unsupported) + ' | ' + x.expected_unsupported + ' |');
  L.push('', '## Tool reading per idiom', '', '| Idiom | TP | FP | FN | Precision | Recall |', '|---|---:|---:|---:|---|---|');
  for (const [k, v] of Object.entries(s.reader_tools_by_idiom)) L.push('| ' + k + ' | ' + v.tp + ' | ' + v.fp + ' | ' + v.fn + ' | ' + pct(v.precision) + ' | ' + pct(v.recall) + ' |');
  L.push('', '## Faulty-oracle cases', '', 'Each of these has a label that is wrong on purpose. The scorer must disagree with it; a case marked NOT CAUGHT means the scorer echoed the label.', '');
  L.push('| Case | Caught | Why the label is wrong | What the scorer said |', '|---|---|---|---|');
  for (const f of s.faulty_oracle) L.push('| ' + f.id + ' | ' + (f.caught ? 'yes' : '**NOT CAUGHT**') + ' | ' + f.label_is_wrong_because.replace(/\|/g, '\\|') + ' | ' + (f.disagreements.slice(0, 3).join('; ').replace(/\|/g, '\\|') || '(nothing)') + ' |');
  L.push('', '## Known gaps', '');
  if (!s.known_gaps.length) L.push('None.');
  for (const g of s.known_gaps) L.push('- **' + g.id + '**' + (g.reproduces ? ' (' + g.reproduces + ')' : '') + ': ' + g.gap + (g.disagreements.length ? ' Scored misses: ' + g.disagreements.join('; ') + '.' : ' Every label of this case agrees today.'));
  L.push('', '## Every disagreement', '');
  const ids = Object.keys(s.disagreements).sort();
  if (!ids.length) L.push('None.');
  for (const id of ids) L.push('- **' + id + '**: ' + s.disagreements[id].join('; ').replace(/\n/g, ' '));
  return escapeInvisible(L.join('\n') + '\n');
}
