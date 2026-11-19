#!/usr/bin/env node
// Grades the tools/list answers recorded by the corpus runner, one JSON line per target.
//
//   node corpus/grade.mjs <out-dir>                 grade every <out-dir>/<target-id>/surface.json
//   node corpus/grade.mjs summarize <dataset.jsonl>  grade and check counts over a dataset (no target ids)
//
// Input: the run folder of isokron-ai/mcp-writecheck-action's corpus driver (corpus/run-shard.mjs), one
// folder per target id holding surface.json ({ initialize, tools, captured_at, ... }, where tools is the
// tools/list result with every page's tools joined) and meta.json. The same files are in the encrypted
// bundles of earlier writecheck corpus runs, so those can be graded too, once decrypted on IsoKron's machine.
//
// The input is untrusted (a server under test wrote it): every read is size-capped, the tool list goes
// through the MCP server's input limits (2 MiB of JSON, 64 levels, 2,000 tools), and a target that
// fails any of that gets a record with an error and no grades. Nothing is fetched, nothing is written
// but stdout. In CI this runs in a container with no network and a read-only root (corpus/grade-shard.sh).
import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import M from '../src/engine.js';
import { readList, InputError, MAX_TOOLS } from '../src/limits.js';
import { VERSION } from '../src/version.js';

export const FORMAT = 'isokron-mcp-check-corpus/1';
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** surface.json files over this size are not read (the probe reads at most 12 MiB of server output). */
export const SURFACE_CAP = 16 * 1024 * 1024;
export const META_CAP = 4 * 1024 * 1024;
const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];

const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : null);

function readCapped(file, cap) {
  const st = lstatSync(file);
  if (!st.isFile()) throw new InputError('not_file', file.split('/').pop() + ' is not a regular file');
  if (st.size > cap) throw new InputError('too_large', file.split('/').pop() + ' is ' + st.size + ' bytes; the cap is ' + cap);
  return readFileSync(file, 'utf8');
}

/** One dataset record for one target folder. Never throws: problems become `error`. */
export function gradeTarget(dir, id, { gradedAt } = {}) {
  const rec = {
    format: FORMAT, target: id, graded_at: gradedAt || new Date().toISOString(),
    engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION, sources_read: M.SOURCES_READ,
    surface: null, server_info: null, tool_count: null, catalog_hash: null, era: null,
    sections: null, check_counts: null, findings: null, error: null,
  };
  try {
    // meta.json (the driver's record) is optional here; only a few typed fields are kept from it.
    try {
      const meta = JSON.parse(readCapped(join(dir, 'meta.json'), META_CAP));
      const s = meta && typeof meta === 'object' ? meta.surface : null;
      if (s && typeof s === 'object') rec.surface = { sha256_jcs: str(s.sha256_jcs, 64), protocol_version: str(s.protocol_version, 64), tools_pages: Number.isInteger(s.tools_pages) ? s.tools_pages : null };
    } catch { /* no or unreadable meta.json: grade from surface.json alone */ }

    let doc;
    try { doc = JSON.parse(readCapped(join(dir, 'surface.json'), SURFACE_CAP)); } catch (e) {
      if (e instanceof InputError) throw e;
      if (e && e.code === 'ENOENT') throw new InputError('no_surface', 'no surface.json (the server did not answer tools/list)');
      throw new InputError('not_json', 'surface.json is not JSON');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new InputError('bad_surface', 'surface.json is not an object');
    rec.surface = Object.assign(rec.surface || {}, { captured_at: str(doc.captured_at, 64) });
    const si = doc.initialize && typeof doc.initialize === 'object' ? doc.initialize.serverInfo : null;
    if (si && typeof si === 'object') rec.server_info = { name: str(si.name, 256), version: str(si.version, 64) };
    if (doc.tools === null || doc.tools === undefined) throw new InputError('no_tools', 'surface.json holds no tools/list result');

    const text = readList(doc.tools, 'tools');
    const parsed = M.parseInput(text);
    if (parsed.error) throw new InputError(parsed.errorType || 'bad_input', parsed.error);
    if (parsed.tools.length > MAX_TOOLS) throw new InputError('too_many_tools', parsed.tools.length + ' tools; the limit is ' + MAX_TOOLS);
    const r = M.analyse(parsed);
    rec.tool_count = r.input.tools;
    rec.catalog_hash = r.input.catalogHash;
    rec.era = r.input.era;
    rec.sections = Object.fromEntries(SECTIONS.map((k) => {
      const s = r.sections[k];
      return [k, { grade: s.grade || null, score: s.score ?? null, ready: k === 'surface' ? null : s.ready ?? null, counts: s.counts || null, caps: s.caps || [] }];
    }));
    const all = M.allFindings(r);
    rec.check_counts = {};
    for (const f of all) rec.check_counts[f.id] = (rec.check_counts[f.id] || 0) + 1;
    rec.findings = all.map((f) => ({ id: f.id, severity: f.severity, tool: f.tool || null, path: f.path || null }));
  } catch (e) {
    rec.error = e instanceof InputError ? { code: e.code, message: e.message } : { code: 'grader_error', message: String(e && e.message || e).slice(0, 300) };
  }
  return rec;
}

/** Records for every target folder in `out` (folders whose name is not a target id, e.g. _shard, are skipped). */
export function gradeRun(out, opts = {}) {
  return readdirSync(out).filter((n) => ID_RE.test(n)).sort().filter((n) => {
    try { return lstatSync(join(out, n)).isDirectory(); } catch { return false; }
  }).map((n) => gradeTarget(join(out, n), n, opts));
}

/** Aggregate over records: grade distribution per section and how many targets each check fires on. No target ids. */
export function summarize(records) {
  const graded = records.filter((r) => !r.error);
  const dist = Object.fromEntries(SECTIONS.map((k) => [k, {}]));
  const fires = {};
  for (const r of graded) {
    for (const k of SECTIONS) { const g = r.sections[k].grade || 'not graded'; dist[k][g] = (dist[k][g] || 0) + 1; }
    for (const id of Object.keys(r.check_counts)) fires[id] = (fires[id] || 0) + 1;
  }
  const errors = {};
  for (const r of records.filter((x) => x.error)) errors[r.error.code] = (errors[r.error.code] || 0) + 1;
  return {
    format: FORMAT + '#summary', rubric_versions: [...new Set(records.map((r) => r.rubric_version))],
    targets: records.length, graded: graded.length, errors,
    tools: graded.reduce((n, r) => n + r.tool_count, 0),
    grades: dist,
    checks_by_targets: Object.fromEntries(Object.entries(fires).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (a === 'summarize' && b) {
    const recs = readFileSync(b, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    process.stdout.write(JSON.stringify(summarize(recs), null, 2) + '\n');
  } else if (a && !b) {
    if (!statSync(a).isDirectory()) { process.stderr.write('not a folder: ' + a + '\n'); process.exit(2); }
    for (const rec of gradeRun(a, { gradedAt: process.env.MCP_CHECK_GRADED_AT || undefined })) process.stdout.write(JSON.stringify(rec) + '\n');
  } else {
    process.stderr.write('usage: node corpus/grade.mjs <out-dir> | summarize <dataset.jsonl>\n');
    process.exit(2);
  }
}
