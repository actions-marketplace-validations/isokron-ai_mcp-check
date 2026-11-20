// Report helpers shared by the CLI and the GitHub Action: SARIF with file locations, the job-summary
// Markdown, the README badge file and the web-checker link. Pure functions over an analyse() result.
import M from './engine.js';
import { tagged } from './links.js';

export const GRADES = ['A', 'B', 'C', 'D', 'F'];
export const ALL_SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];
/** Sections with a letter. Write surface (rubric 2.2.0) reports guard coverage only and is never gated. */
export const GRADED_SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality'];
export const DEFAULT_SECTIONS = ['spec', 'anthropic', 'openai', 'security'];

/** One line on the write surface: guard coverage, advice only (shown when the surface section is selected). */
export function surfaceLine(r) {
  const s = r.sections.surface;
  return 'Write surface (advice, not graded): ' + (s.why || s.summary || 'no write tools.');
}
export const WEB_BASE = 'https://isokron.ai/mcp-check';
/** Longest web-checker link written into a report; longer lists are left out rather than truncated. */
export const MAX_LINK = 64 * 1024;

const below = (g, min) => g != null && GRADES.indexOf(g) > GRADES.indexOf(min);

/** Sections (of `sections`) whose grade is below `minGrade`, as "id grade" strings. */
export function belowMinGrade(r, sections, minGrade) {
  if (!minGrade) return [];
  return sections.filter((s) => below(r.sections[s].grade, minGrade)).map((s) => s + ' ' + r.sections[s].grade);
}

/** Line (1-based) of the first `"name": "<tool>"` in the input text, or 1. */
function lineOf(text, tool) {
  if (!text || !tool) return 1;
  const re = new RegExp('"name"\\s*:\\s*' + JSON.stringify(tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = re.exec(text);
  if (!m) return 1;
  let n = 1;
  for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * SARIF 2.1.0 from the engine, with the channel tag on its help links and, when `uri` is given, a
 * physical location on every result so GitHub code scanning can show it: `uri` is the tool-list file relative to the repository root, and the line is the tool's
 * "name" in that file (line 1 for findings on the whole list).
 */
export function sarifWithLocations(r, text, uri) {
  const s = JSON.parse(M.toSarif(r));
  // The links code scanning shows for the tool and for each rule carry the SARIF channel tag (links.js).
  for (const run of s.runs) {
    const d = run.tool.driver;
    if (d.informationUri) d.informationUri = tagged(d.informationUri, 'sarif');
    for (const rule of d.rules || []) if (rule.helpUri) rule.helpUri = tagged(rule.helpUri, 'sarif');
  }
  if (!uri) return s;
  for (const run of s.runs) {
    for (const res of run.results) {
      const tool = res.locations?.[0]?.logicalLocations?.[0]?.name;
      const line = tool && tool !== 'tools/list' ? lineOf(text, tool) : 1;
      res.locations[0].physicalLocation = { artifactLocation: { uri }, region: { startLine: line } };
    }
  }
  return s;
}

/**
 * Text from the tool list (or the server) as inert Markdown: the engine's escaping (backslash, backtick,
 * emphasis, brackets, angle brackets, pipes, newlines) plus '!', '~', '#' and HTML entities, so no
 * link, image, HTML, heading or table cell can be formed from it.
 */
export const mdText = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/\r?\n|\r/g, ' ')
  .replace(/([\\`*_[\]<>|!~#])/g, '\\$1');
/** A name from the tool list as inline code, fenced so its own backticks cannot close the span. */
export const mdCode = (s) => {
  const t = String(s).replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|');
  const run = Math.max(0, ...(t.match(/`+/g) || []).map((m) => m.length));
  const f = '`'.repeat(run + 1);
  return f + (run || /^`|`$/.test(t) ? ' ' + t + ' ' : t) + f;
};
const esc = mdText;
const code = mdCode;

/**
 * Short Markdown for a GitHub job summary: the grade table, the gate, and the first blocking and
 * attention findings with their docs links. The full report is the Markdown export (M.toMarkdown).
 * `approximate` (a list read from source) marks the heading. `source`, `note` (a paragraph under the first line) and `hint` (the last line) are Markdown the caller
 * composed (with mdText/mdCode for anything taken from the server); every other string taken from the list
 * is escaped here.
 */
export function summaryMarkdown(r, { sections = DEFAULT_SECTIONS, minGrade = null, maxFindings = 25, source = null, note = null, approximate = false, badgeSnippet = null, webLink: link = null, hint = null } = {}) {
  const out = [];
  out.push('## MCP check' + (approximate ? ' (approximate)' : ''), '');
  out.push('Rubric ' + r.rubric_version + ', MCP specification ' + r.spec_version + ', directory rules as read on ' + r.sources_read + '. ' + r.input.tools + ' tools' + (source ? ' from ' + source : '') + '.', '');
  if (note) out.push(note, '');
  out.push('| Section | Grade | Score | Blocking | Attention | Advice | Gate |', '|---|---|---|---|---|---|---|');
  for (const k of GRADED_SECTIONS) {
    const s = r.sections[k];
    const gated = sections.includes(k);
    const gate = !gated ? 'not gated' : !minGrade ? '' : below(s.grade, minGrade) ? 'below ' + minGrade : 'meets ' + minGrade;
    out.push('| ' + s.name + ' | ' + s.grade + ' | ' + s.score + ' | ' + s.counts.blocking + ' | ' + s.counts.attention + ' | ' + s.counts.advice + ' | ' + gate + ' |');
  }
  if (sections.includes('surface')) out.push('', esc(surfaceLine(r)));
  const failing = belowMinGrade(r, sections, minGrade);
  if (minGrade) out.push('', failing.length ? '**Below the minimum grade ' + minGrade + ':** ' + failing.join(', ') + '.' : 'Every gated section meets the minimum grade ' + minGrade + '.');
  const fs = M.allFindings(r).filter((f) => f.severity !== 'advice' && f.section !== 'surface' && f.affects.some((a) => sections.includes(a)));
  const order = { blocking: 0, attention: 1 };
  fs.sort((a, b) => order[a.severity] - order[b.severity]);
  if (fs.length) {
    out.push('', '### Blocking and attention findings', '', '| Severity | Tool | Check | Finding |', '|---|---|---|---|');
    fs.slice(0, maxFindings).forEach((f) => out.push('| ' + f.severity + ' | ' + (f.tool ? code(f.tool) : '(list)') + ' | [' + f.id + '](' + tagged(M.CHECK[f.id].docs, 'action') + ') | ' + esc(f.message) + ' |'));
    if (fs.length > maxFindings) out.push('', fs.length - maxFindings + ' more in the report artifact.');
  } else {
    out.push('', 'No blocking or attention findings in the gated sections.');
  }
  out.push('', 'Catalog hash `' + r.input.catalogHash + '`.');
  if (link) out.push('', '[Open this report in the web checker](' + link + ') (the tool list travels in the link fragment, which is never sent to a server).');
  if (badgeSnippet) out.push('', '### README badge', '', '```markdown', badgeSnippet, '```');
  if (hint) out.push('', hint);
  return out.join('\n') + '\n';
}

const COLOR = { A: 'brightgreen', B: 'green', C: 'yellow', D: 'orange', F: 'red' };

/**
 * The shields.io endpoint file for a README badge. shields.io reads schemaVersion, label, message and
 * color and ignores the other keys, which record what the badge says: the grades, the rubric version,
 * the date, the catalog hash and where the report is.
 *   previous: the file already in the repository (parsed), if any. When the grades, rubric and catalog
 *   hash are the same as in it, `changed` is false and its date is kept, so an unchanged run commits nothing.
 */
export function badgeFile(r, { date, commit = null, report = null, run = null, previous = null } = {}) {
  const base = M.badgeJson(r);
  const grades = Object.fromEntries(GRADED_SECTIONS.map((k) => [k, r.sections[k].grade || null]));
  const key = (b) => b && JSON.stringify([b.message, b.color, b.rubric_version, b.grades, b.catalog_hash]);
  const json = {
    schemaVersion: 1,
    label: base.label,
    message: base.message,
    color: base.color || COLOR.F,
    cacheSeconds: 3600,
    rubric_version: r.rubric_version,
    date,
    grades,
    catalog_hash: r.input.catalogHash,
    commit,
    report,
    run,
  };
  if (previous && key(previous) === key(json)) return { json: previous, changed: false };
  return { json, changed: true };
}

/** README snippet for the badge served from a file in the repository. */
export function badgeSnippet({ owner, repo, branch, dir = '.github/mcp-check' }) {
  const raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + dir + '/badge.json';
  const report = 'https://github.com/' + owner + '/' + repo + '/blob/' + branch + '/' + dir + '/report.md';
  return '[![MCP check](https://img.shields.io/endpoint?url=' + raw + ')](' + report + ')';
}

/** Link that opens the list in the web checker, or null when it would be longer than MAX_LINK. */
export async function webLink(text) {
  try {
    const frag = await M.encodeFragment(text);
    const url = WEB_BASE + '#' + frag;
    return url.length <= MAX_LINK ? url : null;
  } catch {
    return null;
  }
}
