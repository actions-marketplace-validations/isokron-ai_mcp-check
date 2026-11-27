// The ast-grep oracle (O3) of the scan-static lane. For a subject's source at one commit it finds the tool-registration
// idioms of each SDK with ast-grep rules (packs/), reads the tool names (and descriptions and annotations where they are
// literal), and says what it found: a tool set, a count and a confidence. It never grades and never gives a verdict.
// Where it cannot read a registration (a computed name, a loop, a table) it reports `unreadable`: that is never a
// disagreement and never a fault of the server. compare() sets the reader's list beside it, in the worker, where the
// names are; only counts, codes and a fingerprint leave it (results/ and observations/ never hold a subject's text).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { GATE, LANGUAGE_OF_RULE, extractMatch, goConstants } from './extract.mjs';
import { PINNED_VERSION, binaryPath, scan } from './run.mjs';
import { EXCLUDED_PATH } from './paths.mjs';

export { PINNED_VERSION };
export const ORACLE_ID = 'ast-grep';
export const FORMAT = 'mcp-check-ast-grep-oracle/1';
/** Files and folders that are not the server's own registrations: tests, examples, vendored and built code. */
export { EXCLUDED_PATH };
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const AFTER = 4000;
const BEFORE = 1200;

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** Reads the matches of one ast-grep run into tools and unreadable registrations. */
export function readMatches(matches, { root, read = (f) => readFileSync(f), size = (f) => statSync(f).size } = {}) {
  const tools = [];
  const unreadable = [];
  let sites = 0;
  const stats = { files: new Set(), gated_out: 0, excluded: 0, too_large: 0, matches: matches.length, composition: false };
  const buffers = new Map();
  const bufferOf = (file) => { if (!buffers.has(file)) { let b = null; try { b = size(file) > MAX_FILE_BYTES ? false : read(file); } catch { b = null; } buffers.set(file, b); } return buffers.get(file); };
  // constants of the repository's Go files, for tools named by a constant
  const goFiles = [...new Set(matches.filter((m) => LANGUAGE_OF_RULE(m.ruleId) === 'go').map((m) => m.file))];
  const constants = goConstants(goFiles.map((f) => bufferOf(isAbsolute(f) ? f : resolve(f))).filter(Boolean).map((b) => b.toString('utf8')));
  for (const m of matches) {
    const abs = isAbsolute(m.file) ? m.file : resolve(m.file);
    const rel = relative(root, abs).split('\\').join('/');
    if (EXCLUDED_PATH.test(rel)) { stats.excluded++; continue; }
    const buf = bufferOf(abs);
    if (buf === false) { stats.too_large++; continue; }
    if (!buf) continue;
    const lang = LANGUAGE_OF_RULE(m.ruleId);
    const fileText = buf.toString('utf8');
    if (!GATE[lang].test(fileText)) { stats.gated_out++; continue; }
    // FastMCP's mount(prefix, server) and import_server() put other servers' tools under a prefix: a function's own name is then not its wire name
    if (m.ruleId === 'py-compose') { stats.composition = true; continue; }
    const start = m.range.byteOffset.start;
    const end = m.range.byteOffset.end;
    const rec = extractMatch({
      ruleId: m.ruleId, text: m.text,
      before: buf.subarray(Math.max(0, start - BEFORE), start).toString('utf8'),
      after: buf.subarray(end, end + AFTER).toString('utf8'),
      fileText,
    }, { constants });
    stats.files.add(rel);
    for (const r of rec) {
      const at = { file: rel, line: m.range.start.line + 1 };
      if (r.site) { sites++; continue; }
      if (r.unreadable) unreadable.push({ ...r, ...at }); else tools.push({ ...r, ...at });
    }
  }
  // Go: an AddTool call that registers something the rules did not read (a variable, a table, a loop) is unreadable
  const goNamed = tools.filter((t) => t.idiom.startsWith('go-')).length + unreadable.filter((u) => u.idiom.startsWith('go-')).length;
  const goSites = matches.filter((m) => m.ruleId === 'go-add-tool' && !EXCLUDED_PATH.test(relative(root, isAbsolute(m.file) ? m.file : resolve(m.file)).split('\\').join('/')) && bufferOf(isAbsolute(m.file) ? m.file : resolve(m.file)) && GATE.go.test(bufferOf(isAbsolute(m.file) ? m.file : resolve(m.file)).toString('utf8'))).length;
  for (let i = goNamed; i < goSites; i++) unreadable.push({ idiom: 'go-add-tool', unreadable: 'registration_not_read', file: null, line: null });
  return { tools, unreadable, stats: { ...stats, files: stats.files.size } };
}

/**
 * The oracle's answer for one subject: what it read. status: `read` (at least one tool name), `none` (no registration
 * idiom matched: this says nothing about the server), `unreadable` (registrations seen, no name readable) or `error`
 * (ast-grep did not run). confidence: `high` (every registration read, names written out in the source), `medium`
 * (names derived from a function name or a constant, or some registrations unreadable), `low` (most unreadable).
 */
export function summarize({ tools, unreadable, stats }, { error = null, version = PINNED_VERSION } = {}) {
  const byName = new Map();
  for (const t of tools) {
    const prior = byName.get(t.name);
    if (!prior) byName.set(t.name, { ...t, idioms: [t.idiom] });
    else { if (!prior.idioms.includes(t.idiom)) prior.idioms.push(t.idiom); if (!prior.description && t.description) prior.description = t.description; if (!prior.annotations && t.annotations) prior.annotations = t.annotations; }
  }
  const unique = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sources = { literal: 0, const: 0, function_name: 0, derived: 0 };
  for (const t of unique) sources[t.name_source] = (sources[t.name_source] ?? 0) + 1;
  const unreadableCount = unreadable.length;
  let status;
  let confidence = null;
  if (error) status = 'error';
  else if (unique.length) {
    status = 'read';
    const weak = sources.derived + sources.const;
    const ratio = unreadableCount / (unique.length + unreadableCount);
    confidence = unreadableCount === 0 && weak === 0 ? 'high' : ratio > 0.5 ? 'low' : 'medium';
    if (stats.composition && sources.function_name > 0) confidence = 'low';
  } else status = unreadableCount ? 'unreadable' : 'none';
  const idioms = [...new Set(unique.flatMap((t) => t.idioms).concat(unreadable.map((u) => u.idiom)).filter(Boolean))].sort();
  return {
    format: FORMAT, oracle: ORACLE_ID, version, status, error, confidence, composition: stats.composition === true,
    tool_count: unique.length, unreadable_count: unreadableCount, name_sources: sources, idioms,
    languages: [...new Set(idioms.map((i) => LANGUAGE_OF_RULE(i)).filter(Boolean))].sort(),
    files_with_registrations: stats.files, files_excluded: stats.excluded, files_gated_out: stats.gated_out,
    tool_set_sha256: unique.length ? sha(unique.map((t) => t.name)) : null,
    tools: unique, unreadable,
  };
}

const bucket = (n) => (n <= 1 ? '1' : n <= 3 ? '2-3' : n <= 9 ? '4-9' : '10+');

/**
 * Sets the reader's tool names beside the oracle's. `reader`: { names: string[]|null, status: 'graded'|'skipped',
 * detail }. Returns disagreement entries (no names, only counts and codes): D1 static_missing (the oracle read a tool
 * the reader does not list) and D2 static_phantom (the reader lists a tool the oracle did not read). Only a `read`
 * answer is compared. D2 needs the oracle to have read every registration (confidence high); D1 also with medium. A
 * reader that found nothing is compared as an empty list; a reader that did not read the subject (several servers, a
 * subject that could not be fetched) is not compared.
 */
export function compare(oracle, reader) {
  const out = { entries: [], missing: [], phantom: [], compared: false, why: null };
  if (oracle.status !== 'read') { out.why = 'oracle_' + oracle.status; return out; }
  if (oracle.confidence === 'low') { out.why = oracle.composition ? 'oracle_composed_servers' : 'oracle_low_confidence'; return out; }
  const readerOk = reader && ((reader.status === 'graded' && Array.isArray(reader.names)) || (reader.status === 'skipped' && ['no_tools', 'names_only', 'unsupported_language'].includes(reader.detail)));
  if (!readerOk) { out.why = 'reader_not_comparable'; return out; }
  out.compared = true;
  const theirs = new Set(reader.status === 'graded' ? reader.names : []);
  const ours = new Set(oracle.tools.map((t) => t.name));
  const missing = oracle.tools.filter((t) => !theirs.has(t.name));
  const phantom = [...theirs].filter((n) => !ours.has(n));
  out.missing = missing.map((t) => t.name);
  out.phantom = phantom;
  const layout = bucket(new Set(oracle.tools.map((t) => t.file)).size);
  const readerState = reader.status === 'graded' ? 'graded' : reader.detail;
  const make = (cls, direction, count, idioms) => {
    const parts = { tool: 'mcp-check', component: 'reader', oracle: ORACLE_ID, class: cls, idiom: [...idioms].sort().join('+'), layout, signature: direction + ':' + bucket(count) + ':' + readerState };
    return {
      class: cls, kind: 'tool_set', oracles: [ORACLE_ID, 'reader'], attribution: 'tool', direction, confidence: oracle.confidence,
      count, ast_grep_count: oracle.tool_count, reader_count: theirs.size, fingerprint: sha(parts).slice(0, 12),
    };
  };
  if (missing.length) out.entries.push(make('D1', 'reader_missing', missing.length, new Set(missing.flatMap((t) => t.idioms))));
  if (phantom.length && oracle.confidence === 'high') out.entries.push(make('D2', 'reader_phantom', phantom.length, new Set(oracle.idioms)));
  return out;
}

/**
 * The whole oracle step for one subject: fetches the source (fetchSource), scans, summarises and compares. Never throws.
 * Returns { summary, comparison, raw } where summary has no subject text outside `tools` and `unreadable` (raw only).
 */
export async function runOracle({ repo, sha: commit, reader, fetchSource, binary = binaryPath(), timeoutMs = 30_000, scanImpl = scan }) {
  const empty = (error) => ({ summary: summarize({ tools: [], unreadable: [], stats: { files: 0, excluded: 0, gated_out: 0 } }, { error }), comparison: { entries: [], missing: [], phantom: [], compared: false, why: 'oracle_error' } });
  if (!binary) return empty('binary_missing');
  let src;
  try { src = await fetchSource(repo, commit); } catch (e) { return empty(e && e.code === 'timeout' ? 'timeout' : 'source_not_fetched'); }
  try {
    const found = await scanImpl({ binary, target: src.dir, timeoutMs });
    if (found.error) return empty(found.error);
    const summary = summarize(readMatches(found.matches, { root: src.dir }));
    return { summary, comparison: compare(summary, reader) };
  } catch {
    return empty('oracle_failed');
  } finally {
    src.cleanup();
  }
}
