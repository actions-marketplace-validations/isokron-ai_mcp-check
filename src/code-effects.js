// Code-derived annotation checks (experimental, off unless asked for with --code-effects).
//
// The reader (inputs/repo-effects.cjs) works out what each tool's handler touches; this file compares that with the
// annotations the author declared. The checks are separate from the name-based ones in the engine (annot-write-marked-
// readonly, annot-delete-marked-safe): they never change a section grade, never block, and the result sits in its own
// block (`code_effects`) of the report.
//
// Tiers: `definite` is a sink call reached through resolved calls in the repository; `may` is an opaque client call, a
// dynamic method, an unresolved import, a path that looks temporary, a handler found only by its function name.
// Only `definite` produces an "attention" item; `may` is advice, worded "may write" / "may delete".

export const CODE_EFFECTS_VERSION = 1;
/** The strongest severity any code-derived check may have. */
export const SEVERITY_CAP = 'attention';

export const CODE_CHECKS = [
  {
    id: 'annot-code-writes-marked-readonly', severity: 'attention', section: 'annotations',
    title: 'A tool marked read-only reaches a write, delete, state-changing HTTP call or process execution',
    explain: 'readOnlyHint: true means the tool changes no state (MWS-ANN-1). The handler\'s code, followed through the repository, reaches a sink that does: a file write or delete, a SQL or ORM write, an HTTP POST, PUT, PATCH or DELETE, or a process that is not a known read-only command. The finding names the sink and where it is.',
    fix: 'Set "readOnlyHint": false and choose destructiveHint for what the sink does, or take the sink out of the tool.',
  },
  {
    id: 'annot-code-deletes-marked-safe', severity: 'attention', section: 'annotations',
    title: 'A tool marked non-destructive reaches a delete',
    explain: 'destructiveHint: false means the tool deletes nothing and replaces nothing unnamed (MWS-ANN-2). The handler\'s code reaches a file delete, a SQL DELETE or DROP, an ORM delete or an HTTP DELETE.',
    fix: 'Set "destructiveHint": true.',
  },
  {
    id: 'annot-code-unmarked-write', severity: 'advice', section: 'annotations',
    title: 'A tool that writes or deletes does not declare readOnlyHint',
    explain: 'The handler reaches a write, delete, state-changing HTTP call or process execution, and the tool does not set readOnlyHint, so clients fall back to the protocol default. MWS-ANN-4 asks for explicit hints.',
    fix: 'Set "readOnlyHint": false and an explicit destructiveHint.',
  },
];
const CHECK = Object.fromEntries(CODE_CHECKS.map((c) => [c.id, c]));

const WRITEISH = ['write', 'delete', 'unsafe_http', 'exec'];
const definite = (list) => (list || []).filter((e) => e.confidence === 'definite');
const mayOnly = (list) => (list || []).filter((e) => e.confidence !== 'definite');
const where = (e) => e.file + ':' + e.line;
const uniq = (list) => { const seen = new Set(); return list.filter((e) => { const k = e.file + ':' + e.line + ':' + e.sink; if (seen.has(k)) return false; seen.add(k); return true; }); };
const sinkLabel = (e) => (/^http\.[A-Z]+$/.test(e.sink) ? 'HTTP ' + e.sink.slice(5) : e.sink) + ' at ' + where(e);
/** "a possible write (HTTP POST at src/a.ts:3)": the wording of a may. */
const possibleText = (all) => { const list = uniq(all); const word = list.every((e) => e.kind === 'delete') ? 'delete' : 'write'; return 'a possible ' + word + ' (' + list.slice(0, 3).map(sinkLabel).join('; ') + (list.length > 3 ? '; and ' + (list.length - 3) + ' more' : '') + ')'; };
const sinkText = (all) => { const list = uniq(all); return list.slice(0, 3).map((e) => e.sink + ' at ' + where(e) + (e.via && e.via.length > 1 ? ' (through ' + e.via.slice(1).map((v) => v.split('@')[0]).join(' > ') + ')' : '')).join('; ') + (list.length > 3 ? '; and ' + (list.length - 3) + ' more' : ''); };
const trimEv = (e) => ({ file: e.file, line: e.line, sink: e.sink, confidence: e.confidence, via: e.via, ...(e.note ? { note: e.note } : {}) });

/**
 * The code_effects block for one list read from source.
 * @param {object[]} tools    the graded tools (name, annotations)
 * @param {object} effects    RepoEffects.analyse(...) result carried by the candidate
 */
export function codeEffectsReport(tools, effects, opts = {}) {
  const unreadable = new Set((opts.unreadable && Array.isArray(opts.unreadable.annotations) ? opts.unreadable.annotations : []).map(String));
  const out = { version: CODE_EFFECTS_VERSION, experimental: true, severity_cap: SEVERITY_CAP, summary: null, findings: [], tools: [], limits: (effects && effects.limits) || [], ...(opts.maxSeverity ? { max_severity: opts.maxSeverity } : {}) };
  if (!effects || !effects.tools) { out.summary = { tools: (tools || []).length, analysed: 0, available: false }; return out; }
  const counts = { analysed: 0, handler_not_found: 0, unsupported_language: 0, other: 0 };
  for (const t of tools || []) {
    if (!t || typeof t.name !== 'string') continue;
    const e = effects.tools[t.name];
    const a = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
    const annUnreadable = unreadable.has(t.name);
    const declared = { readOnlyHint: typeof a.readOnlyHint === 'boolean' ? a.readOnlyHint : null, destructiveHint: typeof a.destructiveHint === 'boolean' ? a.destructiveHint : null, idempotentHint: typeof a.idempotentHint === 'boolean' ? a.idempotentHint : null };
    if (!e || e.status !== 'analysed') {
      const st = e ? e.status : 'not_analysed';
      if (st === 'handler_not_found') counts.handler_not_found++; else if (st === 'unsupported_language') counts.unsupported_language++; else counts.other++;
      out.tools.push({ name: t.name, status: st, declared });
      continue;
    }
    counts.analysed++;
    const fx = e.effects;
    const defW = WRITEISH.flatMap((k) => definite(fx[k])); const mayW = WRITEISH.flatMap((k) => mayOnly(fx[k]));
    const defDel = definite(fx.delete); const mayDel = mayOnly(fx.delete);
    const row = {
      name: t.name, status: 'analysed', handler: e.handler, declared, ...(annUnreadable ? { annotations: 'unreadable' } : {}), ...(e.truncated ? { truncated: true } : {}),
      effects: Object.fromEntries(Object.keys(fx).map((k) => [k, { definite: definite(fx[k]).length, may: mayOnly(fx[k]).length, evidence: fx[k].slice(0, 6).map(trimEv) }])),
      derived: e.derived,
    };
    out.tools.push(row);
    const push = (id, severity, confidence, message, path, ev) => out.findings.push({ id, section: 'annotations', severity, confidence, tool: t.name, message, path, evidence: ev.slice(0, 6).map(trimEv), experimental: true });
    if (annUnreadable) { /* the reader could not read this tool's annotations: unknown, never "not declared" */ }
    else {
    if (declared.readOnlyHint === true) {
      if (defW.length) push('annot-code-writes-marked-readonly', 'attention', 'definite', 'readOnlyHint is true but the handler reaches ' + sinkText(defW) + '.', 'annotations.readOnlyHint', defW);
      else if (mayW.length) push('annot-code-writes-marked-readonly', 'advice', 'may', 'readOnlyHint is true and the handler reaches ' + possibleText(mayW) + '.', 'annotations.readOnlyHint', mayW);
    }
    if (declared.destructiveHint === false && declared.readOnlyHint !== true) {
      if (defDel.length) push('annot-code-deletes-marked-safe', 'attention', 'definite', 'destructiveHint is false but the handler reaches ' + sinkText(defDel) + '.', 'annotations.destructiveHint', defDel);
      else if (mayDel.length) push('annot-code-deletes-marked-safe', 'advice', 'may', 'destructiveHint is false and the handler reaches ' + possibleText(mayDel) + '.', 'annotations.destructiveHint', mayDel);
    }
    if (declared.readOnlyHint === null && defW.length) push('annot-code-unmarked-write', 'advice', 'definite', 'readOnlyHint is not set, and the handler reaches ' + sinkText(defW) + '.', 'annotations.readOnlyHint', defW);
    }
  }
  out.findings.forEach((f) => { if (f.severity === 'blocking') f.severity = SEVERITY_CAP; if (opts.maxSeverity === 'advice') f.severity = 'advice'; if (f.confidence !== 'definite' && f.severity !== 'advice') f.severity = 'advice'; });
  out.summary = { tools: (tools || []).length, ...counts, findings: out.findings.length, attention: out.findings.filter((f) => f.severity === 'attention').length, advice: out.findings.filter((f) => f.severity === 'advice').length, depth: effects.summary ? effects.summary.depth : null, truncated: effects.summary ? !!effects.summary.truncated : false };
  return out;
}

/** Lines for the text report: attention items first, then advice, then one line of counts. */
export function codeEffectsText(ce, line = (s) => String(s)) {
  if (!ce) return [];
  const out = ['', 'Code-derived annotations (experimental, read from source, not graded):'];
  if (!ce.summary || ce.summary.available === false) { out.push('  no handler analysis for this list (it was not read from source)'); return out; }
  const s = ce.summary;
  out.push('  ' + s.analysed + ' of ' + s.tools + ' tools: handler read' + (s.handler_not_found ? ', ' + s.handler_not_found + ' handler not found' : '') + (s.unsupported_language ? ', ' + s.unsupported_language + ' in a language not read yet' : '') + '; ' + s.attention + ' attention, ' + s.advice + ' advice.');
  const order = ['attention', 'advice'];
  ce.findings.slice().sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).forEach((f) => out.push('  [' + f.severity + '] ' + line(f.tool, 200) + ': ' + f.id + ': ' + line(f.message, 1500)));
  return out;
}

/** Markdown for the same block. */
export function codeEffectsMarkdown(ce, esc = (x) => String(x)) {
  if (!ce || !ce.summary || ce.summary.available === false) return '';
  const sm = ce.summary;
  const out = ['', '## Code-derived annotations (experimental)', '', esc(sm.analysed + ' of ' + sm.tools + ' tools: handler read; ' + sm.attention + ' attention, ' + sm.advice + ' advice. Read from source, not graded.'), ''];
  ce.findings.forEach((f) => out.push('- [' + f.severity + '] `' + String(f.tool).replace(/`/g, "'") + '`: ' + f.id + ': ' + esc(f.message)));
  return out.join('\n');
}

export function codeCheck(id) { return CHECK[id] || null; }
