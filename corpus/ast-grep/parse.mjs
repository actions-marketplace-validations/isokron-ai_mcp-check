// Small text readers for what a registration call says. ast-grep finds the call; these read its arguments, and
// only literals: a string, a boolean, an object or keyword list of those. Anything else is not read (never guessed).

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

/**
 * Index just past the string literal that starts at `i`, or -1. Handles ", ', `, Python triple quotes and Rust or Go
 * raw strings (r"..", r#".."#, backtick).
 */
export function skipString(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return -1;
  if ((q === '"' || q === "'") && s.startsWith(q.repeat(3), i)) {
    const end = s.indexOf(q.repeat(3), i + 3);
    return end < 0 ? -1 : end + 3;
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\' && q !== '`') { j++; continue; }
    if (s[j] === q) return j + 1;
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') {
      // a template substitution: skip to its closing brace
      let depth = 1; j += 2;
      for (; j < s.length && depth; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; else if (s[j] === '"' || s[j] === "'" || s[j] === '`') { const e = skipString(s, j); if (e < 0) return -1; j = e - 1; } }
      j--;
    }
  }
  return -1;
}

/** Index just past a comment that starts at `i` (// or # to end of line, or a block comment), or -1. */
function skipComment(s, i, hash) {
  if (s[i] === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; }
  if (s[i] === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); return e < 0 ? s.length : e + 2; }
  if (hash && s[i] === '#') { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; }
  return -1;
}

/** Splits `s` at top-level `sep` characters (default a comma), outside strings, comments and brackets. Trims the parts. */
export function splitTop(s, { sep = ',', hash = false } = {}) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const str = skipString(s, i);
    if (str > 0) { i = str - 1; continue; }
    const cm = skipComment(s, i, hash);
    if (cm > 0) { i = cm - 1; continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (c === sep && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  const last = s.slice(start).trim();
  if (last || parts.length) parts.push(last);
  return parts.filter((p, i) => p !== '' || i < parts.length - 1);
}

/** The text between the bracket at `open` and its match (exclusive), or null. */
export function balanced(s, open, hash = false) {
  if (!OPEN[s[open]]) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const str = skipString(s, i);
    if (str > 0) { i = str - 1; continue; }
    const cm = skipComment(s, i, hash);
    if (cm > 0) { i = cm - 1; continue; }
    if (OPEN[s[i]]) depth++;
    else if (CLOSE.has(s[i])) { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}

/** The arguments of the call or attribute `text` as source strings: the text inside its first top-level parenthesis pair. */
export function callArgs(text, { hash = false } = {}) {
  const open = text.indexOf('(');
  if (open < 0) return [];
  const inner = balanced(text, open, hash);
  return inner === null ? [] : splitTop(inner, { hash }).filter((x) => x !== '');
}

const ESC = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`' };
function unescape(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return Object.prototype.hasOwnProperty.call(ESC, e) ? ESC[e] : e;
  });
}

/**
 * The value of `src` when it is one string literal (or two or more joined with +, or Python's implicit joining), with
 * the usual wrappers of the language around it (`.into()`, `.to_string()`, `String::from(..)`, `Cow::Borrowed(..)`,
 * `Some(..)`, a Python `r`/`f`-less prefix). null when it is anything else, a template with `${}` or an f-string included.
 */
export function literalString(src) {
  let s = String(src).trim();
  for (let n = 0; n < 4; n++) {
    const before = s;
    s = s.replace(/\.(?:into|to_string|to_owned|into_boxed_str|as_str)\(\)$/, '').trim();
    const w = /^(?:Some|String::from|Cow::Borrowed|Cow::Owned|std::borrow::Cow::Borrowed)\(/.exec(s);
    if (w && s.endsWith(')') && balanced(s, w[0].length - 1) === s.slice(w[0].length, -1)) s = s.slice(w[0].length, -1).trim();
    if (s === before) break;
  }
  const joined = splitTop(s, { sep: '+' });
  const pieces = joined.length > 1 ? joined : [s];
  let out = '';
  for (const piece of pieces) {
    let rest = piece.trim();
    // Python implicit concatenation: "a" "b"
    let any = false;
    for (;;) {
      const m = /^(?:[rRuUbB]|)(?=["'`])/.exec(rest);
      if (!m) break;
      const pre = m[0].length;
      let prefix = rest.slice(0, pre);
      const start = pre;
      if (/^[bB]$/.test(prefix)) return null;
      const end = skipString(rest, start);
      if (end < 0) return null;
      const q = rest[start];
      const triple = rest.startsWith(q.repeat(3), start) && q !== '`';
      const body = rest.slice(start + (triple ? 3 : 1), end - (triple ? 3 : 1));
      if (q === '`' && body.includes('${')) return null;
      out += /^[rR]$/.test(prefix) || q === '`' ? body : unescape(body);
      any = true;
      rest = rest.slice(end).trim();
    }
    if (!any || rest !== '') {
      // Rust raw strings r"..", r#".."#
      const raw = /^r(#*)"([\s\S]*)"\1$/.exec(piece.trim());
      if (raw) { out += raw[2]; continue; }
      return null;
    }
  }
  return out;
}

/** true or false when `src` is a boolean literal (true/True/false/False), else null. */
export function literalBool(src) {
  const m = /^(?:mcp\.ToBoolPtr\(|ptr\(|Some\(|new\(bool\)\()?\s*(true|false|True|False)\s*\)?$/.exec(String(src).trim());
  return m ? m[1].toLowerCase() === 'true' : null;
}

/**
 * The top-level `key: value` pairs of an object, dict, keyword list or struct body, as Map key to source. `body` is
 * the text inside the braces. Keys may be bare, quoted, or (with `eq`) written key = value. Spread and shorthand
 * entries are returned under their own text with value null.
 */
export function fields(body, { sep = ':', hash = false } = {}) {
  const out = new Map();
  for (const part of splitTop(body, { hash })) {
    if (!part) continue;
    let key = null;
    let value = null;
    if (/^["'`]/.test(part)) {
      const end = skipString(part, 0);
      const after = end > 0 ? part.slice(end).trimStart() : '';
      if (end > 0 && after.startsWith(sep) && !(sep === '=' && after.startsWith('=='))) { key = literalString(part.slice(0, end)); value = after.slice(1).trim(); }
    } else {
      const m = sep === ':' ? /^([A-Za-z_$][\w$]*)\s*:(?!:)\s*([\s\S]*)$/.exec(part) : /^([A-Za-z_][\w.]*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
      if (m) { key = m[1]; value = m[2].trim(); }
    }
    if (key === null) { if (/^[A-Za-z_$][\w$]*$/.test(part)) out.set(part, null); continue; }
    out.set(key, value);
  }
  return out;
}

/** The `{...}` body of `src` when it is an object or dict literal (also a type-prefixed struct literal), else null. */
export function objectBody(src) {
  const s = String(src).trim();
  const open = s.indexOf('{');
  if (open < 0) return null;
  // allow a short prefix: `&mcp.Tool`, `ToolAnnotations`, `dict`, `as const` suffixes; the literal must span the whole text
  if (!/^[&\w.:<>\[\]\s*]*$/.test(s.slice(0, open))) return null;
  const inner = balanced(s, open);
  if (inner === null) return null;
  const rest = s.slice(open + inner.length + 2).trim();
  if (rest && !/^(as\s+const|\.\.\.)?$/.test(rest)) return null;
  return inner;
}

/** The elements of an array literal `[a, b]` as source strings, or null. */
export function arrayItems(src) {
  const s = String(src).trim();
  const m = /^(?:(?:vec!|&)?\s*)\[/.exec(s);
  if (!m) return null;
  const open = s.indexOf('[');
  const inner = balanced(s, open);
  if (inner === null || s.slice(open + inner.length + 2).trim().replace(/\s*as\s+const$/, '') !== '') return null;
  return splitTop(inner).filter((x) => x !== '');
}

const HINTS = {
  readonlyhint: 'readOnlyHint', readonly: 'readOnlyHint', read_only_hint: 'readOnlyHint', 'read_only': 'readOnlyHint',
  destructivehint: 'destructiveHint', destructive: 'destructiveHint', destructive_hint: 'destructiveHint',
  idempotenthint: 'idempotentHint', idempotent: 'idempotentHint', idempotent_hint: 'idempotentHint',
  openworldhint: 'openWorldHint', openworld: 'openWorldHint', open_world_hint: 'openWorldHint', open_world: 'openWorldHint',
};
/** The canonical annotation key of a name written as it is in an SDK (camelCase, snake_case, PascalCase), or null. */
export function hintKey(name) {
  const k = String(name).toLowerCase();
  if (k === 'title') return 'title';
  return HINTS[k] ?? null;
}

/** Annotations read from the fields of an object: only literal booleans for the four hints and a literal title. */
export function annotationsOf(map) {
  const out = {};
  for (const [k, v] of map) {
    const key = hintKey(k);
    if (!key || v === null) continue;
    if (key === 'title') { const t = literalString(v); if (t !== null) out.title = t; continue; }
    const b = literalBool(v);
    if (b !== null) out[key] = b;
  }
  return Object.keys(out).length ? out : null;
}
