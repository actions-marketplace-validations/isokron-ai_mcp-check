// The pull-request comment of the GitHub Action (input pr-comment). Two halves, in two steps of action.yml:
//   - main.mjs decides whether to comment and renders the body (renderComment) into the results folder; it never
//     sees the token, so the server that `command` starts cannot read it;
//   - this file, run as its own step with the token, creates or updates the one comment that carries MARKER.
// A failure here is a warning, never a failed job. Only node: built-ins and files of this repository.
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import M from '../src/engine.js';
import { tagged } from '../src/links.js';
import { ALL_SECTIONS, belowMinGrade, mdCode, mdText } from '../src/report.js';

/** The hidden line that marks the comment this Action owns on a pull request. */
export const MARKER = '<!-- isokron-mcp-check -->';
/**
 * The marker line of one comment. Without pr-comment-key it is MARKER, one comment per pull request. With a key
 * (one per matrix leg or per job that comments), the key and the job id are in it, so each keeps its own comment.
 */
export function markerFor(key = '', job = '') {
  const k = String(key || '').trim();
  if (!k) return MARKER;
  return '<!-- isokron-mcp-check key=' + k + ' job=' + String(job || '').replace(/[^A-Za-z0-9_-]/g, '').replace(/-{2,}/g, '-').slice(0, 100) + ' -->';
}
export const validKey = (k) => /^[A-Za-z0-9._-]{0,64}$/.test(String(k || '').trim()) && !/--/.test(String(k || '')); // no "--" inside an HTML comment
/** The second line of a body written by the run step: which run and attempt it belongs to. Removed before posting. */
export const runStamp = (env) => '<!-- mcp-check-run: ' + String(env.GITHUB_RUN_ID || 'local').replace(/[^0-9A-Za-z-]/g, '') + '-' + String(env.GITHUB_RUN_ATTEMPT || '1').replace(/[^0-9]/g, '') + ' -->';
const firstLine = (b) => String(b).split('\n', 1)[0];
export const MODES = ['off', 'auto', 'always'];
/** Findings shown in the comment; the job summary and the report artifact have the rest. */
export const MAX_COMMENT_FINDINGS = 5;
const MAX_BODY = 60000; // GitHub refuses comments over 65,536 characters
/** Text from the tool list, inert: mdText, and no @mention (a zero-width space after every @), so it notifies no one. */
export const commentText = (s) => mdText(s).replace(/@/g, '@&#8203;');

/**
 * Where a comment could go, from the event payload: { number } for a pull request from a branch of the same
 * repository, { skip } with the reason otherwise (a fork, whose token cannot write), or null when the event is not
 * a pull request at all.
 */
export function prContext(eventName, event) {
  if (eventName !== 'pull_request') return null;
  const pr = event && event.pull_request;
  if (!pr || !Number.isInteger(pr.number)) return { skip: 'the event carries no pull request number' };
  const head = pr.head && pr.head.repo && pr.head.repo.full_name;
  const base = pr.base && pr.base.repo && pr.base.repo.full_name;
  if (!head || !base || head.toLowerCase() !== base.toLowerCase()) return { skip: 'the pull request comes from a fork, and its token cannot write comments', fork: true };
  return { number: pr.number };
}

/**
 * What to do with the comment: 'upsert' (create or update), 'update' (only refresh a comment that is already
 * there, so an earlier warning does not stay up after the problem is fixed) or null (nothing).
 *   auto: comment when a gated section is below min-grade or the baseline comparison found a high-risk change.
 */
export function commentAction(mode, problem) {
  if (mode === 'always') return 'upsert';
  if (mode === 'auto') return problem ? 'upsert' : 'update';
  return null;
}

/**
 * The comment body: the marker, a heading with the result (marked approximate for a list read from source), the grade
 * table, the gate, up to five findings with their check pages, and the registry line. Text from the tool list is escaped as in the job summary.
 */
export function renderComment(r, { sections, minGrade = null, diff = null, sourceNote = '', approximate = false, runUrl = null, hint = null, marker = MARKER, stamp = null } = {}) {
  const below = belowMinGrade(r, sections, minGrade);
  const highRisk = diff ? diff.highRisk : [];
  const failed = below.length > 0 || highRisk.length > 0;
  const out = [marker];
  if (stamp) out.push(stamp);
  out.push('### MCP check' + (approximate ? ' (approximate)' : '') + (failed ? ': needs attention' : minGrade ? ': passes min-grade ' + minGrade : ''), '');
  out.push('| ' + ALL_SECTIONS.map((k) => r.sections[k].name).join(' | ') + ' |');
  out.push('|' + ALL_SECTIONS.map(() => '---').join('|') + '|');
  out.push('| ' + ALL_SECTIONS.map((k) => {
    const g = r.sections[k].grade || 'n/a';
    return sections.includes(k) && minGrade && below.some((x) => x.startsWith(k + ' ')) ? '**' + g + '**' : g;
  }).join(' | ') + ' |', '');
  if (minGrade) out.push(below.length ? '**Below min-grade ' + minGrade + ':** ' + below.join(', ') + '.' : 'Every gated section (' + sections.join(', ') + ') meets min-grade ' + minGrade + '.');
  else out.push('No min-grade gate is set.');
  if (highRisk.length) out.push('', '**High-risk annotation change** against the baseline (a client may now run these with less confirmation): ' + highRisk.map((t) => mdCode(String(t).slice(0, 128))).join(', ') + '.');
  const order = { blocking: 0, attention: 1 };
  const fs = M.allFindings(r).filter((f) => f.severity !== 'advice' && f.section !== 'surface' && f.affects.some((a) => sections.includes(a)));
  fs.sort((a, b) => order[a.severity] - order[b.severity]);
  if (fs.length) {
    out.push('', 'Top findings:', '');
    for (const f of fs.slice(0, MAX_COMMENT_FINDINGS)) {
      const msg = String(f.message);
      out.push('- ' + f.severity + ' ' + (f.tool ? mdCode(String(f.tool).slice(0, 128)) : '(list)') + ': [' + f.id + '](' + tagged(M.CHECK[f.id].docs, 'comment') + ') ' + commentText(msg.length > 300 ? msg.slice(0, 297) + '...' : msg));
    }
    if (fs.length > MAX_COMMENT_FINDINGS) out.push('', (fs.length - MAX_COMMENT_FINDINGS) + ' more in the job summary' + (runUrl ? ' of [this run](' + runUrl + ')' : '') + '.');
  } else out.push('', 'No blocking or attention findings in the gated sections.');
  const tail = [];
  if (sourceNote) tail.push(sourceNote);
  if (runUrl && !(fs.length > MAX_COMMENT_FINDINGS)) tail.push('[Workflow run](' + runUrl + ')');
  if (tail.length) out.push('', tail.join(' · '));
  if (hint) out.push('', hint);
  out.push('', '<sub>Updated on every run by isokron-ai/mcp-check, rubric ' + r.rubric_version + '. Set pr-comment: off to stop.</sub>');
  let body = out.join('\n') + '\n';
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '\n\n(cut to fit a comment)\n';
  return body;
}

/**
 * The comment body for a run that graded nothing (the source gave no list): it replaces an earlier verdict, so a stale
 * grade does not stay up on the pull request. `reason` is plain text, escaped here.
 */
export function renderNotGraded(reason, { runUrl = null, marker = MARKER, stamp = null } = {}) {
  const out = [marker];
  if (stamp) out.push(stamp);
  out.push('### MCP check: not graded on this run', '', commentText(String(reason).slice(0, 1500)), '',
    'Earlier grades on this pull request no longer apply. For exact grades, set `command` (the command that starts the server) or `tools-file` (a saved `tools/list` answer).');
  if (runUrl) out.push('', '[Workflow run](' + runUrl + ')');
  out.push('', '<sub>Updated on every run by isokron-ai/mcp-check. Set pr-comment: off to stop.</sub>');
  return out.join('\n') + '\n';
}

/** The GitHub REST call, with the error text kept short and the token never in a message. */
async function gh(fetchImpl, url, token, method = 'GET', body = undefined) {
  const res = await fetchImpl(url, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'isokron-mcp-check-action', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + ' from ' + method + ' ' + url.replace(/\?.*$/, ''));
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Who the token writes as: { login } when GET /user answers (a personal token), else { bot: true } (the default
 * GITHUB_TOKEN and GitHub App tokens cannot read /user; their comments are authored by a bot account).
 */
export async function tokenIdentity(fetchImpl, apiUrl, token) {
  try {
    const u = await gh(fetchImpl, apiUrl.replace(/\/+$/, '') + '/user', token);
    if (u && typeof u.login === 'string' && u.login) return { login: u.login };
  } catch { /* 401/403 for installation tokens */ }
  return { bot: true };
}
/** A comment this Action wrote with this token: its first line is `marker` and its author is the token's identity. */
export function isOwnComment(c, id, marker = MARKER) {
  if (!c || typeof c.body !== 'string' || firstLine(c.body) !== marker || !c.user) return false;
  if (id.login) return c.user.login === id.login;
  return c.user.type === 'Bot';
}

/**
 * Creates or updates this Action's comment. Among the pull request's comments (up to 1,000) it takes one that starts
 * with MARKER and was written by the token's own identity (tokenIdentity; for a bot token, github-actions[bot] first).
 * A marker comment by anyone else is never edited: a new comment is made instead. action 'update' changes an existing
 * comment and creates none. Returns { done: 'created' | 'updated' | 'unchanged' | 'none', id }.
 */
export async function upsertComment({ apiUrl = 'https://api.github.com', repo, number, token, body, action = 'upsert', marker = MARKER, fetch: fetchImpl = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('GITHUB_REPOSITORY is not owner/repo');
  if (!Number.isInteger(number)) throw new Error('no pull request number');
  if (!token) throw new Error('github-token is empty');
  const base = apiUrl.replace(/\/+$/, '') + '/repos/' + repo + '/issues/' + number + '/comments';
  const mine = [];
  for (let page = 1; page <= 10; page++) {
    const list = await gh(fetchImpl, base + '?per_page=100&page=' + page, token);
    if (!Array.isArray(list)) break;
    for (const c of list) if (c && typeof c.body === 'string' && firstLine(c.body) === marker) mine.push(c);
    if (list.length < 100) break;
  }
  // Only when some comment carries the marker is the token's identity needed (one more request).
  const id = mine.length ? await tokenIdentity(fetchImpl, apiUrl, token) : null;
  const own = id ? mine.filter((c) => isOwnComment(c, id, marker)) : [];
  const existing = own.find((c) => c.user.login === 'github-actions[bot]') || own[0];
  const commentsUrl = apiUrl.replace(/\/+$/, '') + '/repos/' + repo + '/issues/comments/';
  if (existing) {
    if (existing.body === body) return { done: 'unchanged', id: existing.id };
    await gh(fetchImpl, commentsUrl + existing.id, token, 'PATCH', { body });
    return { done: 'updated', id: existing.id };
  }
  if (action === 'update') return { done: 'none', id: null };
  const made = await gh(fetchImpl, base, token, 'POST', { body });
  return { done: 'created', id: made && made.id };
}

/** Plain words for a failed call: what usually causes it. */
export function explainFailure(e) {
  const s = e && e.status;
  if (s === 403 || s === 401) return 'the token may not write to pull requests: add permissions: pull-requests: write to the job (' + e.message + ')';
  if (s === 404) return 'the pull request or repository was not found with this token (' + e.message + ')';
  return String(e && e.message || e).slice(0, 300);
}

/**
 * The comment step's own reading of the run, from what GitHub provides and not from the run step's outputs (code that
 * runs on the runner, such as the server `command` starts, could write those): the pull request from the event payload,
 * the body from <results-dir>/pr-comment.md inside the workspace. Returns { skip } or { number, file, action }.
 */
export function stepPlan(env) {
  const mode = String(env.INPUT_PR_COMMENT || 'off').trim().toLowerCase();
  if (mode !== 'auto' && mode !== 'always') return { skip: 'pr-comment is off' };
  let event = {};
  try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH || '', 'utf8')); } catch { event = {}; }
  const pr = prContext(env.GITHUB_EVENT_NAME || '', event);
  if (!pr) return { skip: 'not a pull_request event' };
  if (pr.skip) return { skip: pr.skip };
  const ws = realpathSync(env.GITHUB_WORKSPACE || process.cwd());
  const dir = resolve(ws, String(env.INPUT_RESULTS_DIR || 'mcp-check-results').trim() || 'mcp-check-results');
  const rel = relative(ws, dir);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { skip: 'results-dir is not inside the workspace' };
  const dst = lstatOrNull(dir);
  if (!dst || !dst.isDirectory()) return { skip: 'no results folder (the grading step did not finish)' };
  if (realpathSync(dir) !== dir && !realpathSync(dir).startsWith(ws + sep)) return { skip: 'results-dir resolves outside the workspace' };
  const file = join(dir, 'pr-comment.md');
  const st = lstatOrNull(file);
  if (!st) return { skip: 'no comment for this run' };
  if (!st.isFile() || st.size > 256 * 1024) throw new Error('the comment file is not a regular file of at most 256 KiB');
  if (!validKey(env.INPUT_PR_COMMENT_KEY)) return { skip: 'pr-comment-key is not valid' };
  const marker = markerFor(env.INPUT_PR_COMMENT_KEY, env.GITHUB_JOB);
  const lines = readFileSync(file, 'utf8').split('\n');
  // Written by the run step of this run and attempt, for this marker: anything else (a body left by an earlier run,
  // or one another job wrote) is not posted.
  if (lines[0] !== marker) throw new Error('the comment file was not written by this action for this job');
  if (lines[1] !== runStamp(env)) throw new Error('the comment file was written by another run (expected ' + runStamp(env).replace(/<!-- | -->/g, '') + ')');
  const body = [lines[0]].concat(lines.slice(2)).join('\n');
  return { number: pr.number, file, body, marker, action: mode === 'always' || env.COMMENT_ACTION === 'upsert' ? 'upsert' : 'update' };
}
const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

// The step of action.yml, run with a clean environment (env -i) holding only what it needs.
async function step(env) {
  const warn = (msg) => {
    process.stdout.write('::warning::mcp-check: PR comment not posted: ' + msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') + '\n');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, '\nPR comment not posted: ' + mdText(msg) + '\n');
  };
  try {
    const plan = stepPlan(env);
    if (plan.skip) { process.stdout.write('mcp-check: no PR comment: ' + plan.skip + '\n'); return; }
    const got = await upsertComment({ apiUrl: env.GITHUB_API_URL || 'https://api.github.com', repo: env.GITHUB_REPOSITORY, number: plan.number, token: env.GITHUB_TOKEN, body: plan.body, marker: plan.marker, action: plan.action });
    process.stdout.write('mcp-check: PR comment ' + got.done + (got.id ? ' (' + got.id + ')' : '') + '\n');
  } catch (e) {
    warn(explainFailure(e));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  step(process.env).finally(() => { process.exitCode = 0; });
}
