// Tool handlers as plain functions: no transport, no network, no file access. server.js registers them.
import M from './engine.js';
import { readList, InputError, MAX_TOOLS } from './limits.js';
import { analyseList } from './unreadable.js';

export const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];
export const GRADES = ['A', 'B', 'C', 'D', 'F'];
export const MAX_FINDINGS = 500;
export const DEFAULT_LIMIT = 100;

export function parseList(value, label) {
  const text = readList(value, label);
  const parsed = M.parseInput(text);
  if (parsed.error) throw new InputError(parsed.errorType || 'bad_input', label + ': ' + parsed.error);
  if (parsed.tools.length > MAX_TOOLS) throw new InputError('too_many_tools', label + ' has ' + parsed.tools.length + ' tools; the limit is ' + MAX_TOOLS + '.');
  return parsed;
}

const below = (g, min) => g != null && GRADES.indexOf(g) > GRADES.indexOf(min);

export function checkToolsList({ tools_list, sections, min_grade, limit = DEFAULT_LIMIT, include_fixed_list = true }) {
  const cap = Math.max(1, Math.min(MAX_FINDINGS, limit));
  const want = sections && sections.length ? SECTIONS.filter((s) => sections.includes(s)) : SECTIONS.slice();
  const parsed = parseList(tools_list, 'tools_list');
  const r = analyseList(parsed); // a list saved from a source read marks schemas it could not read; their checks are skipped
  const byName = new Map(parsed.tools.map((t) => [t.name, t]));

  const secOut = want.map((id) => {
    const s = r.sections[id];
    // surface has no grade (rubric 2.2.0): grade and score are null and note carries its guard coverage.
    const base = { id, name: s.name, grade: s.grade ?? null, score: s.score ?? null, ready: id === 'surface' ? null : s.ready, counts: s.counts || null, caps: s.caps || [], note: id === 'surface' ? 'Advice only, not graded. ' + (s.why || '') : s.why || null };
    return id === 'surface' ? Object.assign(base, { state: s.state, coverage: s.coverage }) : base;
  });

  const all = M.allFindings(r).filter((f) => f.affects.some((a) => want.includes(a)));
  const order = { blocking: 0, attention: 1, advice: 2 };
  all.sort((a, b) => order[a.severity] - order[b.severity]);
  const findings = all.slice(0, cap).map((f) => {
    const c = M.CHECK[f.id];
    const tool = f.tool ? byName.get(f.tool) : null;
    return {
      id: f.id, severity: f.severity, section: f.section, tool: f.tool || null, message: f.message, path: f.path || null,
      title: c.title, docs: c.docs, fix: c.fix, fix_snippet: tool ? M.snippetFor(tool, f) : null,
    };
  });

  const fixed = M.fixCatalog(parsed);
  const failing = min_grade ? secOut.filter((s) => below(s.grade, min_grade)).map((s) => s.id + ' ' + s.grade) : [];
  const counts = { blocking: 0, attention: 0, advice: 0 };
  all.forEach((f) => { counts[f.severity] += 1; });

  const report = {
    rubric_version: r.rubric_version,
    report_schema: r.report_schema,
    spec_version: r.spec_version,
    sources_read: r.sources_read,
    input: { tools: r.input.tools, skipped: r.input.skipped, era: r.input.era, catalog_hash: r.input.catalogHash },
    sections: secOut,
    min_grade: min_grade || null,
    passed: failing.length === 0,
    below_min_grade: failing,
    counts,
    findings,
    findings_truncated: all.length > findings.length,
    suggested_fixes: { changes: fixed.changes, tools_list: include_fixed_list ? JSON.parse(fixed.json) : null },
    tool_hashes: r.tools.map((t) => ({ name: t.name, sha256: t.hash })),
  };

  const lines = [
    'MCP check (rubric ' + r.rubric_version + ', ' + r.input.tools + ' tools): ' + [secOut.filter((s) => s.id !== 'surface').map((s) => s.id + ' ' + (s.grade || 'n/a')).join(', ')].filter(Boolean).concat(want.includes('surface') ? ['write surface (advice, not graded): ' + (r.sections.surface.why || '')] : []).join('; ') + (/[.]$/.test(r.sections.surface.why || '') && want.includes('surface') ? '' : '.'),
    counts.blocking + ' blocking, ' + counts.attention + ' attention, ' + counts.advice + ' advice findings' + (findings.length ? '; check docs at ' + M.DOCS_BASE + '<id>.' : '.') + (all.length > findings.length ? ' Showing ' + findings.length + ' of ' + all.length + ' (raise limit for more).' : ''),
  ];
  findings.filter((f) => f.severity === 'blocking').slice(0, 5).forEach((f) => lines.push('- ' + (f.tool || '(list)') + ': ' + f.id + ': ' + f.message));
  if (min_grade) lines.push(failing.length ? 'Below min_grade ' + min_grade + ': ' + failing.join(', ') + '.' : 'Every section meets min_grade ' + min_grade + '.');
  if (fixed.changes.length) lines.push(fixed.changes.length + ' suggested fixes are in suggested_fixes; review the ones marked review: true.');
  return { report, text: lines.join('\n') };
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export function explainCheck({ check_id: id }) {
  const c = M.CHECK[id];
  if (!c) {
    const near = M.CHECKS.map((x) => [x.id, editDistance(id, x.id)]).filter(([, d]) => d <= Math.max(3, Math.floor(id.length / 3))).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([x]) => x);
    throw new InputError('unknown_check', 'No check has the id "' + id + '".' + (near.length ? ' Close matches: ' + near.join(', ') + '.' : ' Check ids appear in check_tools_list findings.'));
  }
  const doc = {
    id: c.id, title: c.title, section: c.section, affects: c.affects, severity: c.severity,
    source_quote: c.quote, source: c.source, source_title: c.sourceTitle,
    explanation: c.explain, fix: c.fix, example: c.example || null, docs: c.docs, rubric_version: M.RUBRIC_VERSION,
  };
  const text = c.id + ' (' + c.severity + ', ' + c.section + '): ' + c.title + '.\nSource: "' + c.quote + '" (' + c.sourceTitle + ')\nFix: ' + c.fix + '\nDocs: ' + c.docs;
  return { report: doc, text };
}

export function compareToolsLists({ before, after }) {
  const a = parseList(before, 'before');
  const b = parseList(after, 'after');
  const d = M.diffCatalogs(a.tools, b.tools);
  const hash = (p) => M.sha256(M.canonical(p.tools));
  const report = {
    before: { tools: a.tools.length, catalog_hash: hash(a) },
    after: { tools: b.tools.length, catalog_hash: hash(b) },
    identical: hash(a) === hash(b),
    added: d.added.map((x) => ({ name: x.name, readOnlyHint: x.readOnlyHint ?? null, destructiveHint: x.destructiveHint ?? null })),
    removed: d.removed,
    changed: d.changed.map((c) => ({ name: c.name, old_hash: c.oldHash, new_hash: c.newHash, changes: c.changes.map((x) => ({ field: x.field, risk: x.risk, from: x.from === undefined ? null : x.from, to: x.to === undefined ? null : x.to, note: x.note || null })) })),
    unchanged: d.unchanged,
    high_risk: d.highRisk,
  };
  const text = report.identical
    ? 'The two lists are identical (catalog hash ' + report.after.catalog_hash.slice(0, 12) + ').'
    : d.added.length + ' added, ' + d.removed.length + ' removed, ' + d.changed.length + ' changed, ' + d.unchanged + ' unchanged.' +
      (d.highRisk.length ? ' HIGH RISK (a client may now run these with less confirmation): ' + d.highRisk.join(', ') + '.' : ' No high-risk annotation changes.');
  return { report, text };
}
