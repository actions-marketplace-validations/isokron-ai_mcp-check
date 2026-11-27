// How the oracle joins a scan-static bundle (corpus/scan-static.mjs calls these and nothing else of the oracle). Off unless the
// caller turns it on (SCAN_STATIC_AST_GREP=1 in the workflow, from the repository variable LANE_SCAN_STATIC_AST_GREP). It adds
// a block to results/scan-static.json, a component to the manifest, an `oracle_disagreements` field record when the
// reader and the oracle differ, and one raw/ file with the names; it changes nothing the reader said.
import { fetchSource } from './source.mjs';
import { ORACLE_ID, PINNED_VERSION, runOracle } from './index.mjs';

/** Subject outcomes the oracle runs for: a graded list, or a reader that found no list in a language the oracle reads. */
export const COMPARABLE_DETAIL = Object.freeze(['no_tools', 'names_only']);

/** The reader's tool names as the worker's raw/subject/tools.json text holds them, or null when they are not all there. */
export function readerNamesOf(scan) {
  const text = scan && scan.rawFiles && scan.rawFiles.files && scan.rawFiles.files['raw/subject/tools.json'];
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return null; // cut to the raw cap: the reader's list is not whole here
    return v.map((t) => (t && typeof t === 'object' ? t.name : null)).filter((n) => typeof n === 'string');
  } catch { return null; }
}

/** Whether the oracle runs for this scan, and the reader view it compares against. */
export function eligible(scan) {
  if (!scan || !scan.commit || !/^[0-9a-f]{40}$/.test(scan.commit.sha || '')) return null;
  if (scan.status === 'graded') { const names = readerNamesOf(scan); return { status: names ? 'graded' : 'skipped', detail: names ? null : 'raw_truncated', names }; }
  if (scan.status === 'skipped' && COMPARABLE_DETAIL.includes(scan.detail)) return { status: 'skipped', detail: scan.detail, names: [] };
  return null;
}

/**
 * Runs the oracle for one scanned subject; resolves the parts the bundle takes, or null when it does not run for it.
 * Never throws: a failure is an `error` status, which is not a disagreement.
 */
export async function oracleForScan(item, scan, { fetchSource: fetchImpl = fetchSource, runImpl = runOracle, binary, timeoutMs } = {}) {
  const reader = eligible(scan);
  if (!reader) return null;
  const repo = scan.raw && scan.raw.repo && typeof scan.raw.repo.full_name === 'string' ? scan.raw.repo.full_name : item.repo;
  let out;
  try {
    out = await runImpl({ repo: item.repo || repo, sha: scan.commit.sha, reader, fetchSource: fetchImpl, ...(binary !== undefined ? { binary } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  } catch { return null; }
  return partsOf(out.summary, out.comparison, reader);
}

/** What goes into the bundle, from a summary and a comparison (no subject text outside `raw`). */
export function partsOf(summary, comparison, reader) {
  const fact = {
    oracle: ORACLE_ID, version: summary.version, status: summary.status, error: summary.error, confidence: summary.confidence,
    tool_count: summary.tool_count, unreadable_count: summary.unreadable_count, name_sources: summary.name_sources,
    idioms: summary.idioms, languages: summary.languages, tool_set_sha256: summary.tool_set_sha256,
    compared: comparison.compared, not_compared: comparison.compared ? null : comparison.why,
    reader_count: reader && Array.isArray(reader.names) ? reader.names.length : null,
    missing_from_reader: comparison.compared ? comparison.missing.length : null,
    not_in_oracle: comparison.compared ? comparison.phantom.length : null,
  };
  return {
    fact,
    entries: comparison.entries,
    component: { name: ORACLE_ID, version: PINNED_VERSION },
    raw: { oracle: ORACLE_ID, version: summary.version, tools: summary.tools, unreadable: summary.unreadable, missing_from_reader: comparison.missing, not_in_oracle: comparison.phantom },
    log: 'ast-grep ' + summary.version + ': ' + summary.status + (summary.confidence ? ' (' + summary.confidence + ')' : '') + ', ' + summary.tool_count + ' tools, ' + summary.unreadable_count + ' unreadable'
      + (comparison.compared ? '; ' + comparison.missing.length + ' missing from the reader, ' + comparison.phantom.length + ' not in the oracle' : '; not compared (' + comparison.why + ')'),
  };
}
