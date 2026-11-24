// The scan-static loop worker (corpus/scan-static.mjs, corpus/loop-guard.mjs). GitHub is a fake: nothing here
// touches the network. The bundle checks mirror what tool-qa's worker-kit and ingest enforce (bundle paths, meta
// keys, control outcomes, no identity claim or forgery marker outside raw/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FORMAT, KNOWN_ANSWER_FILE, MARKER_RE, MAX_ITEMS, MAX_ITEMS_CHARS, PERMANENT, RESULT_PATH, SKIP_REASON, TRANSIENT, skipReasonFor,
  InputProblem, buildBundle, forgeryControl, isDateTime, knownAnswerControl, knownAnswerFile, main, observationsOf,
  parseInputs, runShard, scanSubject, settingsDigest,
} from '../corpus/scan-static.mjs';
import * as guard from '../corpus/loop-guard.mjs';
// tool-qa's own result contract and ingest checks, at the commit WORKER_KIT_REF pins (test/tool-qa/README.md).
import { SKIP_REASONS, buildManifest, validateManifest } from './tool-qa/worker-kit/contract.mjs';
import { readTar, writeTar } from './tool-qa/worker-kit/tar.mjs';
import { checkBundle } from './tool-qa/ingest/forgery.mjs';
import { scanFiles } from './tool-qa/ingest/redact.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const jsLiteral = {
  'package.json': readFileSync(join(root, 'test', 'repos', 'js-literal', 'package.json'), 'utf8'),
  'lib/server.js': readFileSync(join(root, 'test', 'repos', 'js-literal', 'lib', 'server.js'), 'utf8'),
};
const SHA = 'c'.repeat(40);
const DATE = '2026-01-02T03:04:05Z';
const TOKEN = 'test-token-not-real';
const key = (n) => createHash('sha256').update('run ' + n).digest('hex');
const itemsOf = (subjects) => JSON.stringify(subjects.map((subject, i) => ({ subject, run_key: key(i), fence: 10 + i })));
const tmp = (p) => mkdtempSync(join(tmpdir(), 'scan-static-' + p + '-'));

function res(status, body = '', headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
const hang = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

/**
 * A fake GitHub. subjects: { 'owner/name': { repo, branch, tree, file, files, hang } } where repo, branch, tree and
 * file are an HTTP status to answer with (or, for repo, extra fields of the repository), files the repository's files.
 * Every request is recorded in `calls` with the Authorization header it carried.
 */
function fakeGithub(subjects, calls = []) {
  const of = (o, r) => subjects[o + '/' + r];
  return async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: (init.headers && init.headers.Authorization) || null });
    let m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(u);
    if (m) {
      const s = of(m[1], m[2]);
      if (!s) return res(404, { message: 'Not Found' });
      if (s.hang) return hang(init.signal);
      if (s.network) throw new TypeError('fetch failed');
      if (typeof s.repo === 'number') return res(s.repo, s.repoBody || '', s.repoHeaders || {});
      return res(200, { full_name: m[1] + '/' + m[2], default_branch: 'main', private: false, archived: false, fork: false, ...(s.repo || {}) });
    }
    m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(u);
    if (m) {
      const s = of(m[1], m[2]);
      if (!s) return res(404);
      if (typeof s.branch === 'number') return res(s.branch);
      return res(200, { name: decodeURIComponent(m[3]), commit: { sha: s.sha || SHA, commit: { committer: { date: s.date === undefined ? DATE : s.date } } } });
    }
    m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(u);
    if (m) {
      const s = of(m[1], m[2]);
      if (!s) return res(404);
      if (typeof s.tree === 'number') return res(s.tree, '', s.treeHeaders || {});
      return res(200, { sha: m[3], truncated: false, tree: Object.entries(s.files || {}).map(([path, t]) => ({ type: 'blob', path, size: t.length })) });
    }
    m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(u);
    if (m) {
      const s = of(m[1], m[2]);
      if (!s) return res(404);
      if (typeof s.file === 'number') return res(s.file);
      const t = (s.files || {})[m[4].split('/').map(decodeURIComponent).join('/')];
      return t === undefined ? res(404) : res(200, t);
    }
    return res(404);
  };
}

function readTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

// What tool-qa's worker-kit and ingest check, restated here so a change on either side shows.
const BUNDLE_PATH_RE = /^(observations|results|controls|raw|logs)(\/(?!\.\.?(\/|$))[A-Za-z0-9._-]{1,100})+$/;
const META_KEYS = ['subject', 'tools', 'oracles', 'settings_manifest_digest', 'started_at', 'finished_at', 'skips', 'controls'];
const LABEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TEXT_CLAIM_RE = /["']?\b(attempt[_-]?id|run[_-]?key|fencing[_-]?(?:no|number)|fence)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._-]{1,128})/gi;
const IDENTITY_KEY = (k) => ['attempt_id', 'attemptid', 'run_key', 'runkey', 'fence', 'fencing_no', 'fencing_number', 'fencingno', 'fence_token'].includes(String(k).toLowerCase().replace(/[-\s]/g, '_'));
const keysOf = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
};
const objectsOf = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => objectsOf(x, out));
  else if (v && typeof v === 'object') { out.push(v); Object.values(v).forEach((x) => objectsOf(x, out)); }
  return out;
};
const docsOf = (path, text) => (path.endsWith('.json') ? [JSON.parse(text)] : path.endsWith('.ndjson') ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null);

/**
 * What tool-qa itself does with one item's bundle, with its own code: the worker kit builds and validates the
 * manifest from the meta file and packs the tar; ingest reads the tar back and runs its forgery checks (identity,
 * file list, claims outside raw/, controls) and its secret scan outside raw/. Returns the manifest.
 */
function assertToolQa(files, meta, { identity = { attempt_id: 'att-1', fence: 10, run_key: key(0) } } = {}) {
  const workflow = { repo: 'isokron-ai/mcp-check', file: '.github/workflows/scan-static.yml', sha: 'f'.repeat(40), run_id: 4242, run_attempt: 1 };
  const list = [...files].map(([path, text]) => ({ path, data: Buffer.from(text) }));
  const manifest = buildManifest({ identity, workflow, meta, files: list }); // throws if the manifest is invalid
  assert.deepEqual(validateManifest(manifest).errors, []);
  const tar = writeTar([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...list]);
  const read = new Map(readTar(tar).filter((e) => e.path !== 'manifest.json').map((e) => [e.path, e.data]));
  const exp = { ...identity, repo: workflow.repo, workflow_file: workflow.file, workflow_sha: workflow.sha, run_id: workflow.run_id, run_attempt: 1 };
  assert.deepEqual(checkBundle(manifest, read, exp), [], 'tool-qa ingest forgery checks');
  const outsideRaw = [['manifest.json', Buffer.from(JSON.stringify(manifest))], ...[...read].filter(([p]) => !p.startsWith('raw/'))];
  assert.deepEqual(scanFiles(outsideRaw).map((h) => h.path + ' ' + h.rule), [], 'tool-qa secret scan outside raw/');
  return manifest;
}

/** Asserts that one item's bundle and meta file pass the contract; returns the parsed result and observations. */
function assertBundle(files, meta, { subjectText = [] } = {}) {
  for (const p of files.keys()) {
    assert.match(p, BUNDLE_PATH_RE, p);
    assert.ok(p.length <= 240, p);
  }
  assert.deepEqual(Object.keys(meta).sort(), [...META_KEYS].sort());
  assert.deepEqual(Object.keys(meta.subject).sort(), ['id', 'repo', 'sha']);
  assert.match(meta.subject.id, /^[^\s]{1,512}$/);
  assert.ok(meta.subject.repo === null || /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(meta.subject.repo));
  assert.ok(meta.subject.sha === null || /^[0-9a-f]{40}$/.test(meta.subject.sha));
  assert.ok(isDateTime(meta.started_at) && isDateTime(meta.finished_at));
  assert.match(meta.settings_manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(meta.tools.length, 1);
  assert.deepEqual(Object.keys(meta.tools[0]).sort(), ['name', 'version']);
  assert.deepEqual(meta.oracles, []);
  for (const s of meta.skips) {
    assert.ok(SKIP_REASONS.includes(s.reason), s.reason);
    assert.ok(files.has(s.evidence));
  }
  // Controls: at least one, every one as expected, outputs outside raw/, the forgery marker only in raw/.
  assert.ok(meta.controls.length >= 1);
  const forgery = meta.controls.filter((c) => c.kind === 'forgery');
  assert.equal(forgery.length, 1);
  for (const c of meta.controls) {
    assert.match(c.expected, LABEL_RE);
    assert.equal(c.observed, c.expected, c.kind);
    assert.ok(files.has(c.output) && !c.output.startsWith('raw/'), c.output);
  }
  const marker = forgery[0].marker;
  assert.match(marker, MARKER_RE);
  const out = files.get(forgery[0].output);
  assert.ok(!out.includes(marker));
  for (const o of objectsOf(JSON.parse(out))) {
    assert.ok(!Object.keys(o).some(IDENTITY_KEY), 'an identity key in the forgery control output');
    assert.ok(!(Object.keys(o).includes('schema_version') && Object.keys(o).includes('files')), 'an envelope in the forgery control output');
  }
  let inRaw = false;
  for (const [p, text] of files) {
    if (p.startsWith('raw/')) { if (text.includes(marker)) inRaw = true; continue; }
    assert.ok(!text.includes(marker), 'the marker in ' + p);
    for (const s of subjectText) assert.ok(!text.includes(s), JSON.stringify(s) + ' in ' + p);
    const docs = docsOf(p, text);
    if (docs) for (const d of docs) assert.deepEqual(keysOf(d).filter(IDENTITY_KEY), [], 'an identity key in ' + p);
    else assert.deepEqual([...text.matchAll(TEXT_CLAIM_RE)].map((m) => m[0]), [], 'an identity claim in ' + p);
  }
  assert.ok(inRaw, 'the marker came back in raw/');
  assertToolQa(files, meta);
  const result = JSON.parse(files.get(RESULT_PATH));
  const obs = files.get('observations/static.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { result, obs };
}

test('parseInputs: a well-formed dispatch is taken as given', () => {
  const p = parseInputs({ shardId: 'scan-static-3f2a9c01b7d4', attemptId: 'a1.b_c-2', items: itemsOf(['o/r', 'Some-Org/repo.name_x']) });
  assert.equal(p.shardId, 'scan-static-3f2a9c01b7d4');
  assert.deepEqual(p.items, [{ index: 0, subject: 'o/r', repo: 'o/r', run_key: key(0), fence: 10 }, { index: 1, subject: 'Some-Org/repo.name_x', repo: 'Some-Org/repo.name_x', run_key: key(1), fence: 11 }]);
});

test('parseInputs: a subject that is not a GitHub owner/name is taken, with repo null, so its item still reports (a skip)', () => {
  for (const subject of ['o', 'o/r/x', 'o/..', '-o/r', 'https://github.com/o/r', 'pypi:some-pkg']) {
    const p = parseInputs({ shardId: 's', attemptId: 'a', items: itemsOf([subject]) });
    assert.deepEqual(p.items[0], { index: 0, subject, repo: null, run_key: key(0), fence: 10 }, subject);
  }
});

test('parseInputs: malformed dispatches are refused whole, with a code, and the message never repeats the input', () => {
  const ok = { shardId: 's1', attemptId: 'a1', items: itemsOf(['o/r']) };
  const item = (x) => JSON.stringify([{ subject: 'o/r', run_key: key(0), fence: 1, ...x }]);
  const cases = [
    [{ shardId: '' }, 'bad_shard_id'], [{ shardId: 's 1' }, 'bad_shard_id'], [{ shardId: undefined }, 'bad_shard_id'],
    [{ attemptId: 'a1\nhas_0=true' }, 'bad_attempt_id'], [{ attemptId: '-a' }, 'bad_attempt_id'], [{ attemptId: 'a'.repeat(129) }, 'bad_attempt_id'],
    [{ items: '' }, 'bad_items'], [{ items: 'not json' }, 'bad_items'], [{ items: '{}' }, 'bad_items'], [{ items: '[]' }, 'bad_items'],
    [{ items: itemsOf(Array.from({ length: MAX_ITEMS + 1 }, (_, i) => 'o/r' + i)) }, 'bad_items'],
    [{ items: JSON.stringify([{ subject: 'o/r', run_key: key(0), fence: 1, pad: 'x'.repeat(MAX_ITEMS_CHARS) }]) }, 'bad_items'],
    [{ items: '[null]' }, 'bad_item'], [{ items: '[["o/r"]]' }, 'bad_item'], [{ items: item({ extra: 1 }) }, 'bad_item'],
    [{ items: item({ subject: '' }) }, 'bad_subject'], [{ items: item({ subject: 7 }) }, 'bad_subject'], [{ items: item({ subject: 'o/r x' }) }, 'bad_subject'],
    [{ items: item({ subject: 'x'.repeat(513) }) }, 'bad_subject'], [{ items: item({ subject: 'o/r\n' }) }, 'bad_subject'], [{ items: item({ subject: 'o/r\u2028' }) }, 'bad_subject'],
    [{ items: item({ run_key: key(0).toUpperCase() }) }, 'bad_run_key'], [{ items: item({ run_key: 'abc' }) }, 'bad_run_key'],
    [{ items: item({ fence: 0 }) }, 'bad_fence'], [{ items: item({ fence: 1.5 }) }, 'bad_fence'], [{ items: item({ fence: '3' }) }, 'bad_fence'], [{ items: item({ fence: 2 ** 53 }) }, 'bad_fence'],
    [{ items: JSON.stringify([{ subject: 'o/a', run_key: key(0), fence: 1 }, { subject: 'o/b', run_key: key(0), fence: 2 }]) }, 'duplicate_run_key'],
  ];
  for (const [patch, code] of cases) {
    const input = { ...ok, ...patch };
    assert.throws(() => parseInputs(input), (e) => {
      assert.ok(e instanceof InputProblem, code);
      assert.equal(e.code, code, JSON.stringify(patch).slice(0, 80));
      for (const v of Object.values(patch)) if (typeof v === 'string' && v.length > 3) assert.ok(!e.message.includes(v), 'the message repeats the input');
      return true;
    });
  }
});

test('scanSubject: a repository is read at its default branch head and graded; the token goes to api.github.com only', async () => {
  const calls = [];
  const s = await scanSubject('o/r', { fetch: fakeGithub({ 'o/r': { files: jsLiteral } }, calls), token: TOKEN });
  assert.equal(s.status, 'graded', s.detail);
  assert.equal(s.detail, null);
  assert.deepEqual(s.commit, { sha: SHA, date: DATE });
  assert.deepEqual(s.repository, { moved: false, archived: false, fork: false });
  assert.equal(s.grade.tool_count, 1);
  assert.match(s.grade.catalog_hash, /^[0-9a-f]{64}$/);
  assert.equal(s.grade.sections.spec.grade, 'A');
  assert.equal(s.list.fidelity, 'literal');
  assert.equal(s.list.tools_listed, 1);
  assert.equal(s.listing.via, 'github');
  assert.deepEqual(s.raw.tools.map((t) => t.name), ['get_forecast']);
  assert.ok(s.grade.findings.every((f) => f.tool_index === null || f.tool_index === 0));
  assert.ok(!JSON.stringify({ ...s, raw: null }).includes('get_forecast'), 'tool names only under raw');
  // The branch head, then the tree at that commit, then raw files at that commit; no fallback host.
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r');
  assert.equal(calls[1].url, 'https://api.github.com/repos/o/r/branches/main');
  assert.equal(calls[2].url, 'https://api.github.com/repos/o/r/git/trees/' + SHA + '?recursive=1');
  assert.ok(calls.slice(3).every((c) => c.url.startsWith('https://raw.githubusercontent.com/o/r/' + SHA + '/')));
  for (const c of calls) assert.equal(c.auth, new URL(c.url).hostname === 'api.github.com' ? 'Bearer ' + TOKEN : null, c.url);
  // Without a token nothing carries one.
  const anon = [];
  assert.equal((await scanSubject('o/r', { fetch: fakeGithub({ 'o/r': { files: jsLiteral } }, anon) })).status, 'graded');
  assert.ok(anon.every((c) => c.auth === null));
});

test('scanSubject: a moved repository is read under its new name; the new name stays in raw', async () => {
  const fetch = fakeGithub({ 'o/r': { repo: { full_name: 'n/r2' } }, 'n/r2': { files: jsLiteral } });
  const s = await scanSubject('o/r', { fetch });
  assert.equal(s.status, 'graded');
  assert.equal(s.repository.moved, true);
  assert.equal(s.raw.repo.full_name, 'n/r2');
});

test('scanSubject: every failure is a skip; one that may pass when asked again is marked retryable', async () => {
  const cases = [
    ['gone (404)', {}, 'skipped', 'repo_unavailable', 404],
    ['private', { repo: { private: true } }, 'skipped', 'repo_unavailable', null],
    ['blocked (451)', { repo: 451 }, 'skipped', 'repo_unavailable', 451],
    ['no default branch', { repo: { default_branch: null } }, 'skipped', 'repo_empty', null],
    ['empty (branch 404)', { branch: 404, files: jsLiteral }, 'skipped', 'repo_empty', 404],
    ['empty (409)', { branch: 409 }, 'skipped', 'repo_empty', 409],
    ['no tools', { files: { 'README.md': '# hello\n', 'index.js': 'console.log(1)\n' } }, 'skipped', 'no_tools', null],
    ['rate limit (403)', { repo: 403, repoHeaders: { 'x-ratelimit-remaining': '0' } }, 'retry', 'rate_limited', 403],
    ['rate limit (429)', { repo: 429 }, 'retry', 'rate_limited', 429],
    ['secondary rate limit', { repo: 403, repoBody: '{"message":"You have exceeded a secondary rate limit"}' }, 'retry', 'rate_limited', 403],
    ['server error', { repo: 502 }, 'retry', 'upstream_error', 502],
    ['branch server error', { branch: 500 }, 'retry', 'upstream_error', 500],
    ['network', { network: true }, 'retry', 'upstream_error', null],
    ['tree rate limited', { tree: 403, treeHeaders: { 'x-ratelimit-remaining': '0' }, files: jsLiteral }, 'retry', 'rate_limited', 403],
    ['tree server error', { tree: 500, files: jsLiteral }, 'retry', 'upstream_error', 500],
    ['file read refused', { file: 429, files: jsLiteral }, 'retry', 'rate_limited', 429],
    ['file read failed', { file: 500, files: jsLiteral }, 'retry', 'read_failed', 500],
  ];
  for (const [name, spec, status, detail, http] of cases) {
    const subjects = name.startsWith('gone') ? {} : { 'o/r': spec };
    const s = await scanSubject('o/r', { fetch: fakeGithub(subjects) });
    assert.equal(s.status, 'skipped', name);
    assert.equal(s.retryable, status === 'retry', name);
    assert.equal(s.detail, detail, name);
    assert.equal(s.http_status, http, name);
    assert.equal(s.grade, null, name);
    assert.equal(s.list, null, name);
    assert.ok((status === 'skipped' ? PERMANENT : TRANSIENT).includes(detail), name);
    assert.equal(s.skip_reason, status === 'skipped' ? SKIP_REASON : detail === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable', name);
  }
});

test('scanSubject: a subject that takes too long is abandoned (timeout, a retryable skip) and its requests aborted', async () => {
  const t0 = Date.now();
  const s = await scanSubject('o/r', { fetch: fakeGithub({ 'o/r': { hang: true } }), timeoutMs: 50 });
  assert.equal(s.status, 'skipped');
  assert.equal(s.retryable, true);
  assert.equal(s.detail, 'timeout');
  assert.ok(Date.now() - t0 < 5000);
});

test('scanSubject: a list read from source that the grader refuses, or names only, is skipped', async () => {
  const names = { 'package.json': JSON.stringify({ name: 'x', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }), 'index.js': "const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');\nconst s = new McpServer({ name: 'x', version: '1' });\nfor (const n of NAMES) s.tool(n, {}, async () => ({}));\n" };
  const s = await scanSubject('o/r', { fetch: fakeGithub({ 'o/r': { files: names } }) });
  assert.equal(s.status, 'skipped');
  assert.ok(PERMANENT.includes(s.detail), s.detail);
});

test('controls: the known answer matches the committed file, and corpus/fixtures/known-answer.json is current', async () => {
  const committed = JSON.parse(readFileSync(KNOWN_ANSWER_FILE, 'utf8'));
  assert.deepEqual(committed, await knownAnswerFile(), 'regenerate it: node corpus/scan-static.mjs known-answer > corpus/fixtures/known-answer.json');
  assert.equal(committed.answer.grades.security, 'F', 'the fixture hides an instruction');
  const k = await knownAnswerControl();
  assert.deepEqual(k.control, { kind: 'known_bad', expected: 'match', observed: 'match', output: 'controls/known-answer.json' });
  const dir = tmp('ka');
  const wrong = { ...committed, answer: { ...committed.answer, grades: { ...committed.answer.grades, security: 'A' } } };
  writeFileSync(join(dir, 'known-answer.json'), JSON.stringify(wrong));
  const bad = await knownAnswerControl({ expectedFile: join(dir, 'known-answer.json') });
  assert.equal(bad.control.observed, 'mismatch');
  assert.equal(JSON.parse(bad.files['controls/known-answer.json']).match, false);
});

test('controls: the forgery control is contained; its marker is fresh and comes back only in raw/', async () => {
  const a = await forgeryControl({ tmp: tmpdir() });
  const b = await forgeryControl({ tmp: tmpdir() });
  assert.notEqual(a.control.marker, b.control.marker);
  assert.match(a.control.marker, MARKER_RE);
  assert.deepEqual({ ...a.control, marker: null }, { kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json', marker: null });
  const raw = JSON.parse(a.files['raw/control-forgery/tools.json']);
  assert.deepEqual(raw.tools.map((t) => t.name), ['attempt_id', 'fence'], 'the forged names were read');
  assert.ok(a.files['raw/control-forgery/tools.json'].includes(a.control.marker));
  const out = a.files['controls/forgery.json'];
  assert.ok(!out.includes(a.control.marker));
  assert.ok(!/forged-attempt|0f0f0f0f|999999/.test(out));
  assert.equal(JSON.parse(out).status, 'graded');
  await assert.rejects(forgeryControl({ marker: 'short' }), /bad marker/);
});

test('runShard: one bundle per item, failed ones too; a rate limit stops reading and the rest report a retryable skip', async () => {
  const out = join(tmp('run'), 'out');
  const calls = [];
  const subjects = { 'o/good': { files: jsLiteral }, 'o/notools': { files: { 'README.md': 'x' } }, 'o/limited': { repo: 403, repoHeaders: { 'x-ratelimit-remaining': '0' } }, 'o/after': { files: jsLiteral } };
  const items = itemsOf(['o/good', 'o/gone', 'o/notools', 'weird:subject', 'o/limited', 'o/after']);
  const logs = [];
  const r = await runShard({ shardId: 's-1', attemptId: 'att-1', items, out, fetch: fakeGithub(subjects, calls), token: TOKEN, log: (s) => logs.push(s) });
  assert.deepEqual(r.items.map((x) => [x.index, x.status, x.detail]), [[0, 'graded', null], [1, 'skipped', 'repo_unavailable'], [2, 'skipped', 'no_tools'], [3, 'skipped', 'bad_subject'], [4, 'skipped', 'rate_limited'], [5, 'skipped', 'rate_limited']]);
  assert.deepEqual(r.outputs, [0, 1, 2, 3, 4, 5].flatMap((i) => ['has_' + i + '=true', 'fence_' + i + '=' + (10 + i), 'run_key_' + i + '=' + key(i)]));
  assert.deepEqual(readdirSync(out).sort(), ['0', '1', '2', '3', '4', '5']);
  assert.ok(!calls.some((c) => c.url.includes('/o/after')), 'nothing is read after a rate limit');
  assert.ok(!calls.some((c) => c.url.includes('weird')), 'a subject that is not owner/name is not read');
  assert.deepEqual(logs, ['item 0: graded', 'item 1: skipped (repo_unavailable)', 'item 2: skipped (no_tools)', 'item 3: skipped (bad_subject)', 'item 4: skipped (rate_limited, retryable)', 'item 5: skipped (rate_limited, retryable)'], 'the log names items by position only, with no grade');
  const markers = new Set();
  for (const i of ['0', '1', '2', '3', '4', '5']) {
    const files = readTree(join(out, i, 'bundle'));
    const meta = JSON.parse(readFileSync(join(out, i, 'meta.json'), 'utf8'));
    const { result, obs } = assertBundle(files, meta, { subjectText: ['get_forecast', 'Returns the forecast', 'City name', 'lib/server.js', 'weather'] });
    markers.add(meta.controls.find((c) => c.kind === 'forgery').marker);
    assert.equal(result.format, FORMAT);
    assert.equal(meta.subject.id, JSON.parse(items)[Number(i)].subject);
    assert.equal(result.subject, i === '3' ? null : meta.subject.id, 'only an owner/name subject is repeated in results/');
    assert.deepEqual(obs.map((o) => o.field), ['commit_sha', 'commit_date', 'registration_provenance']);
    for (const o of obs) {
      assert.equal(o.stage, 'static');
      if (o.value === null) assert.match(o.why, /\S/);
    }
    if (i === '0') {
      assert.equal(result.status, 'graded');
      assert.equal(result.tool_count, 1);
      assert.equal(meta.subject.sha, SHA);
      assert.deepEqual(meta.skips, []);
      assert.deepEqual(obs.map((o) => o.value === null ? null : typeof o.value), ['string', 'string', 'object']);
      assert.equal(obs[0].value, SHA);
      assert.equal(obs[1].value, DATE);
      assert.equal(obs[2].value.fidelity, 'literal');
      assert.deepEqual(JSON.parse(files.get('raw/subject/tools.json')).map((t) => t.name), ['get_forecast']);
      assert.ok(files.has('raw/subject/report.json'));
    } else {
      assert.equal(result.status, 'skipped');
      const retry = i === '4' || i === '5';
      assert.equal(result.retryable, retry);
      assert.deepEqual(meta.skips, [{ stage: 'static', reason: retry ? skipReasonFor(result.detail) : SKIP_REASON, evidence: RESULT_PATH, retryable: retry }]);
      assert.equal(result.tool_count, null);
      assert.equal(obs[2].value, null);
    }
    if (i === '3') assert.equal(meta.subject.repo, null);
    if (i !== '0' && i !== '2') {
      assert.equal(meta.subject.sha, null);
      assert.deepEqual(obs.map((o) => o.value), [null, null, null]);
    }
    if (i === '2') assert.equal(obs[0].value, SHA, 'the commit is known even with no tools');
  }
  assert.equal(markers.size, 6, 'a fresh forgery marker per bundle');
});

test('runShard: past the shard budget no subject is started (a retryable skip); malformed inputs read and write nothing; a failed control reports nothing', async () => {
  let t = 0;
  const calls = [];
  const out = join(tmp('budget'), 'out');
  const r = await runShard({ shardId: 's', attemptId: 'a', items: itemsOf(['o/a', 'o/b']), out, fetch: fakeGithub({ 'o/a': { files: jsLiteral }, 'o/b': { files: jsLiteral } }, calls), clock: () => (t += 1000), budgetMs: 1500 });
  assert.deepEqual(r.items.map((x) => [x.status, x.detail]), [['graded', null], ['skipped', 'shard_deadline']]);
  assert.ok(!calls.some((c) => c.url.includes('/o/b')));
  const late = JSON.parse(readFileSync(join(out, '1', 'meta.json'), 'utf8'));
  assert.deepEqual(late.skips, [{ stage: 'static', reason: 'upstream_unavailable', evidence: RESULT_PATH, retryable: true }]);
  assertBundle(readTree(join(out, '1', 'bundle')), late);

  const out2 = join(tmp('bad'), 'out');
  await assert.rejects(runShard({ shardId: 's', attemptId: 'a\n', items: itemsOf(['o/a']), out: out2, fetch: () => { throw new Error('no fetch'); } }), InputProblem);
  assert.ok(!existsSync(out2));

  const out3 = tmp('full');
  writeFileSync(join(out3, 'x'), '');
  await assert.rejects(runShard({ shardId: 's', attemptId: 'a', items: itemsOf(['o/a']), out: out3, fetch: fakeGithub({}) }), /not empty/);

  const dir = tmp('ka2');
  const committed = JSON.parse(readFileSync(KNOWN_ANSWER_FILE, 'utf8'));
  writeFileSync(join(dir, 'known-answer.json'), JSON.stringify({ ...committed, answer: { ...committed.answer, tool_count: 3 } }));
  const out4 = join(tmp('ctl'), 'out');
  const seen = [];
  await assert.rejects(runShard({ shardId: 's', attemptId: 'a', items: itemsOf(['o/a']), out: out4, fetch: fakeGithub({ 'o/a': { files: jsLiteral } }, seen), knownAnswerExpected: join(dir, 'known-answer.json') }), /known-answer control gave mismatch/);
  assert.equal(seen.length, 0, 'no subject is read when a control fails');
  assert.ok(!existsSync(out4));
});

test('buildBundle: no commit, no list: every observation is null with a reason; results/ holds no subject text', () => {
  const scan = { status: 'skipped', detail: 'repo_unavailable', http_status: 404, list_error: null, error_name: null, language_hint: null, repository: null, commit: null, listing: null, list: null, grade: null, raw: {} };
  const control = { control: { kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json', marker: 'scanstatic-' + 'a'.repeat(32) }, files: { 'controls/forgery.json': '{}\n', 'raw/control-forgery/tools.json': '{"m":"scanstatic-' + 'a'.repeat(32) + '"}\n' } };
  const b = buildBundle({ item: { subject: 'o/r', repo: 'o/r', run_key: key(0), fence: 1 }, scan, controls: [control], startedAt: DATE, finishedAt: DATE });
  assert.deepEqual(Object.keys(b.files).sort(), ['controls/forgery.json', 'logs/scan.log', 'observations/static.ndjson', 'raw/control-forgery/tools.json', 'results/scan-static.json']);
  assert.equal(observationsOf(scan).split('\n').filter(Boolean).length, 3);
  assert.equal(b.meta.settings_manifest_digest, settingsDigest());
  assertBundle(new Map(Object.entries(b.files)), b.meta);
});

test('main: exit codes, step outputs in GITHUB_OUTPUT, and no input echoed in an error', async () => {
  const sink = () => { const s = { text: '', write: (x) => { s.text += x; } }; return s; };
  const o1 = sink();
  assert.equal(await main([], {}, { stdout: o1 }), 2);
  assert.match(o1.text, /^usage:/);

  const o2 = sink();
  assert.equal(await main(['run', join(tmp('m'), 'out')], { SHARD_ID: 's', ATTEMPT_ID: 'a', ITEMS: '[{"subject":"evil/x\\n::warning::hi"}]' }, { stdout: o2, fetch: fakeGithub({}) }), 1);
  assert.match(o2.text, /^::error title=scan-static::bad_/);
  assert.ok(!o2.text.includes('evil') && !o2.text.includes('::warning::'));

  const dir = tmp('m2');
  const ghOut = join(dir, 'github_output');
  writeFileSync(ghOut, '');
  const o3 = sink();
  const env = { SHARD_ID: 's', ATTEMPT_ID: 'a', ITEMS: itemsOf(['o/r', 'o/gone']), GITHUB_OUTPUT: ghOut, GITHUB_TOKEN: TOKEN };
  assert.equal(await main(['run', join(dir, 'out')], env, { stdout: o3, fetch: fakeGithub({ 'o/r': { files: jsLiteral } }) }), 0);
  assert.equal(readFileSync(ghOut, 'utf8'), ['has_0=true', 'fence_0=10', 'run_key_0=' + key(0), 'has_1=true', 'fence_1=11', 'run_key_1=' + key(1)].join('\n') + '\n');
  assert.match(o3.text, /1 of 2 items graded; every item has a bundle/);
  assert.ok(!o3.text.includes(TOKEN));

  const o4 = sink();
  mkdirSync(join(dir, 'full'));
  writeFileSync(join(dir, 'full', 'x'), '');
  assert.equal(await main(['run', join(dir, 'full')], { ...env, GITHUB_OUTPUT: '' }, { stdout: o4, fetch: fakeGithub({}) }), 3);
  assert.match(o4.text, /::error title=scan-static::harness error/);

  const o5 = sink();
  assert.equal(await main(['known-answer'], {}, { stdout: o5 }), 0);
  assert.deepEqual(JSON.parse(o5.text), JSON.parse(readFileSync(KNOWN_ANSWER_FILE, 'utf8')));
});

test('scan-static.mjs runs as a script (usage error without arguments)', () => {
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'scan-static.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^usage:/);
});

// ------------------------------------------------------------------ kill switch

test('loop-guard: the loop runs only when LOOP_ENABLED is exactly "true", not paused, and the lane is not off', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  const g = (env) => guard.evaluateGuard(env, { lane: 'scan-static', now });
  assert.deepEqual(g({}), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'TRUE' }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(g({ LOOP_ENABLED: '1' }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true' }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-05-02T00:00:00Z' }), { proceed: false, reason: 'paused' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-05-02' }), { proceed: false, reason: 'paused' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-04-30T00:00:00+02:00' }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: 'tomorrow' }), { proceed: false, reason: 'pause_unreadable' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-02-30' }), { proceed: false, reason: 'pause_unreadable' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: ' ' }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: 'false' }), { proceed: false, reason: 'lane_disabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: 'true' }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(g({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: '' }), { proceed: true, reason: 'enabled' });
  assert.equal(guard.laneVariable('scan-static'), 'LANE_SCAN_STATIC_ENABLED');
});

test('loop-guard: a stopped lane exits 0; a running lane needs a pinned worker-kit commit', () => {
  const run = (env, argv = ['--lane', 'scan-static']) => {
    const s = { text: '', write: (x) => { s.text += x; } };
    const dir = tmp('guard');
    const outFile = join(dir, 'out');
    writeFileSync(outFile, '');
    const code = guard.main(argv, { ...env, GITHUB_OUTPUT: outFile }, { out: s, now: Date.parse('2026-05-01T12:00:00Z') });
    return { code, text: s.text, output: readFileSync(outFile, 'utf8') };
  };
  const pinned = 'ab'.repeat(20);
  let r = run({});
  assert.equal(r.code, 0);
  assert.equal(r.output, 'proceed=false\nreason=loop_disabled\n');
  assert.match(r.text, /^::notice /);
  r = run({ LOOP_ENABLED: 'true', WORKER_KIT_REF: guard.PLACEHOLDER_REF });
  assert.equal(r.code, 1);
  assert.match(r.text, /::error title=scan-static::WORKER_KIT_REF is still the all-zero placeholder/);
  r = run({ LOOP_ENABLED: 'true', WORKER_KIT_REF: 'main' });
  assert.equal(r.code, 1);
  r = run({ LOOP_ENABLED: 'true', WORKER_KIT_REF: pinned });
  assert.equal(r.code, 0);
  assert.equal(r.output, 'proceed=true\nreason=enabled\n');
  r = run({ LOOP_ENABLED: 'false', WORKER_KIT_REF: guard.PLACEHOLDER_REF });
  assert.equal(r.code, 0, 'a stopped lane does not need the pin');
  assert.equal(run({}, ['--lane']).code, 2);
  assert.equal(run({}, ['--lane', 'Bad Lane']).code, 2);
  assert.equal(guard.kitRefProblem(pinned), null);
  const sh = spawnSync(process.execPath, [join(root, 'corpus', 'loop-guard.mjs'), '--lane', 'scan-static'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(sh.status, 0);
  assert.match(sh.stdout, /^proceed=false\nreason=loop_disabled\n/);
});

test('a rate-limited and an upstream-failed shard report retryable skips that tool-qa\'s own contract and ingest checks accept', async () => {
  const out = join(tmp('retry'), 'out');
  const r = await runShard({
    shardId: 's', attemptId: 'att-1', items: itemsOf(['o/up', 'o/rl', 'o/next']), out,
    fetch: fakeGithub({ 'o/up': { repo: 502 }, 'o/rl': { repo: 429 }, 'o/next': { files: jsLiteral } }),
  });
  assert.deepEqual(r.items.map((x) => [x.status, x.detail]), [['skipped', 'upstream_error'], ['skipped', 'rate_limited'], ['skipped', 'rate_limited']]);
  const expected = ['upstream_unavailable', 'rate_limited', 'rate_limited'];
  for (const i of [0, 1, 2]) {
    const meta = JSON.parse(readFileSync(join(out, String(i), 'meta.json'), 'utf8'));
    assert.deepEqual(meta.skips, [{ stage: 'static', reason: expected[i], evidence: RESULT_PATH, retryable: true }]);
    assert.ok(!JSON.stringify(meta).includes('trace_unavailable'));
    const manifest = assertToolQa(readTree(join(out, String(i), 'bundle')), meta, { identity: { attempt_id: 'att-1', fence: 10 + i, run_key: key(i) } });
    // Every skip retryable: tool-qa records the item as retry_later and sends it out again.
    assert.ok(manifest.skips.length > 0 && manifest.skips.every((s) => s.retryable === true));
  }
});

test('a lasting failure keeps its non-retryable skip code', async () => {
  const out = join(tmp('gone'), 'out');
  await runShard({ shardId: 's', attemptId: 'att-1', items: itemsOf(['o/gone']), out, fetch: fakeGithub({}) });
  const meta = JSON.parse(readFileSync(join(out, '0', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.skips, [{ stage: 'static', reason: 'no_runnable_artifact', evidence: RESULT_PATH, retryable: false }]);
  const manifest = assertToolQa(readTree(join(out, '0', 'bundle')), meta);
  assert.equal(manifest.skips[0].retryable, false);
  for (const d of TRANSIENT) assert.ok(['rate_limited', 'upstream_unavailable'].includes(skipReasonFor(d)), d);
  for (const d of PERMANENT) assert.equal(skipReasonFor(d), 'no_runnable_artifact', d);
});
