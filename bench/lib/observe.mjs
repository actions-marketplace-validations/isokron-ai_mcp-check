// Runs one mcp-check build over benchmark cases and records what it said, in a form the scorer reads.
// The build is loaded from its own folder (`root`), so a mutated copy in a temp folder is observed the same way.
// Each case is read exactly as a user would read it: `mcp-check --repo-dir <case> --format json`, every section.
// Nothing is run, nothing is fetched: --repo-dir reads files only.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SECTIONS = 'spec,anthropic,openai,security,quality,surface';
const RANK = { advice: 1, attention: 2, blocking: 3 };

/** What the reader produced for one tool, as the truth's `details` labels it. */
export function detailsOf(t) {
  const s = t && t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
  return {
    description: typeof t.description === 'string' ? t.description : null,
    params: s.properties && typeof s.properties === 'object' ? Object.keys(s.properties).sort() : [],
    required: Array.isArray(s.required) ? s.required.slice().sort() : [],
    annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : {},
  };
}

class Sink {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(String(s)); return true; }
  get text() { return this.chunks.join(''); }
}

/** What an exit-3 message says the reader did: the outcome vocabulary of the truth files. */
export function outcomeOf(message) {
  const m = String(message || '');
  if (/more than one server/.test(m)) return 'multiple';
  if (/could not be read completely/.test(m)) return 'incomplete';
  if (/only tool names were found/.test(m)) return 'names';
  if (/source is not read yet/.test(m)) return 'unsupported';
  if (/no tool definitions found/.test(m)) return 'none';
  return 'error';
}

/** Observes one case folder with the CLI's main() of the given build. `work`: a folder for the saved list (the run's
 *  own, removed by the run; a mutant child killed at its time limit leaves it inside the mutant pass's folder). */
export async function observeCase(main, dir, work) {
  const out = new Sink(); const err = new Sink();
  let code;
  const own = !work;
  const tmp = work || mkdtempSync(join(tmpdir(), 'bench-save-'));
  const saved = join(tmp, 'list.json');
  rmSync(saved, { force: true });
  let list = null;
  try {
    code = await main(['--repo-dir', dir, '--format', 'json', '--sections', SECTIONS, '--save', saved], { stdout: out, stderr: err });
    try { const j = JSON.parse(readFileSync(saved, 'utf8')); list = Array.isArray(j.tools) ? j.tools : null; } catch { list = null; }
  } catch (e) {
    return { outcome: 'error', exit: null, message: String(e && e.stack || e).slice(0, 600), tools: [], findings: {}, server: [] };
  } finally { if (own) rmSync(tmp, { recursive: true, force: true }); else rmSync(saved, { force: true }); }
  if (code === 0 || code === 1) {
    let j;
    try { j = JSON.parse(out.text); } catch (e) { return { outcome: 'error', exit: code, message: 'unparsable JSON: ' + String(e.message).slice(0, 200), tools: [], findings: {}, server: [] }; }
    const tools = (j.tools || []).map((t) => String(t.name));
    const findings = {};
    // each check once per tool, at the highest severity it was raised with
    // a name listed twice (a duplicate) merges into one entry: what was raised on either
    for (const t of j.tools || []) {
      const m = { ...(findings[t.name] || {}) };
      for (const f of t.findings || []) if (!m[f.id] || RANK[f.severity] > RANK[m[f.id]]) m[f.id] = f.severity;
      findings[t.name] = Object.fromEntries(Object.entries(m).sort());
    }
    const details = {};
    for (const t of list || []) if (t && typeof t.name === 'string' && !details[t.name]) details[t.name] = detailsOf(t);
    const server = {};
    for (const f of j.server || []) if (!server[f.id] || RANK[f.severity] > RANK[server[f.id]]) server[f.id] = f.severity;
    const s = j.source || {};
    return {
      outcome: 'tools', exit: code, tools, findings, server, details,
      grades: Object.fromEntries(Object.entries(j.sections || {}).map(([k, v]) => [k, v.grade])),
      fidelity: s.fidelity || null, language: s.language || null,
      conditional: s.conditional || [], left_out: (s.left_out || []).map((x) => x.name),
      unresolved_names: s.unresolved_names || 0, skipped_checks: j.skipped_checks || null,
      unreadable: Object.fromEntries(Object.entries(s.unreadable || {}).filter(([k]) => k !== 'text')),
    };
  }
  // the case folder's absolute path is replaced, so observations and reports do not depend on where the checkout is
  const message = err.text.split(dir).join('<case>').trim().slice(0, 600);
  return { outcome: code === 3 ? outcomeOf(message) : 'error', exit: code, message, tools: [], findings: {}, server: [] };
}

/** Loads the CLI of the build at `root` and observes every case: { id: observation }. */
export async function observeAll(root, cases, { onCase, tmp = null } = {}) {
  const { main } = await import(pathToFileURL(join(root, 'src', 'cli.js')).href);
  const work = mkdtempSync(join(tmp || tmpdir(), 'bench-save-'));
  const obs = {};
  try {
    for (const c of cases) {
      obs[c.id] = await observeCase(main, c.dir, work);
      if (onCase) onCase(c, obs[c.id]);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return obs;
}
