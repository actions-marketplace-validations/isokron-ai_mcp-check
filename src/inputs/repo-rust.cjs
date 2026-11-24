// repo-rust: reads the tools of an MCP server written in Rust from its source, without running it. Browser and Node.
// Used by repo-source.cjs (RepoSource), which decides which files to read; nothing here touches the network.
//
//   RepoRust.analyse([[path, text]], { cargo: [[path, text]], workBudget }) -> { found, unresolved, overBudget }
//   RepoRust.tokenize(text)                                               -> tokens
//
// Read, the way the crates list them:
//   rmcp (official)   #[tool(name = …, description = …, annotations(read_only_hint = true, …))] on methods (in
//                     #[tool_router] or #[tool(tool_box)] impls), the description from doc comments when not given,
//                     the input schema from Parameters<T> (T deriving schemars::JsonSchema: fields, `///` docs,
//                     #[schemars(…)] and #[serde(rename…, default, flatten, skip)]), the older #[tool(param)] and
//                     #[tool(aggr)] arguments, and the output schema from a Json<T> return type.
//   rust-mcp-sdk      #[mcp_tool(name = …, description = …, title = …, read_only_hint = …)] on a struct deriving
//                     JsonSchema, its fields as the input schema.
//   by hand           Tool::new(name, description, schema), Tool { name, description, input_schema, annotations, … },
//                     with json!({…}), schema_for_type::<T>() and ToolAnnotations built in place.
// Gated code: #[cfg(test)] modules (and files they declare) are not read; a tool under #[cfg(feature = "x")] is left
// out when x is not a default feature of its crate (Cargo.toml), and marked otherwise. Never guessed: a tool whose
// name cannot be read is counted as unresolved (its text is still scanned); parts that cannot be worked out are marked
// unreadable, with their string literals kept for the poisoning checks. Linear in the input: one tokenizer pass, one
// bracket pass, and a work budget over evaluation.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoRust = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STR = 64 * 1024;
  const MAX_DEPTH = 80;
  const DEFAULT_BUDGET = 2e6;
  class OverBudget extends Error {}
  // Values nested deeper than this are not kept (a tools/list may nest 64 levels in all, and the tool and its schema
  // keywords take some): such a schema is marked unreadable rather than refused by the list limit.
  const MAX_JSON_DEPTH = 56;
  const stringsOf = (v) => { const out = []; const stack = [v]; while (stack.length && out.length < 5000) { const x = stack.pop(); if (typeof x === 'string') { if (x.trim()) out.push(x); } else if (x && typeof x === 'object') for (const k of Object.keys(x)) { stack.push(x[k]); if (!Array.isArray(x)) out.push(k); } } return out; };
  // what a value nested past MAX_JSON_DEPTH becomes: the schema holding it is unreadable (see finish)
  const TOO_DEEP = Object.freeze({ __tooDeep: true });
  const hasTooDeep = (v) => { const stack = [v]; let n = 0; while (stack.length && n++ < 200000) { const x = stack.pop(); if (x === TOO_DEEP) return true; if (x && typeof x === 'object') for (const k of Object.keys(x)) stack.push(x[k]); } return false; };
  const tooDeep = (v, max) => { const stack = [[v, 0]]; while (stack.length) { const [x, d] = stack.pop(); if (d > max) return true; if (x && typeof x === 'object') for (const k of Object.keys(x)) stack.push([x[k], d + 1]); } return false; };
  const WHY_WORK = 'the reader\'s work limit for one repository';
  const WHY_MANY = 'more than 20,000 tool definitions';
  const WHY_CHAIN = 'a chain of helpers longer than followed';

  // ------------------------------------------------------------ tokenizer
  // Tokens: { y: 'id' | 'str' | 'num' | 'char' | 'life' | 'p' | 'doc', v, s, nl }. '<' and '>' are always single
  // tokens (generics). Comments are dropped except outer doc comments (/// and /** */), kept as 'doc' tokens.
  const ID_RE = /[\p{L}_][\p{L}\p{N}_]*/uy;
  const NUM_RE = /(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?)(?:[iu](?:8|16|32|64|128|size)|f32|f64)?/y;
  const PUNCT3 = new Set(['..=', '...', '<<=', '>>=']);
  const PUNCT2 = new Set(['::', '->', '=>', '..', '==', '!=', '<=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=']);
  function unescapeAt(src, i) {
    const e = src[i + 1];
    const simple = { n: '\n', r: '\r', t: '\t', '\\': '\\', 0: '\0', "'": "'", '"': '"' };
    if (e in simple) return [simple[e], i + 2];
    if (e === 'x') return [String.fromCharCode(parseInt(src.substr(i + 2, 2), 16) || 0), i + 4];
    if (e === 'u' && src[i + 2] === '{') { const c = src.indexOf('}', i + 3); const cp = parseInt(src.slice(i + 3, c), 16); return [Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '', c < 0 ? i + 3 : c + 1]; }
    if (e === '\n' || e === '\r') { let j = i + 1; while (j < src.length && /\s/.test(src[j])) j++; return ['', j]; }
    return [e === undefined ? '' : e, i + 2];
  }
  function tokenize(src) {
    src = String(src);
    const t = []; const n = src.length; let i = 0; let nl = false;
    const push = (y, v, s) => { const o = { y, v, s }; if (nl) { o.nl = true; nl = false; } t.push(o); };
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 10) { nl = true; i++; continue; }
      if (c === 32 || c === 9 || c === 13 || c === 0xfeff || c === 12 || c === 11) { i++; continue; }
      if (c === 47 && src.charCodeAt(i + 1) === 47) {
        let e = src.indexOf('\n', i); if (e < 0) e = n;
        if (src[i + 2] === '/' && src[i + 3] !== '/') push('doc', src.slice(i + 3, e).replace(/\r$/, ''), i);
        i = e; continue;
      }
      if (c === 47 && src.charCodeAt(i + 1) === 42) { // nested block comments
        const doc = src[i + 2] === '*' && src[i + 3] !== '*' && src[i + 3] !== '/';
        let d = 1; let j = i + 2;
        while (j < n && d) { if (src[j] === '/' && src[j + 1] === '*') { d++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { d--; j += 2; } else j++; }
        if (doc) push('doc', src.slice(i + 3, Math.max(i + 3, j - 2)).split('\n').map((l) => l.replace(/^\s*\*?/, '')).join('\n'), i);
        else if (src.slice(i, j).indexOf('\n') >= 0) nl = true;
        i = j; continue;
      }
      const s = i;
      // raw and byte strings: r"…", r#"…"#, b"…", br"…", c"…", cr#"…"#
      if ((c === 114 || c === 98 || c === 99) && /^(?:r#*"|br#*"|cr#*"|b"|c")/.test(src.substr(i, 3 + 8))) {
        let j = i; if (src[j] === 'b' || src[j] === 'c') j++;
        if (src[j] === 'r') {
          j++; let h = 0; while (src[j] === '#') { h++; j++; }
          const close = '"' + '#'.repeat(h); const e = src.indexOf(close, j + 1);
          const end = e < 0 ? n : e; push('str', src.slice(j + 1, end).replace(/\r/g, ''), s); i = e < 0 ? n : e + close.length; continue;
        }
        i = j; // b"…" / c"…": a normal string below
      }
      if (src.charCodeAt(i) === 34) {
        let v = ''; let j = i + 1; let from = j;
        while (j < n) { const d = src.charCodeAt(j); if (d === 34) break; if (d === 92) { v += src.slice(from, j); const [x, k] = unescapeAt(src, j); v += x; j = k; from = j; continue; } j++; }
        v += src.slice(from, Math.min(j, n)); i = j < n ? j + 1 : n;
        push('str', v.replace(/\r\n/g, '\n'), s); continue;
      }
      if (c === 39 || (c === 98 && src.charCodeAt(i + 1) === 39)) { // 'c', b'c' or a lifetime 'a
        let j = c === 98 ? i + 2 : i + 1;
        if (src[j] === '\\') { const [x, k] = unescapeAt(src, j); if (src[k] === "'") { push('char', x, s); i = k + 1; continue; } }
        const cp = src.codePointAt(j); const w = cp > 0xffff ? 2 : 1;
        if (src[j + w] === "'") { push('char', String.fromCodePoint(cp), s); i = j + w + 1; continue; }
        ID_RE.lastIndex = j; const m = ID_RE.exec(src);
        if (m && m.index === j) { push('life', m[0], s); i = j + m[0].length; continue; }
        push('p', "'", s); i++; continue;
      }
      if (c === 114 && src[i + 1] === '#' && /[\p{L}_]/u.test(src[i + 2] || '')) { ID_RE.lastIndex = i + 2; const m = ID_RE.exec(src); if (m) { push('id', m[0], s); i = i + 2 + m[0].length; continue; } }
      ID_RE.lastIndex = i; let m = ID_RE.exec(src);
      if (m && m.index === i) { i += m[0].length; push('id', m[0], s); continue; }
      if (c >= 48 && c <= 57) {
        NUM_RE.lastIndex = i; m = NUM_RE.exec(src);
        let txt = m && m.index === i ? m[0] : src[i];
        if (/\.$/.test(txt)) txt = txt.slice(0, -1);
        i += txt.length;
        const clean = txt.replace(/_/g, '').replace(/(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/, '');
        let v = /^0x/.test(clean) ? parseInt(clean.slice(2), 16) : /^0o/.test(clean) ? parseInt(clean.slice(2), 8) : /^0b/.test(clean) ? parseInt(clean.slice(2), 2) : Number(clean);
        push('num', Number.isFinite(v) ? v : 0, s); continue;
      }
      const three = src.substr(i, 3); const two = src.substr(i, 2);
      if (PUNCT3.has(three)) { i += 3; push('p', three, s); continue; }
      if (PUNCT2.has(two)) { i += 2; push('p', two, s); continue; }
      i += 1; push('p', src[s], s);
    }
    return t;
  }
  function bracketIndex(t) {
    const close = new Int32Array(t.length).fill(-1); const stack = [];
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.y !== 'p') continue; const v = x.v;
      if (v === '(' || v === '[' || v === '{') stack.push(k);
      else if (v === ')' || v === ']' || v === '}') {
        const want = v === ')' ? '(' : v === ']' ? '[' : '{';
        let p = stack.length - 1; while (p >= 0 && t[stack[p]].v !== want) p--;
        if (p >= 0) { close[stack[p]] = k; stack.length = p; }
      }
    }
    return close;
  }
  const isP = (x, v) => !!x && x.y === 'p' && x.v === v;
  const isId = (x, v) => !!x && x.y === 'id' && (v === undefined || x.v === v);
  function lineIndex(src) { const ix = [0]; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) ix.push(k + 1); return ix; }
  function lineAt(f, off) { if (f.fixedLine) return f.fixedLine; const ix = f.lines || (f.lines = lineIndex(f.text)); let lo = 0; let hi = ix.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ix[mid] <= off) lo = mid + 1; else hi = mid; } return lo; }

  // Split [a, b) on commas at bracket depth 0 and angle depth 0 (angles counted only when `angles`).
  function splitTop(f, a, b, angles) {
    const t = f.t; const out = []; let s = a; let ang = 0;
    for (let k = a; k < b; k++) {
      const x = t[k]; if (x.y !== 'p') continue;
      if (x.v === '(' || x.v === '[' || x.v === '{') { const c = f.close[k]; if (c < 0 || c >= b) break; k = c; continue; }
      if (angles && x.v === '<') ang++;
      else if (angles && x.v === '>' && ang > 0 && !isP(t[k - 1], '-') && !isP(t[k - 1], '=')) ang--;
      else if (x.v === ',' && ang === 0) { out.push([s, k]); s = k + 1; }
    }
    if (s < b) out.push([s, b]);
    return out;
  }

  // ------------------------------------------------------------ values
  const UNK = (lost) => ({ __unk: true, lost: (lost || []).slice(0, 400) });
  // a parameter of the function being read: unknown, but a function whose tool name is one is a helper
  const PARAM = (fn, name) => ({ __unk: true, __param: true, fn, name, lost: [] });
  const isParamOf = (v, fn) => !!v && v.__param === true && v.fn === fn;
  const MAX_RESULTS = 20000;
  const MAX_HELPER_ROUNDS = 64; // rounds of helper discovery; evaluation depth (40) limits a chain to about 19 helpers, past which the list is refused
  const isUnk = (v) => !!v && typeof v === 'object' && v.__unk === true;
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !v.__unk && !v.__struct && !v.__type && !v.__tool && !v.__ann;
  function literalsIn(f, a, b) { const out = []; for (let k = a; k < b && out.length < 2000; k++) if (f.t[k].y === 'str' && f.t[k].v.trim()) out.push(f.t[k].v); return out; }

  // ------------------------------------------------------------ attributes and items
  // attr: { path: 'tool' | 'serde' | …, full: 'rmcp::tool', a, b (inside the parens or after '='), inner, s }
  function readAttr(f, k) { // '#' at k -> { attr, end }
    const t = f.t; let j = k + 1; let inner = false;
    if (isP(t[j], '!')) { inner = true; j++; }
    if (!isP(t[j], '[')) return null;
    const c = f.close[j]; if (c < 0) return null;
    const segs = []; let q = j + 1;
    while (isId(t[q])) { segs.push(t[q].v); if (isP(t[q + 1], '::')) q += 2; else { q++; break; } }
    let a = q; let b = c; let form = 'word';
    if (isP(t[q], '(')) { a = q + 1; b = f.close[q] < 0 ? c : f.close[q]; form = 'list'; }
    else if (isP(t[q], '=')) { a = q + 1; b = c; form = 'value'; }
    return { attr: { path: segs[segs.length - 1] || '', full: segs.join('::'), a, b, form, inner, s: k }, end: c + 1 };
  }
  // Attribute arguments `key = value, key(nested), flag` -> [{ key, a, b (value range), nested: [...] | null }].
  function metaList(f, a, b) {
    const t = f.t; const out = [];
    splitTop(f, a, b, false).forEach(([p, q]) => {
      if (p >= q) return;
      let j = p; const segs = [];
      while (isId(t[j])) { segs.push(t[j].v); if (isP(t[j + 1], '::')) j += 2; else { j++; break; } }
      const key = segs.join('::');
      if (isP(t[j], '=')) out.push({ key, a: j + 1, b: q, nested: null });
      else if (isP(t[j], '(') && f.close[j] > 0) out.push({ key, a: j + 1, b: f.close[j], nested: metaList(f, j + 1, f.close[j]) });
      else out.push({ key: key || null, a: p, b: q, nested: null, bare: true });
    });
    return out;
  }
  const meta = (list, key) => (list || []).find((m) => m.key === key);

  // Items of a token range: { structs, enums, fns, consts, impls, mods } (recursive; #[cfg(test)] modules are
  // skipped). Each item carries its attributes, its doc text, and the cfg conditions of its enclosing items.
  function parseItems(f, a, b, ctx, out) {
    const t = f.t;
    let attrs = []; let docs = [];
    for (let k = a; k < b; k++) {
      if (--ctx.work.left < 0) throw new OverBudget('work');
      const x = t[k];
      if (x.y === 'doc') { docs.push(x.v); continue; }
      if (isP(x, '#')) { const r = readAttr(f, k); if (r) { if (r.attr.inner) { if (k === a || ctx.top) ctx.inner.push(r.attr); } else attrs.push(r.attr); k = r.end - 1; continue; } }
      if (x.y !== 'id') { if (x.y === 'p' && (x.v === '{' || x.v === '(' || x.v === '[')) { const c = f.close[k]; if (c > 0) k = c; } attrs = []; docs = []; continue; }
      let j = k;
      // visibility and qualifiers
      if (isId(t[j], 'pub')) { j++; if (isP(t[j], '(') && f.close[j] > 0) j = f.close[j] + 1; }
      while (isId(t[j]) && /^(async|const|unsafe|extern|default)$/.test(t[j].v) && !(t[j].v === 'const' && isId(t[j + 1]) && !/^(fn|unsafe|async|extern)$/.test(t[j + 1].v))) { j++; if (t[j] && t[j].y === 'str') j++; }
      const kw = t[j] ? t[j].v : null;
      const cfg = ctx.cfg.concat(attrs.filter((x) => x.path === 'cfg').map((x) => ({ f, a: x.a, b: x.b })));
      const isTestCfg = attrs.some((x) => x.path === 'cfg' && /^\s*test\s*$/.test(f.text.slice(t[x.a] ? t[x.a].s : 0, t[x.b] ? t[x.b].s : 0))) || attrs.some((x) => x.path === 'test' || x.full === 'tokio::test');
      const item = { attrs, docs, cfg, f, s: k };
      attrs = []; docs = [];
      if (kw === 'mod' && isId(t[j + 1])) {
        const name = t[j + 1].v;
        if (isP(t[j + 2], '{')) { const c = f.close[j + 2]; if (!isTestCfg) parseItems(f, j + 3, c < 0 ? b : c, Object.assign({}, ctx, { cfg, top: false, mod: ctx.mod.concat([name]) }), out); else out.skip.push([k, c < 0 ? b : c]); k = c < 0 ? b : c; continue; }
        if (isTestCfg) out.testMods.push(name);
        k = j + 2; continue;
      }
      if (isTestCfg && (kw === 'fn' || kw === 'impl' || kw === 'struct' || kw === 'enum' || kw === 'const' || kw === 'static')) { const e = skipItem(f, j, b); out.skip.push([k, e]); k = e; continue; }
      if (kw === 'struct' || kw === 'enum' || kw === 'union') {
        const name = isId(t[j + 1]) ? t[j + 1].v : null; let q = j + 2;
        const generics = []; if (isP(t[q], '<')) { const e = angleEnd(t, q); for (let z = q + 1; z < e; z++) if (isId(t[z]) && (isP(t[z - 1], '<') || isP(t[z - 1], ','))) generics.push(t[z].v); q = e + 1; }
        while (q < b && !isP(t[q], '{') && !isP(t[q], ';') && !isP(t[q], '(')) q++;
        if (isP(t[q], '{') && f.close[q] > 0) {
          const c = f.close[q];
          const def = Object.assign(item, { kind: kw, name, generics, open: q, close: c });
          if (kw === 'struct') def.fields = parseFields(f, q + 1, c, ctx); else def.variants = parseVariants(f, q + 1, c, ctx);
          if (name) out.types.push(def);
          k = c; continue;
        }
        if (isP(t[q], '(') && f.close[q] > 0) { const c = f.close[q]; if (name) out.types.push(Object.assign(item, { kind: 'tuple', name, generics, items: splitTop(f, q + 1, c, true).map(([p, z]) => parseType(f, stripFieldAttrs(f, p, z), z)) })); k = c; continue; }
        if (name) out.types.push(Object.assign(item, { kind: 'unit', name, generics }));
        k = q; continue;
      }
      if (kw === 'type' && isId(t[j + 1])) { const e = semi(f, j, b); const eq = findP(t, j, e, '='); if (eq > 0) out.aliases.push(Object.assign(item, { name: t[j + 1].v, type: parseType(f, eq + 1, e), owner: ctx.impl || null })); k = e; continue; }
      if ((kw === 'const' || kw === 'static') && (isId(t[j + 1]) || isId(t[j + 2]))) {
        let q = j + 1; if (isId(t[q], 'mut')) q++;
        const name = t[q].v; const e = semi(f, q, b); const eq = findP(t, q, e, '=');
        if (eq > 0) out.consts.push(Object.assign(item, { name, a: eq + 1, b: e, owner: ctx.impl || null }));
        k = e; continue;
      }
      if (kw === 'impl') {
        // impl<…> [Trait for] Type<…> [where …] { items }
        let q = j + 1; if (isP(t[q], '<')) q = angleEnd(t, q) + 1;
        let brace = q; while (brace < b && !isP(t[brace], '{') && !isP(t[brace], ';')) { if (isP(t[brace], '(') || isP(t[brace], '[')) { const c = f.close[brace]; if (c > 0) brace = c; } brace++; }
        if (!isP(t[brace], '{')) { k = brace; continue; }
        const head = []; for (let z = q; z < brace; z++) if (isId(t[z])) head.push(t[z].v);
        const forAt = head.indexOf('for');
        const trait = forAt > 0 ? head[forAt - 1] : null;
        const selfName = (() => { const ids = forAt >= 0 ? head.slice(forAt + 1) : head; const w = ids.indexOf('where'); return (w >= 0 ? ids.slice(0, w) : ids).filter((x) => /^[A-Z]/.test(x))[0] || ids[0] || null; })();
        const c = f.close[brace];
        const impl = Object.assign(item, { kind: 'impl', trait, selfName, open: brace, close: c });
        out.impls.push(impl);
        parseItems(f, brace + 1, c < 0 ? b : c, Object.assign({}, ctx, { cfg, top: false, impl }), out);
        k = c < 0 ? b : c; continue;
      }
      if (kw === 'trait') { k = skipItem(f, j, b); continue; }
      if (kw === 'fn' && isId(t[j + 1])) {
        const name = t[j + 1].v; let q = j + 2;
        if (isP(t[q], '<')) q = angleEnd(t, q) + 1;
        if (!isP(t[q], '(') || f.close[q] < 0) { k = q; continue; }
        const pc = f.close[q];
        const params = parseParams(f, q + 1, pc, ctx);
        let r = pc + 1; let ret = null;
        if (isP(t[r], '->')) { let e = r + 1; while (e < b && !isP(t[e], '{') && !isP(t[e], ';') && !isId(t[e], 'where')) { if (isP(t[e], '(') || isP(t[e], '[')) { const c = f.close[e]; if (c > 0) e = c; } e++; } ret = parseType(f, r + 1, e); r = e; }
        while (r < b && !isP(t[r], '{') && !isP(t[r], ';')) { if (isP(t[r], '(') || isP(t[r], '[')) { const c = f.close[r]; if (c > 0) r = c; } r++; }
        const body = isP(t[r], '{') && f.close[r] > 0 ? [r, f.close[r]] : null;
        out.fns.push(Object.assign(item, { kind: 'fn', name, params, ret, body, impl: ctx.impl || null }));
        k = body ? body[1] : r; continue;
      }
      if (kw === 'macro_rules' || (isP(t[j + 1], '!') && isId(t[j]))) { // a macro definition or an item macro call
        let q = j + 1; if (isP(t[q], '!')) q++; const mname = isId(t[q]) ? t[q].v : null; if (isId(t[q])) q++;
        if ((isP(t[q], '{') || isP(t[q], '(') || isP(t[q], '[')) && f.close[q] > 0) {
          if (kw === 'macro_rules' && mname) out.macros.push({ name: mname, f, open: q, close: f.close[q], cfg });
          else if (kw !== 'macro_rules') out.invocations.push({ name: kw, f, a: q + 1, b: f.close[q], s: k, cfg, attrs: item.attrs });
          k = f.close[q]; continue;
        }
        k = q; continue;
      }
      if (kw === 'use' || kw === 'extern') { k = semi(f, j, b); continue; }
      k = j;
    }
    return out;
  }
  // The '>' closing the '<' at q (generics): one pass over the file, cached on the token array. An unclosed '<' ends
  // before the next '{' or ';' (a comparison, not generics).
  function angleEnd(t, q) {
    let ix = t.__angle;
    if (!ix) {
      ix = new Int32Array(t.length).fill(t.length - 1); const stack = [];
      for (let z = 0; z < t.length; z++) {
        const x = t[z]; if (x.y !== 'p') continue;
        if (x.v === '<') stack.push(z);
        else if (x.v === '>' && !isP(t[z - 1], '-') && !isP(t[z - 1], '=')) { if (stack.length) ix[stack.pop()] = z; }
        else if (x.v === '{' || x.v === ';') { while (stack.length) ix[stack.pop()] = z - 1; }
      }
      Object.defineProperty(t, '__angle', { value: ix, enumerable: false });
    }
    return ix[q];
  }
  function semi(f, j, b) { const t = f.t; for (let z = j; z < b; z++) { if (isP(t[z], ';')) return z; if (t[z].y === 'p' && (t[z].v === '(' || t[z].v === '[' || t[z].v === '{')) { const c = f.close[z]; if (c > 0) z = c; } } return b; }
  function findP(t, a, b, v) { for (let z = a; z < b; z++) if (isP(t[z], v)) return z; return -1; }
  function skipItem(f, j, b) { const t = f.t; for (let z = j; z < b; z++) { if (isP(t[z], ';')) return z; if (isP(t[z], '{')) { const c = f.close[z]; return c < 0 ? b : c; } if (isP(t[z], '(') || isP(t[z], '[')) { const c = f.close[z]; if (c > 0) z = c; } } return b; }
  function stripFieldAttrs(f, p, q) { const t = f.t; let z = p; while (z < q) { if (t[z].y === 'doc') { z++; continue; } if (isP(t[z], '#')) { const r = readAttr(f, z); if (r) { z = r.end; continue; } } if (isId(t[z], 'pub')) { z++; if (isP(t[z], '(') && f.close[z] > 0) z = f.close[z] + 1; continue; } break; } return z; }
  // Leading docs and attributes of a field, variant or parameter in [p, q): { attrs, docs, start }.
  function leading(f, p, q) {
    const t = f.t; const attrs = []; const docs = []; let z = p;
    while (z < q) {
      if (t[z].y === 'doc') { docs.push(t[z].v); z++; continue; }
      if (isP(t[z], '#')) { const r = readAttr(f, z); if (r) { attrs.push(r.attr); z = r.end; continue; } }
      if (isId(t[z], 'pub')) { z++; if (isP(t[z], '(') && f.close[z] > 0) z = f.close[z] + 1; continue; }
      break;
    }
    return { attrs, docs, start: z };
  }
  function parseFields(f, a, b, ctx) {
    const t = f.t; const out = [];
    splitTop(f, a, b, true).forEach(([p, q]) => {
      if (--ctx.work.left < 0) throw new OverBudget('work');
      const l = leading(f, p, q);
      const z = l.start; if (!isId(t[z]) || !isP(t[z + 1], ':')) return;
      out.push({ name: t[z].v, type: parseType(f, z + 2, q), attrs: l.attrs, docs: l.docs, s: z });
    });
    return out;
  }
  function parseVariants(f, a, b, ctx) {
    const t = f.t; const out = [];
    splitTop(f, a, b, false).forEach(([p, q]) => {
      if (--ctx.work.left < 0) throw new OverBudget('work');
      const l = leading(f, p, q); const z = l.start; if (!isId(t[z])) return;
      const v = { name: t[z].v, attrs: l.attrs, docs: l.docs, kind: 'unit' };
      if (isP(t[z + 1], '{') && f.close[z + 1] > 0) { v.kind = 'struct'; v.fields = parseFields(f, z + 2, f.close[z + 1], ctx); }
      else if (isP(t[z + 1], '(') && f.close[z + 1] > 0) { v.kind = 'tuple'; v.items = splitTop(f, z + 2, f.close[z + 1], true).map(([x, y]) => parseType(f, x, y)); }
      out.push(v);
    });
    return out;
  }
  function parseParams(f, a, b, ctx) {
    const t = f.t; const out = [];
    splitTop(f, a, b, true).forEach(([p, q]) => {
      if (--ctx.work.left < 0) throw new OverBudget('work');
      const l = leading(f, p, q); const z = l.start;
      // pattern: type (the first ':' at depth 0 that is not '::')
      let colon = -1;
      for (let k = z; k < q; k++) { const x = t[k]; if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const c = f.close[k]; if (c > 0) k = c; continue; } if (isP(x, ':')) { colon = k; break; } }
      if (colon < 0) { out.push({ self: true, attrs: l.attrs }); return; }
      const pat = []; for (let k = z; k < colon; k++) if (isId(t[k]) && !/^(mut|ref)$/.test(t[k].v)) pat.push(t[k].v);
      out.push({ name: pat.length === 1 ? pat[0] : null, pat, type: parseType(f, colon + 1, q), attrs: l.attrs, docs: l.docs });
    });
    return out;
  }
  // Types: { k: 'path', segs: [{ name, args: [type] }] } | ref { x } | tuple { items } | slice { x } | array { x, len }
  //        | other
  function parseType(f, a, b, depth) {
    const t = f.t;
    depth = depth || 0;
    if (depth > 24) return { k: 'other' }; // deeper generics are not read (and never rescanned)
    while (a < b && (isP(t[a], '&') || isP(t[a], '&&') || t[a].y === 'life' || isId(t[a], 'mut') || isId(t[a], 'dyn') || isId(t[a], 'impl'))) {
      if (isId(t[a], 'dyn') || isId(t[a], 'impl')) return { k: 'other' };
      a++;
    }
    if (a >= b) return { k: 'other' };
    const x = t[a];
    if (isP(x, '(')) { const c = f.close[a]; if (c < 0) return { k: 'other' }; const items = splitTop(f, a + 1, c, true).map(([p, q]) => parseType(f, p, q, depth + 1)); return items.length ? { k: 'tuple', items } : { k: 'unit' }; }
    if (isP(x, '[')) { const c = f.close[a]; if (c < 0) return { k: 'other' }; const semiAt = findP(t, a + 1, c, ';'); if (semiAt > 0) return { k: 'array', x: parseType(f, a + 1, semiAt, depth + 1), len: t[semiAt + 1] && t[semiAt + 1].y === 'num' ? t[semiAt + 1].v : null }; return { k: 'slice', x: parseType(f, a + 1, c, depth + 1) }; }
    if (isP(x, '!')) return { k: 'never' };
    if (isP(x, '::')) a++;
    const segs = []; let z = a;
    while (z < b && isId(t[z])) {
      const seg = { name: t[z].v, args: [] }; z++;
      if (isP(t[z], '::') && isP(t[z + 1], '<')) z++;
      if (isP(t[z], '<')) { const e = angleEnd(t, z); seg.args = depth >= 24 ? [] : splitTop(f, z + 1, e, true).map(([p, q]) => parseType(f, p, q, depth + 1)).filter((y) => y.k !== 'life'); z = e + 1; }
      segs.push(seg);
      if (isP(t[z], '::')) { z++; continue; }
      break;
    }
    if (!segs.length) return t[a] && t[a].y === 'life' ? { k: 'life' } : { k: 'other' };
    return { k: 'path', segs };
  }
  const lastSeg = (ty) => (ty && ty.k === 'path' ? ty.segs[ty.segs.length - 1] : null);

  // ------------------------------------------------------------ the repository
  function Repo(files, opts) {
    this.opts = opts || {};
    this.work = { left: this.opts.workBudget || DEFAULT_BUDGET };
    this.files = []; this.types = new Map(); this.consts = new Map(); this.fns = []; this.aliases = new Map();
    this.crates = (this.opts.cargo || []).map(([p, text]) => ({ dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', features: cargoDefaults(String(text || '')), text: String(text || '') })).sort((a, b) => b.dir.length - a.dir.length);
    const testFiles = new Set();
    const parsed = [];
    files.forEach(([path, text]) => {
      if (typeof text !== 'string') return;
      const t = tokenize(text); const f = { path, text, t, close: bracketIndex(t) };
      f.dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const out = { types: [], consts: [], fns: [], impls: [], aliases: [], testMods: [], skip: [], macros: [], invocations: [] };
      const ctx = { work: this.work, cfg: [], top: true, inner: [], mod: [] };
      try { parseItems(f, 0, t.length, ctx, out); } catch (e) { if (e instanceof OverBudget) throw e; f.failed = true; }
      f.items = out; f.inner = ctx.inner;
      // #![cfg(test)] at the top: a test file
      if (ctx.inner.some((x) => x.path === 'cfg' && /^\s*test\s*$/.test(text.slice(t[x.a] ? t[x.a].s : 0, t[x.b] ? t[x.b].s : 0)))) return;
      // files that a #[cfg(test)] mod x; declares
      const stem = path.replace(/\.rs$/, ''); const base = /(^|\/)(mod|lib|main)$/.test(stem) ? f.dir : stem;
      out.testMods.forEach((m) => { testFiles.add((base ? base + '/' : '') + m + '.rs'); testFiles.add((base ? base + '/' : '') + m + '/mod.rs'); });
      parsed.push(f);
    });
    // item macros of the repository (macro_rules! with plain $x:frag arms) expanded where they are invoked, so tools a
    // macro declares are read like written ones
    const live = parsed.filter((f) => !testFiles.has(f.path));
    const macros = new Map(); live.forEach((f) => f.items.macros.forEach((m) => { if (!macros.has(m.name)) macros.set(m.name, m); }));
    // A worklist: an expansion's own item macros are expanded in turn, up to MAX_MACRO_DEPTH levels and MAX_EXPANSIONS in
    // all. An invocation of a repository macro that is not expanded (no arm matches, too deep, too many) is counted as
    // unresolved with its literals; past MAX_EXPANSIONS the reading is refused as incomplete.
    let expansions = 0;
    this.macroUnresolved = []; this.macroOver = null;
    if (macros.size) {
      const queue = [];
      live.forEach((f) => f.items.invocations.forEach((inv) => queue.push({ f, inv, depth: 0, line: null })));
      for (let qi = 0; qi < queue.length; qi++) {
        if (--this.work.left < 0) throw new OverBudget('work');
        const { f, inv, depth } = queue[qi];
        const m = macros.get(inv.name); if (!m) continue;
        const line = queue[qi].line || lineAt(f, f.t[inv.s].s);
        const unread = (why) => this.macroUnresolved.push({ path: f.path, line, lost: literalsIn(f, inv.a, inv.b).slice(0, 200), why });
        if (expansions >= MAX_EXPANSIONS) { if (!this.macroOver) this.macroOver = { path: f.path, line }; continue; }
        if (depth >= MAX_MACRO_DEPTH) { unread('macro nested deeper than ' + MAX_MACRO_DEPTH); continue; }
        const text = expandMacro(m, inv); if (!text) { unread('no macro arm matched'); continue; }
        expansions++;
        const t = tokenize(text); const g = { path: f.path, text, t, close: bracketIndex(t), dir: f.dir, fixedLine: line, expanded: true };
        const out = { types: [], consts: [], fns: [], impls: [], aliases: [], testMods: [], skip: [], macros: [], invocations: [] };
        try { parseItems(g, 0, t.length, { work: this.work, cfg: inv.cfg, top: false, inner: [], mod: [] }, out); } catch (e) { if (e instanceof OverBudget) throw e; unread('expansion not read'); continue; }
        g.items = out; g.inner = [];
        parsed.push(g);
        out.invocations.forEach((x) => queue.push({ f: g, inv: x, depth: depth + 1, line }));
      }
    }
    parsed.forEach((f) => {
      if (testFiles.has(f.path)) return;
      this.files.push(f);
      f.items.types.forEach((d) => { if (!this.types.has(d.name)) this.types.set(d.name, []); this.types.get(d.name).push(d); });
      f.items.aliases.forEach((d) => { if (!d.owner && !this.aliases.has(d.name)) this.aliases.set(d.name, d); });
      f.items.consts.forEach((d) => { const keys = [d.name].concat(d.owner && d.owner.selfName ? [d.owner.selfName + '::' + d.name] : []); keys.forEach((k) => { if (!this.consts.has(k)) this.consts.set(k, []); this.consts.get(k).push(d); }); });
      f.items.fns.forEach((d) => this.fns.push(d));
    });
  }
  const MAX_EXPANSIONS = 2000;
  const MAX_MACRO_DEPTH = 8;
  // The text of a macro_rules! invocation: the first arm whose pattern (literal tokens and $x:frag captures, no
  // repetitions) matches the arguments, its body with the captures put in. null when no arm matches.
  function expandMacro(m, inv) {
    const f = m.f; const t = f.t; const g = inv.f; const u = g.t;
    // arms: ( pattern ) => { body } ;
    let k = m.open + 1;
    while (k < m.close) {
      if (!(isP(t[k], '(') || isP(t[k], '[') || isP(t[k], '{'))) { k++; continue; }
      const pc = f.close[k]; if (pc < 0) return null;
      if (!isP(t[pc + 1], '=>') || !(isP(t[pc + 2], '{') || isP(t[pc + 2], '(') || isP(t[pc + 2], '['))) return null;
      const bo = pc + 2; const bc = f.close[bo]; if (bc < 0) return null;
      const caps = matchArm(f, k + 1, pc, g, inv.a, inv.b);
      if (caps) {
        let out = ''; let last = t[bo].s + 1;
        for (let q = bo + 1; q < bc; q++) {
          if (isP(t[q], '$') && isId(t[q + 1]) && caps.has(t[q + 1].v)) { out += f.text.slice(last, t[q].s) + caps.get(t[q + 1].v); last = t[q + 1].s + t[q + 1].v.length; q++; }
        }
        out += f.text.slice(last, t[bc].s);
        return out.length > 256 * 1024 ? null : out;
      }
      k = bc + 1;
    }
    void u;
    return null;
  }
  function matchArm(f, a, b, g, ia, ib) {
    const t = f.t; const u = g.t; const caps = new Map();
    let i = ia;
    for (let k = a; k < b; k++) {
      if (isP(t[k], '$') && isP(t[k + 1], '(')) return null; // repetitions are not expanded
      if (isP(t[k], '$') && isId(t[k + 1]) && isP(t[k + 2], ':') && isId(t[k + 3])) {
        // capture up to the next literal token of the pattern (at bracket depth 0), or to the end
        const stop = k + 4 < b ? t[k + 4] : null;
        let j = i;
        while (j < ib) {
          if (stop && u[j].y === stop.y && u[j].v === stop.v) break;
          if (u[j].y === 'p' && (u[j].v === '(' || u[j].v === '[' || u[j].v === '{')) { const c = g.close[j]; if (c < 0) return null; j = c + 1; continue; }
          j++;
        }
        if (j === i) return null;
        caps.set(t[k + 1].v, g.text.slice(u[i].s, j < u.length ? u[j - 1].s + tokLen(g, j - 1) : g.text.length));
        i = j; k += 3; continue;
      }
      if (i >= ib || u[i].y !== t[k].y || u[i].v !== t[k].v) return null;
      i++;
    }
    while (i < ib && isP(u[i], ',')) i++;
    return i >= ib ? caps : null;
  }
  // The source length of token k (up to the next token, without the space between).
  function tokLen(g, k) { const next = g.t[k + 1] ? g.t[k + 1].s : g.text.length; return g.text.slice(g.t[k].s, next).replace(/\s+$/, '').length; }
  // [features] default = ["a", "b"] of a Cargo.toml.
  // The features `default` turns on, followed through the features it names (a visited set; "dep:x" is x, and
  // "x/y" turns on x).
  function cargoDefaults(text) {
    const sec = /^\[features\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
    if (!sec) return new Set();
    const table = new Map(); const re = /^[ \t]*("?)([\w.-]+)\1[ \t]*=[ \t]*\[([^\]]{0,8192})\]/gm; let m;
    while ((m = re.exec(sec[1]))) table.set(m[2], (m[3].match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1)));
    const on = new Set(); const todo = (table.get('default') || []).slice();
    while (todo.length) {
      let x = todo.pop(); x = x.replace(/^dep:/, '').replace(/\?.*$/, '').replace(/\/.*$/, '');
      if (!x || on.has(x)) continue; on.add(x);
      (table.get(x) || []).forEach((y) => todo.push(y));
    }
    return on;
  }
  Repo.prototype.crateOf = function (path) { return this.crates.find((c) => !c.dir || path === c.dir || path.startsWith(c.dir + '/')) || null; };
  Repo.prototype.step = function () { if (--this.work.left < 0) throw new OverBudget('work'); };
  // A type definition by name: the one in the same file, else the same crate, else the only one.
  Repo.prototype.typeDef = function (name, f) {
    const ds = this.types.get(name); if (!ds || !ds.length) { const al = this.aliases.get(name); return al ? { alias: al } : null; }
    if (ds.length === 1) return ds[0];
    const same = ds.find((d) => d.f === f); if (same) return same;
    const cr = this.crateOf(f.path); const inCrate = ds.filter((d) => this.crateOf(d.f.path) === cr);
    return inCrate.length ? inCrate[0] : ds[0];
  };
  Repo.prototype.constDef = function (name, f, selfName) {
    const ds = this.consts.get(selfName ? selfName + '::' + name : name) || (selfName ? null : null) || this.consts.get(name);
    if (!ds || !ds.length) return null;
    return ds.find((d) => d.f === f) || ds[0];
  };

  // ------------------------------------------------------------ cfg
  // The cfg conditions of an item: excluded when they need a feature its crate does not enable by default (or test).
  Repo.prototype.cfgState = function (item) {
    const crate = this.crateOf(item.f.path); const defaults = crate ? crate.features : new Set();
    let excluded = false; const conds = [];
    for (const c of item.cfg) {
      const text = c.f.text.slice(c.f.t[c.a] ? c.f.t[c.a].s : 0, c.f.t[c.b] ? c.f.t[c.b].s : c.f.text.length).trim();
      conds.push(text);
      const v = evalCfg(text, defaults);
      if (v === false) excluded = true;
    }
    return { excluded, conds };
  };
  function evalCfg(s, defaults) { // true | false | null (unknown: a target, an unknown key)
    s = s.trim();
    let m;
    if ((m = /^not\s*\(([\s\S]*)\)$/.exec(s))) { const v = evalCfg(m[1], defaults); return v === null ? null : !v; }
    if ((m = /^(all|any)\s*\(([\s\S]*)\)$/.exec(s))) {
      const parts = splitParen(m[2]).map((x) => evalCfg(x, defaults));
      if (m[1] === 'all') return parts.some((v) => v === false) ? false : parts.every((v) => v === true) ? true : null;
      return parts.some((v) => v === true) ? true : parts.every((v) => v === false) ? false : null;
    }
    if ((m = /^feature\s*=\s*"([^"]*)"$/.exec(s))) return defaults.has(m[1]);
    if (s === 'test' || s === 'doc' || s === 'miri') return false;
    if (s === 'debug_assertions') return null;
    return null;
  }
  function splitParen(s) { const out = []; let d = 0; let cur = ''; let q = false; for (const ch of s) { if (ch === '"') q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (!q && ch === ',' && !d) { out.push(cur); cur = ''; continue; } cur += ch; } if (cur.trim()) out.push(cur); return out.map((x) => x.trim()).filter(Boolean); }

  // ------------------------------------------------------------ expressions
  // A small Rust expression evaluator over [a, b): literals, constants (also Self::X and paths), "…".to_string() /
  // .into() / String::from / Cow, Some(x), concat!, format! with constants, json!({…}), vec![…], schema helpers,
  // ToolAnnotations builders and struct literals. Anything else is unknown, with its string literals kept.
  Repo.prototype.ev = function (f, a, b, env, depth) {
    this.step();
    depth = depth || 0;
    const t = f.t;
    if (a >= b) return UNK();
    if (depth > MAX_DEPTH) return UNK(literalsIn(f, a, b));
    // binary + (string concatenation): split at the last top-level '+'
    const plus = (() => { let last = -1; for (let k = a; k < b; k++) { const x = t[k]; if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const c = f.close[k]; if (c > 0 && c < b) { k = c; continue; } return -1; } if (isP(x, '+') && k > a) last = k; } return last; })();
    if (plus > a) {
      const l = this.ev(f, a, plus, env, depth + 1); const r = this.ev(f, plus + 1, b, env, depth + 1);
      if (typeof l === 'string' && typeof r === 'string') return (l + r).slice(0, MAX_STR);
      if (l && l.__param) return l; if (r && r.__param) return r;
      return UNK([].concat(typeof l === 'string' ? [l] : isUnk(l) ? l.lost : [], typeof r === 'string' ? [r] : isUnk(r) ? r.lost : []));
    }
    while (a < b && (isP(t[a], '&') || isP(t[a], '*') || isId(t[a], 'mut'))) a++;
    if (isP(t[a], '-') && t[a + 1] && t[a + 1].y === 'num' && a + 2 === b) return -t[a + 1].v;
    if (isP(t[a], '!') && a + 1 < b) { const v = this.ev(f, a + 1, b, env, depth + 1); return typeof v === 'boolean' ? !v : UNK(literalsIn(f, a, b)); }
    // primary
    let v; let k = a;
    const x = t[k];
    if (x.y === 'str' || x.y === 'char') { v = x.v; k++; }
    else if (x.y === 'num') { v = x.v; k++; }
    else if (isP(x, '(')) { const c = f.close[k]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b)); const parts = splitTop(f, k + 1, c, false); v = parts.length === 1 && !isP(t[c - 1], ',') ? this.ev(f, k + 1, c, env, depth + 1) : parts.map(([p, q]) => this.ev(f, p, q, env, depth + 1)); k = c + 1; }
    else if (isP(x, '<') && isP(t[angleEnd(t, k) + 1], '::') && isId(t[angleEnd(t, k) + 2], 'from') && isP(t[angleEnd(t, k) + 3], '(')) {
      // <&str>::from(x) / <String>::from(x): the string form of x
      const o = angleEnd(t, k) + 3; const c = f.close[o]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b));
      v = this.ev(f, o + 1, c, env, depth + 1); if (v && v.__variant) v = v.str !== null ? v.str : UNK(); k = c + 1;
    }
    else if (isP(x, '[')) { const c = f.close[k]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b)); v = splitTop(f, k + 1, c, false).map(([p, q]) => this.ev(f, p, q, env, depth + 1)); k = c + 1; }
    else if (isId(x)) {
      // a path a::b::C (with turbofish), a macro call, a call, a struct literal
      const segs = [x.v]; let targs = null; k++;
      for (;;) {
        if (isP(t[k], '::') && isP(t[k + 1], '<')) { const e = angleEnd(t, k + 1); targs = splitTop(f, k + 2, e, true).map(([p, q]) => parseType(f, p, q)); k = e + 1; continue; }
        if (isP(t[k], '::') && isId(t[k + 1])) { segs.push(t[k + 1].v); k += 2; continue; }
        break;
      }
      if (isP(t[k], '!') && (isP(t[k + 1], '(') || isP(t[k + 1], '[') || isP(t[k + 1], '{'))) {
        const c = f.close[k + 1]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b));
        v = this.macro(segs[segs.length - 1], f, k + 2, c, env, depth + 1); k = c + 1;
      } else if (isP(t[k], '(')) {
        const c = f.close[k]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b));
        v = this.callPath(segs, targs, f, k + 1, c, env, depth + 1); k = c + 1;
      } else if (isP(t[k], '{') && /^[A-Z]/.test(segs[segs.length - 1]) && f.close[k] > 0 && f.close[k] < b) {
        const c = f.close[k]; v = this.structLit(segs, f, k + 1, c, env, depth + 1); k = c + 1;
      } else v = this.pathValue(segs, f, env, depth + 1, targs);
    } else return UNK(literalsIn(f, a, b));
    // postfix: .method(args), .field, ?, .await
    while (k < b) {
      this.step();
      if (isP(t[k], '?')) { k++; continue; }
      if (isP(t[k], '.') && isId(t[k + 1])) {
        const m = t[k + 1].v; let q = k + 2; let mt = null;
        if (isP(t[q], '::') && isP(t[q + 1], '<')) { const e = angleEnd(t, q + 1); mt = splitTop(f, q + 2, e, true).map(([p, z]) => parseType(f, p, z)); q = e + 1; }
        if (isP(t[q], '(')) { const c = f.close[q]; if (c < 0 || c >= b) return UNK(literalsIn(f, a, b)); v = this.method(v, m, mt, f, q + 1, c, env, depth + 1); k = c + 1; continue; }
        if (m === 'await') { k = q; continue; }
        v = v && v.__struct ? (m in v.f ? v.f[m] : UNK()) : isPlain(v) && m in v ? v[m] : UNK(); k = q; continue;
      }
      if (isId(t[k], 'as')) { k += 2; continue; }
      return UNK(literalsIn(f, a, b));
    }
    return v;
  };
  Repo.prototype.pathValue = function (segs, f, env, depth, targs) {
    const name = segs[segs.length - 1];
    if (segs.length === 1) {
      if (name === 'true') return true; if (name === 'false') return false; if (name === 'None') return null;
      if (env && env.vars && Object.prototype.hasOwnProperty.call(env.vars, name)) return env.vars[name];
      if (env && env.locals) { const l = env.locals(name); if (l !== undefined) return l; }
    }
    const selfName = segs.length >= 2 && segs[segs.length - 2] === 'Self' && env && env.selfName ? env.selfName : segs.length >= 2 ? segs[segs.length - 2] : null;
    const d = this.constDef(name, f, selfName && /^[A-Z]/.test(selfName) ? selfName : null) || (segs.length >= 2 ? this.constDef(name, f, null) : null);
    if (d) {
      if (d.__busy) return UNK();
      if ('__val' in d) return d.__val;
      d.__busy = true;
      try { d.__val = this.ev(d.f, d.a, d.b, { selfName: d.owner && d.owner.selfName }, depth + 1); } catch (e) { if (e instanceof OverBudget) throw e; d.__val = UNK(); } finally { d.__busy = false; }
      return d.__val;
    }
    // Enum::Variant of a strum or serde enum of the repository: its string form (as_ref, to_string, into)
    if (segs.length >= 2 && /^[A-Z]/.test(name)) {
      const ed = this.typeDef(segs[segs.length - 2], f);
      const v = ed && ed.kind === 'enum' ? ed.variants.find((x) => x.name === name) : null;
      if (v) return { __variant: true, str: this.variantString(ed, v), ed, v };
    }
    if (/^[A-Z]/.test(name) && segs.length >= 1) return { __type: segs, targs };
    return UNK();
  };
  // Struct types of the repository shaped like a tool (fields name and input_schema, or one serde renames to
  // inputSchema): name -> { field -> JSON name }.
  Repo.prototype.toolShaped = function () {
    if (this._shaped) return this._shaped;
    const out = new Map();
    this.types.forEach((ds, name) => ds.forEach((d) => {
      if (d.kind !== 'struct' || name === 'Tool' || out.has(name)) return;
      const cont = this.serdeOf(d.attrs, d.f); const map = {};
      d.fields.forEach((fl) => { const a = this.serdeOf(fl.attrs, d.f); map[fl.name] = typeof a.rename === 'string' ? a.rename : renameCase(fl.name, cont.rename_all, false); });
      const vals = Object.values(map);
      if (vals.includes('name') && (vals.includes('inputSchema') || vals.includes('input_schema'))) out.set(name, map);
    }));
    return (this._shaped = out);
  };
  // A struct value of a tool-shaped type as a Tool { … } literal (its fields by their JSON names).
  Repo.prototype.shapedStruct = function (v) {
    const map = this.toolShaped().get(v.name); if (!map) return v;
    const F = {}; Object.keys(v.f).forEach((k) => { const j = map[k] || k; const key = j === 'inputSchema' ? 'input_schema' : j === 'outputSchema' ? 'output_schema' : j; F[key] = v.f[k]; });
    return Object.assign({}, v, { name: 'Tool', f: F });
  };
  // The loop a site sits in: `.map(|pat| …)` (also filter_map, flat_map) on a list, or `for pat in list { … }`, when the
  // list is known (a literal, a constant, vec![…]): the site's value for each element, or null.
  const MAX_LOOP = 500;
  Repo.prototype.loopExpansion = function (f, start, e, fn, env) {
    const t = f.t; const [o] = fn.body;
    f.__loops = (f.__loops || 0) + 1; if (f.__loops > 200) return null; // a few hundred looked at per file
    for (let q = start - 1, n = 0; q > o && n < 4000; q--, n++) {
      if ((n & 63) === 0) this.step();
      const x = t[q];
      if (x.y !== 'p' || (x.v !== '(' && x.v !== '{')) continue;
      const c = f.close[q]; if (c < 0 || c < e) continue;
      let pat = null; let list = null;
      if (x.v === '(' && isP(t[q + 1], '|') && isId(t[q - 1]) && /^(map|filter_map|flat_map|for_each)$/.test(t[q - 1].v) && isP(t[q - 2], '.')) {
        const pe = findP(t, q + 2, c, '|'); if (pe < 0) return null;
        pat = [q + 2, pe];
        // the receiver: back over .iter() / .into_iter() / .copied() / .cloned() to its start
        const r = q - 2;
        let end = r; let a = r - 1;
        for (let z = 0; z < 8; z++) {
          if (isP(t[a], ')') ) { let open = a - 1; let d = 1; while (open > o && d) { if (isP(t[open], ')')) d++; else if (isP(t[open], '(')) d--; open--; } open++; if (isId(t[open - 1]) && /^(iter|into_iter|copied|cloned|to_vec|values|keys)$/.test(t[open - 1].v) && isP(t[open - 2], '.')) { end = open - 2; a = open - 3; continue; } }
          break;
        }
        let b = end; let s0 = end - 1;
        while (s0 > o && (isId(t[s0]) || isP(t[s0], '::') || isP(t[s0], '&') || isP(t[s0], '.') || isP(t[s0], ']') || isP(t[s0], ')'))) { if (isP(t[s0], ']') || isP(t[s0], ')')) { let d = 1; let z = s0 - 1; while (z > o && d) { if (isP(t[z], ']') || isP(t[z], ')')) d++; else if (isP(t[z], '[') || isP(t[z], '(')) d--; z--; } s0 = z; continue; } s0--; }
        list = [s0 + 1, b];
        if (isP(t[s0], '!') && isId(t[s0 - 1], 'vec')) list = [s0 - 1, b];
      } else if (x.v === '{') {
        // for pat in list {
        let inAt = -1; let forAt = -1;
        for (let z = q - 1; z > o && z > q - 200; z--) { if (isId(t[z], 'in') && inAt < 0) inAt = z; if (isId(t[z], 'for')) { forAt = z; break; } if (isP(t[z], ';') || isP(t[z], '}')) break; }
        if (forAt < 0 || inAt < 0) continue;
        pat = [forAt + 1, inAt]; list = [inAt + 1, q];
        let lb = list[1]; while (lb > list[0] + 2 && isP(t[lb - 1], ')') && isP(t[lb - 2], '(') && isId(t[lb - 3]) && /^(iter|into_iter|copied|cloned)$/.test(t[lb - 3].v)) lb -= 4;
        list[1] = lb;
      } else continue;
      if (!pat || !list || list[0] >= list[1]) return null;
      const coll = this.ev(f, list[0], list[1], env, 0);
      const items = Array.isArray(coll) ? coll : null;
      if (!items || !items.length || items.length > MAX_LOOP) return null;
      const out = [];
      for (const it of items) {
        const vars = Object.assign({}, env.vars); bindPattern(f, pat[0], pat[1], it, vars);
        const w = this.ev(f, start, e, Object.assign({}, env, { vars, locals: this.localsOf(fn, vars) }), 0);
        if (w && (w.__tool || w.__struct)) out.push(w); else return null;
      }
      return out;
    }
    return null;
  };
  function bindPattern(f, a, b, v, vars) {
    const t = f.t;
    while (a < b && (isP(t[a], '&') || isId(t[a], 'mut') || isId(t[a], 'ref'))) a++;
    if (isP(t[a], '(') && f.close[a] === b - 1) { splitTop(f, a + 1, b - 1, false).forEach(([p, q], k) => bindPattern(f, p, q, Array.isArray(v) ? v[k] : UNK(), vars)); return; }
    if (isId(t[a]) && isP(t[a + 1], '{') && f.close[a + 1] === b - 1) { splitTop(f, a + 2, b - 1, false).forEach(([p, q]) => { if (!isId(t[p])) return; const key = t[p].v; const val = v && v.__struct ? v.f[key] : UNK(); if (isP(t[p + 1], ':')) bindPattern(f, p + 2, q, val, vars); else vars[key] = val; }); return; }
    if (isId(t[a]) && a + 1 === b && t[a].v !== '_') vars[t[a].v] = v;
  }
  Repo.prototype.enumFieldExpansion = function (f, start, e, fn, env) {
    const t = f.t; const sd = this.typeDef(fn.impl.selfName, f);
    if (!sd || sd.kind !== 'struct') return null;
    for (let k = start; k < e - 2; k++) {
      if (!(isId(t[k], 'self') && isP(t[k + 1], '.') && isId(t[k + 2]))) continue;
      const fld = sd.fields.find((x) => x.name === t[k + 2].v); const seg = fld && lastSeg(fld.type);
      const ed = seg && this.typeDef(seg.name, f);
      if (!ed || ed.kind !== 'enum' || !ed.attrs.some((a) => a.path === 'derive' && /\bEnumIter\b/.test(ed.f.text.slice(ed.f.t[a.a].s, ed.f.t[a.b] ? ed.f.t[a.b].s : ed.f.text.length)))) continue;
      const out = [];
      for (const v of ed.variants) {
        if (v.attrs.some((a) => (a.path === 'strum' && /\bdisabled\b/.test(ed.f.text.slice(ed.f.t[a.a].s, ed.f.t[a.b].s))) || (a.path === 'cfg' && /^\s*test\s*$/.test(ed.f.text.slice(ed.f.t[a.a].s, ed.f.t[a.b].s))))) continue;
        const self = { __struct: true, name: sd.name, f: { [fld.name]: { __variant: true, str: this.variantString(ed, v), ed, v } } };
        const w = this.ev(f, start, e, Object.assign({}, env, { vars: Object.assign({}, env.vars, { self }) }), 0);
        if (w && w.__tool && typeof w.name === 'string') out.push(w); else return null;
      }
      return out.length ? out : null;
    }
    return null;
  };
  // The value of `match self { … }` (the function's body) for one variant: the arm whose pattern names it.
  Repo.prototype.matchArm = function (fn, variant, depth) {
    const f = fn.f; const t = f.t; const [o, c] = fn.body;
    let k = o + 1; while (k < c && !isId(t[k], 'match')) k++;
    if (!isId(t[k], 'match') || !isId(t[k + 1], 'self') && !(isP(t[k + 1], '*') && isId(t[k + 2], 'self'))) return undefined;
    let br = k + 1; while (br < c && !isP(t[br], '{')) br++;
    const bc = f.close[br]; if (bc < 0) return undefined;
    let q = br + 1;
    while (q < bc) {
      const arrow = (() => { for (let z = q; z < bc; z++) { if (isP(t[z], '=>')) return z; if (t[z].y === 'p' && (t[z].v === '(' || t[z].v === '[' || t[z].v === '{')) { const cc = f.close[z]; if (cc > 0) z = cc; } } return -1; })();
      if (arrow < 0) return undefined;
      const names = []; for (let z = q; z < arrow; z++) if (isId(t[z]) && !isP(t[z + 1], '::') && /^[A-Z]/.test(t[z].v)) names.push(t[z].v);
      let a = arrow + 1; let e;
      if (isP(t[a], '{') && f.close[a] > 0) { e = f.close[a] + 1; } else { e = a; while (e < bc && !isP(t[e], ',')) { if (t[e].y === 'p' && (t[e].v === '(' || t[e].v === '[' || t[e].v === '{')) { const cc = f.close[e]; if (cc > 0) e = cc; } e++; } }
      if (names.includes(variant) || (names.length === 0 && isId(t[q], '_'))) {
        if (isP(t[a], '{')) { a += 1; e -= 1; }
        return this.ev(f, a, e, { selfName: fn.impl.selfName }, (depth || 0) + 1);
      }
      q = isP(t[e], ',') ? e + 1 : e;
    }
    return undefined;
  };
  // The string a strum (serialize / serialize_all / to_string) or serde (rename / rename_all) enum variant stands for.
  Repo.prototype.variantString = function (ed, v) {
    const f = ed.f; let all = null; let own = null;
    ed.attrs.forEach((a) => { if (a.path === 'strum' || a.path === 'serde') metaList(f, a.a, a.b).forEach((m) => { if (/^(serialize_all|rename_all)$/.test(m.key)) { const x = this.ev(f, m.a, m.b, null, 0); if (typeof x === 'string') all = x; } }); });
    v.attrs.forEach((a) => { if (a.path === 'strum' || a.path === 'serde') metaList(f, a.a, a.b).forEach((m) => { if (/^(serialize|to_string|rename)$/.test(m.key) && own === null) { const x = this.ev(f, m.a, m.b, null, 0); if (typeof x === 'string') own = x; } }); });
    if (own !== null) return own;
    if (!ed.attrs.some((a) => a.path === 'strum' || (a.path === 'derive' && /\b(AsRefStr|Display|IntoStaticStr|EnumString)\b/.test(f.text.slice(f.t[a.a].s, f.t[a.b] ? f.t[a.b].s : f.text.length))))) return null;
    return all ? renameCase(v.name, all, true) : v.name;
  };
  // Calls by path: constructors and helpers.
  Repo.prototype.callPath = function (segs, targs, f, a, b, env, depth) {
    const name = segs[segs.length - 1]; const owner = segs.length >= 2 ? segs[segs.length - 2] : null;
    const args = () => splitTop(f, a, b, false).map(([p, q]) => this.ev(f, p, q, env, depth + 1));
    const one = () => { const xs = args(); return xs.length === 1 ? xs[0] : UNK(literalsIn(f, a, b)); };
    if (name === 'Some' || name === 'Ok' || name === 'Box' && false) return one();
    if ((owner === 'String' || owner === 'Cow' || owner === 'Arc' || owner === 'Rc' || owner === 'Box' || owner === 'Value') && /^(from|new|Borrowed|Owned|String)$/.test(name)) return one();
    if (/^(schema_for_type|cached_schema_for_type|schema_for_input|schema_for|schema_for_output)$/.test(name) && targs && targs[0]) return this.schemaValue(targs[0], f, { dialect: 'schemars', output: name === 'schema_for_output' });
    if ((owner === 'TypedTool' || owner === 'SimpleTool' || owner === 'TypedToolWithOutput' || owner === 'TypedSyncTool') && name === 'new') {
      // pmcp: TypedTool::new("name", |args: T, extra| …): the schema of T
      const xs = splitTop(f, a, b, false);
      const out = { __tool: true, f, at: a, name: xs[0] ? this.ev(f, xs[0][0], xs[0][1], env, depth + 1) : UNK(), lost: [] };
      const cl = xs[1] && isP(f.t[xs[1][0]], '|') ? xs[1][0] : -1;
      if (cl >= 0) { const end = findP(f.t, cl + 1, xs[1][1], '|'); const ps = end > 0 ? splitTop(f, cl + 1, end, true) : []; const p0 = ps[0]; const colon = p0 ? findP(f.t, p0[0], p0[1], ':') : -1; if (colon > 0) out.input = this.schemaValue(parseType(f, colon + 1, p0[1]), f, { dialect: 'schemars' }); }
      if (out.input === undefined && owner !== 'SimpleTool') out.input = UNK();
      if (owner === 'SimpleTool') out.input = { type: 'object', properties: {} };
      return out;
    }
    if (owner === 'ToolInfo' && (name === 'new' || name === 'with_annotations')) {
      const xs = splitTop(f, a, b, false); const ev = (k) => (xs[k] ? this.ev(f, xs[k][0], xs[k][1], env, depth + 1) : undefined);
      return { __tool: true, f, at: a, name: ev(0), description: ev(1), input: ev(2), annotations: name === 'with_annotations' ? ev(3) : undefined, lost: [] };
    }
    if (owner === 'Tool' && (name === 'new' || name === 'new_with_raw')) {
      const xs = splitTop(f, a, b, false);
      return { __tool: true, f, at: a, name: xs[0] ? this.ev(f, xs[0][0], xs[0][1], env, depth + 1) : UNK(), description: xs[1] ? this.ev(f, xs[1][0], xs[1][1], env, depth + 1) : undefined, input: xs[2] ? this.ev(f, xs[2][0], xs[2][1], env, depth + 1) : undefined, lost: [] };
    }
    if (owner === 'ToolAnnotations' && name === 'new') return { __ann: true, v: {} };
    if (owner === 'ToolAnnotations' && name === 'with_title') { const v = one(); return { __ann: true, v: typeof v === 'string' ? { title: v } : {}, unk: typeof v !== 'string' }; }
    if (owner === 'ToolAnnotations' && name === 'from_raw') { const xs = args(); const o = {}; ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].forEach((key, k) => { if (xs[k] !== undefined && xs[k] !== null && !isUnk(xs[k])) o[key] = xs[k]; }); return { __ann: true, v: o }; }
    if ((owner === 'Map' || owner === 'JsonObject' || owner === 'HashMap' || owner === 'BTreeMap') && name === 'new') return {};
    if (owner === 'serde_json' && name === 'from_value' || name === 'from_value') return one();
    if (name === 'from_str' && (owner === 'serde_json' || !owner)) { const v = one(); if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return UNK([v]); } } return v; }
    // a function of the repository returning one expression
    const fn = segs.length <= 3 ? this.fns.find((d) => d.name === name && d.body && (!owner || owner === 'Self' || (d.impl && d.impl.selfName === owner) || !/^[A-Z]/.test(owner))) : null;
    if (fn && depth >= 40) this.depthHit = true; // a chain deeper than followed
    if (fn && depth < 40) {
      const ret = this.singleReturn(fn);
      if (ret) {
        const vars = {}; const xs = splitTop(f, a, b, false);
        fn.params.filter((p) => !p.self).forEach((p, k) => { if (p.name && xs[k]) vars[p.name] = this.ev(f, xs[k][0], xs[k][1], env, depth + 1); });
        return this.ev(fn.f, ret[0], ret[1], { vars, selfName: fn.impl && fn.impl.selfName, locals: this.localsOf(fn, vars) }, depth + 1);
      }
    }
    return UNK(literalsIn(f, a, b));
  };
  // A function body's value when it is one expression (or ends in one, or returns one).
  Repo.prototype.singleReturn = function (fn) {
    if (fn.__ret !== undefined) return fn.__ret;
    const f = fn.f; const t = f.t; const [o, c] = fn.body;
    // the tail expression: after the last top-level ';' (or the whole body)
    let last = o;
    for (let k = o + 1; k < c; k++) { const x = t[k]; if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const z = f.close[k]; if (z > 0) k = z; continue; } if (isP(x, ';')) last = k; }
    let a = last + 1; let b = c;
    if (a >= b) { // `return x;` as the last statement
      let r = -1; for (let k = o + 1; k < c; k++) { if (isId(t[k], 'return')) r = k; const x = t[k]; if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const z = f.close[k]; if (z > 0) k = z; } }
      if (r < 0) return (fn.__ret = null);
      a = r + 1; b = semi(f, r, c);
    }
    if (isId(t[a], 'return')) a++;
    if (isId(t[a], 'if') || isId(t[a], 'match') || isId(t[a], 'loop')) return (fn.__ret = null);
    return (fn.__ret = a < b ? [a, b] : null);
  };
  // `let x = …;` bindings of a function body, read lazily: name -> value.
  Repo.prototype.localsOf = function (fn, vars) {
    const self = this;
    // the `let` bindings of the body: found once per function, evaluated per lookup
    if (!fn.__lets) {
      const map = new Map(); const f = fn.f; const t = f.t; const [o, c] = fn.body;
      for (let k = o + 1; k < c; k++) {
        if (--this.work.left < 0) throw new OverBudget('work');
        if (isId(t[k], 'let')) { let j = k + 1; if (isId(t[j], 'mut')) j++; if (isId(t[j])) { const nm = t[j].v; const e = semi(f, j, c); const eq = findP(t, j, e, '='); if (eq > 0) map.set(nm, [eq + 1, e]); k = e; } }
      }
      fn.__lets = map;
    }
    const busy = new Set();
    return (name) => {
      const r = fn.__lets.get(name); if (!r || busy.has(name)) return undefined;
      busy.add(name); // no recursion through the same binding
      try { return self.ev(fn.f, r[0], r[1], { vars, selfName: fn.impl && fn.impl.selfName, locals: null }, 1); } finally { busy.delete(name); }
    };
  };
  Repo.prototype.method = function (v, m, mt, f, a, b, env, depth) {
    if (v && v.__variant) {
      // a method of the enum that matches on self (fn name(&self) -> &str { match self { Self::A => "a", … } })
      const fn = this.fns.find((d) => d.name === m && d.impl && d.impl.selfName === v.ed.name && d.body);
      if (fn) { const r = this.matchArm(fn, v.v.name, depth); if (r !== undefined) return r; }
      if (/^(as_ref|to_string|into|as_str|to_owned)$/.test(m) && v.str !== null) return v.str;
      return UNK();
    }
    if (/^(to_string|to_owned|into|clone|unwrap|expect|as_str|as_ref|to_vec|unwrap_or_default|as_object|cloned|copied|iter|into_iter|borrow|into_owned)$/.test(m)) {
      if (m === 'as_object' && v && typeof v === 'object' && !Array.isArray(v)) return v;
      return v;
    }
    if (v && v.__ann) {
      const arg = () => { const xs = splitTop(f, a, b, false); return xs[0] ? this.ev(f, xs[0][0], xs[0][1], env, depth + 1) : true; };
      const map = { read_only: 'readOnlyHint', destructive: 'destructiveHint', idempotent: 'idempotentHint', open_world: 'openWorldHint', with_title: 'title', title: 'title', read_only_hint: 'readOnlyHint', destructive_hint: 'destructiveHint', idempotent_hint: 'idempotentHint', open_world_hint: 'openWorldHint' };
      if (map[m]) { const x = arg(); const o = Object.assign({}, v.v); if (typeof x === 'boolean' || typeof x === 'string') o[map[m]] = x; else return { __ann: true, v: o, unk: true }; return { __ann: true, v: o, unk: v.unk }; }
      return v;
    }
    if (v && v.__tool) {
      const xs = splitTop(f, a, b, false); const arg0 = () => (xs[0] ? this.ev(f, xs[0][0], xs[0][1], env, depth + 1) : UNK());
      const o = Object.assign({}, v);
      if (m === 'with_annotations' || m === 'annotate') { o.annotations = arg0(); return o; }
      if (m === 'with_title') { o.title = arg0(); return o; }
      if (m === 'with_description') { o.description = arg0(); return o; }
      if (m === 'with_schema' || m === 'with_input_schema' && !(mt && mt[0])) { o.input = arg0(); return o; }
      if (m === 'with_output_schema' && mt && mt[0]) { o.output = this.schemaValue(mt[0], f, { dialect: 'schemars', output: true }); return o; }
      if (m === 'with_raw_output_schema' || m === 'with_output_schema') { o.output = arg0(); return o; }
      if (m === 'with_input_schema' && mt && mt[0]) { o.input = this.schemaValue(mt[0], f, { dialect: 'schemars' }); return o; }
      if (m === 'with_meta' || m === 'with_icons' || m === 'with_execution') return o;
      return o;
    }
    return UNK(literalsIn(f, a, b));
  };
  Repo.prototype.macro = function (name, f, a, b, env, depth) {
    const t = f.t;
    if (name === 'json') return this.json(f, a, b, env, depth + 1);
    if (name === 'concat') { const xs = splitTop(f, a, b, false).map(([p, q]) => this.ev(f, p, q, env, depth + 1)); if (xs.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) return xs.join(''); return UNK(literalsIn(f, a, b)); }
    if (name === 'vec') { if (findP(t, a, b, ';') > 0) return UNK(literalsIn(f, a, b)); return splitTop(f, a, b, false).map(([p, q]) => this.ev(f, p, q, env, depth + 1)); }
    if (name === 'format' || name === 'formatcp' || name === 'const_format') {
      const xs = splitTop(f, a, b, false); if (!xs.length) return UNK();
      const fmt = this.ev(f, xs[0][0], xs[0][1], env, depth + 1); if (typeof fmt !== 'string') return UNK(literalsIn(f, a, b));
      const pos = []; const named = {};
      xs.slice(1).forEach(([p, q]) => { if (isId(t[p]) && isP(t[p + 1], '=') && !isP(t[p + 2], '=')) named[t[p].v] = this.ev(f, p + 2, q, env, depth + 1); else pos.push(this.ev(f, p, q, env, depth + 1)); });
      let k = 0; let ok = true; let param = null;
      const out = fmt.replace(/\{\{|\}\}|\{([A-Za-z_][\w]*)?(?::[^}]*)?\}/g, (m0, nm) => {
        if (m0 === '{{') return '{'; if (m0 === '}}') return '}';
        const v = nm ? (nm in named ? named[nm] : this.pathValue([nm], f, env, depth + 1)) : pos[k++];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v && v.__variant && v.str !== null) return v.str;
        if (v && v.__param) param = param || v;
        ok = false; return '…';
      });
      return ok ? out : param || UNK([out].concat(literalsIn(f, a, b)));
    }
    if (name === 'include_str' || name === 'include_bytes' || name === 'env') return UNK(literalsIn(f, a, b));
    if (name === 'schema_from_type' || name === 'schema_for') { const ty = parseType(f, a, b); return this.schemaValue(ty, f, { dialect: 'schemars' }); }
    if (name === 'stringify') return f.text.slice(t[a].s, t[b - 1].s + String(t[b - 1].v).length);
    return UNK(literalsIn(f, a, b));
  };
  // json!({…}): objects, arrays and literals, with Rust expressions as values.
  Repo.prototype.json = function (f, a, b, env, depth) {
    this.step();
    const t = f.t;
    if (depth > MAX_DEPTH) return UNK(literalsIn(f, a, b));
    if (isP(t[a], '{') && f.close[a] === b - 1) {
      const o = {}; let unk = null;
      splitTop(f, a + 1, b - 1, false).forEach(([p, q]) => {
        if (p >= q) return;
        let colon = -1; for (let k = p; k < q; k++) { const x = t[k]; if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const c = f.close[k]; if (c > 0) k = c; continue; } if (isP(x, ':')) { colon = k; break; } }
        if (colon < 0) return;
        const key = t[p].y === 'str' && colon === p + 1 ? t[p].v : this.ev(f, p, colon, env, depth + 1);
        const val = this.json(f, colon + 1, q, env, depth + 1);
        if (typeof key === 'string') o[key] = val; else unk = (unk || []).concat(literalsIn(f, p, q));
      });
      if (unk) o.__unkKeys = unk;
      return o;
    }
    if (isP(t[a], '[') && f.close[a] === b - 1) return splitTop(f, a + 1, b - 1, false).filter(([p, q]) => q > p).map(([p, q]) => this.json(f, p, q, env, depth + 1));
    if (isId(t[a], 'null') && b === a + 1) return null;
    return this.ev(f, a, b, env, depth + 1);
  };
  Repo.prototype.structLit = function (segs, f, a, b, env, depth) {
    const t = f.t; const out = { __struct: true, name: segs[segs.length - 1] === 'Self' && env && env.selfName ? env.selfName : segs[segs.length - 1], f: {}, at: a };
    splitTop(f, a, b, false).forEach(([p, q]) => {
      if (p >= q) return;
      if (isP(t[p], '..')) { out.rest = true; return; }
      if (isId(t[p]) && isP(t[p + 1], ':')) out.f[t[p].v] = this.ev(f, p + 2, q, env, depth + 1);
      else if (isId(t[p]) && p + 1 === q) out.f[t[p].v] = this.pathValue([t[p].v], f, env, depth + 1);
    });
    if (out.name === 'ToolAnnotations') { const o = {}; const map = { title: 'title', read_only_hint: 'readOnlyHint', destructive_hint: 'destructiveHint', idempotent_hint: 'idempotentHint', open_world_hint: 'openWorldHint' }; let unk = false; Object.keys(out.f).forEach((k) => { const v = out.f[k]; if (v === null) return; if (map[k] && (typeof v === 'boolean' || typeof v === 'string')) o[map[k]] = v; else if (map[k]) unk = true; }); return { __ann: true, v: o, unk }; }
    return out;
  };

  // JSON from a value; unknown parts set c.unk and keep their literals.
  function toJson(v, c, depth) {
    depth = depth || 0;
    if (depth > MAX_JSON_DEPTH) { c.unk = true; if (v && typeof v === 'object' && !v.__unk && !v.__struct && !v.__fn && !v.__tool && !v.__type && !v.__opt) c.lost.push(...stringsOf(v).filter((x) => typeof x === 'string')); return TOO_DEEP; }
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v === undefined || isUnk(v)) { c.unk = true; if (v && v.lost) c.lost.push(...v.lost); return undefined; }
    if (Array.isArray(v)) return v.map((x) => toJson(x, c, depth + 1)).filter((x) => x !== undefined);
    if (v.__schema) return v.schema;
    if (v.__ann) { if (v.unk) c.unk = true; return v.v; }
    if (v.__struct || v.__type || v.__tool) { c.unk = true; return undefined; }
    const o = {};
    Object.keys(v).forEach((k) => { if (k === '__unkKeys') { c.unk = true; c.lost.push(...v[k]); return; } const x = toJson(v[k], c, depth + 1); if (x !== undefined) o[k] = x; });
    return o;
  }

  // ------------------------------------------------------------ schemas from Rust types (schemars, as rmcp uses it)
  // dialect 'schemars': schemars 1.x, draft 2020-12, as rmcp generates input schemas (the root's title and description
  // dropped, $schema kept, nested named types under $defs). dialect 'rmcp-sdk': rust-mcp-sdk's own JsonSchema derive
  // (inline, no formats). ctx: { dialect, defs, seen, unknownTypes, output (serialize contract) }.
  const INT = { i8: [-128, 127, 'int8'], i16: [-32768, 32767, 'int16'], i32: [null, null, 'int32'], i64: [null, null, 'int64'], i128: [null, null, 'int128'], isize: [null, null, 'int'], u8: [0, 255, 'uint8'], u16: [0, 65535, 'uint16'], u32: [0, null, 'uint32'], u64: [0, null, 'uint64'], u128: [0, null, 'uint128'], usize: [0, null, 'uint'] };
  Repo.prototype.schemaValue = function (ty, f, opts) {
    const ctx = { dialect: opts.dialect || 'schemars', defs: {}, seen: new Set(), unknownTypes: 0, output: !!opts.output };
    const s = this.rootSchema(ty, f, ctx);
    if (!s) return UNK();
    return { __schema: true, schema: s, approx: ctx.unknownTypes > 0 };
  };
  Repo.prototype.rootSchema = function (ty, f, ctx) {
    ty = unwrap(ty);
    const seg = lastSeg(ty);
    let s;
    if (seg && this.typeDef(seg.name, f) && !BUILTIN.has(seg.name)) {
      const d = this.typeDef(seg.name, f);
      if (d.alias) return this.rootSchema(d.alias.type, d.alias.f, ctx);
      ctx.seen.add(seg.name);
      s = this.defSchema(d, ctx, 0, true);
      ctx.seen.delete(seg.name);
    } else s = this.typeSchema(ty, f, ctx, 0);
    if (!s || typeof s !== 'object') return null;
    const out = {};
    if (ctx.dialect === 'schemars') out.$schema = 'https://json-schema.org/draft/2020-12/schema';
    Object.assign(out, s);
    if (ctx.dialect === 'schemars' && !ctx.output) { delete out.title; delete out.description; }
    if (ctx.output) { delete out.title; delete out.description; }
    if (Object.keys(ctx.defs).length) out.$defs = ctx.defs;
    return out;
  };
  const BUILTIN = new Set(['String', 'str', 'bool', 'char', 'Option', 'Vec', 'VecDeque', 'HashSet', 'BTreeSet', 'HashMap', 'BTreeMap', 'IndexMap', 'Box', 'Arc', 'Rc', 'Cow', 'Value', 'PathBuf', 'Path', 'Url', 'Uuid', 'DateTime', 'NaiveDate', 'NaiveDateTime', 'Map', 'JsonObject', 'Parameters', 'Json', 'f32', 'f64'].concat(Object.keys(INT)));
  function unwrap(ty) { let s = lastSeg(ty); while (s && /^(Parameters|Json|Box|Arc|Rc|Wrapper)$/.test(s.name) && s.args.length === 1) { ty = s.args[0]; s = lastSeg(ty); } return ty; }
  Repo.prototype.typeSchema = function (ty, f, ctx, depth) {
    this.step();
    if (!ty || depth > 16) { ctx.unknownTypes++; return {}; }
    if (ty.k === 'tuple') return { type: 'array', prefixItems: ty.items.map((x) => this.typeSchema(x, f, ctx, depth + 1)), minItems: ty.items.length, maxItems: ty.items.length };
    if (ty.k === 'unit') return { type: 'null' };
    if (ty.k === 'slice') return { type: 'array', items: this.typeSchema(ty.x, f, ctx, depth + 1) };
    if (ty.k === 'array') { const s = { type: 'array', items: this.typeSchema(ty.x, f, ctx, depth + 1) }; if (typeof ty.len === 'number') { s.minItems = ty.len; s.maxItems = ty.len; } return s; }
    if (ty.k !== 'path') { ctx.unknownTypes++; return {}; }
    const seg = lastSeg(ty); const n = seg.name; const A = seg.args;
    const fmt = ctx.dialect === 'schemars';
    if (n === 'String' || n === 'str' || n === 'PathBuf' || n === 'Path' || n === 'OsString') return { type: 'string' };
    if (n === 'Cow' && A.length) return this.typeSchema(A[A.length - 1], f, ctx, depth + 1);
    if (n === 'bool') return { type: 'boolean' };
    if (n === 'char') return fmt ? { type: 'string', minLength: 1, maxLength: 1 } : { type: 'string' };
    if (INT[n]) { if (!fmt) return { type: 'integer' }; const [lo, hi, fm] = INT[n]; const s = { type: 'integer', format: fm }; if (lo !== null) s.minimum = lo; if (hi !== null) s.maximum = hi; return s; }
    if (n === 'f32' || n === 'f64') return fmt ? { type: 'number', format: n === 'f32' ? 'float' : 'double' } : { type: 'number' };
    if (n === 'Value' && (ty.segs.length === 1 || ty.segs.some((s) => s.name === 'serde_json'))) return true;
    if ((n === 'Map' || n === 'JsonObject') && !A.length) return { type: 'object', additionalProperties: true };
    if (n === 'Url' || n === 'Uri') return { type: 'string', format: 'uri' };
    if (n === 'Uuid') return { type: 'string', format: 'uuid' };
    if (n === 'DateTime' || n === 'NaiveDateTime' || n === 'OffsetDateTime') return { type: 'string', format: 'date-time' };
    if (n === 'NaiveDate' || n === 'Date') return { type: 'string', format: 'date' };
    if (n === 'Option' && A.length === 1) return nullable(this.typeSchema(A[0], f, ctx, depth + 1));
    if (/^(Vec|VecDeque|LinkedList|BinaryHeap)$/.test(n) && A.length === 1) return { type: 'array', items: this.typeSchema(A[0], f, ctx, depth + 1) };
    if (/^(HashSet|BTreeSet|IndexSet)$/.test(n) && A.length === 1) return fmt ? { type: 'array', items: this.typeSchema(A[0], f, ctx, depth + 1), uniqueItems: true } : { type: 'array', items: this.typeSchema(A[0], f, ctx, depth + 1) };
    if (/^(HashMap|BTreeMap|IndexMap|Map)$/.test(n) && A.length === 2) return { type: 'object', additionalProperties: this.typeSchema(A[1], f, ctx, depth + 1) };
    if (/^(Box|Arc|Rc|RefCell|Mutex)$/.test(n) && A.length === 1) return this.typeSchema(A[0], f, ctx, depth + 1);
    const d = this.typeDef(n, f);
    if (!d) { ctx.unknownTypes++; return {}; }
    if (d.alias) return this.typeSchema(d.alias.type, d.alias.f, ctx, depth + 1);
    if (ctx.dialect !== 'schemars') { if (ctx.seen.has(n)) return {}; ctx.seen.add(n); try { return this.defSchema(d, ctx, depth + 1, false); } finally { ctx.seen.delete(n); } }
    // schemars: a named type is a $ref into $defs
    if (!ctx.defs[n] && !ctx.seen.has(n)) { ctx.seen.add(n); ctx.defs[n] = {}; ctx.defs[n] = this.defSchema(d, ctx, depth + 1, false); ctx.seen.delete(n); }
    return { $ref: '#/$defs/' + n };
  };
  function nullable(s) {
    if (s === true || !s || typeof s !== 'object' || s.type === 'null') return s;
    if (typeof s.type === 'string') return Object.assign({}, s, { type: [s.type, 'null'] });
    if (Array.isArray(s.type)) return s.type.includes('null') ? s : Object.assign({}, s, { type: s.type.concat(['null']) });
    if (s.$ref) return { anyOf: [s, { type: 'null' }] };
    return { anyOf: [s, { type: 'null' }] };
  }
  const docText = (docs) => { const lines = docs.join('\n').split('\n').map((l) => l.trim()); while (lines.length && !lines[0]) lines.shift(); while (lines.length && !lines[lines.length - 1]) lines.pop(); return lines.length ? lines.join('\n') : null; };
  // serde / schemars attribute values of an item: { rename, rename_all, default, skip, flatten, description, … }.
  Repo.prototype.serdeOf = function (attrs, f) {
    const o = {};
    attrs.forEach((at) => {
      if (at.path !== 'serde' && at.path !== 'schemars' && at.path !== 'json_schema' && at.path !== 'validate' && at.path !== 'garde') return;
      metaList(f, at.a, at.b).forEach((m) => {
        const val = () => { const v = this.ev(f, m.a, m.b, null, 0); return v; };
        if (!m.key) return;
        if (m.key === 'rename' && !m.nested) o.rename = val();
        else if (m.key === 'rename' && m.nested) { const d = meta(m.nested, 'deserialize'); if (d) o.rename = this.ev(f, d.a, d.b, null, 0); }
        else if (m.key === 'rename_all' && !m.nested) o.rename_all = val();
        else if (m.key === 'rename_all' && m.nested) { const d = meta(m.nested, 'deserialize'); if (d) o.rename_all = this.ev(f, d.a, d.b, null, 0); }
        else if (m.key === 'default') o.default = true;
        else if (m.key === 'skip' || m.key === 'skip_deserializing') o.skip = true;
        else if (m.key === 'skip_serializing_if') o.skipSer = true;
        else if (m.key === 'flatten') o.flatten = true;
        else if (m.key === 'deny_unknown_fields') o.deny = true;
        else if (m.key === 'tag') o.tag = val();
        else if (m.key === 'content') o.content = val();
        else if (m.key === 'untagged') o.untagged = true;
        else if (m.key === 'transparent') o.transparent = true;
        else if (m.key === 'description') o.description = val();
        else if (m.key === 'title') o.title = val();
        else if (m.key === 'required') o.required = true;
        else if (m.key === 'with' && !m.nested) { const v = val(); if (typeof v === 'string') o.with = v; }
        else if (m.key === 'schema_with') o.schemaWith = true;
        else if ((m.key === 'length' || m.key === 'range') && m.nested) { m.nested.forEach((x) => { const v = this.ev(f, x.a, x.b, null, 0); if (typeof v === 'number') (o[m.key] = o[m.key] || {})[x.key] = v; else if (x.key === 'equal' && typeof v === 'number') (o[m.key] = o[m.key] || {}).equal = v; }); }
        else if ((m.key === 'regex' || m.key === 'pattern') && m.nested) { const p = meta(m.nested, 'pattern'); if (p) { const v = this.ev(f, p.a, p.b, null, 0); if (typeof v === 'string') o.pattern = v; } }
        else if (m.key === 'regex' && !m.nested) { /* a path to a regex: not readable */ }
        else if (m.key === 'example') { /* examples are not part of the reading */ }
      });
    });
    return o;
  };
  function renameCase(name, rule, variant) {
    if (typeof rule !== 'string') return name;
    const words = variant ? name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split('_').filter(Boolean) : name.split('_').filter(Boolean);
    const lw = words.map((w) => w.toLowerCase());
    switch (rule) {
      case 'lowercase': return variant ? name.toLowerCase() : name.toLowerCase();
      case 'UPPERCASE': return name.toUpperCase();
      case 'PascalCase': return lw.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      case 'camelCase': return lw.map((w, k) => (k ? w[0].toUpperCase() + w.slice(1) : w)).join('');
      case 'snake_case': return lw.join('_');
      case 'SCREAMING_SNAKE_CASE': return lw.join('_').toUpperCase();
      case 'kebab-case': return lw.join('-');
      case 'SCREAMING-KEBAB-CASE': return lw.join('-').toUpperCase();
      default: return name;
    }
  }
  // The schema of a struct or enum definition (its fields, docs and attributes).
  Repo.prototype.defSchema = function (d, ctx, depth, isRoot) {
    this.step();
    const f = d.f; const cont = this.serdeOf(d.attrs, f);
    const doc = docText(d.docs);
    let s;
    if (d.kind === 'struct') {
      s = this.fieldsSchema(d.fields, f, ctx, depth, cont);
      if (cont.deny) s.additionalProperties = false;
    } else if (d.kind === 'enum') s = this.enumSchema(d, ctx, depth, cont);
    else if (d.kind === 'tuple') s = d.items.length === 1 ? this.typeSchema(d.items[0], f, ctx, depth + 1) : { type: 'array', prefixItems: d.items.map((x) => this.typeSchema(x, f, ctx, depth + 1)) };
    else s = { type: 'null' };
    if (s === true) s = {};
    s = Object.assign({}, s);
    if (ctx.dialect === 'schemars') { if (isRoot) s = Object.assign({ title: cont.title || d.name }, s); if (doc && !cont.description) s.description = doc; }
    if (typeof cont.description === 'string') s.description = cont.description;
    return s;
  };
  Repo.prototype.fieldsSchema = function (fields, f, ctx, depth, cont) {
    const props = {}; const required = [];
    const add = (fl, flatDepth) => {
      const a = this.serdeOf(fl.attrs, f);
      if (a.skip) return;
      if (a.flatten) {
        const seg = lastSeg(fl.type); const d = seg && this.typeDef(seg.name, f);
        if (d && d.kind === 'struct' && flatDepth < 4) { const inner = this.serdeOf(d.attrs, d.f); d.fields.forEach((x) => add(Object.assign({}, x, { __f: d.f, __cont: inner }), flatDepth + 1)); return; }
        ctx.unknownTypes++; return;
      }
      const ff = fl.__f || f; const cc = fl.__cont || cont;
      const name = typeof a.rename === 'string' ? a.rename : renameCase(fl.name.replace(/^r#/, ''), cc.rename_all, false);
      let ty = fl.type;
      if (a.with && ctx.dialect === 'schemars') { ty = { k: 'path', segs: a.with.split('::').map((x) => ({ name: x.replace(/<.*$/, ''), args: [] })) }; }
      let sch = a.schemaWith ? (ctx.unknownTypes++, {}) : this.typeSchema(ty, ff, ctx, depth + 1);
      const isOpt = lastSeg(fl.type) && lastSeg(fl.type).name === 'Option';
      const desc = typeof a.description === 'string' ? a.description : docText(fl.docs || []);
      if (sch === true) sch = desc ? { description: desc } : true;
      else {
        sch = Object.assign({}, sch);
        if (desc) { if (sch.$ref && ctx.dialect === 'schemars') sch = Object.assign({ description: desc }, sch); else sch.description = desc; }
        if (typeof a.title === 'string') sch.title = a.title;
        if (a.length) { if (a.length.min !== undefined) sch[sch.type === 'array' || (Array.isArray(sch.type) && sch.type.includes('array')) ? 'minItems' : 'minLength'] = a.length.min; if (a.length.max !== undefined) sch[sch.type === 'array' || (Array.isArray(sch.type) && sch.type.includes('array')) ? 'maxItems' : 'maxLength'] = a.length.max; }
        if (a.range) { if (a.range.min !== undefined) sch.minimum = a.range.min; if (a.range.max !== undefined) sch.maximum = a.range.max; }
        if (a.pattern) sch.pattern = a.pattern;
      }
      if (name in props) return;
      props[name] = sch;
      const req = ctx.output ? !a.skipSer : (a.required || (!isOpt && !a.default && !cc.default));
      if (req) required.push(name);
    };
    fields.forEach((x) => add(x, 0));
    const s = { type: 'object', properties: props };
    if (required.length || ctx.dialect !== 'schemars') s.required = required;
    if (!required.length && ctx.dialect === 'schemars') delete s.required;
    return s;
  };
  Repo.prototype.enumSchema = function (d, ctx, depth, cont) {
    const f = d.f;
    const names = d.variants.filter((v) => !this.serdeOf(v.attrs, f).skip).map((v) => { const a = this.serdeOf(v.attrs, f); return { v, name: typeof a.rename === 'string' ? a.rename : renameCase(v.name, cont.rename_all, true), doc: docText(v.docs), a }; });
    if (names.every((x) => x.v.kind === 'unit') && !cont.tag && !cont.untagged) {
      if (ctx.dialect === 'schemars' && names.some((x) => x.doc)) return { oneOf: names.map((x) => Object.assign({ type: 'string', const: x.name }, x.doc ? { description: x.doc } : {})) };
      return { type: 'string', enum: names.map((x) => x.name) };
    }
    const variant = (x) => {
      if (x.v.kind === 'unit') return { type: 'string', const: x.name };
      const inner = x.v.kind === 'struct' ? this.fieldsSchema(x.v.fields, f, ctx, depth + 1, {}) : x.v.items.length === 1 ? this.typeSchema(x.v.items[0], f, ctx, depth + 1) : { type: 'array', prefixItems: x.v.items.map((y) => this.typeSchema(y, f, ctx, depth + 1)) };
      if (cont.untagged) return inner;
      if (typeof cont.tag === 'string') { const o = Object.assign({}, inner && typeof inner === 'object' ? inner : {}); o.type = 'object'; o.properties = Object.assign({ [cont.tag]: { type: 'string', const: x.name } }, o.properties || {}); o.required = [cont.tag].concat(o.required || []); return o; }
      return { type: 'object', properties: { [x.name]: inner }, required: [x.name], additionalProperties: false };
    };
    return cont.untagged ? { anyOf: names.map(variant) } : { oneOf: names.map(variant) };
  };

  // ------------------------------------------------------------ tools
  function newTool() { return { name: undefined, title: undefined, description: undefined, input: undefined, output: undefined, annotations: undefined, unreadable: new Set(), lost: [] }; }
  function finish(st) {
    const tool = { name: st.name };
    if (typeof st.title === 'string' && st.title) tool.title = st.title;
    if (typeof st.description === 'string' && st.description) tool.description = st.description;
    tool.inputSchema = st.input && typeof st.input === 'object' ? st.input : { type: 'object', properties: {} };
    // nested past what a list may hold: unreadable here, rather than the whole list refused by the list limit
    if (tooDeep(tool.inputSchema, MAX_JSON_DEPTH) || hasTooDeep(tool.inputSchema)) { st.lost.push(...stringsOf(tool.inputSchema)); tool.inputSchema = { type: 'object', properties: {} }; st.unreadable.add('inputSchema'); }
    if (st.output && typeof st.output === 'object' && !tooDeep(st.output, MAX_JSON_DEPTH) && !hasTooDeep(st.output)) tool.outputSchema = st.output;
    if (st.annotations && hasTooDeep(st.annotations)) { st.unreadable.add('annotations'); st.annotations = undefined; }
    if (st.annotations && typeof st.annotations === 'object' && Object.keys(st.annotations).length) tool.annotations = st.annotations;
    const un = Array.from(st.unreadable); if (un.length) tool._unreadable = un;
    const lost = st.lost.filter((x) => typeof x === 'string' && x.trim()); if (lost.length) tool._lost = lost;
    return tool;
  }
  const strOf = (v, st, part) => {
    if (typeof v === 'string') return v;
    if (v === undefined || v === null) return undefined;
    if (isUnk(v)) { st.lost.push(...v.lost); if (part) st.unreadable.add(part); return part === 'description' && v.lost.length ? v.lost.join(' … ').slice(0, MAX_STR) : undefined; }
    if (part) st.unreadable.add(part);
    return undefined;
  };
  // A tool written as JSON (json!({ "name": …, "inputSchema": { … } }), the evaluated value) as the reader's tool record.
  function jsonTool(v) {
    const st = newTool(); st.name = v.name;
    if ('description' in v) st.description = strOf(v.description, st, 'description');
    if ('title' in v) st.title = strOf(v.title, st, null);
    const c = { unk: false, lost: [] }; const j = toJson(v.inputSchema, c); st.lost.push(...c.lost);
    if (j && typeof j === 'object' && (!c.unk || (j.properties && Object.keys(j.properties).length))) st.input = j; else st.unreadable.add('inputSchema');
    if (v.annotations !== undefined) { const c2 = { unk: false, lost: [] }; const a2 = toJson(v.annotations, c2); if (a2 && typeof a2 === 'object') st.annotations = a2; if (c2.unk) st.unreadable.add('annotations'); }
    if (v.outputSchema !== undefined) { const c3 = { unk: false, lost: [] }; const o = toJson(v.outputSchema, c3); if (o && typeof o === 'object' && !c3.unk) st.output = o; }
    return st;
  }
  // rmcp: #[tool(…)] on a function.
  Repo.prototype.rmcpTool = function (fn, at) {
    const f = fn.f; const st = newTool(); const ms = at.form === 'list' ? metaList(f, at.a, at.b) : [];
    const env = { selfName: fn.impl && fn.impl.selfName };
    const val = (m) => this.ev(f, m.a, m.b, env, 0);
    const nm = meta(ms, 'name'); st.name = nm ? val(nm) : fn.name.replace(/^r#/, '');
    // a description given as the first plain argument (#[tool("…")], as some crates write it) counts like description = …
    const ds = meta(ms, 'description') || ms.find((m) => m.bare && f.t[m.a] && f.t[m.a].y === 'str' && m.b === m.a + 1);
    if (ds) st.description = strOf(val(ds), st, 'description');
    else { const doc = rmcpDoc(fn.docs, fn.attrs, f); if (doc !== null) st.description = doc; }
    const ti = meta(ms, 'title'); if (ti) st.title = strOf(val(ti), st, null);
    const an = meta(ms, 'annotations');
    if (an && an.nested) {
      const map = { title: 'title', read_only_hint: 'readOnlyHint', destructive_hint: 'destructiveHint', idempotent_hint: 'idempotentHint', open_world_hint: 'openWorldHint' };
      st.annotations = {};
      an.nested.forEach((x) => { const v = this.ev(f, x.a, x.b, env, 0); if (!map[x.key]) return; if (typeof v === 'boolean' || typeof v === 'string') st.annotations[map[x.key]] = v; else { st.unreadable.add('annotations'); if (isUnk(v)) st.lost.push(...v.lost); } });
    } else if (an) { const c = { unk: false, lost: [] }; const v = toJson(val(an), c); if (v && typeof v === 'object' && !c.unk) st.annotations = v; else st.unreadable.add('annotations'); st.lost.push(...c.lost); }
    // the input schema
    const is = meta(ms, 'input_schema');
    if (is) { const c = { unk: false, lost: [] }; const v = toJson(val(is), c); if (v && typeof v === 'object' && !c.unk) st.input = v; else st.unreadable.add('inputSchema'); st.lost.push(...c.lost); }
    else {
      const ps = fn.params.filter((p) => !p.self);
      const pr = ps.find((p) => { const s = lastSeg(p.type); return s && s.name === 'Parameters'; });
      const aggr = ps.find((p) => p.attrs.some((x) => x.path === 'tool' && /\baggr\b/.test(f.text.slice(f.t[x.a] ? f.t[x.a].s : 0, f.t[x.b] ? f.t[x.b].s : 0))));
      const params = ps.filter((p) => p.attrs.some((x) => x.path === 'tool' && /\bparam\b/.test(f.text.slice(f.t[x.a] ? f.t[x.a].s : 0, f.t[x.b] ? f.t[x.b].s : 0))));
      if (pr || aggr) {
        const ty = pr ? lastSeg(pr.type).args[0] : aggr.type;
        const s = ty ? this.schemaValue(ty, f, { dialect: 'schemars' }) : UNK();
        if (s && s.__schema) st.input = s.schema; else st.unreadable.add('inputSchema');
      } else if (params.length || this.plainArgs(fn)) {
        // the older #[tool(param)] arguments (or plain arguments, in crates other than rmcp): one property each
        const ctx = { dialect: 'schemars', defs: {}, seen: new Set(), unknownTypes: 0 };
        const props = {}; const required = [];
        (params.length ? params : this.plainArgs(fn)).forEach((p) => {
          const a = this.serdeOf(p.attrs, f); let sch = this.typeSchema(p.type, f, ctx, 0); sch = sch === true ? {} : Object.assign({}, sch);
          if (typeof a.description !== 'string') { const d = docText(p.docs || []); if (d) a.description = d; }
          if (typeof a.description === 'string') sch.description = a.description;
          const name = p.name || (p.pat && p.pat[0]); if (!name) return;
          props[name] = sch; if (!(lastSeg(p.type) && lastSeg(p.type).name === 'Option')) required.push(name);
        });
        st.input = { type: 'object', properties: props }; if (required.length) st.input.required = required;
        if (Object.keys(ctx.defs).length) st.input.$defs = ctx.defs;
      } else st.input = { type: 'object', properties: {} };
    }
    // the output schema: Json<T> or Result<Json<T>, E>
    const os = meta(ms, 'output_schema');
    if (os) { const c = { unk: false, lost: [] }; const v = toJson(val(os), c); if (v && typeof v === 'object' && !c.unk) st.output = v; }
    else if (fn.ret) {
      let r = fn.ret; const rs = lastSeg(r); if (rs && rs.name === 'Result' && rs.args.length) r = rs.args[0];
      const js = lastSeg(r);
      if (js && js.name === 'Json' && js.args.length === 1) { const s = this.schemaValue(js.args[0], f, { dialect: 'schemars', output: true }); if (s && s.__schema) st.output = s.schema; }
    }
    return st;
  };
  // A #[tool] function's plain arguments, as crates other than rmcp take them (fn add(a: i32, b: i32)); null in an
  // rmcp crate (where plain arguments are extractors such as RequestContext) or when an argument is an extractor.
  const EXTRACTOR = /^(RequestContext|Peer|Extension|Meta|CancellationToken|Context|RequestHandlerExtra|State|Arc|ServerContext|ToolContext|Session)$/;
  Repo.prototype.plainArgs = function (fn) {
    const crate = this.crateOf(fn.f.path);
    if (crate && /^[ \t]*rmcp\s*=|^[ \t]*rmcp\s*\.|"rmcp"/m.test(crate.text)) return null;
    const ps = fn.params.filter((p) => !p.self && p.name);
    if (!ps.length || ps.some((p) => { const s0 = lastSeg(p.type); return !s0 || EXTRACTOR.test(s0.name); })) return null;
    return ps;
  };
  // rust-mcp-sdk: #[mcp_tool(…)] on a struct; its fields are the input schema.
  Repo.prototype.mcpTool = function (d, at) {
    const f = d.f; const st = newTool(); const ms = metaList(f, at.a, at.b);
    const val = (m) => this.ev(f, m.a, m.b, null, 0);
    const nm = meta(ms, 'name'); st.name = nm ? val(nm) : UNK();
    const ds = meta(ms, 'description'); if (ds) st.description = strOf(val(ds), st, 'description');
    const ti = meta(ms, 'title'); if (ti) st.title = strOf(val(ti), st, null);
    const map = { destructive_hint: 'destructiveHint', idempotent_hint: 'idempotentHint', open_world_hint: 'openWorldHint', read_only_hint: 'readOnlyHint' };
    Object.keys(map).forEach((k) => { const m = meta(ms, k); if (!m) return; const v = val(m); st.annotations = st.annotations || {}; if (typeof v === 'boolean') st.annotations[map[k]] = v; else st.unreadable.add('annotations'); });
    if (d.kind === 'struct') { const ctx = { dialect: 'rmcp-sdk', defs: {}, seen: new Set([d.name]), unknownTypes: 0 }; st.input = this.fieldsSchema(d.fields, f, ctx, 0, this.serdeOf(d.attrs, f)); }
    else if (d.kind === 'unit') st.input = { type: 'object', properties: {}, required: [] };
    else st.unreadable.add('inputSchema');
    return st;
  };
  // rmcp ToolBase: the trait's functions, the schema of its Parameter type (its Output for the output schema).
  Repo.prototype.toolBase = function (f, im) {
    const st = newTool(); const env = { selfName: im.selfName };
    const fns = f.items.fns.filter((d) => d.impl === im);
    const val = (n) => { const d = fns.find((x) => x.name === n); if (!d || !d.body) return undefined; const r = this.singleReturn(d); return r ? this.ev(f, r[0], r[1], { selfName: im.selfName, locals: this.localsOf(d, {}), vars: {} }, 0) : UNK(); };
    void env;
    st.name = val('name');
    const d = val('description'); if (d !== undefined && d !== null) st.description = strOf(d, st, 'description');
    const ti = val('title'); if (typeof ti === 'string') st.title = ti;
    const an = val('annotations');
    if (an !== undefined && an !== null) { const c = { unk: false, lost: [] }; const a = toJson(an, c); if (a && typeof a === 'object') st.annotations = a; if (c.unk) st.unreadable.add('annotations'); st.lost.push(...c.lost); }
    const alias = (n) => f.items.aliases.find((x) => x.owner === im && x.name === n);
    const is = val('input_schema');
    if (is !== undefined) { const c = { unk: false, lost: [] }; const j = toJson(is, c); if (j && typeof j === 'object' && !c.unk) st.input = j; else st.unreadable.add('inputSchema'); }
    else { const p = alias('Parameter'); const sv = p ? this.schemaValue(p.type, f, { dialect: 'schemars' }) : UNK(); if (sv && sv.__schema) st.input = sv.schema; else st.unreadable.add('inputSchema'); }
    const os = val('output_schema');
    if (os === undefined) { const o = alias('Output'); const sv = o ? this.schemaValue(o.type, f, { dialect: 'schemars', output: true }) : null; if (sv && sv.__schema && sv.schema.type === 'object') st.output = sv.schema; }
    else if (os !== null) { const c = { unk: false, lost: [] }; const j = toJson(os, c); if (j && typeof j === 'object' && !c.unk) st.output = j; }
    return st;
  };
  Repo.prototype.traitTool = function (f, im, fns) {
    const st = newTool();
    const val = (re) => { const d = fns.find((x) => re.test(x.name)); if (!d || !d.body) return undefined; const r = this.singleReturn(d); return r ? this.ev(f, r[0], r[1], { selfName: im.selfName, locals: this.localsOf(d, {}), vars: {} }, 0) : UNK(); };
    st.name = val(/^name$/);
    if (st.name === undefined || st.name === null) return null;
    const d = val(/^(description|desc)$/); if (d !== undefined && d !== null) st.description = strOf(d, st, 'description'); else st.unreadable.add('description');
    const ti = val(/^title$/); if (typeof ti === 'string') st.title = ti;
    const is = val(/^(input_schema|schema|parameters|parameters_schema|params_schema|args_schema|input)$/);
    if (is !== undefined) { const c = { unk: false, lost: [] }; const j = toJson(is, c); st.lost.push(...c.lost); if (j && typeof j === 'object' && (!c.unk || (j.properties && Object.keys(j.properties).length))) st.input = j; else st.unreadable.add('inputSchema'); }
    else st.unreadable.add('inputSchema');
    const an = val(/^annotations$/);
    if (an !== undefined && an !== null) { const c = { unk: false, lost: [] }; const a = toJson(an, c); if (a && typeof a === 'object') st.annotations = a; if (c.unk) st.unreadable.add('annotations'); }
    return st;
  };
  // pmcp: the handler given to .tool("name", handler): a type with `impl ToolHandler for X { fn metadata() … }`, or a
  // TypedTool / SimpleTool built in place. null when it is neither (another builder's .tool()).
  Repo.prototype.pmcpTool = function (f, range, env) {
    const t = f.t; const [a, b] = range;
    let segs = []; let k = a; while (k < b && isId(t[k])) { segs.push(t[k].v); if (isP(t[k + 1], '::')) k += 2; else { k++; break; } }
    if (segs.length && (k >= b || isP(t[k], '{') || isP(t[k], '(')) && /^[A-Z]/.test(segs[segs.length - 1]) && !/^(TypedTool|SimpleTool|TypedToolWithOutput|TypedSyncTool)$/.test(segs[segs.length - 2] || '')) {
      const typeName = segs[segs.length - 1];
      for (const g of this.files) {
        const im = g.items.impls.find((x) => x.trait === 'ToolHandler' && x.selfName === typeName); if (!im) continue;
        const md = g.items.fns.find((x) => x.impl === im && x.name === 'metadata');
        const st = newTool();
        if (!md || !md.body) { st.unreadable.add('inputSchema'); st.unreadable.add('description'); return st; }
        const r = this.singleReturn(md); const v = r ? this.ev(g, r[0], r[1], { selfName: typeName, locals: this.localsOf(md, {}), vars: {} }, 0) : UNK();
        if (v && v.__tool) { const h = this.handTool(v); h.name = undefined; return h; }
        st.unreadable.add('inputSchema'); st.unreadable.add('description'); if (isUnk(v)) st.lost.push(...v.lost); return st;
      }
      return null;
    }
    const v = this.ev(f, a, b, env, 0);
    if (v && v.__tool) { const h = this.handTool(v); h.name = undefined; return h; }
    return null;
  };
  // Tool::new(…) / Tool { … } built by hand.
  Repo.prototype.handTool = function (v) {
    const st = newTool();
    if (v.__tool) {
      st.name = v.name; st.description = strOf(v.description, st, 'description');
      const c = { unk: false, lost: [] }; const j = toJson(v.input, c); st.lost.push(...c.lost);
      if (j && typeof j === 'object' && (!c.unk || (j.properties && Object.keys(j.properties).length))) st.input = j; else st.unreadable.add('inputSchema');
      if (v.title !== undefined) st.title = strOf(v.title, st, null);
      if (v.annotations !== undefined) { const c2 = { unk: false, lost: [] }; const a = toJson(v.annotations, c2); if (a && typeof a === 'object') st.annotations = a; if (c2.unk) st.unreadable.add('annotations'); }
      if (v.output !== undefined) { const c3 = { unk: false, lost: [] }; const o = toJson(v.output, c3); if (o && typeof o === 'object' && !c3.unk) st.output = o; }
      return st;
    }
    const F = v.f;
    st.name = F.name;
    if ('description' in F) st.description = strOf(F.description, st, 'description');
    if ('title' in F) st.title = strOf(F.title, st, null);
    const sk = 'input_schema' in F ? 'input_schema' : 'inputSchema' in F ? 'inputSchema' : null;
    if (sk) {
      const val = F[sk];
      const c = { unk: false, lost: [] }; let j;
      if (val && val.__struct && val.name === 'ToolInputSchema') j = toolInputSchema(val, c); else j = toJson(val, c);
      st.lost.push(...c.lost);
      if (j && typeof j === 'object' && (!c.unk || (j.properties && Object.keys(j.properties).length))) st.input = j; else st.unreadable.add('inputSchema');
    } else st.unreadable.add('inputSchema');
    if ('annotations' in F && F.annotations !== null) { const c2 = { unk: false, lost: [] }; const a = toJson(F.annotations, c2); if (a && typeof a === 'object') st.annotations = a; if (c2.unk) st.unreadable.add('annotations'); }
    if ('output_schema' in F && F.output_schema !== null) { const c3 = { unk: false, lost: [] }; const o = toJson(F.output_schema, c3); if (o && typeof o === 'object' && !c3.unk) st.output = o; }
    return st;
  };
  function toolInputSchema(v, c) { const o = { type: 'object' }; const p = toJson(v.f.properties, c); if (p && typeof p === 'object') o.properties = p; const r = toJson(v.f.required, c); if (Array.isArray(r)) o.required = r; return o; }
  function rmcpDoc(docs, attrs, f) {
    const lines = []; let any = false;
    docs.forEach((d) => d.split('\n').forEach((l) => { any = true; const x = l.trim(); if (x) lines.push(x); }));
    attrs.forEach((a) => { if (a.path === 'doc' && a.form === 'value') { const tk = f.t[a.a]; if (tk && tk.y === 'str') { any = true; const x = tk.v.trim(); if (x) lines.push(x); } } });
    return any && lines.length ? lines.join('\n') : null;
  }

  // Tool objects inside a string literal that holds JSON (r#"{"tools": [{"name": …, "inputSchema": …}]}"#).
  function jsonStringTools(f, skip, push, mk) {
    f.t.forEach((x, k) => {
      if (x.y !== 'str' || x.v.length < 20 || x.v.length > 4 * 1024 * 1024 || x.v.indexOf('"inputSchema"') < 0) return;
      if (skip.some(([a, b]) => a <= k && k <= b)) return;
      let d; try { d = JSON.parse(x.v); } catch (e) { return; }
      const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 64) return;
        if (Array.isArray(v)) { v.forEach((y) => walk(y, depth + 1)); return; }
        if (typeof v.name === 'string' && v.inputSchema && typeof v.inputSchema === 'object') {
          const st = mk(); st.name = v.name;
          if (typeof v.description === 'string') st.description = v.description;
          if (typeof v.title === 'string') st.title = v.title;
          st.input = v.inputSchema; if (v.outputSchema && typeof v.outputSchema === 'object') st.output = v.outputSchema;
          if (v.annotations && typeof v.annotations === 'object') st.annotations = v.annotations;
          push(st, x.s); return;
        }
        Object.keys(v).forEach((key) => walk(v[key], depth + 1));
      };
      walk(d, 0);
    });
  }
  // The innermost function whose body holds token k (bodies sorted once per file; nested ones are rare and short).
  function fnAt(f, k) {
    if (!f.__fnIx) f.__fnIx = f.items.fns.filter((d) => d.body).sort((a, b) => a.body[0] - b.body[0]);
    const xs = f.__fnIx; let lo = 0; let hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid].body[0] < k) lo = mid + 1; else hi = mid; }
    for (let q = lo - 1, n = 0; q >= 0 && n < 8; q--, n++) if (xs[q].body[1] > k) return xs[q];
    return null;
  }
  // ------------------------------------------------------------ the whole repository
  Repo.prototype.run = function () {
    const found = []; const unresolved = []; const overBudget = []; const wrappers = new Set();
    (this.macroUnresolved || []).forEach((u) => unresolved.push({ path: u.path, line: u.line, lost: u.lost }));
    if (this.macroOver) overBudget.push({ path: this.macroOver.path, line: this.macroOver.line, why: 'more than ' + MAX_EXPANSIONS + ' macro expansions' });
    const push = (st, f, s, item, kind) => {
      const line = lineAt(f, s);
      if (typeof st.name !== 'string' || !st.name) {
        const u = { path: f.path, line }; if (typeof st.description === 'string') u.description = st.description; if (typeof st.title === 'string') u.title = st.title;
        const lost = st.lost.concat(isUnk(st.name) ? st.name.lost : []); if (lost.length) u.lost = lost.slice(0, 200);
        unresolved.push(u); return;
      }
      const marks = [];
      if (item) {
        const cs = this.cfgState(item);
        if (cs.excluded) marks.push({ reason: 'cfg-feature', detail: cs.conds.join(' && ').slice(0, 120), exclude: true });
        else if (cs.conds.length) marks.push({ reason: 'conditional-cfg', detail: cs.conds.join(' && ').slice(0, 120), exclude: false });
      }
      found.push({ path: f.path, line, tool: finish(st), fidelity: 'derived', literal: kind === 'hand', marks, language: 'Rust' });
    };
    this.files.forEach((f) => {
      if (f.failed) return;
      try {
        // rmcp #[tool] methods and functions
        f.items.fns.forEach((fn) => {
          const at = fn.attrs.find((a) => a.path === 'tool' && !(a.form === 'list' && /^\s*tool_box\b/.test(f.text.slice(f.t[a.a] ? f.t[a.a].s : 0))));
          if (!at) return;
          try { push(this.rmcpTool(fn, at), f, f.t[fn.s].s, fn, 'rmcp'); } catch (e) { if (e instanceof OverBudget) throw e; unresolved.push({ path: f.path, line: lineAt(f, f.t[fn.s].s) }); }
        });
        // rust-mcp-sdk #[mcp_tool] structs
        f.items.types.forEach((d) => {
          const at = d.attrs.find((a) => a.path === 'mcp_tool' && a.form === 'list'); if (!at) return;
          try { push(this.mcpTool(d, at), f, f.t[d.s].s, d, 'sdk'); } catch (e) { if (e instanceof OverBudget) throw e; unresolved.push({ path: f.path, line: lineAt(f, f.t[d.s].s) }); }
        });
        // rmcp's trait tools: impl ToolBase for X { type Parameter = P; fn name() … fn description() … }
        f.items.impls.filter((im) => im.trait === 'ToolBase').forEach((im) => {
          try { push(this.toolBase(f, im), f, f.t[im.s].s, im, 'rmcp'); } catch (e) { if (e instanceof OverBudget) throw e; unresolved.push({ path: f.path, line: lineAt(f, f.t[im.s].s) }); }
        });
        // a trait of the repository's own for tools: impl SomeTool for X { fn name() -> … "x" … fn description() …
        // fn input_schema() … } (the registry that lists them is read through the impls)
        f.items.impls.filter((im) => im.trait && /Tool/.test(im.trait) && !/^(ToolBase|ToolHandler)$/.test(im.trait) && !/^(Into|From|TryFrom|AsRef|Display|Debug|Default|Clone)$/.test(im.trait)).forEach((im) => {
          const fns = f.items.fns.filter((d) => d.impl === im);
          if (!fns.some((d) => d.name === 'name')) return;
          try { const st = this.traitTool(f, im, fns); if (st) push(st, f, f.t[im.s].s, im, 'hand'); } catch (e) { if (e instanceof OverBudget) throw e; unresolved.push({ path: f.path, line: lineAt(f, f.t[im.s].s) }); }
        });
        // pmcp: Server::builder().tool("name", Handler) (a ToolHandler with metadata(), or TypedTool / SimpleTool)
        for (let k = 1; k < f.t.length - 3; k++) {
          if (!(isP(f.t[k - 1], '.') && isId(f.t[k], 'tool') && isP(f.t[k + 1], '(') && f.t[k + 2] && (f.t[k + 2].y === 'str' || isId(f.t[k + 2])))) continue;
          const c = f.close[k + 1]; if (c < 0) continue;
          const xs = splitTop(f, k + 2, c, false); if (xs.length !== 2) continue;
          if (f.items.skip.some(([a, b]) => a <= k && k <= b)) continue;
          const fn = fnAt(f, k); const env = fn ? { selfName: fn.impl && fn.impl.selfName, locals: this.localsOf(fn, {}), vars: {} } : null;
          const nm = this.ev(f, xs[0][0], xs[0][1], env, 0);
          if (typeof nm !== 'string' && !isUnk(nm)) continue;
          const st = this.pmcpTool(f, xs[1], env);
          if (!st) continue;
          st.name = nm;
          push(st, f, f.t[k].s, fn || null, 'pmcp');
        }
        // tools written as JSON: json!({ "name": …, "inputSchema": { … } }) (a hand-written tools/list answer)
        const t = f.t;
        jsonStringTools(f, f.items.skip, (st, s0) => push(st, f, s0, null, 'hand'), newTool);
        const skipJ = f.items.skip;
        if (f.text.indexOf('inputSchema') >= 0) {
          const stack = [];
          for (let k = 0; k < t.length; k++) {
            const x = t[k];
            if (x.y === 'p' && (x.v === '{' || x.v === '(' || x.v === '[')) { stack.push(k); continue; }
            if (x.y === 'p' && (x.v === '}' || x.v === ')' || x.v === ']')) { stack.pop(); continue; }
            if (x.y !== 'str' || x.v !== 'inputSchema' || !isP(t[k + 1], ':') || !stack.length) continue;
            const open = stack[stack.length - 1]; if (!isP(t[open], '{')) continue;
            if (skipJ.some(([a, b]) => a <= open && open <= b)) continue;
            // inside a json! macro?
            let inJson = false; for (let q = stack.length - 1; q >= 0; q--) { const o = stack[q]; if (isP(t[o - 1], '!') && isId(t[o - 2], 'json')) { inJson = true; break; } }
            if (!inJson) continue;
            const fn = fnAt(f, open);
            const env = fn ? { selfName: fn.impl && fn.impl.selfName, vars: {} } : null;
            // the function's parameters: a tool whose name is one is built by a helper, read where it is called (R-RD-03)
            if (fn) { fn.params.filter((p) => !p.self && p.name).forEach((p) => { env.vars[p.name] = PARAM(fn, p.name); }); env.locals = this.localsOf(fn, env.vars); }
            let v; try { v = this.json(f, open, f.close[open] + 1, env, 0); } catch (e) { if (e instanceof OverBudget) throw e; v = UNK(); }
            if (!isPlain(v)) continue;
            if (fn && isParamOf(v.name, fn)) { wrappers.add(fn.name); continue; }
            push(jsonTool(v), f, t[open].s, fn || null, 'hand');
          }
        }
        // Tool::new(…) and Tool { name, … } by hand, in function bodies and constants
        const inFn = (k) => fnAt(f, k);
        const skip = f.items.skip.slice().sort((x, y) => x[0] - y[0]); let si = 0;
        for (let k = 0; k < t.length - 2; k++) {
          while (si < skip.length && skip[si][1] < k) si++;
          if (si < skip.length && skip[si][0] <= k) { k = skip[si][1]; continue; } // #[cfg(test)] code
          const shaped = t[k].y === 'id' && t[k].v !== 'Tool' && this.toolShaped().has(t[k].v);
          if (!isId(t[k], 'Tool') && !shaped) continue;
          const isNew = isP(t[k + 1], '::') && isId(t[k + 2]) && (shaped ? !isP(t[k - 1], '::') : /^(new|new_with_raw)$/.test(t[k + 2].v)) && isP(t[k + 3], '(') && !isId(t[k - 1], 'fn') && !(fnAt(f, k) && fnAt(f, k).impl && fnAt(f, k).impl.selfName === t[k].v);
          const isLit = isP(t[k + 1], '{') && f.close[k + 1] > 0 && !isId(t[k - 1], 'struct') && !isId(t[k - 1], 'for') && !isId(t[k - 1], 'impl') && splitTop(f, k + 2, f.close[k + 1], false).some(([p]) => isId(t[p], 'name') && isP(t[p + 1], ':'));
          if (!isNew && !isLit) continue;
          const fn = inFn(k);
          if (fn && fn.attrs.some((a) => a.path === 'test')) continue;
          // the expression from Tool to the end of its call/literal (and chained builder calls)
          let e = isNew ? f.close[k + 3] + 1 : f.close[k + 1] + 1;
          while (isP(t[e], '.') && isId(t[e + 1]) && (isP(t[e + 2], '(') || (isP(t[e + 2], '::') && isP(t[e + 3], '<')))) { let q = e + 2; if (isP(t[q], '::')) q = angleEnd(t, q + 1) + 1; if (!isP(t[q], '(') || f.close[q] < 0) break; e = f.close[q] + 1; }
          let start = k; while (start > 0 && isP(t[start - 1], '::') && isId(t[start - 2])) start -= 2;
          const env = fn ? { selfName: fn.impl && fn.impl.selfName, vars: {} } : null;
          if (fn) { fn.params.filter((p) => !p.self && p.name).forEach((p) => { env.vars[p.name] = PARAM(fn, p.name); }); env.locals = this.localsOf(fn, env.vars); }
          let v;
          try { v = this.ev(f, start, e, env, 0); } catch (x) { if (x instanceof OverBudget) throw x; v = UNK(); }
          if (!v || (!v.__tool && !v.__struct)) { unresolved.push({ path: f.path, line: lineAt(f, t[k].s), lost: literalsIn(f, k, e).slice(0, 200) }); k = e - 1; continue; }
          const nm = v.__tool ? v.name : v.f.name;
          if (fn && isParamOf(nm, fn)) { wrappers.add(fn.name); k = e - 1; continue; } // a helper: read where it is called
          // a method building the tool from a field that holds a variant of an enum the repository iterates
          // (#[derive(EnumIter)]): one tool per variant
          let each = fn && fn.impl && (nm === undefined || isUnk(nm)) ? this.enumFieldExpansion(f, start, e, fn, env) : null;
          // inside .map(|x| …) over a known list, or for x in LIST { … }: one tool per element
          if (!each && fn && (nm === undefined || isUnk(nm))) each = this.loopExpansion(f, start, e, fn, env);
          if (each) { each.forEach((w) => { const s2 = w.__struct ? this.shapedStruct(w) : w; push(this.handTool(s2), f, t[k].s, fn, 'hand'); }); k = e - 1; continue; }
          if (shaped && v.__struct) v = this.shapedStruct(v);
          push(this.handTool(v), f, t[k].s, fn || null, 'hand');
          k = (isNew ? k + 3 : k + 1);
        }
      } catch (e) { if (e instanceof OverBudget) { overBudget.push({ path: f.path, line: null, why: WHY_WORK }); return; } throw e; }
    });
    // helpers that build a tool from their parameters (fn tool(name: &str, …) -> Tool { Tool::new(name, …) }): each call
    // is a tool; a caller that passes its own parameter on is a helper too (a few levels)
    const done = new Set(); let next = new Set(); const pending = new Map(); // helper name -> its calls that pass a parameter on
    const called = new Set(); // helpers with a call the reader looked at
    for (let round = 0; round < MAX_HELPER_ROUNDS && wrappers.size && !overBudget.length; round++) {
      next = new Set();
      this.files.forEach((f) => {
        if (f.failed) return;
        const t = f.t; const skip = f.items.skip;
        for (let k = 1; k < t.length - 1; k++) {
          if (t[k].y !== 'id' || !wrappers.has(t[k].v) || !isP(t[k + 1], '(') || isId(t[k - 1], 'fn')) continue;
          let ps = k; while (isP(t[ps - 1], '::') && isId(t[ps - 2])) ps -= 2;
          if (isP(t[ps - 1], '[') && (isP(t[ps - 2], '#') || (isP(t[ps - 2], '!') && isP(t[ps - 3], '#')))) continue; // an attribute #[tool(…)]
          const key = f.path + ':' + k; if (done.has(key)) continue;
          if (skip.some(([a, b]) => a <= k && k <= b)) continue;
          const c = f.close[k + 1]; if (c < 0) continue;
          const fn = fnAt(f, k);
          if (fn && fn.name === t[k].v) continue; // recursion
          done.add(key); called.add(t[k].v);
          const env = { selfName: fn && fn.impl && fn.impl.selfName, vars: {} };
          if (fn) { fn.params.filter((p) => !p.self && p.name).forEach((p) => { env.vars[p.name] = PARAM(fn, p.name); }); env.locals = this.localsOf(fn, env.vars); }
          let v; this.depthHit = false;
          try {
            v = this.callPath([t[k].v], null, f, k + 2, c, env, 0);
            let e = c + 1; // builder calls chained on the result
            while (v && v.__tool && isP(t[e], '.') && isId(t[e + 1]) && isP(t[e + 2], '(') && f.close[e + 2] > 0) { v = this.method(v, t[e + 1].v, null, f, e + 3, f.close[e + 2], env, 0); e = f.close[e + 2] + 1; }
          } catch (x) { if (x instanceof OverBudget) { overBudget.push({ path: f.path, line: null, why: WHY_WORK }); return; } v = UNK(); }
          // a call of a helper that gives no tool the reader can read: refused as incomplete when the chain of helpers is
          // longer than followed (the evaluation went too deep); when it passes the enclosing function's parameters on,
          // that function is followed to its callers (the text may come from there); otherwise counted, its text scanned
          // a helper returning json!({ "name": …, "inputSchema": … }) (a hand-written tool, R-RD-03) gives a plain value
          if (isPlain(v) && 'name' in v && 'inputSchema' in v) { /* read below as a JSON tool */ }
          else if (!v || (!v.__tool && !v.__struct)) {
            if (this.depthHit) { overBudget.push({ path: f.path, line: lineAt(f, t[k].s), why: WHY_CHAIN }); return; }
            const passesParams = !!fn && fn.params.some((p) => p.name && !p.self && t.slice(k + 2, c).some((x) => x.y === 'id' && x.v === p.name));
            if (passesParams) { next.add(fn.name); if (!pending.has(fn.name)) pending.set(fn.name, []); pending.get(fn.name).push({ path: f.path, line: lineAt(f, t[k].s), lost: literalsIn(f, k, c).slice(0, 200) }); continue; }
            unresolved.push({ path: f.path, line: lineAt(f, t[k].s), lost: literalsIn(f, k, c).slice(0, 200) }); continue;
          }
          const nm = v.__tool ? v.name : v.__struct ? v.f.name : v.name;
          if (fn && isParamOf(nm, fn)) { next.add(fn.name); if (!pending.has(fn.name)) pending.set(fn.name, []); pending.get(fn.name).push({ path: f.path, line: lineAt(f, t[k].s), lost: literalsIn(f, k, c).slice(0, 200) }); continue; }
          if (found.length + unresolved.length > MAX_RESULTS) { overBudget.push({ path: f.path, line: null, why: WHY_MANY }); return; }
          push(v.__tool || v.__struct ? this.handTool(v) : jsonTool(v), f, t[k].s, fn || null, 'hand');
        }
      });
      next.forEach((n) => wrappers.add(n));
      if (!next.size) break;
    }
    // helpers found in the last round allowed, whose callers were not followed: refused as incomplete
    if (next.size) { const u = (pending.get(Array.from(next)[0]) || [])[0]; overBudget.push({ path: u ? u.path : null, line: u ? u.line : null, why: WHY_CHAIN }); }
    // a function followed to its callers that has none the reader sees (called from code it does not read): the calls
    // in it are counted as unresolved, with their text
    else pending.forEach((calls, name) => { if (!called.has(name)) calls.forEach((u) => unresolved.push(u)); });
    return { found, unresolved, overBudget };
  };

  function analyse(files, opts) {
    let repo;
    try { repo = new Repo(files, opts); const r = repo.run(); r.work = (opts && opts.workBudget || DEFAULT_BUDGET) - repo.work.left; if (r.overBudget.length) { r.found = []; r.unresolved = []; } return r; } catch (e) {
      if (e instanceof OverBudget) return { found: [], unresolved: [], overBudget: [{ path: (files[0] || [''])[0], line: null, why: WHY_WORK }] };
      throw e;
    }
  }
  const TOOL_HINT = /#\[\s*(?:rmcp::)?tool\b|#\[\s*(?:[\w:]*::)?mcp_tool\s*\(|\bTool::new\b|\bTool\s*\{\s*name\s*:|\btool_router\b|\btool_box\b/;
  const CONSTRUCTS = /\bimpl\s+(?:[\w:]*::)?ServerHandler\s+for\b|#\[\s*(?:rmcp::)?tool_handler\b|\bserver_runtime::create_server\b|\bcreate_server\s*\(|\.serve\s*\(\s*(?:stdio|\(\s*stdin)|\bServerHandlerCore\b/;
  function constructsServer(text) { return typeof text === 'string' && CONSTRUCTS.test(text); }
  return { Repo, tokenize, bracketIndex, analyse, constructsServer, TOOL_HINT, cargoDefaults };
});
