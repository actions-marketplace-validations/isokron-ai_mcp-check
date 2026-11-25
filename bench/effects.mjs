#!/usr/bin/env node
// Scores the code-derived annotation checks (src/code-effects.js) against hand labels (bench/effects/truth.json) on the
// small servers in bench/effects/cases. Separate from the main benchmark (bench/run.mjs, bench/gate.mjs): its cases are
// not part of the case-set hash, and nothing here is gated yet.
//
//   node bench/effects.mjs [--depth N] [--json] [--md]
//
// For each tool: the declared hints (from the list the reader found) and the label (state_change, deletes).
//   positive for annot-code-writes-marked-readonly:  readOnlyHint true and state_change
//   positive for annot-code-deletes-marked-safe:     destructiveHint false, readOnlyHint not true, deletes
// A prediction is an "attention" finding of that check (definite). A "may" finding is advice and never counts as a hit;
// a positive that gets only advice is reported as downgraded. The name-based checks run on the same tools for comparison.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeEffectsReport } from '../src/code-effects.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { wilson } from './lib/score.mjs';

const require = createRequire(import.meta.url);
const Repo = require('../src/inputs/repo-source.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const CASES = join(here, 'effects', 'cases');
const CHECKS = ['annot-code-writes-marked-readonly', 'annot-code-deletes-marked-safe'];
const NAME_OF = { 'annot-code-writes-marked-readonly': 'annot-write-marked-readonly', 'annot-code-deletes-marked-safe': 'annot-delete-marked-safe' };

export async function score({ depth = 3, casesDir = CASES, truthFile = join(here, 'effects', 'truth.json') } = {}) {
  const truth = JSON.parse(readFileSync(truthFile, 'utf8')).tools;
  const rows = [];
  for (const c of readdirSync(casesDir).sort()) {
    const r = await Repo.fromDirectory(join(casesDir, c), { effects: true, effectsDepth: depth });
    const best = r.best;
    if (!best) throw new Error('no tools read in case ' + c);
    const parsed = parseList(best.tools, 'case ' + c);
    const rep = analyseList(parsed, { unreadable: best.unreadable || {}, unresolved: best.unresolved || [] });
    const ce = codeEffectsReport(parsed.tools, best.effects, { unreadable: best.unreadable });
    for (const t of parsed.tools) {
      const key = c + '/' + t.name; const lab = truth[key];
      if (!lab) throw new Error('no label for ' + key);
      const a = t.annotations || {};
      const found = (id) => ce.findings.filter((f) => f.tool === t.name && f.id === id);
      const nameFind = (id) => (rep.tools.find((x) => x.name === t.name) || { findings: [] }).findings.some((f) => f.id === NAME_OF[id]);
      const row = { key, case: c, tool: t.name, label: lab, declared: { readOnlyHint: a.readOnlyHint ?? null, destructiveHint: a.destructiveHint ?? null }, status: (ce.tools.find((x) => x.name === t.name) || {}).status, checks: {} };
      for (const id of CHECKS) {
        const positive = id === CHECKS[0] ? a.readOnlyHint === true && lab.state_change : a.destructiveHint === false && a.readOnlyHint !== true && lab.deletes;
        const fs = found(id);
        row.checks[id] = { positive, ambiguous: !!lab.ambiguous, attention: fs.some((f) => f.severity === 'attention'), advice: fs.some((f) => f.severity === 'advice'), name_based: nameFind(id) };
      }
      rows.push(row);
    }
  }
  return { depth, rows, summary: summarise(rows) };
}

function tally(rows, id, pick) {
  let tp = 0, fp = 0, fn = 0, tn = 0, down = 0;
  for (const r of rows) { const c = r.checks[id]; const pred = pick(c); if (c.positive && pred) tp++; else if (!c.positive && pred) fp++; else if (c.positive && !pred) { fn++; if (c.advice) down++; } else tn++; }
  return { tp, fp, fn, tn, downgraded_to_advice: down, precision: wilson(tp, tp + fp), recall: wilson(tp, tp + fn) };
}
function summarise(rows) {
  const out = {};
  for (const id of CHECKS) {
    const lenient = rows.filter((r) => !r.label.ambiguous);
    out[id] = {
      positives: rows.filter((r) => r.checks[id].positive).length,
      code_lenient: tally(lenient, id, (c) => c.attention),
      code_strict: tally(rows.map((r) => (r.label.ambiguous ? { ...r, checks: { [id]: { ...r.checks[id], positive: false } } } : r)), id, (c) => c.attention),
      name_based: tally(lenient, id, (c) => c.name_based),
      union: tally(lenient, id, (c) => c.name_based || c.attention),
    };
  }
  out.tools = rows.length; out.ambiguous = rows.filter((r) => r.label.ambiguous).map((r) => r.key);
  out.not_analysed = rows.filter((r) => r.status !== 'analysed').map((r) => r.key);
  return out;
}

const pct = (w) => (w ? (w.p * 100).toFixed(0) + '% (' + (w.lo * 100).toFixed(0) + ' to ' + (w.hi * 100).toFixed(0) + ', ' + w.k + '/' + w.n + ')' : 'n/a');
export function markdown(res) {
  const s = res.summary; const out = ['# Code-derived annotation checks: first score', '', 'Depth ' + res.depth + ', ' + s.tools + ' tools, ' + s.ambiguous.length + ' ambiguous, ' + s.not_analysed.length + ' without a handler found. Wilson 95% intervals.', ''];
  for (const id of CHECKS) {
    const x = s[id];
    out.push('## ' + id, '', x.positives + ' labelled positives (declared hint contradicted by the code).', '', '| Detector | TP | FP | FN | Precision | Recall |', '|---|---|---|---|---|---|');
    [['code (attention), ambiguous tools left out', x.code_lenient], ['code (attention), ambiguous counted as wrong', x.code_strict], ['name-based check on the same tools', x.name_based], ['either', x.union]].forEach(([n, t]) => out.push('| ' + n + ' | ' + t.tp + ' | ' + t.fp + ' | ' + t.fn + ' | ' + pct(t.precision) + ' | ' + pct(t.recall) + ' |'));
    out.push('', 'Positives the code check saw only as advice ("may"): ' + x.code_lenient.downgraded_to_advice + '.', '');
  }
  const miss = res.rows.filter((r) => CHECKS.some((id) => r.checks[id].positive && !r.checks[id].attention));
  out.push('## Positives the code check did not report as attention', '', ...miss.map((r) => '- ' + r.key + ': ' + r.label.why + (CHECKS.some((id) => r.checks[id].positive && r.checks[id].advice) ? ' (advice only)' : '')), '');
  const fp = res.rows.filter((r) => CHECKS.some((id) => !r.checks[id].positive && r.checks[id].attention));
  out.push('## Attention findings on tools that are not positives', '', ...(fp.length ? fp.map((r) => '- ' + r.key + (r.label.ambiguous ? ' (ambiguous: ' + r.label.why + ')' : ': ' + r.label.why)) : ['none']), '');
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const di = a.indexOf('--depth');
  const res = await score({ depth: di >= 0 ? Number(a[di + 1]) : 3 });
  process.stdout.write(a.includes('--json') ? JSON.stringify(res, null, 2) + '\n' : markdown(res));
}
