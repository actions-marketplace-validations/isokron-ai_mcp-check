// Mutation sites in mcp-check's reader and check code, and the mutants made from them.
// Each mutant is one small textual change at one site: { id, file, start, end, replacement, op, category, line, before, after }.
import { createHash } from 'node:crypto';
import { tokenize } from './lexer.mjs';

/** The files mutated: the source reader (TypeScript, JavaScript, Python, committed lists), the Go and Rust readers,
 *  the code that decides what a scan gives to grade, the skipping of unreadable parts, list parsing, and the checks. */
export const TARGETS = [
  'src/inputs/repo-source.cjs', 'src/inputs/repo-go.cjs', 'src/inputs/repo-rust.cjs',
  'src/inputs/collect.js', 'src/unreadable.js', 'src/tools.js', 'engine/core.js',
];

/** What the named mutation kinds of the design are made of. */
export const CATEGORIES = {
  'flip-condition': ['eq-flip', 'rel-boundary', 'logic-swap', 'not-drop'],
  'drop-registration-pattern': ['regex-drop-alt-registration'],
  'weaken-regex': ['regex-drop-alt', 'regex-drop-boundary', 'regex-drop-flag-i'],
  'off-by-one': ['num-plus-one'],
  'swap-severity': ['severity-swap'],
  'flip-boolean': ['bool-flip'],
  'swap-some-every': ['some-every'],
};
const CATEGORY_OF = Object.fromEntries(Object.entries(CATEGORIES).flatMap(([c, ops]) => ops.map((o) => [o, c])));

// a regular expression that recognises a registration (a tool definition form) rather than anything else
const REGISTRATION_RE = /registerTool|AddTool|NewTool|add_tool|mcp_tool|tool_router|RegisterTool|Tool::new|setRequestHandler|list_tools|\\.tool|\btool\b/;

/** The ranges of a regex body's alternatives that can be dropped: for each top-level-or-group `|`, the alternative after it. */
function alternatives(body) {
  const out = []; const stack = [[]]; let cls = false; let altStart = [0];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') { cls = true; continue; }
    if (c === '(') { stack.push([]); const m = /^\(\?(?:[:=!]|<[=!]|<[A-Za-z_]\w*>)/.exec(body.slice(i)); altStart.push(i + (m ? m[0].length : 1)); continue; }
    if (c === '|') { stack[stack.length - 1].push(i); continue; }
    if (c === ')') { closeGroup(i); continue; }
  }
  closeGroup(body.length);
  function closeGroup(end) {
    const bars = stack.pop() || []; const s = altStart.pop();
    if (!bars.length) return;
    // drop the first alternative (and its bar), and each later one with the bar before it
    out.push({ start: s, end: bars[0] + 1 });
    bars.forEach((b, k) => out.push({ start: b, end: k + 1 < bars.length ? bars[k + 1] : end }));
  }
  return out;
}

const compiles = (body, flags) => { try { new RegExp(body, flags); return true; } catch { return false; } };

/** Every candidate mutant of one file's source. */
export function mutantsOf(file, src) {
  const toks = tokenize(src);
  const lineStarts = [0]; for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };
  const out = [];
  const seenIds = new Map();
  const add = (t, op, replacement, change = null, start = t.start, end = t.end) => {
    const line = lineOf(start);
    const lineText = src.slice(lineStarts[line - 1], src.indexOf('\n', start) < 0 ? src.length : src.indexOf('\n', start));
    const h = createHash('sha256').update(file + '\0' + op + '\0' + lineText.trim() + '\0' + src.slice(start, end) + '\0' + replacement).digest('hex').slice(0, 10);
    // the id leaves out the line number, so lines added above a site do not rename it; the same change on an identical
    // line text gets a suffix in order of appearance
    let id = file.replace(/^.*\//, '') + ':' + op + ':' + h;
    seenIds.set(id, (seenIds.get(id) || 0) + 1);
    if (seenIds.get(id) > 1) id += '-' + seenIds.get(id);
    out.push({ id, file, start, end, replacement, op, category: CATEGORY_OF[op], line,
      before: src.slice(start, end).slice(0, 160), after: replacement.slice(0, 160), change: change || (src.slice(start, end) + ' -> ' + (replacement || '(removed)')) });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]; const prev = toks[k - 1];
    if (t.type === 'punct') {
      const v = t.value;
      if (v === '===') add(t, 'eq-flip', '!==');
      else if (v === '!==') add(t, 'eq-flip', '===');
      else if (v === '==') add(t, 'eq-flip', '!=');
      else if (v === '!=') add(t, 'eq-flip', '==');
      else if (v === '<') add(t, 'rel-boundary', '<=');
      else if (v === '<=') add(t, 'rel-boundary', '<');
      else if (v === '>') add(t, 'rel-boundary', '>=');
      else if (v === '>=') add(t, 'rel-boundary', '>');
      else if (v === '&&') add(t, 'logic-swap', '||');
      else if (v === '||') add(t, 'logic-swap', '&&');
      else if (v === '!' && toks[k + 1] && toks[k + 1].value !== '!') add(t, 'not-drop', '');
    } else if (t.type === 'ident') {
      if (t.value === 'true' && !(prev && prev.value === '.')) add(t, 'bool-flip', 'false');
      else if (t.value === 'false' && !(prev && prev.value === '.')) add(t, 'bool-flip', 'true');
      else if ((t.value === 'some' || t.value === 'every') && prev && (prev.value === '.' || prev.value === '?.')) add(t, 'some-every', t.value === 'some' ? 'every' : 'some');
    } else if (t.type === 'number') {
      if (/^\d+$/.test(t.value)) add(t, 'num-plus-one', String(Number(t.value) + 1));
    } else if (t.type === 'string') {
      const sw = { blocking: 'attention', attention: 'blocking', advice: 'attention' }[t.value];
      if (sw) add(t, 'severity-swap', t.quote + sw + t.quote);
    } else if (t.type === 'regex') {
      if (!compiles(t.body, t.flags)) continue;
      const reg = REGISTRATION_RE.test(t.body) && /repo-|collect/.test(file);
      for (const a of alternatives(t.body)) {
        const body = t.body.slice(0, a.start) + t.body.slice(a.end);
        if (!body || body === t.body || !compiles(body, t.flags)) continue;
        add(t, reg ? 'regex-drop-alt-registration' : 'regex-drop-alt', '/' + body + '/' + t.flags, 'in /' + t.body.slice(0, 40) + (t.body.length > 40 ? '…' : '') + '/ drop "' + t.body.slice(a.start, a.end) + '"');
      }
      for (const m of t.body.matchAll(/\\b/g)) {
        if (m.index > 0 && t.body[m.index - 1] === '\\') continue;
        const body = t.body.slice(0, m.index) + t.body.slice(m.index + 2);
        if (compiles(body, t.flags)) add(t, 'regex-drop-boundary', '/' + body + '/' + t.flags, 'in /' + t.body.slice(0, 40) + (t.body.length > 40 ? '…' : '') + '/ drop \\b at ' + m.index);
      }
      if (t.flags.includes('i')) add(t, 'regex-drop-flag-i', '/' + t.body + '/' + t.flags.replace('i', ''), 'in /' + t.body.slice(0, 40) + (t.body.length > 40 ? '…' : '') + '/ drop the i flag');
    }
  }
  return out;
}

/** Applies one mutant to its file's text. */
export function applyMutant(src, m) {
  return src.slice(0, m.start) + m.replacement + src.slice(m.end);
}

/** A deterministic shuffle (mulberry32 seeded from a string). */
export function seededShuffle(arr, seed) {
  let h = 0; for (const c of String(seed)) h = (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0);
  let a = h || 1;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
