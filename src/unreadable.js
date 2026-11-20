// Grading a list read from source when parts of some tools could not be read (a schema built at run time, a
// description from a function call, annotations set by a base class). The reader marks them: an unreadable
// inputSchema is { "type": "object", "x-mcp-check-unknown": true } in the list itself, and the source of a repository
// read names the tools whose description or annotations could not be read. The checks that need an unreadable part
// are skipped for that tool, never graded as if the part were empty, and the section grades are recomputed from the
// findings that remain, with the engine's weights, bands and caps (the engine itself is not changed).
import M from './engine.js';

export const UNKNOWN_MARK = 'x-mcp-check-unknown';
const PARTS = ['inputSchema', 'description', 'annotations'];

// Checks that read the input schema, the description, or the annotations.
const NEEDS = {
  inputSchema: (f) => /^(spec-input-schema-|spec-schema-|spec-ref-remote|spec-composition-bounds|spec-x-mcp-header|anthropic-read-write-split|anthropic-api-docs|anthropic-conversation-data|openai-conversation-input|openai-restricted-input|openai-precise-location|openai-generic-executor|schema-|surface-)/.test(f.id) && f.id !== 'schema-output-schema',
  description: (f) => /^(anthropic-description|openai-description|anthropic-api-docs|anthropic-unsupported-use|openai-retry|design-use-when|design-handle-lifetime)$/.test(f.id),
  annotations: (f) => /^(anthropic-title|anthropic-hint|anthropic-hint-platforms-differ|openai-hints-explicit|openai-retry|openai-readonly-starts-job|openai-readonly-destructive|annot-delete-marked-safe|annot-write-marked-readonly|spec-annotation-key-case|schema-output-schema|surface-)/.test(f.id),
};

/** Map(tool name -> Set(part)) from the schema markers in the list and the names a repository read gives (`extra`). */
export function unreadableParts(tools, extra) {
  const out = new Map();
  const add = (n, p) => { if (!out.has(n)) out.set(n, new Set()); out.get(n).add(p); };
  (tools || []).forEach((t) => { const s = t && t.inputSchema; if (s && typeof s === 'object' && s[UNKNOWN_MARK] === true) add(t.name, 'inputSchema'); });
  if (extra && typeof extra === 'object') PARTS.forEach((p) => { (Array.isArray(extra[p]) ? extra[p] : []).forEach((n) => add(String(n), p)); });
  return out;
}

const GRADED = ['spec', 'anthropic', 'openai', 'security', 'quality'];
const ORDER = ['A', 'B', 'C', 'D', 'F'];
const capAt = (g, cap) => (ORDER.indexOf(g) < ORDER.indexOf(cap) ? cap : g);

/** The section grades of the engine's rubric over per-tool and server findings (the engine's grade(), mirrored). */
export function gradeFindings(perTool, server) {
  const W = M.WEIGHTS;
  const sections = {};
  GRADED.forEach((sec) => {
    const toolScores = perTool.map((t) => Math.max(0, 100 - t.findings.filter((f) => f.affects.includes(sec)).reduce((s, f) => s + W.tool[f.severity], 0)));
    const mean = toolScores.length ? toolScores.reduce((a, b) => a + b, 0) / toolScores.length : 0;
    const sf = server.filter((f) => f.affects.includes(sec));
    const score = Math.max(0, Math.min(100, Math.round(mean - sf.reduce((s, f) => s + W.server[f.severity], 0))));
    const all = perTool.reduce((acc, t) => acc.concat(t.findings.filter((f) => f.affects.includes(sec))), []).concat(sf);
    const counts = { blocking: 0, attention: 0, advice: 0 };
    all.forEach((f) => { counts[f.severity] += 1; });
    const blockedTools = perTool.filter((t) => t.findings.some((f) => f.affects.includes(sec) && f.severity === 'blocking')).length;
    sections[sec] = { name: M.SECTION_NAMES[sec], score, grade: M.letter(score), counts, blockedTools, total: perTool.length, caps: [], ready: counts.blocking === 0 };
  });
  const any = (pred) => perTool.some((t) => t.findings.some(pred)) || server.some(pred);
  GRADED.forEach((sec) => { const s = sections[sec]; if (s.counts.blocking > 0 && ORDER.indexOf(s.grade) < ORDER.indexOf('B')) { s.grade = 'B'; s.caps.push('Capped at B: ' + s.counts.blocking + ' blocking item' + (s.counts.blocking === 1 ? '' : 's') + '.'); } });
  if (any((f) => f.section === 'spec' && f.severity === 'blocking')) ['spec', 'anthropic', 'openai'].forEach((sec) => { const s = sections[sec]; const g = capAt(s.grade, 'C'); if (g !== s.grade) { s.grade = g; s.caps.push('Capped at C: the list fails an MCP specification MUST.'); } });
  if (any((f) => f.section === 'security' && f.severity === 'blocking')) ['security', 'anthropic', 'openai'].forEach((sec) => { const s = sections[sec]; s.grade = 'F'; s.caps.push('F: hidden or injected instructions found; both directories reject these.'); });
  return sections;
}

const sameSection = (a, b) => a && b && a.grade === b.grade && a.score === b.score && JSON.stringify(a.counts) === JSON.stringify(b.counts) && JSON.stringify(a.caps) === JSON.stringify(b.caps);

/**
 * M.analyse with the checks of unreadable parts skipped. `extra` is the reader's { description: [names],
 * annotations: [names], inputSchema: [names] }. Adds r.unreadable = { inputSchema, description, annotations, skipped }
 * when anything was unreadable. When the mirrored grading does not reproduce the engine's (a rubric change), the
 * engine's result is returned unchanged and r.unreadable.regraded is false.
 */
export function analyseList(parsed, extra) {
  const r = M.analyse(parsed);
  const parts = unreadableParts(parsed.tools, extra);
  if (!parts.size) return r;
  const count = (p) => Array.from(parts.values()).filter((s) => s.has(p)).length;
  r.unreadable = { inputSchema: count('inputSchema'), description: count('description'), annotations: count('annotations'), skipped: 0, regraded: false };
  const before = gradeFindings(r.tools, r.server);
  if (!GRADED.every((s) => sameSection(before[s], r.sections[s]))) return r;
  let skipped = 0;
  r.tools.forEach((t) => {
    const ps = parts.get(t.name); if (!ps) return;
    const keep = t.findings.filter((f) => !Array.from(ps).some((p) => NEEDS[p](f)));
    skipped += t.findings.length - keep.length; t.findings = keep;
  });
  const after = gradeFindings(r.tools, r.server);
  GRADED.forEach((s) => { r.sections[s] = Object.assign({}, r.sections[s], after[s]); });
  // Write-surface: recounted without the tools whose schema could not be read.
  const surf = M._internal && M._internal.surface;
  const unknownSchema = new Set(Array.from(parts.entries()).filter(([, s]) => s.has('inputSchema')).map(([n]) => n));
  if (unknownSchema.size && typeof surf === 'function') {
    try {
      const keepIdx = parsed.tools.map((t, i) => (unknownSchema.has(t.name) ? -1 : i)).filter((i) => i >= 0);
      const tools = keepIdx.map((i) => parsed.tools[i]);
      const per = keepIdx.map((i) => Object.assign({}, r.tools[i], { findings: r.tools[i].findings.filter((f) => f.section !== 'surface') }));
      const sur = surf(tools, per);
      const fresh = new Map(keepIdx.map((i, k) => [i, per[k].findings.filter((f) => f.section === 'surface').map((f) => Object.assign(f, { tool: r.tools[i].name }))]));
      r.tools.forEach((t, i) => { t.findings = t.findings.filter((f) => f.section !== 'surface').concat(fresh.get(i) || []); });
      const next = Object.assign({}, r.sections.surface);
      Object.keys(sur || {}).forEach((k) => { if (k !== 'findings') next[k] = sur[k]; });
      r.sections.surface = next;
    } catch (e) { /* keep the engine's surface section */ }
  }
  r.unreadable.skipped = skipped; r.unreadable.regraded = true;
  return r;
}
