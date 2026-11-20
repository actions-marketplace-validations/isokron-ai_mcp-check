// The pull-request comment of the GitHub Action (input pr-comment). Two halves, in two steps of action.yml:
//   - main.mjs decides whether to comment and renders the body (renderComment) into the results folder; it never
//     sees the token, so the server that `command` starts cannot read it;
//   - this file, run as its own step with the token, creates or updates the one comment that carries MARKER.
// A failure here is a warning, never a failed job. Only node: built-ins and files of this repository.
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import M from '../src/engine.js';
import { tagged } from '../src/links.js';
import { ALL_SECTIONS, belowMinGrade, mdCode, mdText } from '../src/report.js';

/** The hidden line that marks the comment this Action owns on a pull request. */
export const MARKER = '<!-- isokron-mcp-check -->';
export const MODES = ['off', 'auto', 'always'];
/** Findings shown in the comment; the job summary and the report artifact have the rest. */
export const MAX_COMMENT_FINDINGS = 5;
const MAX_BODY = 60000; // GitHub refuses comments over 65,536 characters

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
 * The comment body: the marker, a heading with the result, the grade table, the gate, up to five findings with
 * their check pages, and the registry line. Text from the tool list is escaped as in the job summary.
 */
export function renderComment(r, { sections, minGrade = null, diff = null, sourceNote = '', runUrl = null, hint = null } = {}) {
  const below = belowMinGrade(r, sections, minGrade);
  const highRisk = diff ? diff.highRisk : [];
  const failed = below.length > 0 || highRisk.length > 0;
  const out = [MARKER];
  out.push('### MCP check' + (failed ? ': needs attention' : minGrade ? ': passes min-grade ' + minGrade : ''), '');
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
      out.push('- ' + f.severity + ' ' + (f.tool ? mdCode(String(f.tool).slice(0, 128)) : '(list)') + ': [' + f.id + '](' + tagged(M.CHECK[f.id].docs, 'comment') + ') ' + mdText(msg.length > 300 ? msg.slice(0, 297) + '...' : msg));
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
 * Creates or updates the comment that starts with MARKER. Finds it among the pull request's comments (up to 1,000),
 * preferring one by github-actions[bot]. action 'update' changes an existing comment and creates none.
 * Returns { done: 'created' | 'updated' | 'none', id }.
 */
export async function upsertComment({ apiUrl = 'https://api.github.com', repo, number, token, body, action = 'upsert', fetch: fetchImpl = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('GITHUB_REPOSITORY is not owner/repo');
  if (!Number.isInteger(number)) throw new Error('no pull request number');
  if (!token) throw new Error('github-token is empty');
  const base = apiUrl.replace(/\/+$/, '') + '/repos/' + repo + '/issues/' + number + '/comments';
  const mine = [];
  for (let page = 1; page <= 10; page++) {
    const list = await gh(fetchImpl, base + '?per_page=100&page=' + page, token);
    if (!Array.isArray(list)) break;
    for (const c of list) if (c && typeof c.body === 'string' && c.body.startsWith(MARKER)) mine.push(c);
    if (list.length < 100) break;
  }
  const existing = mine.find((c) => c.user && c.user.login === 'github-actions[bot]') || mine[0];
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

// The step of action.yml. Inputs: COMMENT_FILE (written by main.mjs), PR_NUMBER, COMMENT_ACTION, GITHUB_TOKEN.
async function step(env) {
  const warn = (msg) => {
    process.stdout.write('::warning::mcp-check: PR comment not posted: ' + msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') + '\n');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, '\nPR comment not posted: ' + mdText(msg) + '\n');
  };
  try {
    const file = env.COMMENT_FILE || '';
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 256 * 1024) throw new Error('the comment file is not a regular file');
    const body = readFileSync(file, 'utf8');
    const got = await upsertComment({ apiUrl: env.GITHUB_API_URL || 'https://api.github.com', repo: env.GITHUB_REPOSITORY, number: Number(env.PR_NUMBER), token: env.GITHUB_TOKEN, body, action: env.COMMENT_ACTION === 'update' ? 'update' : 'upsert' });
    process.stdout.write('mcp-check: PR comment ' + got.done + (got.id ? ' (' + got.id + ')' : '') + '\n');
  } catch (e) {
    warn(explainFailure(e));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  step(process.env).finally(() => { process.exitCode = 0; });
}
