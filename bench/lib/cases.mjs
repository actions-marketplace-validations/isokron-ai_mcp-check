// The benchmark cases: a folder of source per case (cases/<language>/<name>/) and its ground truth
// (truth/<language>/<name>.json). The truth sits outside the case folder, so the reader never sees it.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const OUTCOMES = ['tools', 'none', 'unsupported', 'multiple', 'incomplete', 'names', 'error'];
export const ABSTAIN = new Set(['multiple', 'incomplete', 'names']);
export const UNSUPPORTED = new Set(['unsupported', 'none']);

/** Checks scored on every case that lists tools, unless its truth says otherwise. Each one's truth is "no tool" by default,
 *  so every clean case is a labelled negative for all of them; a case that plants one names the tools it must flag. */
export const CORE_CHECKS = [
  'sec-instruction-phrases', 'sec-instruction-markup', 'sec-html-comment', 'sec-zero-width', 'sec-bidi-controls',
  'sec-cross-tool-steering', 'sec-secret-seeking', 'sec-external-instructions', 'sec-encoded-blob', 'sec-homoglyph',
  'sec-invisible-encoding', 'sec-control-chars',
  'annot-write-marked-readonly', 'annot-delete-marked-safe', 'spec-name-charset', 'spec-name-length',
];
/** Checks of the list as a whole (not of one tool), scored on every case that lists tools; truth "none" by default. */
export const CORE_SERVER_CHECKS = ['spec-name-unique', 'openai-name-unique'];

const KEYS = new Set(['id', 'language', 'idioms', 'about', 'outcome', 'tools', 'optional_tools', 'findings', 'server_findings', 'faulty_oracle', 'known_gap', 'core', 'reproduces', 'details', 'truth_level', 'exhaustive', 'not_scored', 'unreadable', 'split', 'expected_disagreement']);
const SEVERITIES = new Set(['blocking', 'attention', 'advice']);

/** Validates one truth file; throws with the case id on any mistake, so a typo never scores silently. */
export function validateTruth(t, id) {
  const bad = (m) => { throw new Error('truth ' + id + ': ' + m); };
  if (!t || typeof t !== 'object') bad('not an object');
  for (const k of Object.keys(t)) if (!KEYS.has(k)) bad('unknown key ' + k);
  if (t.id !== id) bad('id must be ' + id);
  if (typeof t.language !== 'string') bad('language');
  if (!Array.isArray(t.idioms) || !t.idioms.length) bad('idioms');
  if (!OUTCOMES.includes(t.outcome) || t.outcome === 'error') bad('outcome');
  if (t.outcome === 'tools' && (!Array.isArray(t.tools) || !t.tools.length)) bad('tools');
  if (t.outcome !== 'tools' && t.tools && t.tools.length && t.outcome !== 'unsupported') bad('tools given with outcome ' + t.outcome);
  for (const [k, v] of Object.entries(t.findings || {})) {
    if (!/^[a-z]+(-[a-z0-9]+)+$/.test(k)) bad('check id ' + k);
    if (!Array.isArray(v) && (!v || typeof v !== 'object')) bad('findings.' + k + ' must list tool names, or map them to a severity');
    for (const n of Array.isArray(v) ? v : Object.keys(v)) if (!(t.tools || []).includes(n) && !(t.optional_tools || []).includes(n)) bad('findings.' + k + ' names ' + n + ', which is not a tool of the case');
    if (!Array.isArray(v)) for (const s of Object.values(v)) if (!SEVERITIES.has(s)) bad('findings.' + k + ': severity ' + s);
  }
  for (const [n, d] of Object.entries(t.details || {})) {
    if (!(t.tools || []).includes(n) && !(t.optional_tools || []).includes(n)) bad('details names ' + n + ', which is not a tool of the case');
    for (const k of Object.keys(d)) if (!['description', 'params', 'required', 'annotations'].includes(k)) bad('details.' + n + ': unknown key ' + k);
  }
  if (t.split !== undefined && !['public', 'holdout'].includes(t.split)) bad('split must be public or holdout');
  if (t.truth_level !== undefined && !['established', 'inferred'].includes(t.truth_level)) bad('truth_level');
  for (const [k, v] of Object.entries(t.server_findings || {})) if (!/^[a-z]+(-[a-z0-9]+)+$/.test(k) || !(v === true || SEVERITIES.has(v))) bad('server_findings.' + k + ' must be true or a severity');
  if (t.faulty_oracle !== undefined && (typeof t.faulty_oracle !== 'string' || !t.faulty_oracle)) bad('faulty_oracle must say what is wrong');
  // a faulty-oracle case names the one disagreement its wrong label must cause ("check|fn-or-fp|subject")
  if (t.faulty_oracle !== undefined && !(typeof t.expected_disagreement === 'string' && /^[a-z-]+\|(fn|fp)\|.+$/.test(t.expected_disagreement))) bad('a faulty_oracle case needs expected_disagreement, as check|fn-or-fp|subject');
  if (t.faulty_oracle === undefined && t.expected_disagreement !== undefined) bad('expected_disagreement is for faulty_oracle cases');
  return t;
}

/** Every case under `base` (a folder with cases/ and truth/): [{ id, dir, truth }], sorted by id. */
export function loadCases(base) {
  const out = [];
  const casesDir = join(base, 'cases');
  for (const lang of readdirSync(casesDir).sort()) {
    const ld = join(casesDir, lang);
    if (!statSync(ld).isDirectory()) continue;
    for (const name of readdirSync(ld).sort()) {
      const dir = join(ld, name);
      if (!statSync(dir).isDirectory()) continue;
      const id = lang + '/' + name;
      const tf = join(base, 'truth', lang, name + '.json');
      if (!existsSync(tf)) throw new Error('case ' + id + ' has no truth file ' + tf);
      out.push({ id, dir, truth: validateTruth(JSON.parse(readFileSync(tf, 'utf8')), id) });
    }
  }
  // a truth file with no case is a mistake too
  const truthDir = join(base, 'truth');
  for (const lang of readdirSync(truthDir).sort()) for (const f of readdirSync(join(truthDir, lang))) {
    const id = lang + '/' + f.replace(/\.json$/, '');
    if (!out.some((c) => c.id === id)) throw new Error('truth ' + id + ' has no case folder');
  }
  return out;
}

/** Every file under a folder, as sorted paths relative to it. */
export function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  walk(dir);
  return out.map((p) => relative(dir, p).split('\\').join('/')).sort();
}

/** sha256 of the case set: every case file and every truth file, path and content. The baseline records it, so a case
 *  or a label changed or removed without a rebaseline fails the gate. */
export function caseSetHash(base) {
  const h = createHash('sha256');
  for (const sub of ['cases', 'truth']) for (const f of filesUnder(join(base, sub))) { h.update(sub + '/' + f + '\0'); h.update(readFileSync(join(base, sub, f))); h.update('\0'); }
  return h.digest('hex');
}
