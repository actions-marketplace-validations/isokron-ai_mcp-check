// The GitHub Action's run step (action.yml). Inputs arrive as INPUT_* environment variables, never by
// interpolation into a shell command. Uses only the engine and Node built-ins: no install step.
import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import M from '../src/engine.js';
import { VERSION } from '../src/version.js';
import { capture, CaptureError, splitCommand as split } from '../src/capture.js';
import { parseList } from '../src/tools.js';
import { InputError as LimitError } from '../src/limits.js';
import { tagDocsLinks } from '../src/links.js';
import { ALL_SECTIONS, DEFAULT_SECTIONS, GRADES, badgeFile, badgeSnippet, belowMinGrade, mdCode, sarifWithLocations, summaryMarkdown, webLink } from '../src/report.js';

const env = process.env;
const input = (name, def = '') => (env['INPUT_' + name.toUpperCase().replace(/-/g, '_')] ?? def).trim() || def;
const bool = (name, def) => {
  const v = input(name, def ? 'true' : 'false').toLowerCase();
  if (v !== 'true' && v !== 'false') throw new InputError(name + ' must be true or false');
  return v === 'true';
};
class InputError extends Error {}

function output(name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('output ' + name + ' holds a newline');
  appendFileSync(env.GITHUB_OUTPUT, name + '=' + v + '\n');
}
function summary(md) { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md); }
const annotate = (level, msg) => process.stdout.write('::' + level + '::' + msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') + '\n');

/** A path given by the workflow, resolved inside the workspace; anything outside it is refused. */
function inWorkspace(p, what, allowRoot = false) {
  const ws = realpathSync(env.GITHUB_WORKSPACE || process.cwd());
  const abs = resolve(ws, p);
  const rel = relative(ws, abs);
  if ((rel === '' && !allowRoot) || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new InputError(what + ' must be a path inside the workspace: ' + p);
  // Follow symlinks for what already exists, so a link cannot point the action outside the workspace.
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== ws && !real.startsWith(ws + sep)) throw new InputError(what + ' resolves outside the workspace: ' + p);
  return { abs, rel: rel.split(sep).join('/') || '.' };
}

/** Marker file that says a results folder was made by this action, so a later run may write into it. */
export const MARKER = '.mcp-check-results';
const lstatOrNull = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/**
 * Writes a file without ever following a symlink: an existing symlink or non-file at the path is
 * refused (a checked-out branch can plant one), an existing regular file is removed, and the new file
 * is created with O_EXCL|O_NOFOLLOW, so nothing is written through a link created in between.
 */
export function safeWrite(abs, data, what) {
  const st = lstatOrNull(abs);
  if (st && !st.isFile()) throw new InputError(what + ' exists and is not a regular file (' + (st.isSymbolicLink() ? 'a symlink' : 'a folder or device') + '); remove it from the repository');
  if (st) unlinkSync(abs);
  let fd;
  try {
    fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o644);
  } catch (e) {
    throw new InputError('cannot write ' + what + ': ' + e.code);
  }
  try { writeSync(fd, data); } finally { closeSync(fd); }
}

/** Reads a regular file (never a symlink, folder, FIFO or device), at most `cap` bytes. */
function safeRead(abs, what, cap = 4 * 1024 * 1024) {
  const st = lstatOrNull(abs);
  if (!st) throw new InputError(what + ' not found');
  if (!st.isFile()) throw new InputError(what + ' is not a regular file' + (st.isSymbolicLink() ? ' (a symlink)' : ''));
  if (st.size > cap) throw new InputError(what + ' is ' + (st.size / 1048576).toFixed(2) + ' MiB; the limit is ' + (cap / 1048576).toFixed(2) + ' MiB');
  return readFileSync(abs, 'utf8');
}

/**
 * Makes or reuses a folder this action writes into. A folder that is a symlink is refused; an existing
 * folder that holds anything is used only when this action made it (it holds MARKER).
 */
function ownFolder(dir, what) {
  const st = lstatOrNull(dir.abs);
  if (st && !st.isDirectory()) throw new InputError(what + ' exists and is not a folder' + (st.isSymbolicLink() ? ' (a symlink)' : ''));
  if (!st) mkdirSync(dir.abs, { recursive: true });
  const entries = readdirSync(dir.abs);
  if (entries.length && !entries.includes(MARKER)) throw new InputError(what + ' ' + dir.rel + ' already exists and was not made by this action; choose another results-dir');
  if (!entries.includes(MARKER)) safeWrite(join(dir.abs, MARKER), 'Made by the mcp-check GitHub Action.\n', what + ' marker');
}

const splitCommand = split;
export { splitCommand };

export async function run() {
  const toolsFile = input('tools-file');
  const command = input('command');
  if (!!toolsFile === !!command) throw new InputError('set exactly one of tools-file and command');
  const minGrade = input('min-grade').toUpperCase() || null;
  if (minGrade && !GRADES.includes(minGrade)) throw new InputError('min-grade must be one of A, B, C, D, F, or empty');
  const sections = input('sections', DEFAULT_SECTIONS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  sections.forEach((s) => { if (!ALL_SECTIONS.includes(s)) throw new InputError('unknown section ' + s + ' (use ' + ALL_SECTIONS.join(', ') + ')'); });
  const timeout = Number(input('timeout', '60'));
  if (!(timeout > 0 && timeout <= 600)) throw new InputError('timeout must be 1 to 600 seconds');
  const wantSarif = bool('sarif', true);
  const wantBadge = bool('badge', false);
  const useShell = bool('shell', false);
  const results = inWorkspace(input('results-dir', 'mcp-check-results'), 'results-dir');
  const badgeDir = inWorkspace(input('badge-dir', '.github/mcp-check'), 'badge-dir');
  const baseline = input('baseline') ? inWorkspace(input('baseline'), 'baseline') : null;
  ownFolder(results, 'results-dir');
  const out = (f, data) => safeWrite(join(results.abs, f), data, results.rel + '/' + f);
  // Size, depth and tool-count limits (2 MiB of JSON, 64 levels, 2,000 tools), with a clear error.
  const parse = (t, label) => {
    try { return parseList(t, label); } catch (e) {
      if (e instanceof LimitError) throw new InputError(e.message);
      throw e;
    }
  };

  // 1. The tool list: a file in the repository, or tools/list from the server the command starts.
  let text, listRel, source;
  if (toolsFile) {
    const f = inWorkspace(toolsFile, 'tools-file');
    text = safeRead(f.abs, 'tools-file ' + f.rel);
    listRel = f.rel;
    source = mdCode(f.rel);
  } else {
    const cwd = inWorkspace(input('working-directory', '.'), 'working-directory', true);
    if (!existsSync(cwd.abs)) throw new InputError('working-directory not found: ' + input('working-directory'));
    let argv;
    try { argv = useShell ? ['bash', '-c', command] : split(command); } catch (e) { throw new InputError('command: ' + e.message); }
    if (!argv.length) throw new InputError('command is empty');
    process.stdout.write('Starting the server to read tools/list (initialize and tools/list only; no tool is called).\n');
    let got;
    try {
      got = await capture(argv, { timeoutMs: timeout * 1000, cwd: cwd.abs, stderr: process.stderr, fence: true });
    } catch (e) {
      if (e instanceof CaptureError) throw new InputError('could not read tools/list from the server: ' + e.message);
      throw e;
    }
    text = JSON.stringify(got.result, null, 2) + '\n';
    out('tools-list.json', text);
    listRel = results.rel + '/tools-list.json';
    const si = got.initialize && got.initialize.serverInfo;
    source = 'the server started by `command`' + (si && typeof si.name === 'string' ? ' (' + mdCode(String(si.name).slice(0, 80) + (typeof si.version === 'string' ? ' ' + String(si.version).slice(0, 40) : '')) + ')' : '');
  }

  // 2. Grade it.
  const parsed = parse(text, 'the tool list');
  const r = M.analyse(parsed);
  const below = belowMinGrade(r, sections, minGrade);
  let diff = null;
  if (baseline) {
    const prev = parse(safeRead(baseline.abs, 'baseline ' + baseline.rel), 'baseline');
    diff = M.diffCatalogs(prev.tools, parsed.tools);
  }

  // 3. Reports in the results folder (uploaded as an artifact by the next steps).
  out('report.md', M.toMarkdown(r) + '\n');
  out('report.json', M.toJSON(Object.assign({}, r, { engine_version: VERSION }, diff ? { compare: diff } : {})) + '\n');
  let sarifRel = '';
  if (wantSarif) {
    const s = sarifWithLocations(r, text, listRel);
    s.runs[0].tool.driver.semanticVersion = VERSION;
    out('report.sarif', JSON.stringify(s, null, 2) + '\n');
    sarifRel = results.rel + '/report.sarif';
  }
  const link = await webLink(text);

  // 4. The badge: written into the repository only on the default branch, and only when it changed.
  const repo = env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  // A schedule event carries no repository object, but always runs on the default branch.
  const defaultBranch = env.MCP_CHECK_DEFAULT_BRANCH || (env.GITHUB_EVENT_NAME === 'schedule' ? env.GITHUB_REF_NAME || '' : '');
  const ref = env.GITHUB_REF || '';
  const onDefault = !!defaultBranch && ref === 'refs/heads/' + defaultBranch && ['push', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME || '');
  const runUrl = env.GITHUB_SERVER_URL && repo && env.GITHUB_RUN_ID ? env.GITHUB_SERVER_URL + '/' + repo + '/actions/runs/' + env.GITHUB_RUN_ID : null;
  let badgeChanged = false, badgeNote = null, snippet = null;
  if (wantBadge && !(owner && name && defaultBranch)) badgeNote = 'Badge not updated: the repository or its default branch is not known in this event.';
  if (wantBadge && owner && name && defaultBranch) {
    snippet = badgeSnippet({ owner, repo: name, branch: defaultBranch, dir: badgeDir.rel });
    const badgePath = join(badgeDir.abs, 'badge.json');
    let previous = null;
    const prevSt = lstatOrNull(badgePath);
    if (prevSt && !prevSt.isFile()) throw new InputError(badgeDir.rel + '/badge.json is not a regular file; remove it from the repository');
    try { previous = prevSt ? JSON.parse(safeRead(badgePath, 'badge.json', 64 * 1024)) : null; } catch { previous = null; }
    const reportUrl = 'https://github.com/' + repo + '/blob/' + defaultBranch + '/' + badgeDir.rel + '/report.md';
    const { json, changed } = badgeFile(r, { date: new Date().toISOString().slice(0, 10), commit: env.GITHUB_SHA || null, report: reportUrl, run: runUrl, previous });
    out('badge.json', JSON.stringify(json, null, 2) + '\n');
    if (!onDefault) badgeNote = 'Badge not updated: it is written only on push, schedule or workflow_dispatch runs of ' + defaultBranch + '.';
    else if (!changed) badgeNote = 'Badge unchanged: same grades, rubric and tool list as the committed badge.json.';
    else {
      const bst = lstatOrNull(badgeDir.abs);
      if (bst && !bst.isDirectory()) throw new InputError('badge-dir ' + badgeDir.rel + ' is not a folder' + (bst.isSymbolicLink() ? ' (a symlink)' : ''));
      mkdirSync(badgeDir.abs, { recursive: true });
      safeWrite(badgePath, JSON.stringify(json, null, 2) + '\n', badgeDir.rel + '/badge.json');
      const head = ['# MCP check report', '', 'Commit `' + (env.GITHUB_SHA || 'unknown') + '`' + (runUrl ? ', [workflow run](' + runUrl + ')' : '') + ', graded ' + json.date + ' with @isokron/mcp-check ' + VERSION + '.', ''];
      if (link) head.push('[Open this report in the web checker](' + link + ')', '');
      safeWrite(join(badgeDir.abs, 'report.md'), head.join('\n') + tagDocsLinks(M.toMarkdown(r), 'badge', { docsBase: M.DOCS_BASE, ids: Object.keys(M.CHECK) }).replace(/^# MCP tool list check\n/, '') + '\n', badgeDir.rel + '/report.md');
      badgeChanged = true;
      badgeNote = 'Badge updated in ' + badgeDir.rel + '/badge.json.';
    }
  }

  // 5. Job summary and outputs.
  let md = summaryMarkdown(r, { sections, minGrade, source, badgeSnippet: snippet, webLink: link });
  if (diff) md += '\n### Compared with ' + mdCode(baseline.rel) + '\n\n' + diff.added.length + ' added, ' + diff.removed.length + ' removed, ' + diff.changed.length + ' changed.' + (diff.highRisk.length ? ' **High risk** (a client may now run these with less confirmation): ' + diff.highRisk.map((t) => mdCode(t)).join(', ') + '.' : ' No high-risk annotation changes.') + '\n';
  if (badgeNote) md += '\n' + badgeNote + '\n';
  summary(md);
  for (const k of ALL_SECTIONS) output('grade-' + k, r.sections[k].grade || '');
  const failed = below.length > 0 || !!(diff && diff.highRisk.length);
  output('passed', failed ? 'false' : 'true');
  output('catalog-hash', r.input.catalogHash);
  output('results-dir', results.rel);
  output('sarif-file', sarifRel);
  output('tools-list', listRel);
  output('badge-changed', badgeChanged ? 'true' : 'false');
  output('badge-dir', badgeDir.rel);
  output('badge-branch', badgeChanged ? defaultBranch : '');
  output('exit-status', failed ? 1 : 0);
  if (below.length) annotate('error', 'mcp-check: below min-grade ' + minGrade + ': ' + below.join(', '));
  if (diff && diff.highRisk.length) annotate('error', 'mcp-check: high-risk annotation change against ' + baseline.rel + ': ' + diff.highRisk.join(', '));
  process.stdout.write(ALL_SECTIONS.map((k) => k + ' ' + (r.sections[k].grade || 'n/a')).join(', ') + '\n');
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then((code) => { process.exitCode = 0; void code; }).catch((e) => {
    if (e instanceof InputError) annotate('error', 'mcp-check: ' + e.message);
    else {
      // An unexpected failure: a plain message in the log, the stack only on stderr.
      annotate('error', 'mcp-check: unexpected error: ' + String(e && e.message || e).slice(0, 300) + ' (please report it at https://github.com/isokron-ai/mcp-check/issues)');
      process.stderr.write(String(e && e.stack || e) + '\n');
    }
    try { output('exit-status', 1); } catch { /* no output file */ }
    process.exitCode = 1;
  });
}
