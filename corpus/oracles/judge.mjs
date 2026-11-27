/**
 * Judges one target's oracle record (corpus/oracles/run.mjs, oracles.json) against our own reader's result, for the
 * live-probe bundle (corpus/LIVE-PROBE.md, "Oracles"). Pure: no files, no network.
 *
 * - Each SDK client's catalog is hashed with this repository's engine, exactly as our reader's list is (the catalog
 *   hash of `mcp-check -- <server>`), once more with the annotations that only state the spec's default left out, and
 *   by its tool names alone, so a difference can be told apart: names, the definitions behind the same names, or only
 *   a default the client's SDK wrote out (`catalog_vs_reader: same_but_annotation_defaults`, no disagreement).
 * - Each conformance check gets one status: pass, fail, warning, info, skipped; expected_fail when the subject's
 *   baseline lists that failure; bridge_excluded when the check is about the bridge, not the server (pins.json);
 *   not_applicable when a list method the server never declared answered "method not found".
 * - Disagreements between oracles are recorded with the design's classes (DESIGN-v3 §7): D4 schema_mismatch (same
 *   names, different definitions), D6 live_client (one oracle lists, another does not, or the names differ), D7
 *   lint_vs_conformance (the suite's tool-name check against our engine's), D12 crash/timeout (an oracle timed out
 *   or crashed where another listed). They are evidence for triage, never a verdict.
 *
 * Every string this returns outside `raw` is ours (codes, ids, hashes, counts, SDK versions) or the suite's check
 * ids, which are checked against a strict pattern.
 */
import { createHash } from 'node:crypto';
import M from '../../src/engine.js';

export const ORACLE_FORMAT = 'isokron-live-probe-oracles/1';
const CHECK_ID_RE = /^[a-z0-9][a-z0-9:._-]{0,95}$/;
const SCENARIO_RE = /^[a-z0-9][a-z0-9/._-]{0,95}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
/**
 * The protocol versions a field may name: the specification's revisions. Anything else a server's answer makes a
 * client report is `other` (the text stays in raw/): a server must not be able to put a string of its choosing here.
 */
export const PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const protocolOf = (v) => (typeof v !== 'string' ? null : PROTOCOL_VERSIONS.includes(v) ? v : 'other');
const OUTCOMES = ['listed', 'init_failed', 'list_failed', 'timeout', 'client_error', 'unavailable', 'skipped'];
const STATUS = { SUCCESS: 'pass', FAILURE: 'fail', WARNING: 'warning', INFO: 'info', SKIPPED: 'skipped' };
const SEVERITY = ['SKIPPED', 'INFO', 'SUCCESS', 'WARNING', 'FAILURE'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const int = (x) => (Number.isSafeInteger(x) ? x : null);
const pick = (s, re) => (typeof s === 'string' && re.test(s) ? s : null);

/**
 * The spec's defaults for tool annotations (a hint left out means this value). Some SDKs write a default out when a
 * server left it out (the Go SDK's typed Tool writes idempotentHint: false; since R-ORC-11 the Go client reports the
 * raw list instead): the same catalog to a client, not another server.
 */
export const ANNOTATION_DEFAULTS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

/** The tools with every annotation that only states its default removed (an annotations object left empty goes too). */
export function withoutDefaults(tools) {
  return tools.map((t) => {
    if (!isObj(t) || !isObj(t.annotations)) return t;
    const a = Object.fromEntries(Object.entries(t.annotations).filter(([k, v]) => !(k in ANNOTATION_DEFAULTS && ANNOTATION_DEFAULTS[k] === v)));
    const { annotations: _a, ...rest } = t;
    return Object.keys(a).length ? { ...rest, annotations: a } : rest;
  });
}

function engineHash(tools) {
  try { const p = M.parseInput(JSON.stringify({ tools })); if (p.error) return null; return M.analyse(p).input; } catch { return null; }
}

/**
 * The engine's catalog hash and tool count of a list of tools (a client's, or our reader's), the same hash with the
 * annotation defaults removed, and the hash of the sorted tool names; or null.
 */
export function clientCatalog(tools) {
  if (!Array.isArray(tools)) return null;
  const names = tools.map((t) => (isObj(t) && typeof t.name === 'string' ? t.name : null));
  const namesSha = sha256(JSON.stringify([...names].map(String).sort()));
  const full = engineHash(tools);
  const plain = engineHash(withoutDefaults(tools));
  return { tool_count: full ? full.tools : tools.length, catalog_sha256: full ? full.catalogHash : null, catalog_defaults_sha256: plain ? plain.catalogHash : null, names_sha256: namesSha, names };
}

/** The hash of a reader's sorted tool names, the same way. */
export const namesSha = (names) => sha256(JSON.stringify([...(names || [])].map(String).sort()));

function clientEntry(c, pinsClient) {
  const r = isObj(c.result) ? c.result : null;
  const outcome = OUTCOMES.includes(r && r.outcome) ? r.outcome : OUTCOMES.includes(c.outcome) ? c.outcome : 'client_error';
  const cat = outcome === 'listed' && r ? clientCatalog(r.tools) : null;
  // R-ORC-11: a client that could only report its SDK's typed structs (the Go client when it saw no raw page) lost
  // fields the server sent: its catalog is not compared, only its outcome and names.
  const typedOnly = r && r.tools_source === 'typed';
  return {
    entry: {
      client: c.id, sdk: pinsClient ? pinsClient.sdk : null, sdk_version: pick(r && r.sdk_version, VERSION_RE) || (pinsClient ? pinsClient.version : null),
      outcome, stage: pick(r && r.stage, /^[a-z]{1,12}$/), protocol_negotiated: protocolOf(r && r.protocol),
      tool_count: cat ? cat.tool_count : null, catalog_sha256: cat ? cat.catalog_sha256 : null, catalog_defaults_sha256: cat ? cat.catalog_defaults_sha256 : null, names_sha256: cat ? cat.names_sha256 : null,
      catalog_vs_reader: null,
      pages: int(r && r.pages), ms: int(c.ms),
    },
    names: cat ? cat.names : null,
    typedOnly,
  };
}

/**
 * @param {object|null} rec      oracles.json (or oracles-unlisted.json), or null when the stage did not run
 * @param {object} o
 * @param {object} o.reader      our reader: { listed, tool_count, catalog_hash, names, pages, check_ids, capabilities }
 * @param {object} o.pins        pins.json
 * @param {object|null} [o.baseline]  the subject's expected oracle results (corpus/fixtures/live-probe/oracle-baseline.json)
 */
export function judgeOracles(rec, { reader, pins, baseline = null }) {
  const out = { status: 'absent', mode: null, why: null, ms: null, clients: [], conformance: null, disagreements: [], components: [] };
  if (!isObj(rec) || rec.format !== ORACLE_FORMAT) return out;
  out.mode = pick(rec.mode, /^[a-z_]{1,20}$/);
  out.ms = int(rec.ms);
  if (rec.mode === 'skipped' || rec.mode === 'error') { out.status = rec.mode; out.why = pick(rec.why, /^[a-z_]{1,40}$/) || (rec.mode === 'error' ? 'stage_error' : null); return out; }
  out.status = 'ran';
  const names = new Map();
  const lossy = new Set();
  for (const c of Array.isArray(rec.clients) ? rec.clients : []) {
    const pc = (pins.clients || []).find((x) => x.id === c.id);
    if (!pc) continue;
    const { entry, names: n, typedOnly } = clientEntry(c, pc);
    if (typedOnly) lossy.add(c.id);
    out.clients.push(entry);
    if (n) names.set(c.id, n);
    if (entry.outcome !== 'unavailable' && entry.outcome !== 'skipped') out.components.push({ name: pc.sdk, version: entry.sdk_version || pc.version });
  }
  // Conformance.
  const conf = isObj(rec.conformance) ? rec.conformance : null;
  if (conf) {
    const excluded = pins.bridge_excluded_checks || {};
    const caps = isObj(reader && reader.capabilities) ? reader.capabilities : null;
    const declared = (k) => !!(caps && caps[k] !== undefined && caps[k] !== null && caps[k] !== false);
    const expected = new Set(baseline && Array.isArray(baseline.expected_failures) ? baseline.expected_failures : []);
    const checks = [];
    const summary = {};
    for (const [rev, R] of Object.entries(pins.revisions)) {
      const s = summary[rev] = { wire: R.wire, transport: 'stdio_bridged', level: 'payload', pass: 0, fail: 0, expected_fail: 0, warning: 0, info: 0, skipped: 0, bridge_excluded: 0, not_applicable: 0, scenarios_run: 0, scenarios_not_run: [] };
      for (const sc of R.scenarios) {
        if (!sc.run) { s.scenarios_not_run.push({ scenario: sc.scenario, scored: !!sc.scored, reason: sc.reason }); continue; }
        const run = (conf.runs || []).find((r) => r && r.revision === rev && r.scenario === sc.scenario);
        if (!run || !Array.isArray(run.checks)) { s.scenarios_not_run.push({ scenario: sc.scenario, scored: !!sc.scored, reason: run ? pick(run.why, /^[a-z_]{1,40}$/) || 'no_checks' : conf.problem ? 'suite_unavailable' : 'not_run' }); continue; }
        s.scenarios_run++;
        // A check id can repeat within a scenario (a loop, a retry): the occurrences collapse to the worst status, as
        // the suite's own baseline does.
        const worst = new Map();
        for (const c of run.checks) {
          const id = pick(c && c.id, CHECK_ID_RE);
          if (!id) continue;
          const prev = worst.get(id);
          if (!prev || SEVERITY.indexOf(c.status) > SEVERITY.indexOf(prev.status)) worst.set(id, c);
        }
        for (const [id, c] of worst) {
          let status = STATUS[c.status] || 'skipped';
          const key = `${rev}/${sc.scenario}/${id}`;
          if (excluded[id]) status = 'bridge_excluded';
          else if (status === 'fail' && /^(prompts|resources)-list$/.test(id) && !declared(id.split('-')[0]) && /method not found/i.test(String(c.errorMessage || ''))) status = 'not_applicable';
          else if (status === 'fail' && expected.has(key)) status = 'expected_fail';
          s[status]++;
          checks.push({ spec_revision: rev, scenario: pick(sc.scenario, SCENARIO_RE), check: id, status, scored: !!sc.scored });
        }
      }
    }
    // A baselined failure that did not fail is a stale baseline: the self test refuses it.
    const stale = [...expected].filter((k) => { const [rev, sc, id] = k.split('/'); const c = checks.find((x) => x.spec_revision === rev && x.scenario === sc && x.check === id); return c && c.status !== 'expected_fail'; });
    out.conformance = { suite: { package: pins.conformance.package, version: pins.conformance.version, git_commit: pins.conformance.git_commit, integrity: pins.conformance.integrity, requirement_sets_sha256: pins.conformance.requirement_sets_sha256 }, bridge: isObj(rec.bridge) ? { name: pick(rec.bridge.name, /^[a-z-]{1,40}$/), version: pick(rec.bridge.version, VERSION_RE), stats: isObj(rec.bridge.stats) ? Object.fromEntries(Object.entries(rec.bridge.stats).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && (int(v) !== null || typeof v === 'boolean'))) : null } : null, problem: conf.problem ? 'suite_unavailable' : null, summary, checks, stale_baseline: stale };
    if (!conf.problem) out.components.push({ name: pins.conformance.package, version: pins.conformance.version });
  }
  // Against our reader's list: the same catalog, the same once annotation defaults are left out (the client's SDK
  // wrote a default the server did not send), or different.
  const rd = reader && reader.listed && Array.isArray(reader.tools) ? clientCatalog(reader.tools) : null;
  for (const c of out.clients) {
    // R-LP-75: the server declared no tools capability; a client that was refused the list, or listed none, agrees.
    if (noToolsAgrees(reader, c)) { c.catalog_vs_reader = 'no_tools_capability'; continue; }
    if (c.outcome !== 'listed' || !reader || !reader.listed) continue;
    if (lossy.has(c.client)) { c.catalog_vs_reader = 'sdk_typed_only'; continue; }
    c.catalog_vs_reader = c.catalog_sha256 === reader.catalog_hash ? 'same' : rd && c.catalog_defaults_sha256 && c.catalog_defaults_sha256 === rd.catalog_defaults_sha256 ? 'same_but_annotation_defaults' : 'different';
  }
  out.disagreements = disagreements(out, names, reader, rd, lossy);
  return out;
}

/**
 * Our reader saw a server with no tools capability that answered tools/list "method not found" (live-probe R-LP-75), and
 * this client agrees: it was refused the list, or listed no tool (the TypeScript v2 SDK returns an empty list).
 */
export function noToolsAgrees(reader, c) {
  return !!(reader && !reader.listed && reader.no_tools_capability === true && (c.outcome === 'list_failed' || (c.outcome === 'listed' && c.tool_count === 0)));
}

/** A client that timed out or crashed (D12); one that was refused at initialize or at the list (D6). */
const crashClass = (outcome) => (outcome === 'timeout' || outcome === 'client_error' ? 'D12' : 'D6');

/** The disagreements between our reader, the clients and the suite (DESIGN-v3 §7 classes). */
export function disagreements(j, names, reader, readerCatalog = null, lossy = new Set()) {
  const d = [];
  // A client that agrees there are no tools to list (R-LP-75) takes part in no comparison.
  const clients = j.clients.filter((c) => !noToolsAgrees(reader, c));
  const listedClients = clients.filter((c) => c.outcome === 'listed');
  const failedClients = clients.filter((c) => !['listed', 'unavailable', 'skipped'].includes(c.outcome));
  const readerListed = !!(reader && reader.listed);
  const diffNames = (a, b) => { const A = new Set(a || []); const B = new Set(b || []); return { only_a: [...A].filter((x) => !B.has(x)).length, only_b: [...B].filter((x) => !A.has(x)).length }; };
  // Our reader against each client.
  for (const c of clients) {
    if (c.outcome === 'unavailable' || c.outcome === 'skipped') continue;
    const b = `client:${c.client}`;
    if (readerListed && c.outcome !== 'listed') d.push({ class: crashClass(c.outcome), oracle_a: 'reader', oracle_b: b, kind: 'outcome', detail: { a: 'listed', b: c.outcome } });
    else if (!readerListed && c.outcome === 'listed') d.push({ class: 'D6', oracle_a: 'reader', oracle_b: b, kind: 'outcome', detail: { a: 'not_listed', b: 'listed' } });
    else if (readerListed && c.outcome === 'listed') {
      if (c.names_sha256 !== namesSha(reader.names)) d.push({ class: 'D6', oracle_a: 'reader', oracle_b: b, kind: 'tool_names', detail: { ...diffNames(reader.names, names.get(c.client)), count_a: int(reader.tool_count), count_b: c.tool_count } });
      else if (!lossy.has(c.client) && c.catalog_sha256 !== reader.catalog_hash && !(readerCatalog && c.catalog_defaults_sha256 && c.catalog_defaults_sha256 === readerCatalog.catalog_defaults_sha256)) d.push({ class: 'D4', oracle_a: 'reader', oracle_b: b, kind: 'catalog', detail: { count_a: int(reader.tool_count), count_b: c.tool_count } });
    }
  }
  // Clients against each other: the first listed client is the reference, one whose catalog is comparable if any is
  // (a typed-only list, R-ORC-11, is a reference for names only).
  const ref = listedClients.find((c) => !lossy.has(c.client)) || listedClients[0];
  if (ref) {
    for (const c of listedClients.filter((x) => x !== ref)) {
      if (c.names_sha256 !== ref.names_sha256) d.push({ class: 'D6', oracle_a: `client:${ref.client}`, oracle_b: `client:${c.client}`, kind: 'tool_names', detail: { ...diffNames(names.get(ref.client), names.get(c.client)), count_a: ref.tool_count, count_b: c.tool_count } });
      else if (lossy.has(c.client) || lossy.has(ref.client)) continue;
      else if (c.catalog_sha256 !== ref.catalog_sha256 && c.catalog_defaults_sha256 !== ref.catalog_defaults_sha256) d.push({ class: 'D4', oracle_a: `client:${ref.client}`, oracle_b: `client:${c.client}`, kind: 'catalog', detail: { count_a: ref.tool_count, count_b: c.tool_count } });
    }
    for (const c of failedClients) d.push({ class: crashClass(c.outcome), oracle_a: `client:${ref.client}`, oracle_b: `client:${c.client}`, kind: 'outcome', detail: { a: 'listed', b: c.outcome } });
  }
  // The suite's tool-name check against our engine's (spec Tool Names), when both saw the whole list on one page.
  const conf = j.conformance;
  if (conf && readerListed && reader.pages === 1) {
    const nameCheck = conf.checks.find((c) => c.spec_revision === '2025-11-25' && c.check === 'tools-name-format');
    const ours = (reader.check_ids || []).some((x) => x === 'spec-name-charset' || x === 'spec-name-length');
    if (nameCheck && (nameCheck.status === 'pass' || nameCheck.status === 'fail') && (nameCheck.status === 'fail') !== ours) d.push({ class: 'D7', oracle_a: 'reader', oracle_b: 'conformance:2025-11-25', kind: 'tool_name_rule', detail: { a: ours ? 'flagged' : 'clean', b: nameCheck.status } });
    const list = conf.checks.find((c) => c.spec_revision === '2025-11-25' && c.check === 'tools-list');
    if (list && list.status === 'fail') d.push({ class: 'D6', oracle_a: 'reader', oracle_b: 'conformance:2025-11-25', kind: 'tools_list_shape', detail: { a: 'listed', b: 'fail' } });
  }
  return d;
}

/**
 * The subject's results against its baseline, for the self test and the oracle control: [] when they match.
 * baseline: { expected_failures: [rev/scenario/check], clients: { id: { outcome, catalog_sha256?, protocol_negotiated? } },
 *             disagreements: [{class, oracle_a, oracle_b, kind}] }
 */
export function baselineProblems(j, baseline) {
  const p = [];
  if (!baseline) return ['no baseline'];
  if (j.status !== 'ran') return [`the oracle stage did not run (${j.status}${j.why ? `: ${j.why}` : ''})`];
  for (const [id, want] of Object.entries(baseline.clients || {})) {
    const c = j.clients.find((x) => x.client === id);
    if (!c) { p.push(`client ${id}: missing`); continue; }
    if (c.outcome === 'unavailable') continue; // an install problem: our fault, reported as such, not a wrong answer
    for (const k of ['outcome', 'catalog_sha256', 'protocol_negotiated', 'tool_count']) if (want[k] !== undefined && c[k] !== want[k]) p.push(`client ${id}: ${k} ${c[k]} (expected ${want[k]})`);
  }
  if (baseline.conformance !== false) {
    if (!j.conformance) p.push('conformance: did not run');
    else {
      if (j.conformance.problem) p.push(`conformance: ${j.conformance.problem}`);
      for (const c of j.conformance.checks) if (c.status === 'fail') p.push(`conformance: unexpected failure ${c.spec_revision}/${c.scenario}/${c.check}`);
      for (const k of j.conformance.stale_baseline) p.push(`conformance: baselined failure ${k} did not fail (stale baseline)`);
      for (const [rev, n] of Object.entries(baseline.scenarios_run || {})) if (!j.conformance.summary[rev] || j.conformance.summary[rev].scenarios_run !== n) p.push(`conformance: ${rev} ran ${j.conformance.summary[rev] ? j.conformance.summary[rev].scenarios_run : 0} scenarios (expected ${n})`);
    }
  }
  const key = (x) => `${x.class} ${x.oracle_a} ${x.oracle_b} ${x.kind}`;
  const want = new Set((baseline.disagreements || []).map(key));
  const unavailable = new Set(j.clients.filter((c) => c.outcome === 'unavailable').map((c) => `client:${c.client}`));
  for (const x of j.disagreements) if (!want.has(key(x))) p.push(`unexpected disagreement: ${key(x)}`);
  for (const k of want) if (!j.disagreements.some((x) => key(x) === k) && ![...unavailable].some((u) => k.includes(u))) p.push(`expected disagreement missing: ${k}`);
  return p;
}
