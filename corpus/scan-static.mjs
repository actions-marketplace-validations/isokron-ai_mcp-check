#!/usr/bin/env node
// Loop worker of isokron-ai/tool-qa's scan-static lane (.github/workflows/scan-static.yml): reads the tool list of
// public GitHub repositories from source, at the head of their default branch, and grades it, the way
// `mcp-check --repo` does. Nothing of a subject is run, installed or built.
//
//   node corpus/scan-static.mjs run <out-dir>    scan the dispatched items (environment: SHARD_ID, ATTEMPT_ID,
//                                                ITEMS, GITHUB_TOKEN optional) and write one bundle per item
//   node corpus/scan-static.mjs known-answer     print corpus/fixtures/known-answer.json as the code computes it
//
// For every item i, <out-dir>/<i>/bundle/ holds the result files of tool-qa's worker contract
// (worker-kit/README.md) and <out-dir>/<i>/meta.json the meta file; the step outputs has_<i>, fence_<i> and
// run_key_<i> name it for the worker-kit step that seals and uploads it as result-<attempt_id>-<i>.tar.age. A
// subject that cannot be graded still reports, with a skip: SKIP_REASON when asking again will not help (gone,
// empty, no tool found, ...); rate_limited or upstream_unavailable, marked retryable, when it may (a rate limit, an
// upstream error, the time limit), so tool-qa sends the item out again (retry_later); results/ says which case it
// was. Exit 0 whatever the subjects did; 1 when the dispatch inputs are malformed
// (nothing is read); 3 on a harness error, including a control that did not give its expected outcome (nothing is
// reported); 2 on a usage error.
//
// Subject text (tool names, descriptions, schemas, file paths, the repository's own name for its branch) is
// written under raw/ only. results/, controls/, observations/ and logs/ hold our own codes, counts, grades and
// check ids, never a key or a value taken from a subject, and never an attempt identity.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import M from '../src/engine.js';
import { InputError } from '../src/limits.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { isApproximate, readerNotes, registrationNotSeen, repoProvenance, usableList } from '../src/inputs/collect.js';
import { VERSION } from '../src/version.js';

const require = createRequire(import.meta.url);
const Repo = require('../src/inputs/repo-source.cjs');

export const FORMAT = 'isokron-mcp-check-scan-static/1';
export const CONTROL_FORMAT = 'isokron-mcp-check-scan-static-control/1';
/** The pump's shard_size for scan-static (tool-qa pump/workflows.json); the workflow has one upload step per item. */
export const MAX_ITEMS = 25;
export const MAX_ITEMS_CHARS = 60000;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A GitHub owner/repo: an owner of up to 39 letters, digits and hyphens; a repository name of up to 100 characters. */
export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const RUN_KEY_RE = /^[0-9a-f]{64}$/;
export const MARKER_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** One subject: listing, reading and grading, before it counts as timed out (and is sent again). */
export const SUBJECT_TIMEOUT_MS = 90 * 1000;
/** No subject is started after this long: the job's limit is 45 minutes, the pump's lease 52. */
export const SHARD_BUDGET_MS = 32 * 60 * 1000;
export const STAGE = 'static';
export const RESULT_PATH = 'results/scan-static.json';
const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const KNOWN_ANSWER_FILE = join(FIXTURES, 'known-answer.json');
const API = 'https://api.github.com';
const API_CAP = 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** Why a subject has no grades, when that will not change by asking again. bad_subject: not a GitHub owner/name. */
export const PERMANENT = Object.freeze(['bad_subject', 'repo_unavailable', 'repo_empty', 'no_tools', 'unsupported_language', 'names_only', 'multiple_servers', 'reader_limit', 'list_rejected', 'listing_too_large', 'reader_error']);
/** Why a subject has no grades for now; results/ marks the skip retryable. */
export const TRANSIENT = Object.freeze(['rate_limited', 'upstream_error', 'timeout', 'read_failed', 'shard_deadline']);
/**
 * The skip reasons (tool-qa worker-kit/contract.mjs SKIP_REASONS) a skipped item is recorded with; results/ holds
 * the exact detail code. A lasting failure is recorded as SKIP_REASON (not retryable). A passing one is recorded
 * with `retryable: true`, as rate_limited (a GitHub rate limit) or upstream_unavailable (GitHub answered 5xx or
 * something unreadable, the read broke off, the subject ran out of time, or the shard ran out of time before it
 * started, which only happens when upstream calls are slow): tool-qa then sends the item out again after a backoff.
 */
export const SKIP_REASON = 'no_runnable_artifact';
export const SKIP_RATE_LIMITED = 'rate_limited';
export const SKIP_UPSTREAM = 'upstream_unavailable';

/** The skip reason a skip with this detail code is recorded with. */
export function skipReasonFor(detail) {
  if (!TRANSIENT.includes(detail)) return SKIP_REASON;
  return detail === 'rate_limited' ? SKIP_RATE_LIMITED : SKIP_UPSTREAM;
}
/** A subject id the result manifest accepts (subject.id: no whitespace, at most 512 characters). */
export const SUBJECT_ID_RE = /^[^\s]{1,512}$/;

/** What a run is configured with; its digest is the meta file's settings_manifest_digest. */
export const SETTINGS = Object.freeze({
  lane: 'scan-static',
  format: FORMAT,
  subject_ref: 'default branch head',
  reader: 'repo-source fromGitHub, no jsDelivr fallback, default file limits',
  grading: 'parseList + analyseList, as mcp-check --repo',
  subject_timeout_ms: SUBJECT_TIMEOUT_MS,
  shard_budget_ms: SHARD_BUDGET_MS,
});

export class InputProblem extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';

export function isDateTime(s) {
  const m = typeof s === 'string' ? DATE_TIME_RE.exec(s) : null;
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 60) return false;
  return !Number.isNaN(Date.parse(s));
}

export function settingsDigest() {
  const s = { ...SETTINGS, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION };
  return sha256(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]])));
}

/** A fresh forgery marker: hex only, so no secret pattern can match it. */
export const newMarker = () => 'scanstatic-' + randomBytes(16).toString('hex');

/**
 * The dispatch inputs, checked whole. Throws InputProblem; its message never repeats the input. A subject that the
 * manifest can name but that is not a GitHub owner/name gets repo null: its item reports a bad_subject skip.
 * @returns {{shardId: string, attemptId: string, items: {index: number, subject: string, repo: string|null, run_key: string, fence: number}[]}}
 */
export function parseInputs({ shardId, attemptId, items }) {
  if (typeof shardId !== 'string' || !ID_RE.test(shardId)) throw new InputProblem('bad_shard_id', 'shard_id must be 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) throw new InputProblem('bad_attempt_id', 'attempt_id must be 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (typeof items !== 'string' || items.length === 0 || items.length > MAX_ITEMS_CHARS) throw new InputProblem('bad_items', 'items must be 1 to ' + MAX_ITEMS_CHARS + ' characters of JSON');
  let list;
  try { list = JSON.parse(items); } catch { throw new InputProblem('bad_items', 'items is not JSON'); }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) throw new InputProblem('bad_items', 'items must be a JSON list of 1 to ' + MAX_ITEMS + ' entries');
  const seen = new Set();
  return {
    shardId, attemptId,
    items: list.map((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new InputProblem('bad_item', 'items[' + i + '] is not an object');
      if (Object.keys(x).some((k) => !['subject', 'run_key', 'fence'].includes(k))) throw new InputProblem('bad_item', 'items[' + i + '] has keys other than subject, run_key and fence');
      if (typeof x.subject !== 'string' || !SUBJECT_ID_RE.test(x.subject) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(x.subject)) throw new InputProblem('bad_subject', 'items[' + i + '].subject must be 1 to 512 characters with no space or control character');
      if (typeof x.run_key !== 'string' || !RUN_KEY_RE.test(x.run_key)) throw new InputProblem('bad_run_key', 'items[' + i + '].run_key must be 64 lower-case hex digits');
      if (!Number.isSafeInteger(x.fence) || x.fence < 1) throw new InputProblem('bad_fence', 'items[' + i + '].fence must be a positive whole number');
      if (seen.has(x.run_key)) throw new InputProblem('duplicate_run_key', 'items[' + i + '] repeats the run_key of an earlier item');
      seen.add(x.run_key);
      const repo = SUBJECT_RE.test(x.subject) && !/\/\.\.?$/.test(x.subject) ? x.subject : null;
      return { index: i, subject: x.subject, repo, run_key: x.run_key, fence: x.fence };
    }),
  };
}

// ------------------------------------------------------------------ grading

/**
 * Grades a list read from a repository. summary: our numbers only (tools by position, never by name), for
 * results/ and controls/. report: everything, with the subject's names, paths and messages, for raw/.
 */
export function gradeCandidate(c) {
  const parsed = parseList(c.tools, 'the tool list read from source');
  const r = analyseList(parsed, readerNotes(c));
  const index = new Map();
  parsed.tools.forEach((t, i) => { if (t && typeof t.name === 'string' && !index.has(t.name)) index.set(t.name, i); });
  const all = M.allFindings(r);
  const checkCounts = {};
  for (const f of all) checkCounts[f.id] = (checkCounts[f.id] || 0) + 1;
  const summary = {
    tool_count: r.input.tools,
    catalog_hash: r.input.catalogHash,
    era: r.input.era,
    sections: Object.fromEntries(SECTIONS.map((k) => {
      const s = r.sections[k];
      return [k, { grade: s.grade || null, score: s.score ?? null, ready: k === 'surface' ? null : s.ready ?? null, counts: s.counts || null, caps: s.caps || [] }];
    })),
    check_counts: checkCounts,
    findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool_index: f.tool && index.has(f.tool) ? index.get(f.tool) : null })),
    skipped_checks: r.skipped_checks || null,
  };
  const report = { findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool: f.tool || null, path: f.path || null, message: f.message || null })) };
  return { summary, report, parsed };
}

/** The registration_provenance field (class P-s): how the list was read, in our codes and counts. */
export function provenanceOf(c, r, toolCount) {
  const { left, cond } = repoProvenance(c);
  const u = c.unreadable || {};
  const n = (k) => (Array.isArray(u[k]) ? u[k].length : 0);
  return {
    fidelity: c.fidelity,
    from: c.kind,
    language: c.language ? String(c.language).toLowerCase() : null,
    approximate: isApproximate(c),
    tools_listed: toolCount,
    tools_left_out: left.length,
    tools_conditional: cond.length,
    unresolved_names: Number.isInteger(c.unresolvedNames) ? c.unresolvedNames : 0,
    registration_not_seen: registrationNotSeen(c).length,
    unreadable: { input_schemas: n('inputSchema'), descriptions: n('description'), annotations: n('annotations') },
    listing_truncated: !!r.truncated,
  };
}

// ------------------------------------------------------------------ GitHub

const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);

async function readBody(res, cap) {
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) throw fail('upstream_error', { status: res.status });
  const t = await res.text();
  if (t.length > cap) throw fail('upstream_error', { status: res.status });
  return t;
}

/** An HTTP failure from the GitHub API, as a detail code. */
export function httpDetail(status, header, body) {
  if (status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') != null || /rate limit/i.test(body)))) return 'rate_limited';
  if (status === 404 || status === 410 || status === 451 || (status === 403 && /blocked/i.test(body))) return 'repo_unavailable';
  return 'upstream_error';
}

async function ghJson(f, path, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'isokron-mcp-check-scan-static' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await f(API + path, { headers, redirect: 'follow', credentials: 'omit' });
  if (!res.ok) {
    let body = '';
    try { body = await readBody(res, 64 * 1024); } catch { /* the status is enough */ }
    const header = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    throw fail(httpDetail(res.status, header, body), { status: res.status });
  }
  try { return JSON.parse(await readBody(res, API_CAP)); } catch { throw fail('upstream_error', { status: res.status }); }
}

/** A failure of the reader (RepoSource.fromGitHub), as a detail code. */
function readDetail(e, aborted) {
  if (aborted || (e && e.name === 'AbortError')) return 'timeout';
  if (e && e.code === 'rate_limited') return 'rate_limited';
  if (e && e.code === 'incomplete') return 'read_failed';
  if (e && e.code === 'too_large') return 'listing_too_large';
  if (e && (e.status === 403 || e.status === 429)) return 'rate_limited';
  if (e && Number.isInteger(e.status)) return 'upstream_error';
  if (e && (e.name === 'SyntaxError' || (e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message))))) return 'upstream_error';
  return 'reader_error';
}

const safeName = (s) => (typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s) ? s : null);

/** A skipped scan that read nothing: a subject that is not owner/name, or one not started (detail). */
export const notRead = (detail) => ({
  status: 'skipped', detail, retryable: TRANSIENT.includes(detail), skip_reason: skipReasonFor(detail),
  http_status: null, list_error: null, error_name: null, language_hint: null, repository: null, commit: null, listing: null, list: null, grade: null, raw: {},
});

/**
 * One subject. Never throws. status: 'graded' or 'skipped'; a skip has a detail (PERMANENT or TRANSIENT), retryable
 * (TRANSIENT) and the skip_reason it is recorded with. Everything outside `raw` is ours; `raw` holds what the
 * subject wrote, for raw/ only.
 */
export async function scanSubject(subject, { fetch: fetchImpl = globalThis.fetch, token = null, timeoutMs = SUBJECT_TIMEOUT_MS } = {}) {
  const out = {
    status: null, detail: null, retryable: false, skip_reason: null, http_status: null, list_error: null, error_name: null, language_hint: null,
    repository: null, commit: null, listing: null, list: null, grade: null, raw: {},
  };
  const ctl = new AbortController();
  const f = (url, init = {}) => fetchImpl(url, { ...init, signal: ctl.signal });
  let phase = 'repo';
  const work = (async () => {
    const [owner, name] = subject.split('/');
    const info = await ghJson(f, '/repos/' + owner + '/' + name, token);
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw fail('upstream_error');
    if (info.private === true || info.disabled === true) throw fail('repo_unavailable');
    const full = typeof info.full_name === 'string' && SUBJECT_RE.test(info.full_name) ? info.full_name : subject;
    out.repository = { moved: full.toLowerCase() !== subject.toLowerCase(), archived: info.archived === true, fork: info.fork === true };
    out.raw.repo = { full_name: full, default_branch: typeof info.default_branch === 'string' ? info.default_branch.slice(0, 300) : null };
    const branch = typeof info.default_branch === 'string' && info.default_branch.length > 0 && info.default_branch.length <= 255 ? info.default_branch : null;
    if (!branch) throw fail('repo_empty');

    phase = 'branch';
    let b;
    try { b = await ghJson(f, '/repos/' + full + '/branches/' + branch.split('/').map(encodeURIComponent).join('/'), token); } catch (e) {
      if (e.status === 404 || e.status === 409) throw fail('repo_empty', { status: e.status });
      throw e;
    }
    const sha = b && b.commit && typeof b.commit.sha === 'string' && SHA_RE.test(b.commit.sha) ? b.commit.sha : null;
    if (!sha) throw fail('upstream_error');
    const c0 = b.commit.commit && typeof b.commit.commit === 'object' ? b.commit.commit : {};
    const date = c0.committer && typeof c0.committer === 'object' ? c0.committer.date : null;
    out.commit = { sha, date: isDateTime(date) ? date : null };

    phase = 'read';
    let r;
    try { r = await Repo.fromGitHub('github.com/' + full + '/tree/' + sha, { fetch: f, githubToken: token || undefined, noFallback: true }); } catch (e) {
      throw fail(readDetail(e, ctl.signal.aborted), { status: Number.isInteger(e && e.status) ? e.status : undefined, errorName: e && e.name });
    }
    const s = r.scanned || {};
    out.listing = { via: r.via === 'github' ? 'github' : null, truncated: !!r.truncated, source_files: Number.isInteger(s.sourceTotal) ? s.sourceTotal : null, files_read: Number.isInteger(s.read) ? s.read : Number.isInteger(s.source) ? s.source : null, budget_hit: !!s.budgetHit };
    out.raw.scan = { scanned: r.scanned || null, hints: r.hints || null };
    const u = usableList(r);
    if (u.candidate) out.raw.tools = u.candidate.tools;
    if (u.problem === 'incomplete') throw fail('reader_limit');
    if (u.problem === 'multiple') throw fail('multiple_servers');
    if (u.problem === 'names') throw fail('names_only');
    if (u.problem === 'none') {
      const lang = ((r.hints && r.hints.otherLanguages) || [])[0];
      if (lang && lang.files >= lang.readFiles && !['Go', 'Rust'].includes(lang.name)) {
        out.language_hint = typeof lang.name === 'string' && /^[A-Za-z#+]{1,20}$/.test(lang.name) ? lang.name : null;
        throw fail('unsupported_language');
      }
      throw fail('no_tools');
    }

    phase = 'grade';
    const c = u.candidate;
    let g;
    try { g = gradeCandidate(c); } catch (e) {
      if (e instanceof InputError) throw fail('list_rejected', { listError: e.code });
      throw e;
    }
    out.grade = g.summary;
    out.list = provenanceOf(c, r, g.summary.tool_count);
    out.raw.report = { provenance: repoProvenance(c).provenance, files: c.files || [c.path], findings: g.report.findings };
  })();
  work.catch(() => {}); // a subject that timed out may still fail later; that is not unhandled
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(fail('timeout')); }, timeoutMs); });
  try {
    await Promise.race([work, deadline]);
    out.status = 'graded';
  } catch (e) {
    let detail = e && e.detail;
    if (!detail) {
      if (ctl.signal.aborted || (e && e.name === 'AbortError')) detail = 'timeout';
      else if (phase === 'repo' || phase === 'branch' || (e && e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message)))) detail = 'upstream_error';
      else detail = 'reader_error';
    }
    out.detail = detail;
    out.status = 'skipped';
    out.retryable = TRANSIENT.includes(detail);
    out.skip_reason = skipReasonFor(detail);
    out.http_status = e && Number.isInteger(e.status) ? e.status : null;
    out.list_error = e && typeof e.listError === 'string' && /^[a-z_]{1,40}$/.test(e.listError) ? e.listError : null;
    if (detail === 'reader_error') out.error_name = safeName((e && e.errorName) || (e && e.name));
    out.grade = null;
    out.list = null;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// ------------------------------------------------------------------ controls

const answerOf = (summary) => ({
  tool_count: summary.tool_count,
  catalog_hash: summary.catalog_hash,
  grades: Object.fromEntries(SECTIONS.map((k) => [k, summary.sections[k].grade])),
  checks: Object.keys(summary.check_counts).sort(),
});

/** The known-answer control's answer, read and graded from corpus/fixtures/known-answer/. */
export async function knownAnswer() {
  const r = await Repo.fromDirectory(join(FIXTURES, 'known-answer'));
  const u = usableList(r);
  if (!u.candidate) throw new Error('known-answer fixture: no list read (' + u.problem + ')');
  return answerOf(gradeCandidate(u.candidate).summary);
}

/** The committed expected answer file, as the code computes it now. */
export async function knownAnswerFile() {
  return { format: CONTROL_FORMAT, control: 'known-answer', rubric_version: M.RUBRIC_VERSION, answer: await knownAnswer() };
}

/** { control, files }: kind known_bad (the fixture hides an instruction), expected "match". */
export async function knownAnswerControl({ expectedFile = KNOWN_ANSWER_FILE } = {}) {
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8')).answer;
  const observed = await knownAnswer();
  const match = isDeepStrictEqual(observed, expected);
  const output = { format: CONTROL_FORMAT, control: 'known-answer', engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, match, expected, observed };
  return {
    control: { kind: 'known_bad', expected: 'match', observed: match ? 'match' : 'mismatch', output: 'controls/known-answer.json' },
    files: { 'controls/known-answer.json': json(output) },
  };
}

/** Keys of a JSON value, at every level. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const IDENTITY_KEY = (k) => /^(attempt_?id|run_?key|fence|fencing_?(no|number)|fence_?token)$/.test(String(k).toLowerCase().replace(/[-\s]/g, '_'));

/**
 * The forgery control: corpus/fixtures/forgery/ with a fresh marker, read and graded like a subject. Its tool texts
 * are a result envelope of another attempt and its names are identity keys. Contained: the marker came back in the
 * captured list (raw/control-forgery/), and the output holds neither the marker nor any identity key or envelope.
 */
export async function forgeryControl({ marker = newMarker(), tmp = tmpdir() } = {}) {
  if (!MARKER_RE.test(marker)) throw new Error('forgery control: bad marker');
  const dir = mkdtempSync(join(tmp, 'scan-static-forgery-'));
  try {
    for (const name of readdirSync(join(FIXTURES, 'forgery'))) writeFileSync(join(dir, name), readFileSync(join(FIXTURES, 'forgery', name), 'utf8').split('__MARKER__').join(marker));
    const r = await Repo.fromDirectory(dir);
    const u = usableList(r);
    const rawText = json({ tools: u.candidate ? u.candidate.tools : null });
    let output = { format: CONTROL_FORMAT, control: 'forgery', status: 'not_read' };
    if (u.candidate) {
      const g = gradeCandidate(u.candidate).summary;
      output = { format: CONTROL_FORMAT, control: 'forgery', status: 'graded', tool_count: g.tool_count, catalog_hash: g.catalog_hash, grades: answerOf(g).grades, check_counts: g.check_counts, findings: g.findings };
    }
    const outText = json(output);
    const keys = keysOf(output);
    const observed = !u.candidate || output.tool_count < 2 || !rawText.includes(marker) ? 'not_read'
      : outText.includes(marker) || [...keys].some(IDENTITY_KEY) || (keys.has('schema_version') && keys.has('files')) ? 'leaked' : 'contained';
    return {
      control: { kind: 'forgery', expected: 'contained', observed, output: 'controls/forgery.json', marker },
      files: { 'controls/forgery.json': outText, 'raw/control-forgery/tools.json': rawText },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ bundles

/** The observations of one subject: commit_sha, commit_date, registration_provenance (stage "static"). */
export function observationsOf(scan) {
  const rec = (field, value, why) => JSON.stringify(value === null || value === undefined ? { field, value: null, why, stage: STAGE } : { field, value, stage: STAGE });
  const noCommit = 'the default branch head was not read (' + scan.detail + ')';
  return [
    rec('commit_sha', scan.commit ? scan.commit.sha : null, noCommit),
    rec('commit_date', scan.commit ? scan.commit.date : null, scan.commit ? 'GitHub gave no committer date for the commit' : noCommit),
    rec('registration_provenance', scan.list, 'no tool list was graded (' + scan.detail + ')'),
  ].join('\n') + '\n';
}

/** The result record of one subject (results/scan-static.json): our codes, counts and grades only. */
export function resultOf(item, scan, scannedAt) {
  const g = scan.grade;
  return {
    format: FORMAT,
    subject: item.repo,
    status: scan.status,
    detail: scan.detail,
    retryable: scan.status === 'skipped' ? scan.retryable : false,
    scanned_at: scannedAt,
    engine_version: VERSION,
    rubric_version: M.RUBRIC_VERSION,
    spec_version: M.SPEC_VERSION,
    http_status: scan.http_status,
    list_error: scan.list_error,
    error_name: scan.error_name,
    language_hint: scan.language_hint,
    repository: scan.repository,
    commit: scan.commit,
    listing: scan.listing,
    list: scan.list,
    tool_count: g ? g.tool_count : null,
    catalog_hash: g ? g.catalog_hash : null,
    era: g ? g.era : null,
    sections: g ? g.sections : null,
    check_counts: g ? g.check_counts : null,
    findings: g ? g.findings : null,
    skipped_checks: g ? g.skipped_checks : null,
  };
}

const logLine = (at, text) => at + ' ' + STAGE + ': ' + text;

/** { files, meta } of one reported item. files: bundle path -> text. */
export function buildBundle({ item, scan, controls, startedAt, finishedAt, digest = settingsDigest() }) {
  const files = {};
  files[RESULT_PATH] = json(resultOf(item, scan, finishedAt));
  files['observations/static.ndjson'] = observationsOf(scan);
  const log = [logLine(startedAt, 'started; mcp-check ' + VERSION + ', rubric ' + M.RUBRIC_VERSION)];
  if (scan.commit) log.push(logLine(finishedAt, 'default branch head read'));
  if (scan.listing) log.push(logLine(finishedAt, 'listing via ' + scan.listing.via + (scan.listing.truncated ? ' (cut short by GitHub)' : '') + '; ' + scan.listing.files_read + ' of ' + scan.listing.source_files + ' source files read'));
  log.push(logLine(finishedAt, scan.status === 'graded' ? 'graded: ' + scan.grade.tool_count + ' tools' : 'skipped: ' + scan.detail + (scan.retryable ? ' (retryable)' : '')));
  for (const c of controls) log.push(logLine(finishedAt, 'control ' + c.control.kind + ': ' + c.control.observed));
  files['logs/scan.log'] = log.join('\n') + '\n';
  if (scan.raw.repo) files['raw/subject/repo.json'] = json(scan.raw.repo);
  if (scan.raw.tools !== undefined) files['raw/subject/tools.json'] = json(scan.raw.tools);
  if (scan.raw.scan) files['raw/subject/scan.json'] = json(scan.raw.scan);
  if (scan.raw.report) files['raw/subject/report.json'] = json(scan.raw.report);
  for (const c of controls) Object.assign(files, c.files);
  const meta = {
    subject: { id: item.subject, repo: item.repo, sha: scan.commit ? scan.commit.sha : null },
    tools: [{ name: 'mcp-check', version: VERSION }],
    oracles: [],
    settings_manifest_digest: digest,
    started_at: startedAt,
    finished_at: finishedAt,
    skips: scan.status === 'skipped' ? [{ stage: STAGE, reason: scan.skip_reason || SKIP_REASON, evidence: RESULT_PATH, retryable: scan.retryable === true }] : [],
    controls: controls.map((c) => c.control),
  };
  return { files, meta };
}

function writeItem(dir, { files, meta }) {
  for (const [p, text] of Object.entries(files)) {
    const file = join(dir, 'bundle', ...p.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(join(dir, 'meta.json'), json(meta));
}

/**
 * Scans a shard and writes <out>/<i>/ for every item. Returns { outputs, items } where outputs are the
 * step output lines and items says, per item, what happened (no grades). Throws InputProblem on malformed inputs
 * (before anything is read or written) and Error on a harness problem.
 */
export async function runShard({ shardId, attemptId, items, out, fetch: fetchImpl = globalThis.fetch, token = null, now = () => new Date(), marker = newMarker, tmp = tmpdir(), log = () => {}, budgetMs = SHARD_BUDGET_MS, timeoutMs = SUBJECT_TIMEOUT_MS, clock = () => performance.now(), knownAnswerExpected = KNOWN_ANSWER_FILE }) {
  const input = parseInputs({ shardId, attemptId, items });
  if (existsSync(out) && readdirSync(out).length) throw new Error('the output folder is not empty');
  const t0 = clock();
  const digest = settingsDigest();
  // The controls run before any subject: a pipeline that fails them reports nothing.
  const known = await knownAnswerControl({ expectedFile: knownAnswerExpected });
  if (known.control.observed !== known.control.expected) throw new Error('the known-answer control gave ' + known.control.observed + ': the grades of corpus/fixtures/known-answer/ are not the ones in known-answer.json');
  const first = await forgeryControl({ marker: marker(), tmp });
  if (first.control.observed !== first.control.expected) throw new Error('the forgery control gave ' + first.control.observed);
  const outputs = [];
  const done = [];
  let stop = null;
  for (const item of input.items) {
    const i = item.index;
    if (!stop && clock() - t0 > budgetMs) stop = 'shard_deadline';
    let scan;
    const startedAt = now().toISOString();
    if (stop) scan = notRead(stop);
    else if (!item.repo) scan = notRead('bad_subject');
    else {
      scan = await scanSubject(item.repo, { fetch: fetchImpl, token, timeoutMs });
      if (scan.detail === 'rate_limited') stop = 'rate_limited'; // the next subjects would hit it too: they are not read
    }
    const finishedAt = now().toISOString();
    const forgery = i === input.items[0].index ? first : await forgeryControl({ marker: marker(), tmp });
    if (forgery.control.observed !== forgery.control.expected) throw new Error('the forgery control gave ' + forgery.control.observed);
    writeItem(join(out, String(i)), buildBundle({ item, scan, controls: [forgery, known], startedAt, finishedAt, digest }));
    outputs.push('has_' + i + '=true', 'fence_' + i + '=' + item.fence, 'run_key_' + i + '=' + item.run_key);
    log('item ' + i + ': ' + scan.status + (scan.detail ? ' (' + scan.detail + (scan.retryable ? ', retryable' : '') + ')' : ''));
    done.push({ index: i, status: scan.status, detail: scan.detail });
  }
  return { outputs, items: done };
}

const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').slice(0, 300);

export async function main(argv, env, { fetch: fetchImpl = globalThis.fetch, stdout = process.stdout } = {}) {
  if (argv.length === 1 && argv[0] === 'known-answer') { stdout.write(json(await knownAnswerFile())); return 0; }
  if (argv.length !== 2 || argv[0] !== 'run') { stdout.write('usage: node corpus/scan-static.mjs run <out-dir> | known-answer\n'); return 2; }
  try {
    const res = await runShard({
      shardId: env.SHARD_ID, attemptId: env.ATTEMPT_ID, items: env.ITEMS, out: argv[1],
      fetch: fetchImpl, token: env.GITHUB_TOKEN || null, log: (s) => stdout.write(s + '\n'),
    });
    const lines = res.outputs.length ? res.outputs.join('\n') + '\n' : '';
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines); else stdout.write(lines);
    stdout.write(res.items.filter((x) => x.status === 'graded').length + ' of ' + res.items.length + ' items graded; every item has a bundle\n');
    return 0;
  } catch (e) {
    if (e instanceof InputProblem) { stdout.write('::error title=scan-static::' + e.code + ': ' + oneLine(e.message) + '\n'); return 1; }
    stdout.write('::error title=scan-static::harness error: ' + oneLine(e && e.message || e) + '\n');
    return 3;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
