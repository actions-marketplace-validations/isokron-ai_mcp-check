#!/usr/bin/env node
// Loop worker of isokron-ai/tool-qa's live-probe lane (.github/workflows/live-probe.yml). For each dispatched subject (a
// public GitHub repository, owner/name) it works out how to install the server from its published package, then the
// sandbox of isokron-ai/mcp-surface-corpus installs and starts it, speaks MCP to it (initialize, tools/list,
// prompts/list, resources/list, resources/templates/list; no tool is ever called) and stops it. This script grades the
// live tool list with this repository's engine, the way `mcp-check -- <server>` grades a captured list, compares it
// with the list read from source when the sandbox read one, and writes one result bundle per item for tool-qa's
// worker kit. corpus/LIVE-PROBE.md describes the lane.
//
//   node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <seed-v1.json>]
//        environment: SHARD_ID, ATTEMPT_ID, ITEMS. Checks the inputs whole, resolves each subject's install method
//        from the seed list and the official MCP Registry, writes <work>/plan.json and the sandbox's two target lists
//        (<work>/targets-controls.json, <work>/targets-subjects.json), and the step outputs has_<i>, fence_<i>,
//        run_key_<i> and subject_timeout_s.
//   node corpus/live-probe.mjs bundle <work>
//        after corpus/live-probe-sandbox.sh: checks the three controls, then writes <work>/out/<i>/bundle/ and
//        <work>/out/<i>/meta.json for every item.
//   node corpus/live-probe.mjs verify <tool-qa dir> <tar>...
//        the pull request self test: judges dry-run bundles with tool-qa's own manifest, forgery, field and secret
//        checks, and checks the fixture shard's expected outcomes.
//   node corpus/live-probe.mjs known-answer [<capture.json>]
//        prints corpus/fixtures/live-probe/known-answer.json as this code computes it from the saved capture.
//
// Exit codes: 0 done (whatever the subjects did); 1 malformed dispatch inputs (nothing is read); 2 usage; 3 a control
// did not give its expected outcome, or another harness error (nothing may be uploaded).
//
// Subject text (tool names, descriptions, schemas, server info, package names, host names a server looked up, install
// logs) goes under raw/ only. results/, controls/, observations/ and logs/ hold our own codes, counts, hashes and
// grades, and a subject's own strings only where a strict pattern shows they cannot carry an attempt identity.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import M from '../src/engine.js';
import { InputError } from '../src/limits.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { VERSION } from '../src/version.js';

export const LANE = 'live-probe';
export const FORMAT = 'isokron-mcp-check-live-probe/1';
export const CONTROL_FORMAT = 'isokron-mcp-check-live-probe-control/1';
export const PLAN_FORMAT = 'isokron-mcp-check-live-probe-plan/1';
export const STAGE = 'live';
export const RESULT_PATH = 'results/live-probe.json';
/** The pump's shard_size for live-probe (tool-qa pump/workflows.json); the workflow has one upload step per item. */
export const MAX_ITEMS = 10;
export const MAX_ITEMS_CHARS = 60000;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const SUBJECT_ID_RE = /^[^\s]{1,512}$/;
export const RUN_KEY_RE = /^[0-9a-f]{64}$/;
export const MARKER_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
export const TARGETS_FORMAT = 'isokron-surface-targets/1';
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'live-probe');
export const KNOWN_ANSWER_FILE = join(FIXTURES, 'known-answer.json');
/** Our server's tools/list, captured as it answers (its docs links included): a test fixture, outside the link-tag scan. */
export const KNOWN_ANSWER_CAPTURE = join(here, '..', 'test', 'fixtures', 'live-probe', 'known-answer-tools.json');
export const FORGERY_SERVER = join(FIXTURES, 'forgery-server.js');

/**
 * The known-answer control: our own published server, @isokron/mcp-check 1.3.1, installed from npm and started in the
 * sandbox exactly as a subject is. Its live tool list is the one saved in test/fixtures/live-probe/known-answer-tools.json.
 */
export const KNOWN_ANSWER = Object.freeze({
  id: 's901', repo: 'isokron-ai/mcp-check', commit: '5e2668aed07efeb61beb2f3761bc3348af2075c3', registry: 'io.github.isokron-ai/mcp-check',
  launch: Object.freeze({ kind: 'npm', package: '@isokron/mcp-check', version: '1.3.1', args: Object.freeze(['serve']) }),
  timeout_s: 300,
});
/** The forgery control: corpus/fixtures/live-probe/forgery-server.js in the sandbox's own digest-pinned node image. */
export const FORGERY = Object.freeze({ id: 's902', repo: 'isokron-ai/mcp-check', commit: KNOWN_ANSWER.commit, timeout_s: 150 });
/** Item i runs as sandbox target s001, s002, ... (the sandbox's ids are never public beyond this). */
export const targetId = (i) => 's' + String(i + 1).padStart(3, '0');

/** Subjects: the sandbox's whole budget for them, and each one's limit within it. */
export const SUBJECT_BUDGET_S = 26 * 60;
export const SUBJECT_TIMEOUT_MIN_S = 90;
export const SUBJECT_TIMEOUT_MAX_S = 300;
export const PROBE_MS = 45_000;
/** One raw file at most (tool-qa's limit is 8 MiB a file, 64 MiB a bundle). */
export const RAW_FILE_CAP = 6 * 1024 * 1024;
export const RAW_TOTAL_CAP = 40 * 1024 * 1024;
const REGISTRY_CAP = 4 * 1024 * 1024;

/**
 * Why an item has no live grade: our detail code, the tool-qa skip reason (worker-kit/contract.mjs SKIP_REASONS) it is
 * recorded with, whether it is retryable, and the stage. results/ keeps the detail.
 */
export const DETAILS = Object.freeze({
  bad_subject: ['no_runnable_artifact', false, 'resolve'],
  no_package: ['no_runnable_artifact', false, 'resolve'],
  unsupported_package: ['no_runnable_artifact', false, 'resolve'],
  private_registry: ['no_runnable_artifact', false, 'resolve'],
  launch_invalid: ['no_runnable_artifact', false, 'resolve'],
  remote_only: ['remote_only', false, 'resolve'],
  unsupported_transport: ['unsupported_transport', false, 'resolve'],
  image_unavailable: ['install_failed_registry', false, 'install'],
  install_failed: ['install_failed_registry', false, 'install'],
  install_timeout: ['install_failed_registry', false, 'install'],
  needs_credentials: ['start_requires_credentials', false, 'start'],
  start_failed: ['timeout_start', false, 'start'],
  start_timeout: ['timeout_start', false, 'start'],
  list_failed: ['timeout_start', false, 'list'],
  list_rejected: ['no_runnable_artifact', false, 'grade'],
  rate_limited: ['rate_limited', true, 'resolve'],
  upstream_error: ['upstream_unavailable', true, 'resolve'],
  harness_error: ['upstream_unavailable', true, 'start'],
  shard_deadline: ['upstream_unavailable', true, 'start'],
  sandbox_evidence_missing: ['trace_unavailable', true, 'start'],
});

/** The fields this lane writes, with their types in mcp-results fields/registry.yaml (at tool-qa's pinned commit). */
export const FIELDS = Object.freeze({
  subject_id: 'string', registry_name: 'string', registry_version: 'string', registry_package_register_type: 'string',
  registry_package_identifier: 'string', registry_package_version: 'string', registry_package_transport: 'string',
  registry_package_runtime_hint: 'string', package_purl: 'string', oci_digest: 'hash', transports_offered: 'array',
  protocol_era: 'enum', protocol_negotiated: 'string', client_version: 'string', server_info: 'object',
  capabilities_flags: 'object', capabilities_jcs_sha256: 'hash', instructions_len_chars: 'integer', instructions_sha256: 'hash',
  startup_ms: 'integer', latency_cold_ms: 'number', startup_without_config: 'enum', config_state: 'enum',
  catalog_per_config_state: 'object', stdout_noise_lines: 'integer', stderr_counts: 'object', list_changed_notifications: 'integer',
  pagination_behaviour: 'object', step_telemetry: 'object', sandbox_tier: 'enum', runner_env: 'object', our_tool_versions: 'object',
  observation_coverage: 'object', install_phase_behaviour: 'object', network_event: 'object', error_taxonomy_code: 'enum',
  static_vs_live_agreement: 'object', commit_sha: 'string', commit_date: 'timestamp',
});
const ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** What a run is configured with; its digest (with the sandbox commit) is the meta file's settings_manifest_digest. */
export const SETTINGS = Object.freeze({
  lane: LANE, format: FORMAT, subject_ref: 'default branch head (static layer); the registry package version (live)',
  install: 'npm, pypi or oci package from the official MCP Registry entry, else from the seed list; stdio or streamable HTTP',
  sandbox: 'isokron-ai/mcp-surface-corpus bin/run-shard.mjs, lane ci (gVisor, deny-by-default egress, DNS logger)',
  probe: 'initialize, tools/list, prompts/list, resources/list, resources/templates/list; no tool called; with no env, then dummy env',
  grading: 'parseList + analyseList of the live tools/list result, as mcp-check -- <server>',
  probe_ms: PROBE_MS, subject_budget_s: SUBJECT_BUDGET_S,
});

export class InputProblem extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class ControlFailure extends Error {}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const int = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);

export function isDateTime(s) {
  const m = typeof s === 'string' ? DATE_TIME_RE.exec(s) : null;
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 60) return false;
  return !Number.isNaN(Date.parse(s));
}

/** Canonical JSON (keys sorted), for hashes of subject objects. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// ------------------------------------------------------------------ subject text

/** The words ingest reads as an attempt identity (tool-qa ingest/forgery.mjs IDENTITY_ALIASES and TEXT_CLAIM_RE). */
export const IDENTITY_WORD_RE = /(attempt[\s_-]?id|run[\s_-]?key|fenc(?:e|ing))/i;
const PRINTABLE = /^[\x20-\x7e]{1,200}$/;

/**
 * A subject's string, kept outside raw/ only when it matches `re`, holds no identity word (ingest reads a claim only
 * next to one) and no quote, so it can never read as a claim about an attempt; else null (raw/ keeps the original).
 */
export function safeText(s, re = PRINTABLE) {
  return typeof s === 'string' && re.test(s) && !IDENTITY_WORD_RE.test(s) && !/["'\\`]/.test(s) ? s : null;
}
const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+ -]{0,199}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_HOST = /^[a-z0-9_][a-z0-9_.-]{0,252}$/;

// ------------------------------------------------------------------ inputs

/**
 * The dispatch inputs, checked whole. Throws InputProblem; its message never repeats the input. A subject the manifest
 * can name but that is not a GitHub owner/name gets repo null: its item reports a bad_subject skip.
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
      if (!isObj(x)) throw new InputProblem('bad_item', 'items[' + i + '] is not an object');
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

// ------------------------------------------------------------------ resolving the install method

const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);

/** The seed list (tool-qa history/seed-v1.json): lower-cased owner/name -> its packages [{registry, identifier}]. */
export function loadSeed(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return map; }
  for (const s of Array.isArray(d && d.subjects) ? d.subjects : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.packages)) continue;
    map.set(s.id.toLowerCase(), s.packages.filter((p) => p && typeof p.registry === 'string' && typeof p.identifier === 'string').slice(0, 20));
  }
  return map;
}

/** A fetch's failure as a detail code: rate_limited (429, or 403 with a rate limit), else upstream_error. */
export function httpDetail(status, header = () => null) {
  if (status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') != null))) return 'rate_limited';
  return 'upstream_error';
}

async function readCapped(res, cap) {
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) throw fail('upstream_error');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cap) throw fail('upstream_error');
  return buf;
}

/** GET JSON from a fixed host. 404 gives null; any other failure throws a detail code. */
export async function getJson(fetchImpl, url, { headers = {}, timeoutMs = 20_000, cap = REGISTRY_CAP } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'isokron-mcp-check-live-probe', ...headers }, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw fail('upstream_error'); }
  if (res.status === 404) return null;
  if (!res.ok) throw fail(httpDetail(res.status, (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null)), { status: res.status });
  try { return JSON.parse((await readCapped(res, cap)).toString('utf8')); } catch (e) { throw e && e.detail ? e : fail('upstream_error'); }
}

/** owner/name of a GitHub repository URL, lower case, or null. */
export function repoOfUrl(url) {
  const m = typeof url === 'string' ? /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url.trim()) : null;
  return m ? (m[1] + '/' + m[2]).toLowerCase() : null;
}

const TYPE_RANK = { npm: 0, pypi: 1, oci: 2 };
const TRANSPORT_RANK = { stdio: 0, 'streamable-http': 1 };
const DEFAULT_BASE = { npm: ['https://registry.npmjs.org', 'https://registry.npmjs.org/'], pypi: ['https://pypi.org', 'https://pypi.org/', 'https://pypi.org/simple', 'https://pypi.org/simple/'] };
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,80}\/)?[a-z0-9][a-z0-9._~-]{0,120}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$/;
const SEMVER = /^[0-9]+(?:\.[0-9A-Za-z-]+){0,3}(?:[-+.][0-9A-Za-z.+-]{1,60})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = /^(PATH|HOME|TMPDIR|LD_[A-Z_]+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PYTHON(PATH|HOME|STARTUP)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|DOCKER_.*|GITHUB_.*|ACTIONS_.*|RUNNER_.*|SURFACE_.*|CORPUS_.*)$/i;
const ARG_RE = /^[^\u0000\n\r]{1,2000}$/;
const SUBDIR = /^(?![/.])(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+/-]{1,200}$/;
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,120}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** An OCI reference split into host, path, tag and digest; null when it is not one we can pull by digest. */
export function parseOciRef(id) {
  if (typeof id !== 'string' || id.length > 300 || /\s/.test(id)) return null;
  let rest = id; let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null; }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  const parts = rest.split('/');
  let host = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift().toLowerCase();
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  let path = parts.join('/');
  if (host === 'docker.io' && !path.includes('/')) path = 'library/' + path;
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(host) || host === 'localhost') return null;
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(path) || /(^|\/)\.\.?(\/|$)|\/\/|\/$/.test(path)) return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(tag)) return null;
  return { host, path, tag: tag || 'latest', digest };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * The digest an OCI tag points to, from the registry's v2 API (anonymous: the registry's own token service when it
 * asks for one). Data only: nothing is pulled here. Throws a detail code: image_unavailable, rate_limited or
 * upstream_error.
 */
export async function resolveOciDigest(ref, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (ref.digest) return ref.digest;
  const api = ref.host === 'docker.io' ? 'registry-1.docker.io' : ref.host;
  const url = 'https://' + api + '/v2/' + ref.path + '/manifests/' + encodeURIComponent(ref.tag);
  const ask = async (method, auth) => {
    try {
      return await fetchImpl(url, { method, headers: { accept: MANIFEST_ACCEPT, 'user-agent': 'isokron-mcp-check-live-probe', ...(auth ? { authorization: auth } : {}) }, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw fail('upstream_error'); }
  };
  const header = (res, k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  let auth = null;
  let res = await ask('HEAD', null);
  if (res.status === 401) {
    const m = /^Bearer\s+(.*)$/i.exec(String(header(res, 'www-authenticate') || ''));
    if (!m) throw fail('image_unavailable');
    const params = {};
    for (const p of m[1].matchAll(/([a-z]+)="([^"]{0,500})"/gi)) params[p[1].toLowerCase()] = p[2];
    let realm;
    try { realm = new URL(params.realm); } catch { throw fail('image_unavailable'); }
    if (realm.protocol !== 'https:' || !SAFE_HOST.test(realm.hostname)) throw fail('image_unavailable');
    if (params.service) realm.searchParams.set('service', params.service);
    realm.searchParams.set('scope', 'repository:' + ref.path + ':pull');
    const tok = await getJson(fetchImpl, realm.href, { timeoutMs, cap: 64 * 1024 });
    const token = tok && (typeof tok.token === 'string' ? tok.token : typeof tok.access_token === 'string' ? tok.access_token : null);
    if (!token || token.length > 16384) throw fail('image_unavailable');
    auth = 'Bearer ' + token;
    res = await ask('HEAD', auth);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    if (res.status === 403 && httpDetail(403, (k) => header(res, k)) === 'rate_limited') throw fail('rate_limited');
    throw fail('image_unavailable', { status: res.status });
  }
  if (!res.ok) throw fail(httpDetail(res.status, (k) => header(res, k)), { status: res.status });
  let digest = header(res, 'docker-content-digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest || ''))) {
    // Some registries leave the digest out of a HEAD answer: the manifest's own bytes give it.
    const g = await ask('GET', auth);
    if (!g.ok) throw fail(g.status === 404 ? 'image_unavailable' : httpDetail(g.status, (k) => header(g, k)));
    digest = 'sha256:' + sha256(await readCapped(g, 4 * 1024 * 1024));
  }
  return digest;
}

/** Arguments from a registry package's packageArguments: values and defaults only, never a value we would invent. */
export function packageArgs(list) {
  const args = []; let unfilled = 0;
  for (const a of Array.isArray(list) ? list.slice(0, 40) : []) {
    if (!isObj(a)) continue;
    const v = typeof a.value === 'string' ? a.value : typeof a.default === 'string' ? a.default : null;
    const usable = v !== null && ARG_RE.test(v) && !/\{[A-Za-z0-9_]+\}/.test(v);
    if (a.type === 'named') {
      if (typeof a.name !== 'string' || !/^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,80}(=)?$/.test(a.name)) { if (a.isRequired) unfilled++; continue; }
      if (usable) { if (a.name.endsWith('=')) args.push(a.name + v); else args.push(a.name, v); } else if (a.isRequired) unfilled++;
    } else if (usable) args.push(v);
    else if (a.isRequired) unfilled++;
  }
  return { args: args.slice(0, 40), unfilled };
}

/** Env names a registry package declares as required: dummy values in the sandbox (or the declared default). */
export function packageEnv(list) {
  const env = {}; const names = [];
  for (const e of Array.isArray(list) ? list.slice(0, 100) : []) {
    if (!isObj(e) || typeof e.name !== 'string' || !ENV_NAME.test(e.name) || RESERVED_ENV.test(e.name)) continue;
    names.push(e.name);
    if (!e.isRequired) continue;
    const d = typeof e.default === 'string' && e.default.length <= 500 && !/[\u0000\n\r]/.test(e.default) && !e.isSecret ? e.default : null;
    if (Object.keys(env).length < 60) env[e.name] = d;
  }
  return { env, names: names.slice(0, 100) };
}

/** The transport block for the sandbox target list, or a detail code. */
export function transportOf(t) {
  const type = isObj(t) && typeof t.type === 'string' ? t.type : 'stdio';
  if (type === 'stdio') return { transport: 'stdio' };
  if (type !== 'streamable-http') return { detail: 'unsupported_transport' };
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])(?::([0-9]{2,5}))?(\/[A-Za-z0-9._~/-]{0,200})?$/.exec(String(t.url || ''));
  const port = m && m[1] ? Number(m[1]) : null;
  if (!m || !port || port < 1024 || port > 65535) return { detail: 'unsupported_transport' };
  return { transport: 'http', http: { port, path: m[2] || '/mcp' } };
}

/** A package URL for the chosen package (purl spec), or null. */
export function purlOf(type, id, version) {
  const v = typeof version === 'string' && version && version !== 'latest' ? '@' + encodeURIComponent(version) : '';
  if (type === 'npm') return 'pkg:npm/' + id.split('/').map(encodeURIComponent).join('/') + v;
  if (type === 'pypi') return 'pkg:pypi/' + encodeURIComponent(id.toLowerCase().replace(/[-_.]+/g, '-')) + v;
  return null;
}

/**
 * The sandbox launch block for one package of a registry entry (or of the seed list, when the registry has no entry),
 * or { detail } saying why it cannot run here.
 */
export async function launchFor(pkg, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const type = String(pkg.registryType || pkg.registry || '').toLowerCase();
  const id = typeof pkg.identifier === 'string' ? pkg.identifier.trim() : '';
  if (!['npm', 'pypi', 'oci'].includes(type)) return { detail: 'unsupported_package' };
  const base = typeof pkg.registryBaseUrl === 'string' ? pkg.registryBaseUrl : null;
  if (base && type !== 'oci' && !DEFAULT_BASE[type].includes(base)) return { detail: 'private_registry' };
  const tr = transportOf(pkg.transport);
  if (tr.detail) return tr;
  const { args, unfilled } = packageArgs(pkg.packageArguments);
  const { env, names } = packageEnv(pkg.environmentVariables);
  const version = typeof pkg.version === 'string' && SEMVER.test(pkg.version) ? pkg.version : 'latest';
  const common = { ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(tr.transport === 'http' ? { transport: 'http', http: tr.http } : {}) };
  const choice = { type, identifier: id, version, transport: tr.transport, runtime_hint: typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : null, args_n: args.length, args_unfilled: unfilled, env_names: names, oci_digest: null, purl: null };
  if (type === 'npm') {
    if (!NPM_NAME.test(id)) return { detail: 'launch_invalid' };
    choice.purl = purlOf('npm', id, version);
    return { launch: { kind: 'npm', package: id, version, ...common }, choice };
  }
  if (type === 'pypi') {
    if (!PYPI_NAME.test(id)) return { detail: 'launch_invalid' };
    choice.purl = purlOf('pypi', id, version);
    return { launch: { kind: 'pypi', package: id, version, ...common }, choice };
  }
  const ref = parseOciRef(id);
  if (!ref) return { detail: 'launch_invalid' };
  const digest = await resolveOciDigest(ref, { fetch: fetchImpl });
  choice.oci_digest = digest.slice('sha256:'.length);
  choice.version = ref.tag;
  return { launch: { kind: 'docker', image: ref.host + '/' + ref.path + ':' + ref.tag + '@' + digest, ...common }, choice };
}

/** Registry entries (latest versions) whose repository is the subject or whose packages are the seed list's. */
export async function registryEntries(subject, seedPkgs, { fetch: fetchImpl = globalThis.fetch, base = REGISTRY_BASE } = {}) {
  const [owner, name] = subject.split('/');
  const seedIds = new Set(seedPkgs.map((p) => String(p.registry).toLowerCase() + ':' + String(p.identifier).toLowerCase()));
  const queries = [...new Set([name, owner + '/' + name, ...seedPkgs.filter((p) => ['npm', 'pypi'].includes(p.registry)).map((p) => p.identifier.split('/').pop())])].filter((q) => q && q.length <= 200).slice(0, 5);
  const found = new Map();
  for (const q of queries) {
    const d = await getJson(fetchImpl, base + '/v0.1/servers?search=' + encodeURIComponent(q) + '&version=latest&limit=100');
    for (const x of Array.isArray(d && d.servers) ? d.servers : []) {
      const s = x && isObj(x.server) ? x.server : x;
      if (!isObj(s) || typeof s.name !== 'string' || found.has(s.name)) continue;
      const byRepo = repoOfUrl(s.repository && s.repository.url) === subject.toLowerCase();
      const bySeed = (Array.isArray(s.packages) ? s.packages : []).some((p) => isObj(p) && seedIds.has(String(p.registryType).toLowerCase() + ':' + String(p.identifier).toLowerCase()));
      if (byRepo || bySeed) found.set(s.name, { server: s, by: byRepo && bySeed ? 'repository+seed' : byRepo ? 'repository' : 'seed' });
    }
  }
  // Entries carrying a package of the seed list first (the seed names what was sampled), then by name.
  return [...found.values()].sort((a, b) => (b.by.includes('seed') - a.by.includes('seed')) || (a.server.name < b.server.name ? -1 : 1));
}

const DETAIL_ORDER = ['unsupported_transport', 'image_unavailable', 'launch_invalid', 'private_registry', 'unsupported_package'];

/**
 * How to run one subject: { status: 'runnable', launch, choice, registry, subdir } or { status: 'skipped', detail }.
 * Never throws; a fetch that failed gives rate_limited or upstream_error (retryable).
 */
export async function resolveSubject(item, { seed = new Map(), fetch: fetchImpl = globalThis.fetch, base = REGISTRY_BASE } = {}) {
  const out = { status: 'skipped', detail: null, registry: null, choice: null, launch: null, subdir: null, seed_packages: 0, candidates: [] };
  if (!item.repo) { out.detail = 'bad_subject'; return out; }
  const seedPkgs = seed.get(item.repo.toLowerCase()) || [];
  out.seed_packages = seedPkgs.length;
  try {
    const entries = await registryEntries(item.repo, seedPkgs, { fetch: fetchImpl, base });
    const cands = [];
    for (const { server, by } of entries) for (const p of Array.isArray(server.packages) ? server.packages.slice(0, 20) : []) if (isObj(p)) cands.push({ server, by, pkg: p });
    if (!entries.length) for (const p of seedPkgs) cands.push({ server: null, by: 'seed-only', pkg: { registryType: p.registry, identifier: p.identifier } });
    const inSeed = (c) => seedPkgs.some((p) => p.registry === String(c.pkg.registryType).toLowerCase() && p.identifier.toLowerCase() === String(c.pkg.identifier).toLowerCase());
    const rank = (c) => [inSeed(c) ? 0 : 1, TRANSPORT_RANK[(c.pkg.transport && c.pkg.transport.type) || 'stdio'] ?? 9, TYPE_RANK[String(c.pkg.registryType).toLowerCase()] ?? 9];
    cands.sort((a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    out.candidates = cands.map((c) => ({ registry_type: String(c.pkg.registryType || '').slice(0, 20), identifier: String(c.pkg.identifier || '').slice(0, 300), transport: String((c.pkg.transport && c.pkg.transport.type) || 'stdio').slice(0, 30), server: c.server ? String(c.server.name).slice(0, 250) : null }));
    const details = [];
    for (const c of cands.slice(0, 8)) {
      let r;
      try { r = await launchFor(c.pkg, { fetch: fetchImpl }); } catch (e) {
        if (e && (e.detail === 'rate_limited' || e.detail === 'upstream_error')) throw e;
        r = { detail: (e && e.detail) || 'launch_invalid' };
      }
      if (r.detail) { details.push(r.detail); continue; }
      const s = c.server;
      out.status = 'runnable'; out.launch = r.launch; out.choice = { ...r.choice, matched_by: c.by };
      if (s) {
        out.registry = { name: s.name, version: typeof s.version === 'string' ? s.version.slice(0, 64) : null, entries: entries.length, transports: [...new Set((s.packages || []).map((p) => (p && p.transport && typeof p.transport.type === 'string' ? p.transport.type : 'stdio')))].slice(0, 5), remotes: Array.isArray(s.remotes) ? s.remotes.length : 0 };
        const sub = s.repository && typeof s.repository.subfolder === 'string' ? s.repository.subfolder.replace(/^\.?\/+|\/+$/g, '') : '';
        if (sub && SUBDIR.test(sub)) out.subdir = sub;
      }
      return out;
    }
    if (!cands.length) out.detail = entries.some(({ server }) => Array.isArray(server.remotes) && server.remotes.length) ? 'remote_only' : 'no_package';
    else out.detail = DETAIL_ORDER.find((d) => details.includes(d)) || 'unsupported_package';
    if (entries.length) out.registry = { name: entries[0].server.name, version: typeof entries[0].server.version === 'string' ? entries[0].server.version.slice(0, 64) : null, entries: entries.length, transports: [], remotes: Array.isArray(entries[0].server.remotes) ? entries[0].server.remotes.length : 0 };
  } catch (e) {
    out.status = 'skipped';
    out.detail = e && (e.detail === 'rate_limited' || e.detail === 'upstream_error') ? e.detail : 'upstream_error';
    out.launch = null; out.choice = null;
  }
  return out;
}

/** The forgery server as one line of JavaScript for `node -e` (comment lines dropped). */
export function forgeryScript(file = FORGERY_SERVER) {
  const s = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).filter(Boolean).join(' ');
  if (s.length > 2000 || /[\u0000\n\r]/.test(s)) throw new Error('the forgery server does not fit one sandbox argument');
  return s;
}

/** A fresh forgery marker: hex only, so no secret pattern can match it. */
export const newMarker = () => 'liveprobe-' + randomBytes(16).toString('hex');

/** The sandbox's target lists: the two controls, and the runnable subjects. */
export function targetLists(plan, { node24Image, forgery = forgeryScript() }) {
  if (!/^docker\.io\/library\/node:[0-9a-z.-]+@sha256:[0-9a-f]{64}$/.test(String(node24Image))) throw new Error('the sandbox has no pinned node image');
  const controls = {
    format: TARGETS_FORMAT, about: 'live-probe controls', defaults: { timeout_s: 300 },
    targets: [
      { id: KNOWN_ANSWER.id, repo: KNOWN_ANSWER.repo, commit: KNOWN_ANSWER.commit, registry: KNOWN_ANSWER.registry, launch: { ...KNOWN_ANSWER.launch, args: [...KNOWN_ANSWER.launch.args] }, timeout_s: KNOWN_ANSWER.timeout_s },
      { id: FORGERY.id, repo: FORGERY.repo, commit: FORGERY.commit, launch: { kind: 'docker', image: node24Image, entrypoint: 'node', args: ['-e', forgery, plan.marker] }, timeout_s: FORGERY.timeout_s },
    ],
  };
  const subjects = { format: TARGETS_FORMAT, about: 'live-probe subjects', defaults: { timeout_s: plan.subject_timeout_s }, targets: plan.items.filter((x) => x.target).map((x) => x.target) };
  return { controls, subjects };
}

/** Each subject's time limit: the subject budget shared out, within bounds. */
export const subjectTimeout = (n) => Math.max(SUBJECT_TIMEOUT_MIN_S, Math.min(SUBJECT_TIMEOUT_MAX_S, Math.floor((SUBJECT_BUDGET_S - 90) / Math.max(1, n))));

/**
 * The shard plan. validateTarget is the sandbox's own check of one target (mcp-surface-corpus src/targets.mjs): a
 * target it refuses becomes a launch_invalid skip instead of stopping the whole list.
 */
export async function planShard({ inputs, seed = new Map(), fetch: fetchImpl = globalThis.fetch, validateTarget = () => {}, marker = newMarker(), now = () => new Date(), clock = () => Date.now(), base = REGISTRY_BASE }) {
  const items = [];
  for (const it of inputs.items) {
    const t0 = clock();
    const r = await resolveSubject(it, { seed, fetch: fetchImpl, base });
    const x = { index: it.index, subject: it.subject, repo: it.repo, run_key: it.run_key, fence: it.fence, target_id: null, target: null, resolution: r, resolve_ms: clock() - t0 };
    if (r.status === 'runnable') {
      const target = { id: targetId(it.index), repo: it.repo, ref: 'HEAD', ...(r.subdir ? { subdir: r.subdir } : {}), ...(r.registry && REGISTRY_NAME.test(r.registry.name) ? { registry: r.registry.name } : {}), launch: r.launch };
      try { validateTarget(target, it.index); x.target_id = target.id; x.target = target; } catch (e) {
        r.status = 'skipped'; r.detail = 'launch_invalid'; r.invalid = String((e && e.message) || e).slice(0, 200);
      }
    }
    items.push(x);
  }
  const runnable = items.filter((x) => x.target).length;
  const timeout = subjectTimeout(runnable);
  for (const x of items) if (x.target) x.target.timeout_s = timeout;
  return { format: PLAN_FORMAT, shard_id: inputs.shardId, attempt_id: inputs.attemptId, marker, planned_at: now().toISOString(), subject_timeout_s: timeout, runnable, items };
}

// ------------------------------------------------------------------ grading

const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];

/** The tools/list result(s) of a probe, as `mcp-check -- <server>` hands them to the engine: one page, or every page. */
export function listText(rawPages) {
  const results = (Array.isArray(rawPages) ? rawPages : []).map((p) => (p && isObj(p.result) ? p.result : null)).filter(Boolean);
  if (!results.length) return null;
  return JSON.stringify(results.length === 1 ? results[0] : results);
}

/**
 * Grades a live list. summary: our numbers only (tools by position, never by name), for results/ and controls/.
 * report: the findings with the subject's names and messages, for raw/. Throws InputError when the engine refuses it.
 */
export function gradeList(text, label = 'the live tool list') {
  const parsed = parseList(text, label);
  const r = analyseList(parsed, null);
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
  };
  const report = { findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool: f.tool || null, path: f.path || null, message: f.message || null })) };
  return { summary, report, names: parsed.tools.map((t) => (t && typeof t.name === 'string' ? t.name : null)) };
}

/** What a grade is compared on: the list's identity, the letters and the checks that fired. */
export const answerOf = (summary) => ({
  tool_count: summary.tool_count,
  catalog_hash: summary.catalog_hash,
  grades: Object.fromEntries(SECTIONS.map((k) => [k, summary.sections[k].grade])),
  checks: Object.keys(summary.check_counts).sort(),
});

/** The engine's catalog hash and size of a probe's list, or null (for the per-config record). */
function catalogOf(probe) {
  const text = listed(probe) ? listText(probe.lists['tools/list'].raw_pages) : null;
  if (!text) return null;
  try { const p = M.parseInput(text); if (p.error) return null; const r = M.analyse(p); return { tool_count: r.input.tools, catalog_hash: r.input.catalogHash }; } catch { return null; }
}

/** A probe that got a whole tools/list answer. */
export const listed = (p) => !!(p && isObj(p.lists) && isObj(p.lists['tools/list']) && p.lists['tools/list'].ok === true && Array.isArray(p.lists['tools/list'].raw_pages) && p.lists['tools/list'].raw_pages.length > 0);

/** Live against static: counts and letters for results/; the names on each side for raw/. */
export function compareStatic(live, stat) {
  const best = stat && isObj(stat.static) && Array.isArray(stat.static.candidates) ? stat.static.candidates[0] : null;
  if (!best || !Array.isArray(best.tools) || !best.tools.length) return { summary: { static_read: false }, raw: null };
  let g;
  try { g = gradeList(JSON.stringify({ tools: best.tools }), 'the tool list read from source'); } catch (e) {
    return { summary: { static_read: true, static_graded: false, static_error: e instanceof InputError ? e.code : 'engine_error' }, raw: null };
  }
  const ln = new Set(live.names.filter(Boolean)); const sn = new Set(g.names.filter(Boolean));
  const onlyLive = [...ln].filter((n) => !sn.has(n)); const onlyStatic = [...sn].filter((n) => !ln.has(n));
  const differing = SECTIONS.filter((k) => live.summary.sections[k].grade !== g.summary.sections[k].grade);
  return {
    summary: {
      static_read: true, static_graded: true,
      static_kind: safeText(best.kind, /^[a-z][a-z0-9_-]{0,39}$/), static_fidelity: safeText(best.fidelity, /^[a-z][a-z0-9_-]{0,39}$/),
      live_tool_count: live.summary.tool_count, static_tool_count: g.summary.tool_count,
      names_in_both: [...ln].filter((n) => sn.has(n)).length, names_only_live: onlyLive.length, names_only_static: onlyStatic.length,
      same_catalog_hash: live.summary.catalog_hash === g.summary.catalog_hash,
      static_grades: Object.fromEntries(SECTIONS.map((k) => [k, g.summary.sections[k].grade])),
      sections_differing: differing,
      checks_only_live: Object.keys(live.summary.check_counts).filter((c) => !(c in g.summary.check_counts)).sort(),
      checks_only_static: Object.keys(g.summary.check_counts).filter((c) => !(c in live.summary.check_counts)).sort(),
    },
    raw: { names_only_live: onlyLive.slice(0, 500), names_only_static: onlyStatic.slice(0, 500), static_report: g.report },
  };
}

// ------------------------------------------------------------------ reading the sandbox's output

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { return readFileSync(file); } catch { return null; } }

/** Telemetry records about one target (and the run's own, subject null), as raw JSON lines. */
export function telemetryFor(file, id) {
  const buf = readText(file);
  if (!buf) return { lines: [], records: [] };
  const lines = []; const records = [];
  for (const l of buf.toString('utf8').split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!isObj(r) || (r.subject !== id && r.subject !== null)) continue;
    lines.push(l); if (r.subject === id) records.push(r);
  }
  return { lines, records };
}

/** network_event values: what the server and its install looked up or tried to reach, in our words. */
export function networkEvents(records, cap = 200) {
  const out = [];
  for (const r of records) {
    if (out.length >= cap) break;
    if (r.type === 'dns_query') out.push({ source: 'netlog', kind: 'dns_query', role: r.role ?? null, qtype: safeText(String(r.qtype ?? ''), /^[A-Z0-9]{1,10}$/), answer: safeText(String(r.answer ?? ''), /^[a-z]{1,12}$/), host: safeText(r.qname, SAFE_HOST), host_sha256: typeof r.qname === 'string' ? sha256(r.qname) : null });
    else if (r.type === 'connection') out.push({ source: 'netlog', kind: 'connection', role: r.role ?? null, proto: safeText(String(r.proto ?? ''), /^[a-z]{3}$/), port: int(r.port), bytes: int(r.bytes), host: safeText(r.sni || (isObj(r.http) ? r.http.host : null), SAFE_HOST) });
    else if (r.type === 'egress') out.push({ source: 'proxy', kind: 'egress', role: 'install', host: safeText(r.host, SAFE_HOST), port: int(r.port), allowed: r.allowed === true, up: int(r.up), down: int(r.down) });
    else if (r.type === 'host_drop') out.push({ source: 'host', kind: 'host_drop', chain: safeText(String(r.chain ?? ''), /^[a-z0-9]{1,12}$/), proto: safeText(String(r.proto ?? ''), /^[A-Za-z0-9]{1,10}$/), dst: safeText(String(r.dst ?? ''), /^[0-9a-f.]{1,45}$/), dpt: int(r.dpt), n: int(r.n) });
  }
  return out;
}

/** Why an item that had a target got no live list: a detail code (DETAILS). */
export function failureDetail(rec, bare, envp, { deadlineHit = false } = {}) {
  if (!rec) return deadlineHit ? 'shard_deadline' : 'harness_error';
  if (rec.excluded) return 'sandbox_evidence_missing';
  const inst = rec.install;
  if (!inst) return rec.timed_out ? 'shard_deadline' : 'harness_error';
  if (!inst.ok) {
    if (inst.kind === 'docker') return 'image_unavailable';
    if (rec.timed_out || (Array.isArray(inst.steps) && inst.steps.some((s) => s && s.timed_out))) return 'install_timeout';
    if (Array.isArray(inst.steps) && inst.steps.some((s) => s && Number.isInteger(s.exit) && s.exit !== 0)) return 'install_failed';
    return 'harness_error';
  }
  const p = envp || bare;
  if (!p) return rec.timed_out ? 'start_timeout' : 'harness_error';
  // Credentials only when the publisher declares a required env var (the registry entry). A secret-looking name in the
  // README or the source is no such evidence: optional keys are common, and the server failed with dummies too.
  const needsEnv = !!(rec.env && rec.env.names && Array.isArray(rec.env.names.registry) && rec.env.names.registry.length);
  if (p.initialize || p.era === 'modern') return needsEnv ? 'needs_credentials' : 'list_failed';
  if (rec.timed_out || /^time limit/.test(String(p.error || ''))) return needsEnv ? 'needs_credentials' : 'start_timeout';
  return needsEnv ? 'needs_credentials' : 'start_failed';
}

// ------------------------------------------------------------------ observations

/** One observations line, checked against FIELDS. A value of the wrong type is written as null with why. */
export function obs(field, value, why) {
  const type = FIELDS[field];
  if (!type) throw new Error('not a field of this lane: ' + field);
  const ok = value !== null && value !== undefined && checkType(type, value);
  return JSON.stringify(ok ? { field, value, stage: STAGE } : { field, value: null, why: why || (value === null || value === undefined ? 'not observed' : 'not of the registry type'), stage: STAGE });
}
function checkType(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string' && ENUM_RE.test(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    case 'timestamp': return isDateTime(v);
    case 'hash': return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    default: return false;
  }
}

const CAP_KEYS = ['tools', 'prompts', 'resources', 'logging', 'completions', 'experimental'];
/** capabilities_flags: what the server declared, as booleans; other keys only counted. */
export function capabilityFlags(caps) {
  if (!isObj(caps)) return null;
  const sub = (k, f) => isObj(caps[k]) && caps[k][f] === true;
  return {
    tools: k(caps, 'tools'), tools_list_changed: sub('tools', 'listChanged'),
    prompts: k(caps, 'prompts'), prompts_list_changed: sub('prompts', 'listChanged'),
    resources: k(caps, 'resources'), resources_subscribe: sub('resources', 'subscribe'), resources_list_changed: sub('resources', 'listChanged'),
    logging: k(caps, 'logging'), completions: k(caps, 'completions'), experimental: k(caps, 'experimental'),
    other_keys: Object.keys(caps).filter((x) => !CAP_KEYS.includes(x)).length,
  };
  function k(o, n) { return o[n] !== undefined && o[n] !== null && o[n] !== false; }
}

/** server_info: name, version and title when they are plain, always their hashes. */
export function serverInfo(info) {
  if (!isObj(info)) return null;
  const f = (x, re) => (typeof x === 'string' ? { v: safeText(x, re), h: sha256(x) } : { v: null, h: null });
  const n = f(info.name, SAFE_NAME); const v = f(info.version, SAFE_VERSION); const t = f(info.title, SAFE_NAME);
  return { name: n.v, version: v.v, title: t.v, name_sha256: n.h, version_sha256: v.h, title_sha256: t.h, other_keys: Object.keys(info).filter((x) => !['name', 'version', 'title'].includes(x)).length };
}

/** The registry and package fields, from the resolution (subject strings only when safeText passes). */
function resolutionObs(r) {
  const lines = [];
  const reg = r && r.registry; const c = r && r.choice;
  if (reg) {
    lines.push(obs('registry_name', safeText(reg.name, REGISTRY_NAME), 'not a plain registry name'));
    lines.push(obs('registry_version', safeText(reg.version, SAFE_VERSION), 'no plain version'));
    if (reg.transports && reg.transports.length) lines.push(obs('transports_offered', reg.transports.map((x) => safeText(x, /^[a-z][a-z-]{0,29}$/)).filter(Boolean)));
  }
  if (c) {
    lines.push(obs('registry_package_register_type', c.type));
    lines.push(obs('registry_package_identifier', safeText(c.identifier, /^[A-Za-z0-9@][A-Za-z0-9@._/:-]{0,299}$/), 'not a plain package name'));
    lines.push(obs('registry_package_version', safeText(c.version, SAFE_VERSION), 'no plain version'));
    lines.push(obs('registry_package_transport', c.transport === 'http' ? 'streamable-http' : 'stdio'));
    if (c.runtime_hint) lines.push(obs('registry_package_runtime_hint', safeText(c.runtime_hint, /^[a-z][a-z0-9_-]{0,29}$/), 'not a plain runtime hint'));
    if (c.purl) lines.push(obs('package_purl', safeText(c.purl, /^pkg:[a-z]+\/[A-Za-z0-9%._/@-]{1,300}$/), 'not a plain package URL'));
    if (c.oci_digest) lines.push(obs('oci_digest', c.oci_digest));
  }
  return lines;
}

// ------------------------------------------------------------------ one item

/** Everything about one item: { status, detail, files, skips, subjectSha }. Never throws on subject data. */
export function buildItem(item, ctx) {
  const files = {};
  const r = item.resolution;
  const lines = [obs('subject_id', item.subject)];
  const result = {
    format: FORMAT, lane: LANE, subject: item.subject, status: null, detail: null, skip_reason: null, retryable: false,
    engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION,
    install: null, live: null, static_vs_live: null, timing: { resolve_ms: int(item.resolve_ms) }, sandbox: ctx.sandboxSummary,
    driver: null, raw_truncated: [],
  };
  if (r) {
    lines.push(...resolutionObs(r));
    result.install = r.choice ? { method: r.choice.type, matched_by: safeText(r.choice.matched_by, /^[a-z+-]{1,20}$/), transport: r.choice.transport, version_requested: safeText(r.choice.version, SAFE_VERSION), args: r.choice.args_n, args_unfilled: r.choice.args_unfilled, env_declared: r.choice.env_names.length, registry_entries: r.registry ? r.registry.entries : 0 } : null;
    files['raw/resolution.json'] = json({ registry: r.registry, choice: r.choice, candidates: r.candidates, launch: r.launch, subdir: r.subdir, seed_packages: r.seed_packages, invalid: r.invalid ?? null });
  }
  let detail = null; let subjectSha = null; let deadlineHit = ctx.deadlineHit;
  if (!r || r.status !== 'runnable' || !item.target_id) {
    detail = (r && r.detail) || 'harness_error';
  } else {
    const dir = join(ctx.subjectsOut, item.target_id);
    const rec = readJson(join(dir, 'record.json'));
    const bare = readJson(join(dir, 'probe-bare.json'));
    const envp = readJson(join(dir, 'probe-env.json'));
    const stat = readJson(join(dir, 'static.json'));
    if (rec) {
      const gh = rec.source && rec.source.github;
      subjectSha = gh && typeof gh.sha === 'string' && /^[0-9a-f]{40}$/.test(gh.sha) ? gh.sha : null;
      result.driver = { public_exit: int(rec.public_exit), timed_out: rec.timed_out === true, excluded: !!rec.excluded, layers: isObj(rec.layers) ? { registry: !!rec.layers.registry, live: !!rec.layers.live, static: !!rec.layers.static, readme: !!rec.layers.readme } : null, errors: Array.isArray(rec.errors) ? rec.errors.map((e) => safeText(String(e && e.step), /^[a-z]{1,20}$/)).filter(Boolean) : [] };
      const tm = isObj(rec.timing) ? rec.timing : {};
      Object.assign(result.timing, { static_ms: int(tm.static_ms), install_ms: int(tm.install_ms), probe_ms: int(tm.probe_ms), analyse_ms: int(tm.analyse_ms), total_ms: int(tm.total_ms) });
      if (subjectSha) lines.push(obs('commit_sha', subjectSha));
      if (rec.source && rec.source.github && isObj(rec.source.github.commit) && isDateTime(rec.source.github.commit.date)) lines.push(obs('commit_date', rec.source.github.commit.date));
      const inst = rec.install;
      if (isObj(inst)) {
        const egress = Array.isArray(inst.egress) ? inst.egress : [];
        lines.push(obs('install_phase_behaviour', { kind: safeText(String(inst.kind), /^[a-z]{2,8}$/), ok: inst.ok === true, steps: (Array.isArray(inst.steps) ? inst.steps : []).slice(0, 10).map((s) => ({ name: safeText(String(s && s.name), /^[a-z]{1,12}$/), exit: Number.isInteger(s && s.exit) ? s.exit : null, ms: int(s && s.ms), timed_out: !!(s && s.timed_out) })), egress_allowed: egress.filter((e) => e && e.allowed === true).length, egress_refused: egress.filter((e) => e && e.allowed === false).length, resolved_version: safeText(inst.resolved_version, SAFE_VERSION) }));
      }
      lines.push(obs('observation_coverage', { registry: !!(rec.layers && rec.layers.registry), live: !!(rec.layers && rec.layers.live), static: !!(rec.layers && rec.layers.static), readme: !!(rec.layers && rec.layers.readme), probes: ['bare', 'env'].filter((k) => isObj(rec.probes) && rec.probes[k]) }));
    }
    const primary = listed(envp) ? envp : listed(bare) ? bare : null;
    if (!primary) {
      detail = failureDetail(rec, bare, envp, { deadlineHit });
    } else {
      const text = listText(primary.lists['tools/list'].raw_pages);
      let g = null;
      const g0 = Date.now();
      try { g = gradeList(text); } catch (e) {
        if (!(e instanceof InputError)) throw e;
        detail = 'list_rejected'; result.live = { list_error: safeText(e.code, /^[a-z_]{1,40}$/) };
      }
      result.timing.grade_ms = Date.now() - g0;
      if (g) {
        result.live = { ...g.summary, config_state: primary === bare ? 'none' : 'dummy', pages: int(primary.lists['tools/list'].pages) };
        files['raw/report.json'] = json({ findings: g.report.findings, tool_names: g.names });
        const cmp = compareStatic(g, stat);
        result.static_vs_live = cmp.summary;
        if (cmp.raw) files['raw/static-compare.json'] = json(cmp.raw);
        lines.push(obs('static_vs_live_agreement', cmp.summary));
        const init = isObj(primary.initialize) ? primary.initialize : null;
        lines.push(obs('protocol_era', primary.era === 'modern' ? 'modern' : 'legacy'));
        lines.push(obs('client_version', safeText(primary.protocol_offered, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)));
        if (init) {
          lines.push(obs('protocol_negotiated', safeText(init.protocolVersion, /^[0-9A-Za-z.-]{1,40}$/), 'not a plain protocol version'));
          lines.push(obs('server_info', serverInfo(init.serverInfo), 'no serverInfo object'));
          lines.push(obs('capabilities_flags', capabilityFlags(init.capabilities), 'no capabilities object'));
          if (isObj(init.capabilities)) lines.push(obs('capabilities_jcs_sha256', sha256(canonical(init.capabilities))));
          if (typeof init.instructions === 'string') { lines.push(obs('instructions_len_chars', init.instructions.length)); lines.push(obs('instructions_sha256', sha256(init.instructions))); }
        }
        const tm = isObj(primary.timing) ? primary.timing : {};
        lines.push(obs('startup_ms', int(tm.initialize_ms), 'no initialize answer'));
        lines.push(obs('latency_cold_ms', int(primary.lists['tools/list'].ms), 'not timed'));
        lines.push(obs('startup_without_config', bare ? (listed(bare) ? 'lists_tools' : 'no_list') : 'not_run'));
        lines.push(obs('config_state', primary === bare ? 'none' : 'dummy'));
        lines.push(obs('catalog_per_config_state', { none: bare ? { listed: listed(bare), ...(catalogOf(bare) || {}) } : null, dummy: envp ? { listed: listed(envp), ...(catalogOf(envp) || {}) } : null }));
        const tr = isObj(primary.transport) ? primary.transport : {};
        lines.push(obs('stdout_noise_lines', int(tr.non_json_lines), 'not counted'));
        lines.push(obs('stderr_counts', { bytes: int(primary.stderr_bytes), truncated: primary.stderr_truncated === true }));
        lines.push(obs('list_changed_notifications', (Array.isArray(tr.notifications) ? tr.notifications : []).filter((n) => n === 'notifications/tools/list_changed').length));
        const tl = primary.lists['tools/list'];
        lines.push(obs('pagination_behaviour', { pages: int(tl.pages), page_sizes: Array.isArray(tl.page_sizes) ? tl.page_sizes.filter((n) => int(n) !== null).slice(0, 100) : [], paginated: int(tl.pages) > 1 }));
      }
    }
    // The captured bytes: the tools/list answers, each probe whole, the static read, the registry entry, the logs.
    const raw = [];
    if (primary) raw.push(['raw/tools-list.json', Buffer.from(json(primary.lists['tools/list'].raw_pages))]);
    for (const [k, p] of [['bare', bare], ['env', envp]]) if (p) raw.push(['raw/probe-' + k + '.json', Buffer.from(json(p))]);
    if (rec) raw.push(['raw/record.json', Buffer.from(json(rec))]);
    for (const f of ['registry.json', 'static.json', 'analysis.json', 'steps.log']) { const b = readText(join(dir, f)); if (b) raw.push(['raw/' + f.replace(/\.log$/, '.txt'), b]); }
    const tel = telemetryFor(ctx.subjectsTelemetry, item.target_id);
    if (tel.lines.length) raw.push(['raw/telemetry.jsonl', Buffer.from(tel.lines.join('\n') + '\n')]);
    lines.push(...networkEvents(tel.records).map((e) => obs('network_event', e)));
    addRaw(files, raw, result);
  }
  lines.push(obs('step_telemetry', result.timing));
  lines.push(obs('sandbox_tier', 'gvisor'));
  lines.push(obs('runner_env', ctx.runnerEnv, 'the sandbox wrote no shard record'));
  lines.push(obs('our_tool_versions', ctx.toolVersions));
  if (detail) {
    const [reason, retryable, stage] = DETAILS[detail] || DETAILS.harness_error;
    result.status = 'skipped'; result.detail = detail; result.skip_reason = reason; result.retryable = retryable;
    lines.push(obs('error_taxonomy_code', detail));
    files[RESULT_PATH] = json(result);
    files['observations/live.ndjson'] = lines.join('\n') + '\n';
    return { status: 'skipped', detail, files, skips: [{ stage, reason, evidence: RESULT_PATH, ...(retryable ? { retryable: true } : {}) }], subjectSha };
  }
  result.status = 'graded';
  files[RESULT_PATH] = json(result);
  files['observations/live.ndjson'] = lines.join('\n') + '\n';
  return { status: 'graded', detail: null, files, skips: [], subjectSha };
}

/** Raw files, each capped at RAW_FILE_CAP and all at RAW_TOTAL_CAP; what was cut is recorded. */
function addRaw(files, raw, result) {
  let total = 0;
  for (const [path, buf] of raw) {
    let b = buf.length > RAW_FILE_CAP ? buf.subarray(0, RAW_FILE_CAP) : buf;
    if (total + b.length > RAW_TOTAL_CAP) b = b.subarray(0, Math.max(0, RAW_TOTAL_CAP - total));
    if (b.length < buf.length) result.raw_truncated.push({ path, bytes: buf.length, kept: b.length });
    if (!b.length) continue;
    files[path] = b; total += b.length;
  }
}

// ------------------------------------------------------------------ controls

/** The known-answer control's expected answer, computed from the saved capture of our own server. */
export function knownAnswerFrom(captureFile = KNOWN_ANSWER_CAPTURE) {
  const g = gradeList(readFileSync(captureFile, 'utf8'), 'the known-answer capture');
  return { format: CONTROL_FORMAT, control: 'known-answer', server: KNOWN_ANSWER.launch.package + '@' + KNOWN_ANSWER.launch.version, rubric_version: M.RUBRIC_VERSION, answer: answerOf(g.summary) };
}

/** The identity keys and envelope shape ingest's forgery check looks for in a control output. */
export function leaks(text, marker) {
  if (text.includes(marker)) return true;
  if (/"(attempt[_-]?id|attemptid|run[_-]?key|runkey|fence|fencing[_-]?(?:no|number)|fencingno|fence[_-]?token)"\s*:/i.test(text)) return true;
  if (/"schema_version"\s*:/.test(text) && /"files"\s*:/.test(text)) return true;
  return /["']?\b(attempt[_-]?id|run[_-]?key|fencing[_-]?(?:no|number)|fence)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{1,128}/i.test(text);
}

/**
 * The three controls, from the sandbox's output. Each returns { control, files }; observed is the expected label only
 * when the evidence shows it. known_good: our own server's live list and grades are the known answer. forgery: the
 * forgery server's list came back (its marker is in raw/), and what this lane wrote about it outside raw/ (the same
 * results and observations a subject gets) holds neither the marker nor anything ingest reads as an identity or an
 * envelope. malicious: the sandbox self test blocked and logged every escape attempt, and its telemetry check passed.
 */
export function evaluateControls(ctx, { knownFile = KNOWN_ANSWER_FILE } = {}) {
  const out = [];
  // known answer
  {
    const dir = join(ctx.controlsOut, KNOWN_ANSWER.id);
    const p = [readJson(join(dir, 'probe-env.json')), readJson(join(dir, 'probe-bare.json'))].find(listed) || null;
    const expected = readJson(knownFile);
    let observed = null; let pages = null;
    if (p) { pages = p.lists['tools/list'].raw_pages; try { observed = answerOf(gradeList(listText(pages)).summary); } catch { observed = null; } }
    const match = !!(observed && expected && JSON.stringify(observed) === JSON.stringify(expected.answer));
    out.push({
      control: { kind: 'known_good', expected: 'match', observed: !p ? 'not_run' : match ? 'match' : 'mismatch', output: 'controls/known-answer.json' },
      files: { 'controls/known-answer.json': json({ format: CONTROL_FORMAT, control: 'known-answer', server: KNOWN_ANSWER.launch.package + '@' + KNOWN_ANSWER.launch.version, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, match, expected: expected && expected.answer, observed }), ...(pages ? { 'raw/control-known-answer/tools-list.json': json(pages) } : {}) },
    });
  }
  // forgery
  {
    const marker = ctx.plan.marker;
    const dir = join(ctx.controlsOut, FORGERY.id);
    const bare = readJson(join(dir, 'probe-bare.json'));
    let observed = 'not_run'; let outText = json({ format: CONTROL_FORMAT, control: 'forgery', status: 'not_run' }); let rawText = null;
    if (listed(bare)) {
      rawText = json(bare);
      // The forgery server runs through the same item code as a subject, against the controls' output.
      const fake = { index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', target_id: FORGERY.id, resolve_ms: 0, resolution: { status: 'runnable', detail: null, registry: null, choice: null, candidates: [], launch: null, subdir: null, seed_packages: 0 } };
      const built = buildItem(fake, { ...ctx, subjectsOut: ctx.controlsOut, subjectsTelemetry: ctx.controlsTelemetry });
      const ours = Object.entries(built.files).filter(([k]) => !k.startsWith('raw/'));
      outText = json({ format: CONTROL_FORMAT, control: 'forgery', status: built.status, files: Object.fromEntries(ours.map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('utf8') : v])) });
      const tools = (bare.lists['tools/list'].raw_pages || []).length;
      observed = built.status !== 'graded' || !tools || !rawText.includes(marker) ? 'not_run' : leaks(outText, marker) ? 'leaked' : 'contained';
    }
    out.push({
      control: { kind: 'forgery', expected: 'contained', observed, output: 'controls/forgery.json', marker },
      files: { 'controls/forgery.json': outText, ...(rawText ? { 'raw/control-forgery/probe.json': rawText } : {}) },
    });
  }
  // sandbox self test
  {
    const res = readJson(join(ctx.work, 'selftest', 'results.json'));
    const cases = res && Array.isArray(res.cases) ? res.cases.map((c) => ({ case: safeText(String(c && c.case), /^[a-z0-9-]{1,30}$/), blocked: !!(c && c.blocked), logged: !!(c && c.logged), pass: !!(c && c.pass) })) : [];
    const ok = ctx.state && ctx.state.selftest_check_rc === 0 && cases.length > 0 && res.total === cases.length && cases.every((c) => c.pass);
    out.push({
      control: { kind: 'malicious', expected: 'blocked', observed: ok ? 'blocked' : 'not_blocked', output: 'controls/sandbox-selftest.json' },
      files: { 'controls/sandbox-selftest.json': json({ format: CONTROL_FORMAT, control: 'sandbox-selftest', check_rc: ctx.state ? ctx.state.selftest_check_rc : null, gvisor_release: res ? safeText(res.gvisor_release, /^[0-9.a-z-]{1,40}$/) : null, passed: res ? int(res.passed) : null, total: res ? int(res.total) : null, cases }) },
    });
  }
  return out;
}

// ------------------------------------------------------------------ the shard

/** The settings digest: SETTINGS, our version and the sandbox commit. */
export function settingsDigest(mscCommit) {
  const s = { ...SETTINGS, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION, surface_corpus: mscCommit || null };
  return sha256(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]])));
}

/**
 * Builds every item's bundle from <work>. Throws ControlFailure when a control did not give its expected outcome: then
 * nothing is written and nothing may be uploaded.
 */
export function bundleShard({ work, now = () => new Date(), log = () => {}, knownFile = KNOWN_ANSWER_FILE }) {
  const plan = readJson(join(work, 'plan.json'));
  if (!plan || plan.format !== PLAN_FORMAT) throw new ControlFailure('no plan in the work folder');
  const state = readJson(join(work, 'sandbox.json')) || {};
  const shardJson = readJson(join(work, 'driver-subjects', '_shard', 'shard.json')) || readJson(join(work, 'driver-controls', '_shard', 'shard.json'));
  const runner = shardJson && isObj(shardJson.runner) ? shardJson.runner : null;
  const mscCommit = typeof state.msc_commit === 'string' && /^[0-9a-f]{40}$/.test(state.msc_commit) ? state.msc_commit : null;
  const ctx = {
    work, plan, state,
    controlsOut: join(work, 'driver-controls'), controlsTelemetry: join(work, 'driver-controls', '_shard', 'telemetry.jsonl'),
    subjectsOut: join(work, 'driver-subjects'), subjectsTelemetry: join(work, 'driver-subjects', '_shard', 'telemetry.jsonl'),
    deadlineHit: state.subjects_rc === 124 || state.subjects_rc === 137,
    runnerEnv: runner ? { os: safeText(runner.os, /^[a-z]{1,10}$/), arch: safeText(runner.arch, /^[a-z0-9_]{1,10}$/), kernel: safeText(runner.kernel, /^[A-Za-z0-9._+-]{1,60}$/), node: safeText(runner.node, /^v[0-9.]{1,20}$/), docker: safeText(runner.docker, /^[0-9][0-9A-Za-z.+-]{0,30}$/), container_platform: safeText(runner.container_platform, /^[a-z0-9/]{1,30}$/) } : null,
    toolVersions: { mcp_check: VERSION, rubric: M.RUBRIC_VERSION, spec: M.SPEC_VERSION, surface_corpus: mscCommit, worker_kit: safeText(state.worker_kit_ref, /^[0-9a-f]{40}$/), gvisor: safeText(state.gvisor_release, /^[0-9.a-z-]{1,40}$/) },
    sandboxSummary: { runtime: 'runsc', selftest: state.selftest_check_rc === 0 ? 'passed' : 'failed', controls_rc: int(state.controls_rc), subjects_rc: int(state.subjects_rc), swept: state.swept === true },
  };
  const controls = evaluateControls(ctx, { knownFile });
  const bad = controls.filter((c) => c.control.observed !== c.control.expected);
  if (bad.length) throw new ControlFailure('controls failed: ' + bad.map((c) => c.control.kind + '=' + c.control.observed).join(', '));
  if (state.swept !== true) throw new ControlFailure('the sandbox was not shown to be gone before upload');
  const digest = settingsDigest(mscCommit);
  const finishedAt = now().toISOString();
  const outRoot = join(work, 'out');
  rmSync(outRoot, { recursive: true, force: true });
  const summary = [];
  for (const item of plan.items) {
    const b = buildItem(item, ctx);
    const files = { ...b.files };
    for (const c of controls) Object.assign(files, c.files);
    files['logs/live-probe.log'] = 'item ' + item.index + ': ' + b.status + (b.detail ? ' (' + b.detail + ')' : '') + '\n';
    const dir = join(outRoot, String(item.index));
    for (const [p, data] of Object.entries(files)) { mkdirSync(dirname(join(dir, 'bundle', p)), { recursive: true }); writeFileSync(join(dir, 'bundle', p), data); }
    const meta = {
      subject: { id: item.subject, repo: item.repo, sha: b.subjectSha },
      tools: [{ name: '@isokron/mcp-check', version: VERSION }, ...(mscCommit ? [{ name: 'isokron-ai/mcp-surface-corpus', version: mscCommit }] : [])],
      oracles: [],
      settings_manifest_digest: digest,
      started_at: plan.planned_at,
      finished_at: finishedAt,
      skips: b.skips,
      controls: controls.map((c) => c.control),
    };
    writeFileSync(join(dir, 'meta.json'), json(meta));
    summary.push({ index: item.index, status: b.status, detail: b.detail });
    log('item ' + item.index + ': ' + b.status + (b.detail ? ' (' + b.detail + ', ' + DETAILS[b.detail][0] + (DETAILS[b.detail][1] ? ', retryable' : '') + ')' : ''));
  }
  return summary;
}

// ------------------------------------------------------------------ the pull request self test

/**
 * Judges dry-run bundles with tool-qa's own code at the pinned commit (a checkout in toolQa): the manifest schema,
 * ingest's forgery checks (identity, files, claims, controls), the field registry and the secret scan. Returns the
 * problems found and each bundle's results file.
 */
/** The tool-qa files verify imports, with what they import; the workflows' sparse checkout of tool-qa must hold them. */
export const TOOL_QA_FILES = Object.freeze(['worker-kit/contract.mjs', 'worker-kit/manifest.schema.json', 'worker-kit/tar.mjs', 'ingest/forgery.mjs', 'ingest/redact.mjs', 'ingest/registry.mjs', 'scripts/lib/yaml-lite.mjs', 'history/seed-v1.json']);

export async function verifyBundles({ toolQa, tars, expect, env = process.env, fetch: fetchImpl = globalThis.fetch, registryFile = null }) {
  const imp = (p) => import(pathToFileURL(join(toolQa, p)).href);
  const { validateManifest } = await imp('worker-kit/contract.mjs');
  const { readTar } = await imp('worker-kit/tar.mjs');
  const { checkBundle } = await imp('ingest/forgery.mjs');
  const { scanFiles } = await imp('ingest/redact.mjs');
  const reg = await imp('ingest/registry.mjs');
  const registry = registryFile ? reg.parseRegistry(readFileSync(registryFile, 'utf8')) : await reg.loadRegistry({ fetch: fetchImpl });
  const problems = []; const results = [];
  for (const t of tars) {
    const entries = readTar(readFileSync(t));
    const files = new Map(entries.map((e) => [e.path, e.data]));
    const manifestBuf = files.get('manifest.json'); files.delete('manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    const v = validateManifest(manifest);
    if (!v.ok) problems.push({ tar: t, reason: 'manifest_invalid', detail: v.errors.slice(0, 5) });
    const item = expect.items.find((x) => x.run_key === manifest.run_key);
    if (!item) { problems.push({ tar: t, reason: 'unexpected_run_key' }); continue; }
    const exp = { attempt_id: env.ATTEMPT_ID || expect.attempt_id, fence: item.fence, run_key: item.run_key, repo: env.GITHUB_REPOSITORY, workflow_file: manifest.workflow && manifest.workflow.file, workflow_sha: env.GITHUB_WORKFLOW_SHA, run_id: Number(env.GITHUB_RUN_ID) };
    for (const p of checkBundle(manifest, files, exp)) problems.push({ tar: t, ...p });
    const obsFiles = new Map([...files].filter(([k]) => k.startsWith('observations/')));
    const ov = reg.validateObservations(obsFiles, registry);
    if (!ov.ok) for (const p of ov.errors) problems.push({ tar: t, ...p });
    if (!ov.records) problems.push({ tar: t, reason: 'no_observations' });
    const hits = scanFiles(new Map([...files].filter(([k]) => !k.startsWith('raw/'))));
    if (hits.length) problems.push({ tar: t, reason: 'secret_outside_raw', n: hits.length, paths: [...new Set(hits.map((h) => h.path))].slice(0, 5) });
    const res = JSON.parse(files.get(RESULT_PATH).toString('utf8'));
    results.push({ index: expect.items.indexOf(item), subject: item.subject, status: res.status, detail: res.detail, skip_reason: res.skip_reason, live: res.live ? answerOf2(res.live) : null, skips: manifest.skips, controls: manifest.controls.map((c) => c.kind + ':' + c.observed) });
    const want = item.expect || {};
    if (want.status && res.status !== want.status) problems.push({ tar: t, reason: 'unexpected_status', want: want.status, got: res.status, detail: res.detail });
    if (want.skip_reason && res.skip_reason !== want.skip_reason) problems.push({ tar: t, reason: 'unexpected_skip_reason', want: want.skip_reason, got: res.skip_reason });
    if (want.catalog_hash && (!res.live || res.live.catalog_hash !== want.catalog_hash)) problems.push({ tar: t, reason: 'unexpected_catalog', want: want.catalog_hash, got: res.live && res.live.catalog_hash });
    if (want.min_tools && (!res.live || !(res.live.tool_count >= want.min_tools))) problems.push({ tar: t, reason: 'too_few_tools', want: want.min_tools, got: res.live && res.live.tool_count });
    if (manifest.controls.length !== 3) problems.push({ tar: t, reason: 'controls_missing', got: manifest.controls.length });
  }
  if (results.length !== expect.items.length) problems.push({ reason: 'bundle_count', want: expect.items.length, got: results.length });
  return { problems, results };
}
function answerOf2(live) { return live && live.sections ? { tool_count: live.tool_count, catalog_hash: live.catalog_hash, grades: Object.fromEntries(SECTIONS.map((k) => [k, live.sections[k] && live.sections[k].grade])) } : live; }

// ------------------------------------------------------------------ command line

function output(env, lines, stdout) {
  const text = lines.map((l) => l + '\n').join('');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text); else stdout.write(text);
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetch: fetchImpl = globalThis.fetch } = {}) {
  const [cmd, ...rest] = argv;
  const say = (s) => stdout.write(s + '\n');
  if (cmd === 'known-answer' && rest.length <= 1) { stdout.write(json(knownAnswerFrom(rest[0] || KNOWN_ANSWER_CAPTURE))); return 0; }
  if (cmd === 'plan') {
    const work = rest[0];
    const opt = {}; for (let i = 1; i < rest.length; i += 2) opt[rest[i]] = rest[i + 1];
    if (!work || !opt['--msc'] || Object.keys(opt).some((k) => !['--msc', '--seed'].includes(k))) { say('usage: node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <seed-v1.json>]'); return 2; }
    let inputs;
    try { inputs = parseInputs({ shardId: env.SHARD_ID, attemptId: env.ATTEMPT_ID, items: env.ITEMS }); } catch (e) {
      if (e instanceof InputProblem) { say('::error title=' + LANE + '::' + e.message + ' (' + e.code + ')'); return 1; }
      throw e;
    }
    const { validateTarget } = await import(pathToFileURL(join(resolve(opt['--msc']), 'src', 'targets.mjs')).href);
    const images = JSON.parse(readFileSync(join(resolve(opt['--msc']), 'images.json'), 'utf8'));
    const seed = loadSeed(opt['--seed']);
    const plan = await planShard({ inputs, seed, fetch: fetchImpl, validateTarget });
    const lists = targetLists(plan, { node24Image: images.node24 });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'plan.json'), json(plan));
    writeFileSync(join(work, 'targets-controls.json'), json(lists.controls));
    writeFileSync(join(work, 'targets-subjects.json'), json(lists.subjects));
    const lines = ['subject_timeout_s=' + plan.subject_timeout_s, 'runnable=' + plan.runnable];
    for (const it of plan.items) lines.push('has_' + it.index + '=true', 'fence_' + it.index + '=' + it.fence, 'run_key_' + it.index + '=' + it.run_key);
    output(env, lines, stdout);
    for (const it of plan.items) say('item ' + it.index + ': ' + (it.target ? 'runnable (' + it.resolution.choice.type + ', ' + it.resolution.choice.transport + ')' : 'skipped (' + it.resolution.detail + ')'));
    say(plan.runnable + ' of ' + plan.items.length + ' subjects runnable; each has ' + plan.subject_timeout_s + ' s');
    return 0;
  }
  if (cmd === 'bundle' && rest.length === 1) {
    try { bundleShard({ work: rest[0], log: say }); } catch (e) {
      if (e instanceof ControlFailure) { say('::error title=' + LANE + '::' + e.message + '; nothing is uploaded'); return 3; }
      throw e;
    }
    return 0;
  }
  if (cmd === 'verify' && rest.length >= 3) {
    const [toolQa, expectFile, ...tars] = rest;
    const expect = JSON.parse(readFileSync(expectFile, 'utf8'));
    const { problems, results } = await verifyBundles({ toolQa, tars, expect, env, fetch: fetchImpl });
    for (const r of results) say(JSON.stringify(r));
    for (const p of problems) say('::error title=' + LANE + ' self test::' + JSON.stringify(p));
    say(problems.length ? problems.length + ' problem(s)' : 'every bundle passed tool-qa\'s checks and the expected outcomes');
    return problems.length ? 3 : 0;
  }
  stderr.write('usage: node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <file>] | bundle <work> | verify <tool-qa dir> <expect.json> <tar>... | known-answer [<capture.json>]\n');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, (e) => { process.stderr.write(LANE + ': harness error: ' + String((e && e.stack) || e).slice(0, 2000) + '\n'); process.exitCode = 3; });
}
