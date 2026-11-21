// repo-go: reads the tools of an MCP server written in Go from its source, without running it. Browser and Node.
// Used by repo-source.cjs (RepoSource), which decides which files to read; nothing here touches the network.
//
//   RepoGo.analyse([[path, text]], { goMods: [[path, text]], workBudget }) -> { found, unresolved, overBudget }
//   RepoGo.tokenize(text)                                                -> { t: tokens, dirs: //go: directives }
//
// Read, the way the SDK lists them:
//   mark3labs/mcp-go   mcp.NewTool(name, mcp.WithDescription(…), mcp.WithString(…, mcp.Required(), …), annotations,
//                      WithInputSchema[T](), WithRawInputSchema(…)), mcp.NewToolWithRawSchema, mcp.Tool{…} literals,
//                      and option helpers of the repository (func WithPagination() mcp.ToolOption { … }).
//   go-sdk (official)  mcp.AddTool(server, &mcp.Tool{Name, Description, Annotations: &mcp.ToolAnnotations{…}}, handler),
//                      the input (and output) schema inferred from the handler's input struct, its `json` and
//                      `jsonschema` tags; server.AddTool(&mcp.Tool{…, InputSchema: …}, h) with an explicit schema.
//   metoro mcp-golang  server.RegisterTool("name", "description", func(args T) …), the schema from T's tags.
//   Other Tool{Name, Description, InputSchema, Annotations} literals, and helpers of the repository that build a tool
//   from their parameters (MustTool(name, description, handler, opts…), followed through several levels).
// Never guessed: a tool whose name cannot be read is counted as unresolved (its text is still scanned); a description,
// schema or annotations that cannot be worked out are marked unreadable, with their string literals kept for the
// poisoning checks. Everything here runs in time linear in the input: one tokenizer pass, one bracket pass, parse
// results cached per position, and a work budget over evaluation (over it, the scan is refused as incomplete).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoGo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STR = 64 * 1024;      // a string built from constants is cut here (the rest is kept as lost text)
  const MAX_DEPTH = 80;           // expression and type nesting read; deeper is unreadable
  const MAX_CALL_DEPTH = 8;       // repository functions followed into
  const MAX_HELPER_ROUNDS = 64;   // rounds of helper discovery (functions that build a tool from their parameters); past it, or past MAX_CALL_DEPTH nested calls, the list is refused
  const DEFAULT_BUDGET = 2e6;     // evaluation steps for one repository (the largest servers read take under 0.2e6)
  const MAX_RESULTS = 20000;      // tool definitions read in one repository (more: refused as over the work limit)

  // ------------------------------------------------------------ tokenizer
  // Tokens: { y: 'id' | 'str' | 'num' | 'char' | 'p', v, s (offset), nl (a line break before it) }.
  // Comments are dropped, except //go: directives (build constraints, embed), which are kept with the index of the
  // token that follows them.
  const ID_RE = /[\p{L}_][\p{L}\p{N}_]*/uy;
  const NUM_RE = /(?:0[xX][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]*)?(?:[pP][+-]?[0-9_]+)?|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?)i?/y;
  const PUNCT3 = new Set(['...', '<<=', '>>=', '&^=', '&&=']);
  const PUNCT2 = new Set(['&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^', '~']);
  function unescapeAt(src, i, quote) { // a Go escape at src[i] === '\\' -> [text, next index]
    const e = src[i + 1];
    const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"' };
    if (e in simple) return [simple[e], i + 2];
    if (e === 'x') return [String.fromCharCode(parseInt(src.substr(i + 2, 2), 16) || 0), i + 4];
    if (e === 'u') { const c = parseInt(src.substr(i + 2, 4), 16); return [Number.isFinite(c) ? String.fromCodePoint(c) : '', i + 6]; }
    if (e === 'U') { const c = parseInt(src.substr(i + 2, 8), 16); return [Number.isFinite(c) && c <= 0x10ffff ? String.fromCodePoint(c) : '', i + 10]; }
    if (e >= '0' && e <= '7') return [String.fromCharCode(parseInt(src.substr(i + 1, 3), 8) || 0), i + 4];
    void quote; return [e === undefined ? '' : e, i + 2];
  }
  function tokenize(src) {
    src = String(src);
    const t = []; const dirs = []; const n = src.length; let i = 0; let nl = false;
    const push = (y, v, s) => { const o = { y, v, s }; if (nl) { o.nl = true; nl = false; } t.push(o); };
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 10) { nl = true; i++; continue; }
      if (c === 32 || c === 9 || c === 13 || c === 0xfeff || c === 12 || c === 11) { i++; continue; }
      if (c === 47 && src.charCodeAt(i + 1) === 47) { // line comment
        let e = src.indexOf('\n', i); if (e < 0) e = n;
        if (src.startsWith('//go:', i)) dirs.push({ tok: t.length, text: src.slice(i + 2, e).trim(), s: i });
        i = e; continue;
      }
      if (c === 47 && src.charCodeAt(i + 1) === 42) { // block comment
        const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2;
        for (let q = i + 2; q < end; q++) if (src.charCodeAt(q) === 10) { nl = true; break; }
        i = end; continue;
      }
      const s = i;
      if (c === 34) { // "…"
        let v = ''; let j = i + 1; let from = j;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (d === 34 || d === 10) break;
          if (d === 92) { v += src.slice(from, j); const [x, k] = unescapeAt(src, j, '"'); v += x; j = k; from = j; continue; }
          j++;
        }
        v += src.slice(from, Math.min(j, n));
        i = src.charCodeAt(j) === 34 ? j + 1 : j;
        push('str', v, s); continue;
      }
      if (c === 96) { // `raw`
        const e = src.indexOf('`', i + 1); const end = e < 0 ? n : e;
        const v = src.slice(i + 1, end).replace(/\r/g, '');
        if (v.indexOf('\n') >= 0) { push('str', v, s); t[t.length - 1].raw = true; } else { push('str', v, s); t[t.length - 1].raw = true; }
        i = e < 0 ? n : e + 1; continue;
      }
      if (c === 39) { // 'r'
        let j = i + 1; let v = '';
        if (src[j] === '\\') { const [x, k] = unescapeAt(src, j, "'"); v = x; j = k; } else { const cp = src.codePointAt(j); v = cp === undefined ? '' : String.fromCodePoint(cp); j += cp > 0xffff ? 2 : 1; }
        if (src[j] === "'") j++;
        i = j; push('char', v, s); continue;
      }
      ID_RE.lastIndex = i; let m = ID_RE.exec(src);
      if (m && m.index === i) { i += m[0].length; push('id', m[0], s); continue; }
      if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
        NUM_RE.lastIndex = i; m = NUM_RE.exec(src);
        const txt = m && m.index === i ? m[0] : src[i]; i += txt.length;
        const clean = txt.replace(/_/g, '').replace(/i$/, '');
        let v = Number(clean); if (!Number.isFinite(v) && /^0[oO]/.test(clean)) v = parseInt(clean.slice(2), 8);
        if (!Number.isFinite(v) && /^0[0-7]+$/.test(clean)) v = parseInt(clean, 8);
        push('num', Number.isFinite(v) ? v : 0, s); continue;
      }
      const three = src.substr(i, 3); const two = src.substr(i, 2);
      if (PUNCT3.has(three)) { i += 3; push('p', three, s); continue; }
      if (PUNCT2.has(two)) { i += 2; push('p', two, s); continue; }
      i += 1; push('p', src[s], s);
    }
    return { t, dirs };
  }
  // One pass: the matching close of every ( [ {, or -1.
  function bracketIndex(t) {
    const close = new Int32Array(t.length).fill(-1); const stack = [];
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.y !== 'p') continue;
      const v = x.v;
      if (v === '(' || v === '[' || v === '{') stack.push(k);
      else if (v === ')' || v === ']' || v === '}') {
        const want = v === ')' ? '(' : v === ']' ? '[' : '{';
        // tolerant: pop to the nearest matching opener
        let p = stack.length - 1; while (p >= 0 && t[stack[p]].v !== want) p--;
        if (p >= 0) { close[stack[p]] = k; stack.length = p; }
      }
    }
    return close;
  }
  const isP = (x, v) => !!x && x.y === 'p' && x.v === v;
  const isId = (x, v) => !!x && x.y === 'id' && (v === undefined || x.v === v);

  // ------------------------------------------------------------ values
  // Evaluation gives JS values: strings, numbers, booleans, null, arrays, plain objects (a map literal), and:
  // could not be worked out (its literals kept, at most MAX_LOST_PARTS of them; more is refused as over the work limit
  // by the caller's text budget, never silently cut: see capLost)
  const MAX_LOST_PARTS = 400;
  const capLost = (lost) => { if (!lost || lost.length <= MAX_LOST_PARTS) return lost || []; const u = Array.from(new Set(lost)); if (u.length <= MAX_LOST_PARTS) return u; const head = u.slice(0, MAX_LOST_PARTS - 1); head.push(u.slice(MAX_LOST_PARTS - 1).join(' … ').slice(0, 4 * 1024 * 1024)); return head; };
  const UNK = (lost) => ({ __unk: true, lost: capLost(lost) });
  const isUnk = (v) => !!v && typeof v === 'object' && v.__unk === true;
  const PARAM = (owner, name, path) => ({ __param: true, owner, name, path: path || [] }); // a parameter of the function being read (a field of it: path)
  const isParam = (v) => !!v && typeof v === 'object' && v.__param === true;
  // struct literal: { __struct: true, type: { pkg, name, path }, f: { Field: value }, pos }
  // function: { __fn: decl | lit, scope }; option: { __opt: name, args: [values], spread }
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

  // ------------------------------------------------------------ file model
  function lineIndex(src) { const ix = [0]; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) ix.push(k + 1); return ix; }
  function lineAt(f, off) { const ix = f.lines || (f.lines = lineIndex(f.text)); let lo = 0; let hi = ix.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ix[mid] <= off) lo = mid + 1; else hi = mid; } return lo; }

  // Statement ends (Go's semicolon insertion): a line break after an identifier, literal, ) ] } ++ -- or a keyword
  // that ends a statement, or ';', or the close of the enclosing bracket.
  const ENDS_LINE = new Set([')', ']', '}', '++', '--']);
  function endsLine(x) { return x && (x.y === 'id' || x.y === 'str' || x.y === 'num' || x.y === 'char' || (x.y === 'p' && ENDS_LINE.has(x.v))); }
  function stmtEnd(f, i, limit) {
    const t = f.t;
    for (let k = i; k < limit; k++) {
      const x = t[k];
      if (k > i && x.nl && endsLine(t[k - 1])) return k;
      if (x.y === 'p') {
        if (x.v === ';') return k;
        if (x.v === '(' || x.v === '[' || x.v === '{') { const c = f.close[k]; if (c < 0 || c >= limit) return limit; k = c; continue; }
        if (x.v === ')' || x.v === ']' || x.v === '}') return k;
      }
    }
    return limit;
  }
  // Split [a, b) on top-level commas.
  function splitCommas(f, a, b) {
    const out = []; let s = a;
    for (let k = a; k < b; k++) {
      const x = f.t[k];
      if (x.y !== 'p') continue;
      if (x.v === '(' || x.v === '[' || x.v === '{') { const c = f.close[k]; if (c < 0) break; k = c; continue; }
      if (x.v === ',') { out.push([s, k]); s = k + 1; }
    }
    if (s < b) out.push([s, b]);
    return out;
  }

  // ------------------------------------------------------------ parser
  // Expression nodes: str num char id sel call index lit unary bin paren fn(func literal) type nodes (tptr tslice
  // tarray tmap tstruct tfunc tiface tchan tname) and bad. Parsed on demand and cached per (start, end).
  function Parser(f, work) { this.f = f; this.t = f.t; this.close = f.close; this.memo = new Map(); this.work = work; }
  Parser.prototype.step = function () { if (--this.work.left < 0) throw new OverBudget('work'); };
  Parser.prototype.expr = function (a, b, depth) {
    if (this.header) return this.exprRaw(a, b, depth || 0); // header parses are not cached (they stop earlier)
    const key = a * 1048576 + b; // a, b < 2^20 tokens per file is plenty; larger files fall back to no cache
    if (b < 1048576 && this.memo.has(key)) return this.memo.get(key);
    const r = this.exprRaw(a, b, depth || 0);
    if (b < 1048576) this.memo.set(key, r);
    return r;
  };
  const BIN_PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3, '+': 4, '-': 4, '|': 4, '^': 4, '*': 5, '/': 5, '%': 5, '<<': 5, '>>': 5, '&': 5, '&^': 5 };
  // The whole range [a, b) as one expression: { n, e } where e is where it stopped.
  Parser.prototype.exprRaw = function (a, b, depth) {
    if (depth > MAX_DEPTH) return { n: { k: 'bad', a, b, deep: true }, e: b };
    const r = this.binary(a, b, 0, depth);
    return r;
  };
  Parser.prototype.binary = function (a, b, minPrec, depth) {
    let l = this.unary(a, b, depth);
    for (;;) {
      this.step();
      const x = this.t[l.e];
      if (l.e >= b || !x || x.y !== 'p' || !BIN_PREC[x.v] || BIN_PREC[x.v] <= minPrec) return l;
      const op = x.v; const r = this.binary(l.e + 1, b, BIN_PREC[op], depth + 1);
      l = { n: { k: 'bin', op, a: l.n, b: r.n, s: a }, e: r.e };
    }
  };
  Parser.prototype.unary = function (a, b, depth) {
    this.step();
    const x = this.t[a];
    if (a >= b || !x) return { n: { k: 'bad', a, b }, e: b };
    if (depth > MAX_DEPTH) return { n: { k: 'bad', a, b, deep: true }, e: b };
    if (x.y === 'p' && (x.v === '&' || x.v === '-' || x.v === '+' || x.v === '!' || x.v === '^' || x.v === '*' || x.v === '<-')) {
      const r = this.unary(a + 1, b, depth + 1);
      return { n: { k: 'unary', op: x.v, x: r.n, s: a }, e: r.e };
    }
    return this.postfix(a, b, depth);
  };
  Parser.prototype.operand = function (a, b, depth) {
    const t = this.t; const x = t[a];
    if (x.y === 'str') return { n: { k: 'str', v: x.v, s: a }, e: a + 1 };
    if (x.y === 'num') return { n: { k: 'num', v: x.v, s: a }, e: a + 1 };
    if (x.y === 'char') return { n: { k: 'char', v: x.v, s: a }, e: a + 1 };
    if (x.y === 'p' && x.v === '(') {
      const c = this.close[a]; if (c < 0 || c >= b) return { n: { k: 'bad', a, b }, e: b };
      const inner = this.expr(a + 1, c, depth + 1);
      return { n: { k: 'paren', x: inner.n, s: a }, e: c + 1 };
    }
    if (x.y === 'p' && (x.v === '[' || x.v === '*')) { const ty = this.type(a, b, depth + 1); return ty; }
    if (x.y === 'id') {
      if (x.v === 'func') {
        const sig = this.signature(a + 1, b, depth + 1);
        if (isP(t[sig.e], '{')) { const c = this.close[sig.e]; return { n: { k: 'fn', sig: sig.n, body: [sig.e, c < 0 ? b : c], s: a }, e: c < 0 ? b : c + 1 }; }
        return { n: { k: 'tfunc', sig: sig.n, s: a }, e: sig.e };
      }
      if (x.v === 'map' || x.v === 'struct' || x.v === 'interface' || x.v === 'chan') return this.type(a, b, depth + 1);
      return { n: { k: 'id', v: x.v, s: a }, e: a + 1 };
    }
    return { n: { k: 'bad', a, b }, e: a + 1 };
  };
  const TYPEISH = new Set(['id', 'sel', 'index', 'tslice', 'tarray', 'tmap', 'tstruct', 'tname']);
  // Is the token before a '{' the end of a type (so the '{' opens a composite literal, not a block)?
  const TYPEISH_PREV = (x) => !!x && ((x.y === 'id' && !/^(if|else|for|switch|select|func|go|defer|return|range|struct|interface|case|default)$/.test(x.v)) || (x.y === 'p' && x.v === ']'));
  Parser.prototype.postfix = function (a, b, depth) {
    const t = this.t;
    let r = this.operand(a, b, depth);
    for (;;) {
      this.step();
      const e = r.e; const x = t[e];
      if (e >= b || !x || x.y !== 'p') return r;
      if (x.v === '.') {
        const y = t[e + 1];
        if (isId(y)) { r = { n: { k: 'sel', x: r.n, v: y.v, s: a, at: e + 1 }, e: e + 2 }; continue; }
        if (isP(y, '(')) { const c = this.close[e + 1]; if (c < 0) return { n: r.n, e: b }; r = { n: { k: 'assert', x: r.n, s: a }, e: c + 1 }; continue; }
        return r;
      }
      if (x.v === '(') {
        const c = this.close[e]; if (c < 0 || c >= b) return { n: { k: 'bad', a, b }, e: b };
        const parts = splitCommas(this.f, e + 1, c); const args = []; let spread = false;
        parts.forEach(([p, q], k) => {
          let qq = q; if (k === parts.length - 1 && isP(t[q - 1], '...')) { spread = true; qq = q - 1; }
          if (qq > p) args.push(this.expr(p, qq, depth + 1).n);
        });
        r = { n: { k: 'call', fn: r.n, args, spread, s: a, open: e, close: c }, e: c + 1 }; continue;
      }
      if (x.v === '[') {
        const c = this.close[e]; if (c < 0 || c >= b) return { n: r.n, e: b };
        const parts = splitCommas(this.f, e + 1, c);
        // a slice expression a[i:j] has a top-level ':'
        let slice = -1; for (let k = e + 1; k < c; k++) { if (isP(t[k], ':')) { slice = k; break; } const cc = this.close[k]; if (cc > 0 && t[k].y === 'p') k = cc; }
        const idx = slice >= 0 ? [slice > e + 1 ? this.expr(e + 1, slice, depth + 1).n : null, c > slice + 1 ? this.expr(slice + 1, c, depth + 1).n : null] : parts.map(([p, q]) => this.typeOrExpr(p, q, depth + 1));
        r = { n: { k: 'index', x: r.n, idx, slice: slice >= 0, s: a }, e: c + 1 }; continue;
      }
      if (x.v === '{' && TYPEISH.has(r.n.k) && !(this.header && (r.n.k === 'id' || r.n.k === 'sel' || r.n.k === 'index'))) {
        const c = this.close[e]; if (c < 0 || c >= b) return { n: r.n, e: b };
        r = { n: { k: 'lit', type: r.n, elems: this.elems(e, c, depth + 1), s: a, open: e }, e: c + 1 }; continue;
      }
      return r;
    }
  };
  // A composite literal's elements between open and close: [{ key, value }], key a node or null.
  Parser.prototype.elems = function (open, close, depth) {
    const t = this.t; const out = [];
    splitCommas(this.f, open + 1, close).forEach(([p, q]) => {
      if (q <= p) return;
      let colon = -1;
      for (let k = p; k < q; k++) { const x = t[k]; if (x.y !== 'p') continue; if (x.v === '(' || x.v === '[' || x.v === '{') { const c = this.close[k]; if (c < 0) break; k = c; continue; } if (x.v === ':') { colon = k; break; } }
      const val = (s, e) => (isP(t[s], '{') && this.close[s] === e - 1 ? { k: 'lit', type: null, elems: this.elems(s, e - 1, depth + 1), s, open: s } : this.expr(s, e, depth + 1).n);
      if (colon > p) out.push({ key: isP(t[p], '{') ? val(p, colon) : this.expr(p, colon, depth + 1).n, value: val(colon + 1, q) });
      else out.push({ key: null, value: val(p, q) });
    });
    return out;
  };
  Parser.prototype.typeOrExpr = function (a, b, depth) {
    const x = this.t[a];
    if (isP(x, '[') || isP(x, '*') || isId(x, 'map') || isId(x, 'struct') || isId(x, 'interface') || isId(x, 'func') || isId(x, 'chan')) { const ty = this.type(a, b, depth); if (ty.e >= b) return ty.n; }
    return this.expr(a, b, depth).n;
  };
  // Types: tname { pkg, v, targs } | tptr { x } | tslice { x } | tarray { x } | tmap { key, x } | tstruct { fields }
  //        | tiface | tfunc { sig } | tchan { x } | tell { x } (a ...T parameter)
  Parser.prototype.type = function (a, b, depth) {
    this.step();
    const t = this.t; const x = t[a];
    if (!x || a >= b || depth > MAX_DEPTH) return { n: { k: 'bad', a, b }, e: Math.max(a + 1, Math.min(b, a + 1)) };
    if (isP(x, '*')) { const r = this.type(a + 1, b, depth + 1); return { n: { k: 'tptr', x: r.n, s: a }, e: r.e }; }
    if (isP(x, '...')) { const r = this.type(a + 1, b, depth + 1); return { n: { k: 'tell', x: r.n, s: a }, e: r.e }; }
    if (isP(x, '(')) { const c = this.close[a]; if (c < 0) return { n: { k: 'bad', a, b }, e: b }; const r = this.type(a + 1, c, depth + 1); return { n: r.n, e: c + 1 }; }
    if (isP(x, '[')) {
      const c = this.close[a]; if (c < 0 || c >= b) return { n: { k: 'bad', a, b }, e: b };
      const r = this.type(c + 1, b, depth + 1);
      if (c === a + 1) return { n: { k: 'tslice', x: r.n, s: a }, e: r.e };
      const len = c === a + 2 && t[a + 1].y === 'num' ? t[a + 1].v : null;
      return { n: { k: 'tarray', x: r.n, len, s: a }, e: r.e };
    }
    if (isP(x, '<-')) { const r = this.type(a + 2, b, depth + 1); return { n: { k: 'tchan', x: r.n, s: a }, e: r.e }; }
    if (isId(x)) {
      if (x.v === 'map' && isP(t[a + 1], '[')) {
        const c = this.close[a + 1]; if (c < 0 || c >= b) return { n: { k: 'bad', a, b }, e: b };
        const key = this.type(a + 2, c, depth + 1); const r = this.type(c + 1, b, depth + 1);
        return { n: { k: 'tmap', key: key.n, x: r.n, s: a }, e: r.e };
      }
      if (x.v === 'chan') { let s = a + 1; if (isP(t[s], '<-')) s++; const r = this.type(s, b, depth + 1); return { n: { k: 'tchan', x: r.n, s: a }, e: r.e }; }
      if (x.v === 'func') { const sig = this.signature(a + 1, b, depth + 1); return { n: { k: 'tfunc', sig: sig.n, s: a }, e: sig.e }; }
      if (x.v === 'interface' && isP(t[a + 1], '{')) { const c = this.close[a + 1]; return { n: { k: 'tiface', s: a }, e: c < 0 ? b : c + 1 }; }
      if (x.v === 'struct' && isP(t[a + 1], '{')) { const c = this.close[a + 1]; if (c < 0) return { n: { k: 'bad', a, b }, e: b }; return { n: { k: 'tstruct', fields: this.fields(a + 1, c, depth + 1), s: a }, e: c + 1 }; }
      let e = a + 1; let pkg = null; let v = x.v;
      if (isP(t[e], '.') && isId(t[e + 1])) { pkg = v; v = t[e + 1].v; e += 2; }
      let targs = null;
      if (isP(t[e], '[') && e < b) {
        const c = this.close[e];
        if (c > 0 && c < b && c > e + 1) { targs = splitCommas(this.f, e + 1, c).map(([p, q]) => this.type(p, q, depth + 1).n); e = c + 1; }
      }
      return { n: { k: 'tname', pkg, v, targs, s: a }, e };
    }
    return { n: { k: 'bad', a, b }, e: a + 1 };
  };
  // Struct fields between { and }: [{ name, type, tag, embedded }].
  Parser.prototype.fields = function (open, close, depth) {
    const t = this.t; const out = [];
    let k = open + 1;
    while (k < close) {
      this.step();
      const e = stmtEnd(this.f, k, close);
      if (e > k) {
        let tagTok = null; let end = e;
        if (t[e - 1] && t[e - 1].y === 'str' && e - 1 > k) { tagTok = t[e - 1]; end = e - 1; }
        const tag = tagTok ? parseTag(tagTok.v) : {};
        // names: id (, id)* followed by a type; embedded: [*]Type or pkg.Type alone
        const names = []; let j = k;
        while (isId(t[j]) && (isP(t[j + 1], ',') || (j + 1 < end && !isP(t[j + 1], '.')))) { names.push(t[j].v); if (isP(t[j + 1], ',')) j += 2; else { j += 1; break; } }
        if (names.length && j < end) { const ty = this.type(j, end, depth + 1); names.forEach((nm) => out.push({ name: nm, type: ty.n, tag, s: k })); }
        else { const ty = this.type(k, end, depth + 1); const base = ty.n.k === 'tptr' ? ty.n.x : ty.n; out.push({ name: base && base.v ? base.v : null, type: ty.n, tag, embedded: true, s: k }); }
      }
      k = isP(t[e], ';') || e <= k ? e + 1 : e;
    }
    return out;
  };
  // A function signature from '(' at a: { params: [{ name, type, variadic }], results: [{ name, type }] }.
  Parser.prototype.signature = function (a, b, depth) {
    const t = this.t;
    if (!isP(t[a], '(')) return { n: { params: [], results: [] }, e: a };
    const c = this.close[a]; if (c < 0) return { n: { params: [], results: [] }, e: b };
    const params = this.params(a, c, depth);
    let e = c + 1; let results = [];
    const r0 = t[e];
    if (isP(r0, '(')) { const rc = this.close[e]; if (rc > 0) { results = this.params(e, rc, depth); e = rc + 1; } }
    else if (r0 && e < b && !isP(r0, '{') && !isP(r0, ',') && !isP(r0, ')') && !isP(r0, ']') && !isP(r0, ';') && !isP(r0, '}') && !isP(r0, '=') && !(r0.nl && endsLine(t[e - 1])) && (r0.y === 'id' || isP(r0, '*') || isP(r0, '[') || isP(r0, '<-'))) {
      const ty = this.type(e, b, depth + 1); results = [{ name: null, type: ty.n }]; e = ty.e;
    }
    return { n: { params, results }, e };
  };
  Parser.prototype.params = function (open, close, depth) {
    const t = this.t; const parts = splitCommas(this.f, open + 1, close);
    const raw = parts.map(([p, q]) => {
      if (isId(t[p]) && q - p >= 2 && !isP(t[p + 1], '.')) { const ty = this.type(p + 1, q, depth + 1); return { name: t[p].v, type: ty.n, variadic: ty.n.k === 'tell' }; }
      const ty = this.type(p, q, depth + 1); return { name: null, type: ty.n, single: q - p === 1 && isId(t[p]) ? t[p].v : null, variadic: ty.n.k === 'tell' };
    });
    if (raw.some((x) => x.name)) { // grouped names: (a, b string)
      for (let k = raw.length - 1, next = null; k >= 0; k--) { if (raw[k].name) next = raw[k].type; else if (raw[k].single && next) { raw[k] = { name: raw[k].single, type: next, variadic: next.k === 'tell' }; } }
    }
    return raw.map((x) => ({ name: x.name, type: x.type, variadic: !!x.variadic }));
  };

  // A struct tag `json:"name,omitempty" jsonschema:"…"` -> { json: '…', jsonschema: '…', … }.
  function parseTag(s) {
    const out = {}; const re = /([A-Za-z_][\w-]*):"((?:\\.|[^"\\])*)"/g; let m;
    while ((m = re.exec(s))) { if (!(m[1] in out)) out[m[1]] = m[2].replace(/\\(.)/g, '$1'); }
    return out;
  }

  // ------------------------------------------------------------ declarations of a file
  // { pkg, imports: Map(alias -> path), consts, vars: [{ name, type, value (node), file, embed }], types: [{ name,
  //   type, tparams }], funcs: [{ name, recv, recvType, tparams, sig, body: [open, close], s }] }
  function fileDecls(f, work) {
    const P = new Parser(f, work); f.P = P;
    const t = f.t; const out = { pkg: null, imports: new Map(), consts: [], vars: [], types: [], funcs: [] };
    const dirAt = new Map(); (f.dirs || []).forEach((d) => { if (!dirAt.has(d.tok)) dirAt.set(d.tok, []); dirAt.get(d.tok).push(d.text); });
    const embedFor = (k) => { for (let q = k; q >= Math.max(0, k - 2); q--) { const ds = dirAt.get(q); if (ds) { const e = ds.find((x) => /^go:embed\s/.test(x)); if (e) return e.replace(/^go:embed\s+/, '').trim(); } } return null; };
    const specs = (k) => { // a declaration's specs: [[a, b)] for `kw spec` or `kw ( spec; spec )`
      if (isP(t[k + 1], '(')) { const c = f.close[k + 1]; if (c < 0) return { list: [], end: t.length }; const list = []; let s = k + 2; while (s < c) { const e = stmtEnd(f, s, c); if (e > s) list.push([s, e]); s = isP(t[e], ';') || e <= s ? e + 1 : e; } return { list, end: c + 1 }; }
      const e = stmtEnd(f, k + 1, t.length); return { list: [[k + 1, e]], end: e };
    };
    let k = 0;
    while (k < t.length) {
      work.left--; if (work.left < 0) throw new OverBudget('work');
      const x = t[k];
      if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const c = f.close[k]; k = c < 0 ? t.length : c + 1; continue; }
      if (x.y !== 'id') { k++; continue; }
      if (x.v === 'package' && isId(t[k + 1])) { out.pkg = t[k + 1].v; k += 2; continue; }
      if (x.v === 'import') {
        const sp = specs(k);
        sp.list.forEach(([a, b]) => { let alias = null; let j = a; if (isId(t[j]) || isP(t[j], '.')) { alias = t[j].v; j++; } if (t[j] && t[j].y === 'str') { const path = t[j].v; out.imports.set(alias || defaultAlias(path), path); } });
        k = sp.end; continue;
      }
      if (x.v === 'const' || x.v === 'var') {
        const sp = specs(k); let prev = null;
        sp.list.forEach(([a, b]) => {
          const names = []; let j = a;
          while (isId(t[j])) { names.push(t[j].v); if (isP(t[j + 1], ',')) j += 2; else { j++; break; } }
          let eq = -1; for (let q = j; q < b; q++) { if (isP(t[q], '=')) { eq = q; break; } const cc = f.close[q]; if (cc > 0 && t[q].y === 'p') q = cc; }
          const type = (eq < 0 ? b : eq) > j ? P.type(j, eq < 0 ? b : eq, 0).n : null;
          let vals = eq >= 0 ? splitCommas(f, eq + 1, b).map(([p, q]) => ({ a: p, b: q })) : null;
          if (x.v === 'const' && !vals && prev) vals = prev; // implicit repetition in a const group
          if (x.v === 'const' && vals) prev = vals;
          const embed = x.v === 'var' ? embedFor(a) || embedFor(k) : null;
          names.forEach((nm, q) => { if (nm === '_') return; (x.v === 'const' ? out.consts : out.vars).push({ name: nm, type, value: vals && vals[q] ? vals[q] : null, file: f, embed, s: a }); });
        });
        k = sp.end; continue;
      }
      if (x.v === 'type') {
        const sp = specs(k);
        sp.list.forEach(([a, b]) => {
          if (!isId(t[a])) return;
          let j = a + 1; let tparams = null;
          if (isP(t[j], '[')) {
            const c = f.close[j];
            if (c > 0 && isId(t[j + 1]) && !isP(t[j + 2], ']')) { tparams = P.params(j, c, 0).map((p) => p.name); j = c + 1; }
          }
          if (isP(t[j], '=')) j++;
          out.types.push({ name: t[a].v, type: P.type(j, b, 0).n, tparams, file: f, s: a });
        });
        k = sp.end; continue;
      }
      if (x.v === 'func') {
        let j = k + 1; let recv = null; let recvType = null;
        if (isP(t[j], '(')) { const c = f.close[j]; if (c < 0) { k = t.length; continue; } const ps = P.params(j, c, 0); recv = ps[0] ? ps[0].name : null; const rt = ps[0] ? ps[0].type : null; recvType = rt ? (rt.k === 'tptr' ? rt.x : rt) : null; j = c + 1; }
        if (!isId(t[j])) { k = j; continue; }
        const name = t[j].v; j++;
        let tparams = null;
        if (isP(t[j], '[')) { const c = f.close[j]; if (c > 0) { tparams = P.params(j, c, 0).map((p) => p.name); j = c + 1; } }
        const sig = P.signature(j, t.length, 0);
        let body = null; let e = sig.e;
        if (isP(t[e], '{')) { const c = f.close[e]; body = [e, c < 0 ? t.length - 1 : c]; e = (c < 0 ? t.length : c + 1); }
        out.funcs.push({ name, recv, recvType: recvType && recvType.v ? recvType.v : null, tparams, sig: sig.n, body, file: f, s: k });
        k = e; continue;
      }
      k++;
    }
    return out;
  }
  function defaultAlias(path) {
    const segs = String(path).split('/'); let last = segs.pop() || '';
    if (/^v\d+$/.test(last) && segs.length) last = segs.pop();
    return last.replace(/^go-/, '').replace(/[.-]go$/, '').replace(/[^\w]/g, '_');
  }

  // ------------------------------------------------------------ SDKs
  const SDK_OF = (path) => {
    if (/(^|\/)mark3labs\/mcp-go\//.test(path) || /\/mcp-go\/(mcp|server)$/.test(path)) return 'mcp-go';
    if (/(^|\/)modelcontextprotocol\/go-sdk\//.test(path)) return 'go-sdk';
    if (/(^|\/)metoro-io\/mcp-golang/.test(path)) return 'metoro';
    if (/jsonschema/.test(path)) return 'jsonschema';
    if (/mcp/i.test(path)) return 'mcp-other';
    return null;
  };
  // Constructors of a server (a package that constructs one is a server; see serverPackages in repo-source).
  const CONSTRUCTS = /\b(?:server\.NewMCPServer|mcp\.NewServer|NewMCPServer|mcp_golang\.NewServer|mcpgolang\.NewServer)\s*\(/;

  // mcp-go property options (PropertyOption): their JSON Schema keyword.
  const PROP_KEY = { Description: 'description', Title: 'title', DefaultString: 'default', DefaultNumber: 'default', DefaultBool: 'default', DefaultArray: 'default', MaxLength: 'maxLength', MinLength: 'minLength', Pattern: 'pattern', Max: 'maximum', Min: 'minimum', MultipleOf: 'multipleOf', Properties: 'properties', AdditionalProperties: 'additionalProperties', MinProperties: 'minProperties', MaxProperties: 'maxProperties', PropertyNames: 'propertyNames', Items: 'items', MinItems: 'minItems', MaxItems: 'maxItems', UniqueItems: 'uniqueItems', Format: 'format', Default: 'default' };
  const PROP_TYPE = { WithString: 'string', WithNumber: 'number', WithInteger: 'integer', WithBoolean: 'boolean', WithObject: 'object', WithArray: 'array', WithAny: null };
  const ITEM_TYPE = { WithStringItems: 'string', WithNumberItems: 'number', WithIntegerItems: 'integer', WithBooleanItems: 'boolean' };
  const HINTS = { WithReadOnlyHintAnnotation: 'readOnlyHint', WithDestructiveHintAnnotation: 'destructiveHint', WithIdempotentHintAnnotation: 'idempotentHint', WithOpenWorldHintAnnotation: 'openWorldHint' };
  const TOOL_OPTS = new Set(['WithDescription', 'WithToolTitle', 'WithTitle', 'WithInputSchema', 'WithOutputSchema', 'WithRawInputSchema', 'WithRawOutputSchema', 'WithToolAnnotation', 'WithTitleAnnotation', 'WithoutDefaultAnnotations', 'WithSchemaAdditionalProperties', 'WithDeferLoading', 'WithToolIcons', 'WithTaskSupport', 'WithCachedInputSchema', 'WithCachedInputSchemaKey', 'WithCachedOutputSchema', 'WithCachedOutputSchemaKey'].concat(Object.keys(PROP_TYPE), Object.keys(HINTS)));
  const PROP_OPTS = new Set(['Required'].concat(Object.keys(PROP_KEY), Object.keys(ITEM_TYPE), ['Enum', 'WithStringEnumItems']));
  // JSON keys of Go struct fields of the SDK types (jsonschema.Schema, ToolInputSchema, ToolAnnotation(s), Tool).
  const FIELD_JSON = { ID: '$id', Schema: '$schema', Ref: '$ref', Comment: '$comment', Defs: '$defs', Definitions: 'definitions', Anchor: '$anchor', DynamicRef: '$dynamicRef', DynamicAnchor: '$dynamicAnchor', Vocabulary: '$vocabulary', Types: 'type', Type: 'type', PropertyOrder: '-', AdditionalProperties: 'additionalProperties', PropertyNames: 'propertyNames', ReadOnlyHint: 'readOnlyHint', DestructiveHint: 'destructiveHint', IdempotentHint: 'idempotentHint', OpenWorldHint: 'openWorldHint', InputSchema: 'inputSchema', OutputSchema: 'outputSchema' };
  const lowerCamel = (s) => (FIELD_JSON[s] || (/^[A-Z0-9]+$/.test(s) ? s.toLowerCase() : s.charAt(0).toLowerCase() + s.slice(1)));
  const CTX_TYPES = /^(Context|CallToolRequest|ServerSession|ClientSession|RequestExtra|ServerRequest|CallToolParams|CallToolParamsFor|Request)$/;

  // ------------------------------------------------------------ the repository
  function Repo(files, opts) {
    this.opts = opts || {};
    this.work = { left: this.opts.workBudget || DEFAULT_BUDGET };
    this.files = []; this.pkgs = new Map(); this.byName = new Map(); this.modules = [];
    (this.opts.goMods || []).forEach(([p, text]) => { const m = /^\s*module\s+("?)([^\s"]+)\1/m.exec(String(text || '')); if (m) this.modules.push({ dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', path: m[2] }); });
    this.modules.sort((a, b) => b.path.length - a.path.length);
    files.forEach(([path, text]) => {
      if (typeof text !== 'string') return;
      const tk = tokenize(text); const f = { path, text, t: tk.t, dirs: tk.dirs, close: bracketIndex(tk.t) };
      f.dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      f.tag = buildConstraint(tk.dirs);
      try { f.decls = fileDecls(f, this.work); } catch (e) { if (e instanceof OverBudget) throw e; f.decls = { pkg: null, imports: new Map(), consts: [], vars: [], types: [], funcs: [] }; f.failed = true; }
      if (/_test$/.test(f.decls.pkg || '')) return;
      this.files.push(f);
      let pk = this.pkgs.get(f.dir);
      if (!pk) { pk = { dir: f.dir, name: f.decls.pkg, files: [], consts: new Map(), vars: new Map(), types: new Map(), funcs: new Map(), methods: new Map() }; this.pkgs.set(f.dir, pk); }
      f.pkg = pk; pk.files.push(f);
      f.decls.consts.forEach((c) => { if (!pk.consts.has(c.name)) pk.consts.set(c.name, c); });
      f.decls.vars.forEach((c) => { if (!pk.vars.has(c.name)) pk.vars.set(c.name, c); });
      f.decls.types.forEach((c) => { if (!pk.types.has(c.name)) pk.types.set(c.name, c); });
      f.decls.funcs.forEach((d) => {
        if (d.body) { // types declared inside a function (type args struct {…})
          const t = f.t;
          for (let k = d.body[0] + 1; k < d.body[1] - 1; k++) {
            if (t[k].y !== 'id' || t[k].v !== 'type' || !isId(t[k + 1]) || !(t[k].nl || isP(t[k - 1], '{') || isP(t[k - 1], ';'))) continue;
            const e = stmtEnd(f, k + 2, d.body[1]);
            try { const ty = f.P.type(k + 2, e, 0).n; if (!pk.types.has(t[k + 1].v)) pk.types.set(t[k + 1].v, { name: t[k + 1].v, type: ty, tparams: null, file: f, s: k }); } catch (x) { if (x instanceof OverBudget) throw x; }
          }
        }
        d.pkg = pk;
        const m = d.recv !== null || d.recvType ? pk.methods : pk.funcs;
        if (!m.has(d.name)) m.set(d.name, []); m.get(d.name).push(d);
        if (!this.byName.has(d.name)) this.byName.set(d.name, []); this.byName.get(d.name).push(d);
      });
    });
  }
  // Struct types of the repository shaped like a tool: fields tagged json:"name" and json:"inputSchema" (a server's own
  // tool type, converted to the SDK's at run time). Their literals are read like Tool{…}.
  Repo.prototype.toolShaped = function () {
    if (this._shaped) return this._shaped;
    const out = new Map();
    this.pkgs.forEach((pk) => pk.types.forEach((d, name) => {
      if (!d.type || d.type.k !== 'tstruct') return;
      const tag = (fd) => (fd.tag && typeof fd.tag.json === 'string' ? fd.tag.json.split(',')[0] : null);
      const byTag = {}; d.type.fields.forEach((fd) => { const j = tag(fd); if (j && fd.name) byTag[j] = fd.name; });
      if (byTag.name && (byTag.inputSchema || byTag.input_schema)) out.set(name, { name: byTag.name, description: byTag.description, title: byTag.title, input: byTag.inputSchema || byTag.input_schema, output: byTag.outputSchema || byTag.output_schema, annotations: byTag.annotations });
    }));
    return (this._shaped = out);
  };
  // `//go:build` constraint: excluded when it can only hold with a tag the default build does not set (ignore, a
  // custom tag such as `enterprise`); platform, architecture, cgo and go1.x tags count as possibly set.
  const PLATFORM = /^(aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos|unix|386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|wasm|cgo|gc|gccgo|go1\.\d+)$/;
  function buildConstraint(dirs) {
    const d = (dirs || []).find((x) => /^go:build\s/.test(x.text)); if (!d) return null;
    const expr = d.text.replace(/^go:build\s+/, '');
    // evaluate with every platform tag "maybe": true if some assignment of platform tags makes it true
    const toks = expr.match(/!|\(|\)|&&|\|\||[\w.]+/g) || [];
    const platforms = Array.from(new Set(toks.filter((x) => PLATFORM.test(x))));
    const tryWith = (set) => { let i = 0; const or = () => { let v = and(); while (toks[i] === '||') { i++; const r = and(); v = v || r; } return v; }; const and = () => { let v = not(); while (toks[i] === '&&') { i++; const r = not(); v = v && r; } return v; }; const not = () => { if (toks[i] === '!') { i++; return !not(); } if (toks[i] === '(') { i++; const v = or(); i++; return v; } const x = toks[i++]; return set.has(x); }; try { return or(); } catch (e) { return true; } };
    let ok = false;
    const n = Math.min(platforms.length, 10);
    for (let mask = 0; mask < (1 << n) && !ok; mask++) { const set = new Set(); for (let b = 0; b < n; b++) if (mask & (1 << b)) set.add(platforms[b]); if (tryWith(set)) ok = true; }
    return { expr, excluded: !ok };
  }

  // The package an import path names: a folder of the repository (through go.mod's module path, else by suffix).
  Repo.prototype.pkgOfImport = function (path) {
    if (!path) return null;
    const cache = this._imp || (this._imp = new Map()); if (cache.has(path)) return cache.get(path);
    let hit = null;
    const sdk = SDK_OF(path);
    if (sdk && sdk !== 'mcp-other') { cache.set(path, null); return null; }
    for (const m of this.modules) {
      if (path === m.path || path.startsWith(m.path + '/')) { const rest = path.slice(m.path.length).replace(/^\//, ''); const dir = [m.dir, rest].filter(Boolean).join('/'); hit = this.pkgs.get(dir) || null; break; }
    }
    // without a go.mod that names it: a folder whose last two segments (or more) end the import path
    if (!hit && !this.modules.some((m) => path === m.path || path.startsWith(m.path + '/'))) { const cands = Array.from(this.pkgs.keys()).filter((d) => d && d.includes('/') && (path === d || path.endsWith('/' + d))); if (cands.length) hit = this.pkgs.get(cands.sort((a, b) => b.length - a.length)[0]); }
    cache.set(path, hit); return hit;
  };
  // A qualifier (`mcp` in mcp.NewTool) in a file: { sdk, pkg } or null when it is not an import.
  Repo.prototype.qual = function (f, name) {
    const path = f.decls.imports.get(name); if (path === undefined) return null;
    return { path, sdk: SDK_OF(path), pkg: this.pkgOfImport(path) };
  };

  // ------------------------------------------------------------ scopes and evaluation
  // A scope: { vars: Map(name -> binding), parent, f (file), pkg, fn (the function decl), locals (lazy) }.
  // A binding: { val } | { node, scope } | { local: [assignments] }.
  function Scope(parent, f, pkg, fn) { this.vars = new Map(); this.parent = parent; this.f = f; this.pkg = pkg; this.fn = fn; }
  Scope.prototype.lookup = function (name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return { b: s.vars.get(name), s }; return null; };

  // Local assignments of a function body: name -> [{ at, op, a, b }] (a..b the right-hand side), found in one pass.
  Repo.prototype.locals = function (f, body) {
    const key = body[0]; f.localCache = f.localCache || new Map();
    if (f.localCache.has(key)) return f.localCache.get(key);
    const t = f.t; const out = new Map(); const ranges = []; out.ranges = ranges;
    // the if / else blocks around each position: a stack of { close, cond: [a, b) | null, neg }
    const blocks = [];
    let lastIf = null; // the condition of the if block that just closed (for a following else)
    const add = (name, at, op, a, b, idx, count) => { if (name === '_') return; if (!out.has(name)) out.set(name, []); out.get(name).push({ at, op, a, b, idx, count, conds: blocks.filter((x) => x.cond || x.unknown).map((x) => ({ cond: x.cond, neg: x.neg, unknown: x.unknown, open: x.open, close: x.close })), depth: blocks.length }); };
    for (let k = body[0] + 1; k < body[1]; k++) {
      if (--this.work.left < 0) throw new OverBudget('work');
      const x = t[k];
      while (blocks.length && k > blocks[blocks.length - 1].close) { const b = blocks.pop(); if (b.isIf) lastIf = b; }
      if (x.y === 'p' && x.v === '{') {
        const c = f.close[k]; if (c < 0) continue;
        // the block's header: `if cond {`, `} else {`, or anything else (for, switch, func literal: unknown)
        let h = k - 1; while (h > body[0] && !(t[h].nl && endsLine(t[h - 1])) && !isP(t[h], ';') && !isP(t[h], '{') && !isP(t[h], '}')) { if (t[h].y === 'p' && (t[h].v === ')' || t[h].v === ']')) { /* walk over a bracket */ let o = h - 1; let d = 1; while (o > body[0] && d) { if (t[o].y === 'p' && (t[o].v === ')' || t[o].v === ']')) d++; else if (t[o].y === 'p' && (t[o].v === '(' || t[o].v === '[')) d--; o--; } h = o + 1; } h--; }
        let hs = isP(t[h], ';') || isP(t[h], '{') || isP(t[h], '}') ? h + 1 : h;
        if (isP(t[hs - 1], '}') && isId(t[hs], 'else')) hs = hs;
        const kw = t[hs];
        if (isId(kw, 'if')) {
          let a = hs + 1; for (let q = hs + 1; q < k; q++) if (isP(t[q], ';')) a = q + 1; // if init; cond {
          blocks.push({ open: k, close: c, cond: [a, k], neg: false, isIf: true });
        } else if (isId(t[k - 1], 'else') && lastIf && lastIf.close === k - 2) {
          blocks.push({ open: k, close: c, cond: lastIf.cond, neg: !lastIf.neg });
        } else if (isId(kw) && /^(for|switch|select)$/.test(kw.v)) {
          blocks.push({ open: k, close: c, cond: null, unknown: true }); // a loop or switch body
        } else if (k > body[0] + 1 && TYPEISH_PREV(t[k - 1])) {
          blocks.push({ close: c, cond: null, literal: true }); // a composite literal
        } else blocks.push({ open: k, close: c, cond: null, unknown: !isId(kw, 'func') && kw !== undefined });
        continue;
      }
      if (x.y !== 'id') continue;
      const prev = t[k - 1];
      const start = prev && (prev.y === 'p' && (prev.v === '{' || prev.v === ';' || prev.v === '}' || prev.v === '(')) || x.nl || (prev && prev.y === 'id' && /^(if|for|switch|var|const)$/.test(prev.v));
      if (!start) continue;
      if (blocks.length && blocks[blocks.length - 1].literal) continue;
      if (x.v === 'var' || x.v === 'const') {
        let j = k + 1; const names = [];
        while (isId(t[j])) { names.push(t[j].v); if (isP(t[j + 1], ',')) j += 2; else { j++; break; } }
        const e = stmtEnd(f, k + 1, body[1]);
        let eq = -1; for (let q = j; q < e; q++) if (isP(t[q], '=')) { eq = q; break; }
        if (eq > 0) { const parts = splitCommas(f, eq + 1, e); names.forEach((nm, q) => { if (parts.length === names.length) add(nm, k, '=', parts[q][0], parts[q][1]); else if (parts.length === 1) add(nm, k, '=', parts[0][0], parts[0][1], q, names.length); }); }
        else names.forEach((nm) => add(nm, k, 'zero', -1, -1));
        continue;
      }
      // x.Field.Sub = …: a field set on a struct value (a parameter or a local)
      if (isP(t[k + 1], '.') && isId(t[k + 2])) {
        let j = k + 1; const path = [];
        while (isP(t[j], '.') && isId(t[j + 1])) { path.push(t[j + 1].v); j += 2; }
        if (isP(t[j], '=') && path.length <= 3) { const e = stmtEnd(f, j + 1, body[1]); add(x.v, k, 'field', j + 1, e); out.get(x.v)[out.get(x.v).length - 1].path = path; }
        continue;
      }
      // a, b := …  /  x = …  /  x += …
      const names = [x.v]; let j = k + 1;
      while (isP(t[j], ',') && isId(t[j + 1])) { names.push(t[j + 1].v); j += 2; }
      const op = t[j];
      if (!op || op.y !== 'p' || !(op.v === ':=' || op.v === '=' || op.v === '+=')) continue;
      if (isId(t[j + 1], 'range')) {
        names.forEach((nm) => add(nm, k, 'range', -1, -1));
        // the range expression ends where the loop body starts: parsed as a statement header, where only a
        // literal of a slice, array, map or struct type may follow (range names { is the body, range []T{…} { not)
        let br = -1;
        try { f.P.header = true; br = f.P.expr(j + 2, body[1]).e; } catch (e) { if (e instanceof OverBudget) throw e; } finally { f.P.header = false; }
        if (br > j + 2 && br < body[1] && isP(t[br], '{') && f.close[br] > 0) ranges.push({ names: names.slice(0, 2), a: j + 2, b: br, open: br, close: f.close[br] });
        continue;
      }
      const e = stmtEnd(f, j + 1, body[1]);
      const parts = splitCommas(f, j + 1, e);
      names.forEach((nm, q) => { if (parts.length === names.length) add(nm, k, op.v, parts[q][0], parts[q][1]); else if (parts.length === 1) add(nm, k, op.v, parts[0][0], parts[0][1], q, names.length); });
    }
    f.localCache.set(key, out);
    return out;
  };
  // A function's scope: parameters bound (to PARAM, or to a call's arguments), locals read lazily.
  Repo.prototype.fnScope = function (decl, parent, bind) {
    const sc = new Scope(parent || this.pkgScope(decl.pkg, decl.file), decl.file, decl.pkg, decl);
    (decl.sig ? decl.sig.params : []).forEach((p, k) => { if (p.name) sc.vars.set(p.name, bind ? bind(p, k) : { val: PARAM(decl, p.name) }); });
    if (decl.recv) sc.vars.set(decl.recv, bind && bind.recv ? bind.recv : { val: PARAM(decl, decl.recv) });
    if (decl.body) sc.body = decl.body;
    return sc;
  };
  Repo.prototype.pkgScope = function (pkg, f) { const s = new Scope(null, f, pkg, null); s.isPkg = true; return s; };

  Repo.prototype.step = function () { if (--this.work.left < 0) throw new OverBudget('work'); };
  // The string literals in a node (for text that could not be placed: scanned for poisoning).
  function literals(n, out, depth) {
    out = out || []; depth = depth || 0; if (!n || depth > 200 || out.length > 2000) return out;
    if (n.k === 'str') { if (n.v.trim()) out.push(n.v); return out; }
    for (const key of ['x', 'a', 'b', 'fn', 'type']) if (n[key] && typeof n[key] === 'object') literals(n[key], out, depth + 1);
    if (n.args) n.args.forEach((y) => literals(y, out, depth + 1));
    if (n.idx) n.idx.forEach((y) => literals(y, out, depth + 1));
    if (n.elems) n.elems.forEach((e) => { if (e.key) literals(e.key, out, depth + 1); literals(e.value, out, depth + 1); });
    return out;
  }
  function bodyLiterals(f, body) { const out = []; if (!body) return out; for (let k = body[0]; k < body[1] && out.length < 2000; k++) if (f.t[k].y === 'str' && f.t[k].v.trim()) out.push(f.t[k].v); return out; }

  // Evaluate node in scope. `at`: the token index the value is read at (for locals assigned more than once).
  Repo.prototype.ev = function (n, sc, depth) {
    this.step();
    depth = depth || 0;
    if (!n) return UNK();
    if (depth > MAX_DEPTH) return UNK(literals(n));
    switch (n.k) {
      case 'str': return n.v;
      case 'num': return n.v;
      case 'char': return n.v;
      case 'paren': return this.ev(n.x, sc, depth + 1);
      case 'id': return this.ident(n.v, sc, n.s, depth);
      case 'sel': return this.select(n, sc, depth);
      case 'unary': {
        const v = this.ev(n.x, sc, depth + 1);
        if (n.op === '&' || n.op === '*') return v;
        if (n.op === '-' && typeof v === 'number') return -v;
        if (n.op === '!' && typeof v === 'boolean') return !v;
        return isUnk(v) || isParam(v) ? v : UNK();
      }
      case 'bin': {
        if (n.op !== '+') {
          const a = this.ev(n.a, sc, depth + 1); const b = this.ev(n.b, sc, depth + 1);
          const prim = (x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || x === null;
          if ((n.op === '==' || n.op === '!=') && prim(a) && prim(b)) return n.op === '==' ? a === b : a !== b;
          if (isParam(a)) return a; if (isParam(b)) return b;
          if (n.op === '&&' && (a === false || b === false)) return false;
          if (n.op === '||' && (a === true || b === true)) return true;
          if ((n.op === '&&' || n.op === '||') && typeof a === 'boolean' && typeof b === 'boolean') return n.op === '&&' ? a && b : a || b;
          if (typeof a === 'number' && typeof b === 'number') { if (n.op === '-') return a - b; if (n.op === '*') return a * b; if (n.op === '/' && b) return a / b; if (n.op === '<') return a < b; if (n.op === '>') return a > b; if (n.op === '<=') return a <= b; if (n.op === '>=') return a >= b; }
          return UNK(literals(n));
        }
        const a = this.ev(n.a, sc, depth + 1); const b = this.ev(n.b, sc, depth + 1);
        if (isParam(a)) return a; if (isParam(b)) return b;
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' && typeof b === 'string') { const s = a + b; return s.length > MAX_STR ? partial(s.slice(0, MAX_STR), [s.slice(MAX_STR)]) : s; }
        return concatPartial(a, b);
      }
      case 'call': return this.call(n, sc, depth);
      case 'index': {
        if (!n.slice && n.idx.length === 1) {
          const base = this.ev(n.x, sc, depth + 1); const k = this.ev(n.idx[0], sc, depth + 1);
          if (Array.isArray(base) && typeof k === 'number') return k in base ? base[k] : UNK();
          if (isPlain(base) && (typeof k === 'string' || typeof k === 'number') && Object.prototype.hasOwnProperty.call(base, k)) return base[k];
          if (base && base.__fn) return base; // a generic function instantiated: f[T]
        }
        const base = this.ev(n.x, sc, depth + 1); if (base && base.__fn) return base;
        if (n.slice && Array.isArray(base)) { const lo = n.idx[0] ? this.ev(n.idx[0], sc, depth + 1) : 0; const hi = n.idx[1] ? this.ev(n.idx[1], sc, depth + 1) : base.length; if (typeof lo === 'number' && typeof hi === 'number') return base.slice(lo, hi); }
        if (n.slice && typeof base === 'string') { const lo = n.idx[0] ? this.ev(n.idx[0], sc, depth + 1) : 0; const hi = n.idx[1] ? this.ev(n.idx[1], sc, depth + 1) : base.length; if (typeof lo === 'number' && typeof hi === 'number') return base.slice(lo, hi); }
        return UNK(literals(n));
      }
      case 'lit': return this.literal(n, sc, depth);
      case 'fn': return { __fn: { lit: n, f: sc.f }, scope: sc };
      default: return UNK(literals(n));
    }
  };
  // A field of a struct value, also one promoted from an embedded struct (tool: tool{name: …} gives t.name).
  function promoted(v, name, depth) {
    depth = depth || 0;
    if (!v || !v.__struct || depth > 3) return undefined;
    if (Object.prototype.hasOwnProperty.call(v.f, name)) return v.f[name];
    for (const k of Object.keys(v.f)) { const x = v.f[k]; if (x && x.__struct && x.type && x.type.name === k) { const y = promoted(x, name, depth + 1); if (y !== undefined) return y; } }
    return undefined;
  }
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !v.__unk && !v.__param && !v.__struct && !v.__fn && !v.__opt && !v.__tool && !v.__partial;
  // A string read in part: { __partial: true, v: 'known parts … with …', lost: [literals] }.
  const partial = (v, lost) => ({ __unk: true, __partial: true, v, lost: capLost(lost) });
  function concatPartial(a, b) {
    const part = (x) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : x && x.__partial ? x.v : '…');
    const lost = [].concat(isUnk(a) ? a.lost : [], isUnk(b) ? b.lost : []);
    const v = part(a) + part(b);
    return partial(v.slice(0, MAX_STR), lost);
  }

  Repo.prototype.ident = function (name, sc, at, depth) {
    if (name === 'true') return true; if (name === 'false') return false; if (name === 'nil') return null;
    for (let s = sc; s; s = s.parent) {
      if (s.vars.has(name)) {
        let v = this.binding(s.vars.get(name), name, depth);
        if (s.body && s.fn && v && (v.__struct || isPlain(v))) {
          const loc = this.locals(s.f, s.body).get(name);
          const sets = loc ? loc.filter((x) => x.op === 'field' && (at === undefined || x.at < at)) : [];
          if (sets.length) { if (loc.some((x) => x.op !== 'field' && (at === undefined || x.at < at))) return this.localValue(loc.filter((x) => at === undefined || x.at < at), s, name, depth); sets.forEach((x) => { v = this.withField(v, x.path, this.ev(s.f.P.expr(x.a, x.b).n, s, depth + 1), x.conds.length > 0); }); }
        }
        return v;
      }
      if (s.body && s.fn) {
        const loc = this.locals(s.f, s.body).get(name);
        if (loc) {
          // the assignments before this place, not the one whose right-hand side holds it (opts = append(opts, …))
          const before = loc.filter((x) => at === undefined || (x.at < at && !(x.a <= at && at < x.b)));
          if (before.length) return this.localValue(before, s, name, depth, sc, at);
        }
      }
      if (s.isPkg) {
        const pk = s.pkg;
        if (pk.consts.has(name)) return this.declValue(pk.consts.get(name), depth);
        if (pk.vars.has(name)) return this.declValue(pk.vars.get(name), depth);
        if (pk.funcs.has(name)) return { __fn: pk.funcs.get(name)[0], scope: null };
      }
    }
    return UNK();
  };
  Repo.prototype.binding = function (b, name, depth) {
    if ('val' in b) return b.val;
    if (b.node) { if (b.busy) return UNK(); b.busy = true; try { const v = this.ev(b.node, b.scope, depth + 1); b.val = v; return v; } finally { b.busy = false; } }
    if (b.list) return b.list;
    return UNK();
  };
  Repo.prototype.localValue = function (assigns, home, name, depth, from, at) {
    // home: the function's scope (its file and body); from: the scope the name was looked up in (a loop's scope);
    // at: where it is read (a block that also holds that place is not a condition of the assignments in it)
    const sc = from && from.f === home.f ? from : home;
    const key = '__l' + assigns[assigns.length - 1].at + ':' + name + ':' + (at === undefined ? '' : at); sc.cache = sc.cache || new Map();
    if (sc.cache.has(key)) return sc.cache.get(key);
    sc.cache.set(key, UNK());
    // in order; an assignment under an if whose condition is known false is skipped, one under an unknown
    // condition (or a loop) makes the value unknown when it would change it
    let v;
    for (const a of assigns) {
      let state = true; let paramCond = null;
      for (const c of a.conds) {
        if (at !== undefined && c.open !== undefined && c.open < at && at < c.close) continue; // the read is in this block too
        if (c.unknown) { state = null; continue; }
        const r = this.ev(sc.f.P.expr(c.cond[0], c.cond[1]).n, sc, depth + 1);
        if (isParam(r)) paramCond = r;
        const b = typeof r === 'boolean' ? (c.neg ? !r : r) : null;
        if (b === false) { state = false; break; }
        if (b === null) state = null;
      }
      if (state === false) continue;
      if (a.op === 'field') { if (v !== undefined) v = this.withField(v, a.path, this.ev(sc.f.P.expr(a.a, a.b).n, sc, depth + 1), state === null); continue; }
      let x;
      if (a.op === 'zero' || a.op === 'range') x = a.op === 'zero' ? undefined : UNK();
      else if (a.count && a.count > 1) x = this.multi(sc.f.P.expr(a.a, a.b).n, sc, a.idx, depth);
      else x = this.ev(sc.f.P.expr(a.a, a.b).n, sc, depth + 1);
      let nv;
      if (a.op === 'zero') nv = '';
      else if (a.op === '+=' && v !== undefined) nv = typeof v === 'string' && typeof x === 'string' ? v + x : concatPartial(v, x);
      else nv = x;
      const same = (x, y) => x === y || (!!x && !!y && ((x.__opt && x.n === y.n) || (x.__arg && x.n === y.n) || (isUnk(x) && isUnk(y))));
      let prefix = 0;
      if (state === null && Array.isArray(v) && Array.isArray(nv)) while (prefix < v.length && prefix < nv.length && same(nv[prefix], v[prefix])) prefix++;
      if (state === null && Array.isArray(v) && Array.isArray(nv) && prefix > 0) {
        // x = append(x, …) under a condition or in a loop: what both have in common stays, and more may follow
        v = v.slice(0, prefix); if (!isUnk(v[v.length - 1])) v.push(UNK());
      } else if (state === null && paramCond && v !== undefined && !(typeof nv === 'string' && nv === v)) v = paramCond; // depends on a parameter: a helper
      else if (state === null && v !== undefined && !(typeof nv === 'string' && nv === v)) {
        const lost = [].concat(typeof v === 'string' ? [v] : isUnk(v) ? v.lost : [], typeof nv === 'string' ? [nv] : isUnk(nv) ? nv.lost : []);
        v = UNK(lost);
      } else v = nv;
    }
    sc.cache.set(key, v === undefined ? UNK() : v);
    return v === undefined ? UNK() : v;
  };
  // A copy of a struct (or map) value with one field path set (unknown when the set is conditional and changes it).
  Repo.prototype.withField = function (v, path, x, conditional) {
    if (!v || !(v.__struct || isPlain(v))) return v;
    const copy = (o) => (o && o.__struct ? Object.assign({}, o, { f: Object.assign({}, o.f) }) : isPlain(o) ? Object.assign({}, o) : o);
    const out = copy(v); let cur = out;
    for (let k = 0; k < path.length; k++) {
      const key = path[k]; const bag = cur.__struct ? cur.f : cur;
      if (k === path.length - 1) { const old = bag[key]; bag[key] = conditional && old !== x ? UNK([].concat(typeof old === 'string' ? [old] : [], typeof x === 'string' ? [x] : [])) : x; break; }
      const next = copy(bag[key]); if (!next || !(next.__struct || isPlain(next))) return out;
      bag[key] = next; cur = next;
    }
    return out;
  };
  // The idx-th value of a call returning several (a, b := f()): the function's return list when it is read.
  Repo.prototype.multi = function (n, sc, idx, depth) {
    if (n.k !== 'call') return UNK();
    const fn = this.ev(n.fn, sc, depth + 1);
    if (fn && fn.__fn && fn.__fn.body) { const r = this.inlineReturn(fn.__fn, n, sc, depth + 1, idx); if (r !== undefined) return r; }
    return UNK(literals(n));
  };
  Repo.prototype.declValue = function (d, depth) {
    if (d.__busy) return UNK();
    if ('__val' in d) return d.__val;
    if (d.embed && !d.value) { d.__val = { __unk: true, lost: [], embed: d.embed }; return d.__val; }
    if (!d.value) { d.__val = d.type && d.type.k === 'tname' && d.type.v === 'string' ? '' : UNK(); return d.__val; }
    d.__busy = true;
    try { const n = d.file.P.expr(d.value.a, d.value.b).n; d.node = n; d.__val = this.ev(n, this.pkgScope(d.file.pkg, d.file), depth + 1); }
    catch (e) { if (e instanceof OverBudget) throw e; d.__val = UNK(); }
    finally { d.__busy = false; }
    return d.__val;
  };
  Repo.prototype.select = function (n, sc, depth) {
    // pkg.Name of a repository package, or a field of a struct literal / key of a map
    if (n.x.k === 'id') {
      const q = this.qual(sc.f, n.x.v);
      const local = sc.lookup(n.x.v) || (sc.fn && sc.body && this.locals(sc.f, sc.body).has(n.x.v));
      if (q && !local) {
        if (q.pkg) {
          const pk = q.pkg;
          if (pk.consts.has(n.v)) return this.declValue(pk.consts.get(n.v), depth);
          if (pk.vars.has(n.v)) return this.declValue(pk.vars.get(n.v), depth);
          if (pk.funcs.has(n.v)) return { __fn: pk.funcs.get(n.v)[0], scope: null };
          return UNK();
        }
        return { __ext: true, q, v: n.v };
      }
    }
    const base = this.ev(n.x, sc, depth + 1);
    if (base && base.__struct) {
      const pf = promoted(base, n.v); if (pf !== undefined) return pf;
      const pk = base.def && base.def.pkg || sc.pkg; const ms = pk && pk.methods.get(n.v);
      if (ms && ms.length) return { __fn: ms.find((m) => m.recvType === (base.type && base.type.name)) || ms[0], scope: null };
      return UNK();
    }
    if (isPlain(base) && Object.prototype.hasOwnProperty.call(base, n.v)) return base[n.v];
    if (isParam(base)) {
      // a method value of the receiver (s.handleX), or a field of a parameter: the method when the package has one
      const ms = sc.pkg && sc.pkg.methods.get(n.v);
      if (ms && ms.length) return { __fn: ms[0], scope: null };
      return PARAM(base.owner, base.name, base.path.concat([n.v]));
    }
    const ms = sc.pkg && sc.pkg.methods.get(n.v);
    if (ms && ms.length && (base === undefined || isUnk(base))) return { __fn: ms[0], scope: null, method: true };
    return UNK();
  };

  // Calls: known helpers, the SDK's options, repository functions (inlined when they return one expression).
  const BASIC_CONV = new Set(['string', 'bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'byte', 'rune', 'any']);
  const PTR_FN = /^(new|To|ToPtr|Ptr|ToBoolPtr|BoolPtr|Bool|StringPtr|IntPtr|Int|Int64|Float64|String|ptr|boolPtr|strPtr|stringPtr|intPtr|toPtr|pointerTo|PointerTo|Of|ValueOf)$/;
  Repo.prototype.call = function (n, sc, depth) {
    const fnNode = n.fn;
    const name = fnNode.k === 'id' ? fnNode.v : fnNode.k === 'sel' ? fnNode.v : fnNode.k === 'index' && fnNode.x ? (fnNode.x.k === 'sel' ? fnNode.x.v : fnNode.x.k === 'id' ? fnNode.x.v : null) : null;
    const qualName = fnNode.k === 'sel' && fnNode.x.k === 'id' ? fnNode.x.v : fnNode.k === 'index' && fnNode.x && fnNode.x.k === 'sel' && fnNode.x.x.k === 'id' ? fnNode.x.x.v : null;
    const q = qualName ? this.qual(sc.f, qualName) : null;
    const args = n.args;
    const A = (k) => (args[k] ? this.ev(args[k], sc, depth + 1) : undefined);
    // conversions and pure helpers
    if (fnNode.k === 'tslice' || (fnNode.k === 'paren' && fnNode.x && fnNode.x.k === 'tslice')) { const v = A(0); return typeof v === 'string' ? v : v; }
    if (fnNode.k === 'id' && BASIC_CONV.has(name) && args.length === 1 && !sc.lookup(name)) return A(0); // float64(x), string(x), …
    if (fnNode.k === 'id' && name === 'append' && args.length >= 1 && !sc.lookup(name)) {
      // append(slice, x, y) / append(slice, xs...): the elements in order; an unknown part stays as an unknown element
      const base = A(0); const out = Array.isArray(base) ? base.slice() : [base === null ? [] : base].filter((x) => !Array.isArray(x) || x.length);
      if (n.spread && args.length === 2) { const xs = A(1); if (Array.isArray(xs)) out.push(...xs); else out.push(isUnk(xs) ? xs : UNK(literals(args[1]))); }
      else args.slice(1).forEach((a) => out.push({ __arg: true, n: a, sc }));
      return out;
    }
    if ((name === 'RawMessage' || (name === 'Value' && qualName === 'jsontext')) && args.length === 1) { const v = A(0); return typeof v === 'string' ? jsonOrUnk(v) : isPlain(v) ? v : UNK(literals(n)); }
    if (name === 'MustMarshal' || (name === 'Marshal' && qualName === 'json')) { const v = A(0); return isPlain(v) || Array.isArray(v) ? v : UNK(literals(n)); }
    if (args.length === 1 && PTR_FN.test(name || '') && (!q || !q.pkg)) { const v = A(0); if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' || isParam(v)) return v; if (name === 'new') return v; }
    if (qualName === 'strings' && q && !q.pkg) {
      if (name === 'Join' && args.length === 2) { const a = A(0); const s = A(1); if (Array.isArray(a) && a.every((x) => typeof x === 'string') && typeof s === 'string') return a.join(s); return UNK(literals(n)); }
      if (/^(TrimSpace|ToLower|ToUpper|Title)$/.test(name) && args.length === 1) { const v = A(0); if (typeof v !== 'string') return isParam(v) ? v : UNK(literals(n)); return name === 'TrimSpace' ? v.trim() : name === 'ToLower' ? v.toLowerCase() : name === 'ToUpper' ? v.toUpperCase() : v; }
      if (/^(ReplaceAll|Replace)$/.test(name) && args.length >= 3) { const v = A(0); const a = A(1); const b = A(2); if ([v, a, b].every((x) => typeof x === 'string')) return v.split(a).join(b); return UNK(literals(n)); }
      if (name === 'TrimPrefix' || name === 'TrimSuffix') { const v = A(0); const a = A(1); if (typeof v === 'string' && typeof a === 'string') return name === 'TrimPrefix' ? (v.startsWith(a) ? v.slice(a.length) : v) : (v.endsWith(a) ? v.slice(0, v.length - a.length) : v); return UNK(literals(n)); }
    }
    if ((name === 'Sprintf' || name === 'Sprint') && qualName === 'fmt') return this.sprintf(n, sc, depth, name === 'Sprint');
    if (/^(Doc|Docf|Dedent|Dedentf)$/.test(name || '') && args.length >= 1 && (!q || !q.pkg)) { const v = A(0); if (typeof v === 'string' && args.length === 1) return heredoc(v); return isParam(v) ? v : UNK(literals(n)); }
    // the SDK's options and property options: kept as option values, applied by the tool builder
    if (name && (TOOL_OPTS.has(name) || PROP_OPTS.has(name)) && (!q || !q.pkg || !this.repoFn(q.pkg, name))) {
      const targs = fnNode.k === 'index' ? fnNode.idx : null;
      return { __opt: name, args: args.map((a) => ({ n: a, sc })), spread: n.spread, targs, n, sc };
    }
    // a repository function
    const fn = this.ev(fnNode, sc, depth + 1);
    if (fn && fn.__fn) {
      if (fn.__fn.lit) return this.inlineLit(fn, n, sc, depth);
      const d = fn.__fn;
      if (this.wrappers && this.wrappers.has(d)) return { __toolcall: true, d, n, sc };
      if (d.body) { const r = this.inlineReturn(d, n, sc, depth + 1, 0); if (r !== undefined) return r; }
    }
    if (fn && fn.__ext) {
      // an option of another package named like the SDK's: kept as an option (WithTitleAnnotation of a helper package)
      if (TOOL_OPTS.has(fn.v) || PROP_OPTS.has(fn.v) || ((fn.v === 'Input' || fn.v === 'Property') && fn.q && fn.q.sdk)) return { __opt: fn.v, args: args.map((a) => ({ n: a, sc })), spread: n.spread, targs: null, n, sc };
    }
    if (isParam(fn)) {
      // a function value whose type says it returns a default (func(key string, defaultValue string) string, as
      // translation helpers are declared): the default, which is what the server sends unless it is configured
      const d = this.defaultArgOf(fn, sc);
      if (d >= 0 && args[d]) return A(d);
      return UNK(literals(n));
    }
    return UNK(literals(n));
  };
  Repo.prototype.defaultArgOf = function (p, sc) {
    const owner = p.owner; if (!owner || !owner.sig) return -1;
    const decl = owner.sig.params.find((x) => x.name === p.name); if (!decl || !decl.type) return -1;
    let ty = decl.type;
    for (let k = 0; k < 4 && ty && ty.k === 'tname'; k++) { const d = this.typeDef({ pkg: ty.pkg, name: ty.v }, owner.file || sc.f); if (!d) return -1; ty = d.def; }
    if (!ty || ty.k !== 'tfunc' || !ty.sig) return -1;
    const ps = ty.sig.params;
    if (ps.length < 2 || !ty.sig.results.length) return -1;
    const last = ps[ps.length - 1];
    return last.name && /^default/i.test(last.name) ? ps.length - 1 : -1;
  };
  Repo.prototype.repoFn = function (pkg, name) { return pkg && pkg.funcs.has(name) ? pkg.funcs.get(name)[0] : null; };
  // A function literal called directly or passed as an option: its result when it returns one expression.
  Repo.prototype.inlineLit = function (fn, n, sc, depth) {
    const lit = fn.__fn.lit; const f = fn.__fn.f;
    const decl = { sig: lit.sig, body: lit.body, file: f, pkg: f.pkg, name: '(func literal)' };
    const r = this.inlineReturn(decl, n, sc, depth + 1, 0, fn.scope);
    return r === undefined ? UNK(literals(n)) : r;
  };
  // Follow a repository function: bind its parameters to the call's arguments, return its single return value.
  Repo.prototype.inlineReturn = function (d, n, sc, depth, idx, parentScope) {
    if (depth > MAX_DEPTH || (sc.callDepth || 0) >= MAX_CALL_DEPTH) return undefined;
    const rets = this.returns(d); if (!rets.length) return undefined;
    const inner = this.bindCall(d, n, sc, parentScope);
    // several return statements (an override, a fallback): one value when the known ones agree (an empty string
    // gives way to a non-empty one); different values are not guessed between
    const vals = [];
    for (const r of rets.slice(0, 6)) {
      const parts = splitCommas(d.file, r[0], r[1]);
      const part = parts[idx] || (parts.length === 1 && idx === 0 ? parts[0] : null); if (!part) continue;
      const v = this.ev(d.file.P.expr(part[0], part[1]).n, inner, depth + 1);
      if (v === null) continue;
      vals.push(v);
    }
    if (!vals.length) return undefined;
    const known = vals.filter((v) => !isUnk(v));
    if (!known.length) return vals[0];
    if (known.every((v) => typeof v === 'string')) {
      const ne = Array.from(new Set(known.filter((v) => v !== '')));
      if (ne.length === 1) return ne[0];
      if (!ne.length) return '';
      return UNK(ne);
    }
    return known[0];
  };
  // The return statements of a function body that are not inside a nested function literal: [[a, b)].
  Repo.prototype.returns = function (d) {
    if (d.__rets) return d.__rets;
    const f = d.file; const t = f.t; const out = []; if (!d.body) return (d.__rets = out);
    for (let k = d.body[0] + 1; k < d.body[1]; k++) {
      this.step();
      const x = t[k];
      if (isId(x, 'func') && !isP(t[k - 1], '.')) { // skip a nested function literal's body
        let j = k + 1; if (isP(t[j], '(')) { const c = f.close[j]; if (c > 0) j = c + 1; }
        for (let q = j; q < d.body[1] && q < j + 64; q++) { if (isP(t[q], '{')) { const c = f.close[q]; if (c > 0) { k = c; } break; } if (isP(t[q], '(')) { const c = f.close[q]; if (c > 0) q = c; } }
        continue;
      }
      if (isId(x, 'return')) { const e = stmtEnd(f, k + 1, d.body[1]); if (e > k + 1) out.push([k + 1, e]); k = e; }
    }
    return (d.__rets = out);
  };
  Repo.prototype.bindCall = function (d, n, sc, parentScope) {
    const params = d.sig ? d.sig.params : [];
    const args = n.args;
    const inner = this.fnScope(d, parentScope || this.pkgScope(d.pkg, d.file), (p, k) => {
      if (p.variadic) {
        if (n.spread && args.length === k + 1) return { node: args[k], scope: sc, spreadOf: true };
        return { list: args.slice(k).map((a) => ({ __arg: true, n: a, sc })) };
      }
      return args[k] ? { node: args[k], scope: sc } : { val: UNK() };
    });
    inner.callDepth = (sc.callDepth || 0) + 1;
    void params;
    return inner;
  };
  Repo.prototype.sprintf = function (n, sc, depth, plain) {
    const vals = n.args.map((a) => this.ev(a, sc, depth + 1));
    if (vals.some(isParam)) return vals.find(isParam);
    if (plain) { if (vals.every((v) => typeof v === 'string' || typeof v === 'number')) return vals.join(''); return UNK(literals(n)); }
    const fmt = vals[0];
    if (typeof fmt !== 'string') return UNK(literals(n));
    let k = 1; let ok = true;
    const out = fmt.replace(/%([-+# 0]*\d*(?:\.\d+)?)([a-zA-Z%])/g, (m, fl, verb) => {
      if (verb === '%') return '%';
      const v = vals[k++];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return verb === 'q' ? JSON.stringify(String(v)) : String(v);
      ok = false; return '…';
    });
    if (ok) return out;
    return partial(out, literals(n).slice(1));
  };
  function heredoc(s) {
    const lines = s.replace(/^\n/, '').split('\n');
    const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length).concat([1e9]));
    return lines.map((l) => (ind < 1e9 ? l.slice(ind) : l)).join('\n').replace(/\s+$/, '') + (s.endsWith('\n') ? '\n' : '');
  }
  const hasProps = (j) => !!j && typeof j === 'object' && !!j.properties && typeof j.properties === 'object' && Object.keys(j.properties).length > 0;
  function jsonOrUnk(s) { try { return JSON.parse(s); } catch (e) { return UNK([s]); } }

  // Composite literals: a struct (with its type), a map (plain object), or a slice (array).
  Repo.prototype.literal = function (n, sc, depth, hint) {
    const ty = n.type || hint || null;
    const base = ty && ty.k === 'tptr' ? ty.x : ty;
    if (base && (base.k === 'tslice' || base.k === 'tarray')) {
      return n.elems.map((e) => (e.value.k === 'lit' && !e.value.type ? this.literal(e.value, sc, depth + 1, base.x) : this.ev(e.value, sc, depth + 1)));
    }
    if (base && base.k === 'tmap') {
      const o = {};
      n.elems.forEach((e) => {
        const k = e.key ? (e.key.k === 'lit' ? UNK() : this.ev(e.key, sc, depth + 1)) : UNK();
        const v = e.value.k === 'lit' && !e.value.type ? this.literal(e.value, sc, depth + 1, base.x) : this.ev(e.value, sc, depth + 1);
        if (typeof k === 'string' || typeof k === 'number') o[k] = v; else { o.__unkKeys = (o.__unkKeys || []).concat([v]); }
      });
      return o;
    }
    // a struct (named type, or an unnamed literal of an element type)
    const tn = base && (base.k === 'tname' || base.k === 'id' || base.k === 'sel') ? typeName(base) : base && base.k === 'index' ? typeName(base.x) : null;
    const st = { __struct: true, type: tn ? Object.assign({}, tn, { sdk: tn.pkg ? (this.qual(sc.f, tn.pkg) || {}).sdk || null : null }) : null, f: {}, pos: n.s, file: sc.f, elemType: null };
    const def = tn ? this.typeDef(tn, sc.f) : base && base.k === 'tstruct' ? { def: base, pkg: sc.f.pkg, file: sc.f } : null;
    const fieldType = (name) => { if (!def || !def.def || def.def.k !== 'tstruct') return null; const fd = def.def.fields.find((x) => x.name === name); return fd ? fd.type : null; };
    const positional = [];
    n.elems.forEach((e) => {
      if (e.key && e.key.k === 'id') {
        const ft = fieldType(e.key.v) || sdkFieldType(tn, e.key.v);
        st.f[e.key.v] = e.value.k === 'lit' && !e.value.type ? this.literal(e.value, sc, depth + 1, ft) : this.ev(e.value, sc, depth + 1);
        if (e.value.k === 'lit' && e.value.type === null && ft) st.f[e.key.v + '$t'] = ft;
      } else positional.push(e.value.k === 'lit' && !e.value.type ? this.literal(e.value, sc, depth + 1, null) : this.ev(e.value, sc, depth + 1));
    });
    if (positional.length && def && def.def && def.def.k === 'tstruct') def.def.fields.forEach((fd, k) => { if (k < positional.length && fd.name) st.f[fd.name] = positional[k]; });
    else if (positional.length) st.positional = positional;
    st.def = def;
    return st;
  };
  function typeName(n) {
    if (!n) return null;
    if (n.k === 'tname') return { pkg: n.pkg, name: n.v };
    if (n.k === 'id') return { pkg: null, name: n.v };
    if (n.k === 'sel' && n.x.k === 'id') return { pkg: n.x.v, name: n.v };
    return null;
  }
  // Element types of the SDK's structs, for elided literals ("x": {Type: "string"} in map[string]*jsonschema.Schema).
  function sdkFieldType(tn, field) {
    if (!tn) return null;
    const schema = { k: 'tptr', x: { k: 'tname', pkg: 'jsonschema', v: 'Schema' } };
    if (tn.name === 'Schema') {
      if (/^(Properties|Defs|Definitions|PatternProperties|DependentSchemas)$/.test(field)) return { k: 'tmap', key: { k: 'tname', v: 'string' }, x: schema };
      if (/^(AnyOf|OneOf|AllOf|PrefixItems)$/.test(field)) return { k: 'tslice', x: schema };
      if (/^(Items|AdditionalProperties|Not|If|Then|Else|Contains|PropertyNames|UnevaluatedProperties|UnevaluatedItems)$/.test(field)) return schema;
    }
    return null;
  }
  // The definition of a named type of the repository: { def: type node, pkg, file, tparams } or null.
  Repo.prototype.typeDef = function (tn, f) {
    let pk = f.pkg;
    if (tn.pkg) { const q = this.qual(f, tn.pkg); pk = q && q.pkg; if (!pk) return null; }
    const d = pk && pk.types.get(tn.name);
    return d ? { def: d.type, pkg: pk, file: d.file, tparams: d.tparams, name: tn.name } : null;
  };

  // ------------------------------------------------------------ JSON from Go values
  // To JSON: struct literals by their field names (the SDK's mapping, the repository type's json tags, else lowerCamel),
  // maps and slices as they are. Parts that are not known set c.unk and keep their literals in c.lost.
  Repo.prototype.toJson = function (v, c, depth) {
    depth = depth || 0;
    if (depth > MAX_JSON_DEPTH) { c.unk = true; if (v && typeof v === 'object' && !v.__unk && !v.__struct && !v.__fn && !v.__tool && !v.__type && !v.__opt) c.lost.push(...stringsOf(v).filter((x) => typeof x === 'string')); return TOO_DEEP; }
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v === undefined) { c.unk = true; return undefined; }
    if (isUnk(v)) { c.unk = true; if (v.lost) c.lost.push(...v.lost); if (v.__partial) c.lost.push(v.v); return undefined; }
    if (isParam(v)) { c.unk = true; return undefined; }
    if (Array.isArray(v)) return v.map((x) => this.toJson(x && x.__arg ? this.ev(x.n, x.sc) : x, c, depth + 1)).filter((x) => x !== undefined);
    if (v.__struct) {
      const o = {}; const tags = jsonTagsOf(v.def);
      Object.keys(v.f).forEach((k) => {
        if (/\$t$/.test(k)) return;
        if (k === 'Extra' || k === 'Extras' || k === 'AdditionalFields') { const x = this.toJson(v.f[k], c, depth + 1); if (x && typeof x === 'object') Object.assign(o, x); return; }
        const tag = tags && tags[k];
        if (tag === '-' || (!tags && lowerCamel(k) === '-')) return;
        const key = tag ? tag.name : lowerCamel(k);
        const x = this.toJson(v.f[k], c, depth + 1);
        if (x === undefined) return;
        if (tag && tag.omitempty && (x === '' || x === 0 || x === false || x === null || (Array.isArray(x) && !x.length))) return;
        o[key] = x;
      });
      // jsonschema.Schema{Not: &jsonschema.Schema{}} is the false schema (how jsonschema-go writes additionalProperties: false)
      if (v.type && v.type.name === 'Schema' && Object.keys(o).length === 1 && o.not && typeof o.not === 'object' && !Object.keys(o.not).length) return false;
      return o;
    }
    if (v.__fn || v.__opt || v.__toolcall || v.__ext) { c.unk = true; return undefined; }
    if (typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach((k) => { if (k === '__unkKeys') { c.unk = true; v[k].forEach((x) => this.toJson(x, c, depth + 1)); return; } const x = this.toJson(v[k], c, depth + 1); if (x !== undefined) o[k] = x; });
      return o;
    }
    c.unk = true; return undefined;
  };
  function jsonTagsOf(def) {
    if (!def || !def.def || def.def.k !== 'tstruct') return null;
    const o = {};
    def.def.fields.forEach((fd) => { if (!fd.name) return; const j = fd.tag && fd.tag.json; if (j === undefined) return; const parts = j.split(','); o[fd.name] = parts[0] === '-' && parts.length === 1 ? '-' : { name: parts[0] || fd.name, omitempty: parts.includes('omitempty') || parts.includes('omitzero') }; });
    return o;
  }

  // ------------------------------------------------------------ schemas from Go types (reflection, as the libraries do)
  // dialect 'google' (google/jsonschema-go: go-sdk, mcp-go WithInputSchema): the jsonschema tag is the description,
  // fields without omitempty/omitzero are required, structs get additionalProperties: false, pointers and slices allow null.
  // dialect 'invopop' (invopop/jsonschema as mcp-golang and its followers configure it): `jsonschema:"required,
  // description=…,enum=…"` tags, required only when tagged, nested structs inlined, no additionalProperties.
  // A struct whose tags use key=value forms is read as invopop whatever the call site.
  Repo.prototype.typeSchema = function (ty, f, ctx, depth) {
    this.step();
    depth = depth || 0;
    if (!ty || depth > 12) { ctx.unknownTypes++; return {}; }
    // 'plain' and 'invopop': a pointer is its element type
    const nullable = (s) => { if (ctx.dialect !== 'google') return s; if (typeof s.type === 'string') return Object.assign({}, s, { type: ['null', s.type] }); return s; };
    switch (ty.k) {
      case 'tptr': { const s = this.typeSchema(ty.x, f, ctx, depth + 1); return ty.x && (ty.x.k === 'tname' && /^(Time|Duration)$/.test(ty.x.v)) ? s : nullable(s); }
      case 'tslice': case 'tarray': {
        if (ty.x && ty.x.k === 'tname' && ty.x.v === 'byte' && !ty.x.pkg) return { type: 'string' };
        const s = { type: ctx.dialect === 'google' && ty.k === 'tslice' ? ['null', 'array'] : 'array', items: this.typeSchema(ty.x, f, ctx, depth + 1) };
        if (ty.k === 'tarray' && typeof ty.len === 'number') { s.minItems = ty.len; s.maxItems = ty.len; }
        return s;
      }
      case 'tmap': return { type: 'object', additionalProperties: this.typeSchema(ty.x, f, ctx, depth + 1) };
      case 'tiface': return {};
      case 'tstruct': return this.structSchema({ def: ty, pkg: f.pkg, file: f }, ctx, depth + 1);
      case 'tname': {
        if (!ty.pkg) {
          const b = BASIC[ty.v]; if (b) return Object.assign({}, ctx.dialect === 'google' ? b : { type: b.type });
          if (ty.v === 'any' || ty.v === 'error') return {};
        } else if (ty.pkg === 'time' && ty.v === 'Time') return { type: 'string' }; // as google/jsonschema-go lists it (no format)
        else if (ty.pkg === 'time' && ty.v === 'Duration') return { type: 'integer' };
        else if (ty.pkg === 'json' && ty.v === 'RawMessage') return {};
        const d = this.typeDef({ pkg: ty.pkg, name: ty.v }, f);
        if (!d) { ctx.unknownTypes++; return {}; }
        const key = d.pkg.dir + '.' + ty.v;
        if (ctx.seen.has(key)) return {};
        ctx.seen.add(key);
        try {
          if (d.def && d.def.k === 'tstruct') return this.structSchema(d, ctx, depth + 1);
          return this.typeSchema(d.def, d.file, ctx, depth + 1);
        } finally { ctx.seen.delete(key); }
      }
      default: ctx.unknownTypes++; return {};
    }
  };
  const BASIC = { string: { type: 'string' }, bool: { type: 'boolean' }, int: { type: 'integer' }, int64: { type: 'integer' }, uint: { type: 'integer', minimum: 0 }, uint64: { type: 'integer', minimum: 0 }, uintptr: { type: 'integer', minimum: 0 }, int8: { type: 'integer', minimum: -128, maximum: 127 }, uint8: { type: 'integer', minimum: 0, maximum: 255 }, byte: { type: 'integer', minimum: 0, maximum: 255 }, int16: { type: 'integer', minimum: -32768, maximum: 32767 }, uint16: { type: 'integer', minimum: 0, maximum: 65535 }, int32: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, rune: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, uint32: { type: 'integer', minimum: 0, maximum: 4294967295 }, float32: { type: 'number' }, float64: { type: 'number' } };
  const INVOPOP_TAG = /(^|,)(required|nullable|-|description=|title=|enum=|default=|minimum=|maximum=|exclusiveMinimum=|exclusiveMaximum=|multipleOf=|minLength=|maxLength=|pattern=|format=|minItems=|maxItems=|uniqueItems|example=|const=|type=|oneof_required=|anyof_required=|readOnly|writeOnly)/;
  function structUsesInvopop(def) { return !!def && def.k === 'tstruct' && def.fields.some((fd) => fd.tag && ((fd.tag.jsonschema && INVOPOP_TAG.test(fd.tag.jsonschema)) || fd.tag.jsonschema_description !== undefined || fd.tag.jsonschema_extras !== undefined)); }
  Repo.prototype.structSchema = function (d, ctx, depth) {
    const def = d.def; const f = d.file;
    const dialect = structUsesInvopop(def) ? 'invopop' : ctx.dialect;
    const c2 = dialect === ctx.dialect ? ctx : Object.assign({}, ctx, { dialect });
    const props = {}; const required = [];
    const addFields = (sdef, sf, level) => {
      if (level > 6) return;
      sdef.fields.forEach((fd) => {
        const j = fd.tag && fd.tag.json !== undefined ? fd.tag.json.split(',') : null;
        if (j && j[0] === '-' && j.length === 1) return;
        if (fd.embedded && (!j || !j[0])) { // promoted fields of an embedded struct
          const base = fd.type && fd.type.k === 'tptr' ? fd.type.x : fd.type;
          const ed = base && base.k === 'tname' ? this.typeDef({ pkg: base.pkg, name: base.v }, sf) : null;
          if (ed && ed.def && ed.def.k === 'tstruct') addFields(ed.def, ed.file, level + 1); else c2.unknownTypes++;
          return;
        }
        if (!fd.name || !/^\p{Lu}/u.test(fd.name)) return; // unexported
        const name = (j && j[0]) || fd.name;
        const opts = j ? j.slice(1) : [];
        let s = this.typeSchema(fd.type, sf, c2, depth + 1);
        s = Object.assign({}, s);
        let req;
        if (dialect === 'invopop') {
          const tag = fd.tag.jsonschema || '';
          const parts = splitTag(tag);
          req = parts.includes('required');
          parts.forEach((p) => {
            const m = /^([A-Za-z_]+)=([\s\S]*)$/.exec(p); if (!m) return;
            const k = m[1]; const val = m[2];
            if (k === 'description' || k === 'title' || k === 'pattern' || k === 'format') s[k] = val;
            else if (/^(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems)$/.test(k)) { const x = Number(val); if (Number.isFinite(x)) s[k] = x; }
            else if (k === 'enum') { s.enum = (s.enum || []).concat([s.type === 'integer' || s.type === 'number' ? Number(val) : val]); }
            else if (k === 'default') s.default = s.type === 'integer' || s.type === 'number' ? Number(val) : s.type === 'boolean' ? val === 'true' : val;
            else if (k === 'type') s.type = val;
          });
          if (fd.tag.jsonschema_description !== undefined) s.description = fd.tag.jsonschema_description;
          if (!fd.tag.jsonschema && c2.requiredFromTags === false) req = !opts.includes('omitempty') && !opts.includes('omitzero');
        } else {
          const tag = fd.tag && fd.tag.jsonschema;
          if (tag) s.description = tag;
          req = !opts.includes('omitempty') && !opts.includes('omitzero');
        }
        // tags some libraries read beside json: description:"…", required:"true", enum:"a,b"
        if (fd.tag && typeof fd.tag.description === 'string' && fd.tag.description && !s.description) s.description = fd.tag.description;
        if (fd.tag && /^(true|false)$/.test(fd.tag.required || '')) req = fd.tag.required === 'true';
        if (fd.tag && typeof fd.tag.enum === 'string' && fd.tag.enum && !s.enum) s.enum = fd.tag.enum.split(',').map((x) => x.trim()).map((x) => (s.type === 'integer' || s.type === 'number' ? Number(x) : x));
        if (!(name in props)) { props[name] = s; if (req) required.push(name); }
      });
    };
    addFields(def, f, 0);
    const out = { type: 'object', properties: props };
    if (required.length) out.required = required;
    if (dialect === 'google') out.additionalProperties = false;
    return out;
  };
  function splitTag(s) { const out = []; let cur = ''; for (let k = 0; k < s.length; k++) { if (s[k] === '\\' && s[k + 1] === ',') { cur += ','; k++; continue; } if (s[k] === ',') { out.push(cur); cur = ''; continue; } cur += s[k]; } out.push(cur); return out.map((x) => x.trim()).filter(Boolean); }

  // The struct type a handler takes as its input (and the one it returns, for go-sdk's output schema):
  // the last parameter that is not a context, request or session.
  Repo.prototype.handlerTypes = function (v, sc, depth) {
    depth = depth || 0; if (depth > 4 || !v) return null;
    let sig = null; let f = null;
    if (v.__fn) { if (v.__fn.lit) { sig = v.__fn.lit.sig; f = v.__fn.f; } else { sig = v.__fn.sig; f = v.__fn.file; } }
    else if (v.__toolcall) return null;
    if (!sig) return null;
    const generic = sig.params.map((p) => (p.type && p.type.k === 'tptr' ? p.type.x : p.type)).find((b) => b && b.k === 'tname' && /^(CallToolParamsFor|CallToolRequest|ServerRequest)$/.test(b.v) && b.targs && b.targs.length);
    const ps = sig.params.filter((p) => { const b = p.type && p.type.k === 'tptr' ? p.type.x : p.type; return !(b && b.k === 'tname' && CTX_TYPES.test(b.v)); });
    const input = generic ? generic.targs[0] : ps.length ? ps[ps.length - 1].type : null;
    const rs = sig.results.filter((r) => { const b = r.type && r.type.k === 'tptr' ? r.type.x : r.type; return !(b && b.k === 'tname' && (/^(error|CallToolResult|CallToolResultFor)$/.test(b.v))); });
    const isAny = (x) => !x || (x.k === 'tname' && !x.pkg && x.v === 'any') || x.k === 'tiface';
    const output = sig.results.length === 3 && rs.length && !isAny(sig.results[1].type) ? sig.results[1].type : null;
    return { input, output, f };
  };

  // ------------------------------------------------------------ building a tool
  // A tool being built: { name, title, description, input (schema object | null), required, props, annotations,
  // output, raw, unreadable: Set, lost: [] }. finish() gives the tools/list entry.
  function newState(flavour) {
    const st = { flavour, name: undefined, title: undefined, description: undefined, props: {}, required: [], input: null, inputSet: false, annotations: undefined, output: undefined, unreadable: new Set(), lost: [], icons: undefined };
    if (flavour === 'mcp-go') st.annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    return st;
  }
  Repo.prototype.str = function (v, st, part) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (isUnk(v)) { st.lost.push(...(v.lost || [])); if (part) st.unreadable.add(part); if (v.__partial) { st.lost.push(v.v); return v.v; } if (v.lost && v.lost.length && part === 'description') return v.lost.join(' … ').slice(0, MAX_STR); return undefined; }
    if (part) st.unreadable.add(part);
    return undefined;
  };
  Repo.prototype.argVal = function (a, depth) { return a && a.__arg ? this.ev(a.n, a.sc, depth) : a; };
  // The option values of a call's arguments, a spread list expanded.
  Repo.prototype.optionList = function (vals, st, depth) {
    const out = [];
    const walk = (v, d) => {
      if (d > 8) return;
      v = this.argVal(v, depth + 1);
      if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
      out.push(v);
    };
    vals.forEach((v) => walk(v, 0));
    void st;
    return out;
  };
  Repo.prototype.applyOption = function (o, st, depth) {
    this.step();
    if (depth > 48) { st.unreadable.add('inputSchema'); st.optsUnknown = true; return; } // options followed past 48 levels: any part may come from them
    o = this.argVal(o, depth + 1);
    if (o === null || o === undefined) return;
    if (o.__opt) return this.applyKnown(o, st, depth + 1);
    if (o.__fn) { // a ToolOption written as a function: apply what its body does to the tool
      return this.applyFnOption(o, st, depth + 1);
    }
    if (o.__toolcall) return;
    // an option the reader cannot see (a slice filled at run time): any part of the tool may come from it
    if (isUnk(o) || isParam(o)) { st.lost.push(...(o.lost || [])); st.unreadable.add('inputSchema'); st.unreadable.add('annotations'); st.optsUnknown = true; return; }
  };
  Repo.prototype.applyFnOption = function (o, st, depth) {
    const lit = o.__fn.lit; const f = lit ? o.__fn.f : o.__fn.file; const sig = lit ? lit.sig : o.__fn.sig; const body = lit ? lit.body : o.__fn.body;
    if (!body || !sig || !sig.params.length || !sig.params[0].name) { st.unreadable.add('inputSchema'); return; }
    const pname = sig.params[0].name; const t = f.t;
    const sc = new Scope(o.scope || this.pkgScope(f.pkg, f), f, f.pkg, { sig, body, file: f, pkg: f.pkg }); sc.body = body;
    sc.vars.set(pname, { val: PARAM(null, pname) });
    for (let k = body[0] + 1; k < body[1]; k++) {
      // <option>(t)  /  t.Field = value
      const x = t[k];
      if (isId(x, pname) && isP(t[k - 1], '(') && isP(t[k + 1], ')')) {
        // the call expression ends just before '(' at k-1: find its start (statement start)
        let s = k - 2; let open = k - 1;
        const stmtStart = (() => { for (let q = open - 1; q > body[0]; q--) { const y = t[q]; if (y.nl && (q === open - 1 || true)) { if (endsLine(t[q - 1]) || isP(t[q - 1], '{') || isP(t[q - 1], '}')) return q; } if (isP(y, '{') || isP(y, ';')) return q + 1; } return body[0] + 1; })();
        void s;
        const n = f.P.expr(stmtStart, open).n;
        if (n && n.k === 'call') this.applyOption(this.ev(n, sc, depth + 1), st, depth + 1);
        else if (n && n.k !== 'bad') { const v = this.ev(n, sc, depth + 1); if (v && (v.__opt || v.__fn)) this.applyOption(v, st, depth + 1); }
        continue;
      }
      if (isId(x, pname) && isP(t[k + 1], '.') && (x.nl || isP(t[k - 1], '{') || isP(t[k - 1], ';'))) {
        let j = k + 1; const path = [];
        while (isP(t[j], '.') && isId(t[j + 1])) { path.push(t[j + 1].v); j += 2; }
        if (isP(t[j], '=')) {
          const e = stmtEnd(f, j + 1, body[1]);
          const v = this.ev(f.P.expr(j + 1, e).n, sc, depth + 1);
          this.setField(st, path, v);
        }
      }
    }
  };
  Repo.prototype.setField = function (st, path, v) {
    const c = { unk: false, lost: [] };
    if (path[0] === 'Description' && path.length === 1) st.description = this.str(v, st, 'description');
    else if (path[0] === 'Title' && path.length === 1) st.title = this.str(v, st, null);
    else if (path[0] === 'Annotations') {
      if (path.length === 1) { const a = this.toJson(v, c); if (a && typeof a === 'object') st.annotations = a; if (c.unk) st.unreadable.add('annotations'); }
      else { st.annotations = st.annotations || {}; const x = this.toJson(v, c); if (x !== undefined) st.annotations[lowerCamel(path[1])] = x; else st.unreadable.add('annotations'); }
    } else if (path[0] === 'InputSchema' || path[0] === 'RawInputSchema') { st.unreadable.add('inputSchema'); }
    st.lost.push(...c.lost);
  };
  Repo.prototype.applyKnown = function (o, st, depth) {
    const name = o.__opt; const ev = (k) => (o.args[k] ? this.ev(o.args[k].n, o.args[k].sc, depth + 1) : undefined);
    const c = { unk: false, lost: [] };
    switch (name) {
      case 'WithDescription': st.description = this.str(ev(0), st, 'description'); return;
      case 'WithToolTitle': case 'WithTitle': st.title = this.str(ev(0), st, null); return;
      case 'WithTitleAnnotation': { const v = this.str(ev(0), st, 'annotations'); st.annotations = st.annotations || {}; if (v !== undefined) st.annotations.title = v; return; }
      case 'WithoutDefaultAnnotations': st.annotations = {}; return;
      case 'WithToolAnnotation': { const a = this.toJson(ev(0), c); st.lost.push(...c.lost); if (c.unk) st.unreadable.add('annotations'); if (a && typeof a === 'object') st.annotations = a; return; }
      case 'WithSchemaAdditionalProperties': { const v = this.toJson(ev(0), c); if (v !== undefined) st.additionalProperties = v; if (c.unk) st.unreadable.add('inputSchema'); return; }
      case 'WithRawInputSchema': case 'WithRawOutputSchema': {
        const v = ev(0); const s = typeof v === 'string' ? jsonOrUnk(v) : v; const j = this.toJson(s, c); st.lost.push(...c.lost);
        if (name === 'WithRawInputSchema') { if (j && typeof j === 'object' && !c.unk) { st.input = j; st.inputSet = true; } else { st.unreadable.add('inputSchema'); st.inputSet = true; } }
        else if (j && typeof j === 'object' && !c.unk) st.output = j;
        return;
      }
      case 'WithInputSchema': case 'WithOutputSchema': case 'WithCachedInputSchema': case 'WithCachedInputSchemaKey': case 'WithCachedOutputSchema': case 'WithCachedOutputSchemaKey': {
        const ty = o.targs && o.targs[0];
        const s = ty ? this.schemaFor(ty, o.sc.f, 'google') : null;
        if (/Input/.test(name)) { if (s && s.schema) { st.input = s.schema; st.inputSet = true; if (s.approx) st.approx = true; } else { st.unreadable.add('inputSchema'); st.inputSet = true; } }
        else if (s && s.schema) { const out = Object.assign({}, s.schema); delete out.additionalProperties; st.output = out; }
        return;
      }
      case 'WithDeferLoading': case 'WithTaskSupport': return;
      case 'WithToolIcons': return;
      default: break;
    }
    if (HINTS[name]) { const v = ev(0); st.annotations = st.annotations || {}; if (typeof v === 'boolean') st.annotations[HINTS[name]] = v; else st.unreadable.add('annotations'); return; }
    if (name in PROP_TYPE) {
      const pn = ev(0);
      if (typeof pn !== 'string') { st.unreadable.add('inputSchema'); if (isUnk(pn)) st.lost.push(...pn.lost); o.args.slice(1).forEach((a) => st.lost.push(...literals(a.n))); return; }
      const schema = PROP_TYPE[name] ? { type: PROP_TYPE[name] } : {};
      if (name === 'WithObject') schema.properties = {};
      let req = false;
      const popts = this.optionList(o.args.slice(1).map((a) => ({ __arg: true, n: a.n, sc: a.sc })), st, depth);
      if (o.spread && o.args.length > 1) { /* spread of a property option slice: optionList expanded it */ }
      popts.forEach((p) => { if (this.applyProp(p, schema, st, depth + 1)) req = true; });
      delete schema.__required;
      st.props[pn] = schema;
      if (req && !st.required.includes(pn)) st.required.push(pn);
      return;
    }
    // a property option outside a property: ignore
  };
  // Apply a property option to a property schema; true when it makes the property required.
  Repo.prototype.applyProp = function (p, schema, st, depth) {
    this.step();
    if (depth > 48) return false;
    p = this.argVal(p, depth + 1);
    if (!p) return false;
    if (p.__fn) return this.applyFnProp(p, schema, st, depth + 1);
    if (!p.__opt) { if (isUnk(p)) { st.lost.push(...(p.lost || [])); st.unreadable.add('inputSchema'); } return false; }
    const name = p.__opt; const ev = (k) => (p.args[k] ? this.ev(p.args[k].n, p.args[k].sc, depth + 1) : undefined);
    const c = { unk: false, lost: [] };
    if (name === 'Required') return true;
    if (name === 'Enum') {
      let vals;
      if (p.spread && p.args.length === 1) vals = ev(0); else vals = p.args.map((a, k) => ev(k));
      const j = this.toJson(Array.isArray(vals) ? vals : [vals], c); st.lost.push(...c.lost);
      if (Array.isArray(j) && !c.unk) schema.enum = j; else st.unreadable.add('inputSchema');
      return false;
    }
    if (name === 'WithStringEnumItems') { const j = this.toJson(ev(0), c); st.lost.push(...c.lost); if (Array.isArray(j) && !c.unk) schema.items = { type: 'string', enum: j }; else st.unreadable.add('inputSchema'); return false; }
    if (ITEM_TYPE[name]) {
      const items = { type: ITEM_TYPE[name] };
      this.optionList(p.args.map((a) => ({ __arg: true, n: a.n, sc: a.sc })), st, depth).forEach((q) => { this.applyProp(q, items, st, depth + 1); });
      schema.items = items; return false;
    }
    if (PROP_KEY[name]) {
      const v = ev(0); const j = this.toJson(v, c); st.lost.push(...c.lost);
      if (name === 'Description' || name === 'Title') { const s = this.str(v, st, null); if (s !== undefined) schema[PROP_KEY[name]] = s; if (typeof v !== 'string') st.unreadable.add('inputSchema'); return false; }
      if (j !== undefined && !c.unk) schema[PROP_KEY[name]] = j; else st.unreadable.add('inputSchema');
      return false;
    }
    return false;
  };
  // A PropertyOption written as a function of the schema map: schema["key"] = value.
  Repo.prototype.applyFnProp = function (o, schema, st, depth) {
    const lit = o.__fn.lit; const f = lit ? o.__fn.f : o.__fn.file; const sig = lit ? lit.sig : o.__fn.sig; const body = lit ? lit.body : o.__fn.body;
    if (!body || !sig || !sig.params.length || !sig.params[0].name) { st.unreadable.add('inputSchema'); return false; }
    const pname = sig.params[0].name; const t = f.t; let req = false;
    const sc = new Scope(o.scope || this.pkgScope(f.pkg, f), f, f.pkg, { sig, body, file: f, pkg: f.pkg }); sc.body = body;
    for (let k = body[0] + 1; k < body[1]; k++) {
      if (isId(t[k], pname) && isP(t[k + 1], '[') && t[k + 2] && t[k + 2].y === 'str' && isP(t[k + 3], ']') && isP(t[k + 4], '=')) {
        const e = stmtEnd(f, k + 5, body[1]);
        const c = { unk: false, lost: [] }; const v = this.toJson(this.ev(f.P.expr(k + 5, e).n, sc, depth + 1), c); st.lost.push(...c.lost);
        if (t[k + 2].v === 'required' && v === true) req = true; else if (v !== undefined && !c.unk) schema[t[k + 2].v] = v; else st.unreadable.add('inputSchema');
      }
    }
    return req;
  };
  // A schema for a Go type (WithInputSchema[T], AddTool's handler input): { schema, approx } or null.
  const asType = (n) => (!n ? n : n.k === 'id' ? { k: 'tname', pkg: null, v: n.v } : n.k === 'sel' && n.x.k === 'id' ? { k: 'tname', pkg: n.x.v, v: n.v } : n.k === 'unary' && n.op === '*' ? { k: 'tptr', x: asType(n.x) } : n.k === 'index' ? asType(n.x) : n);
  Repo.prototype.schemaFor = function (ty, f, dialect, extra) {
    ty = asType(ty); if (!ty) return null;
    const ctx = Object.assign({ dialect, seen: new Set(), unknownTypes: 0 }, extra || {});
    let s;
    const base = ty.k === 'tptr' ? ty.x : ty;
    if (base.k === 'tname' && !base.pkg && (base.v === 'any' || base.v === 'interface')) return { schema: { type: 'object' } };
    if (base.k === 'tiface') return { schema: { type: 'object' } };
    if (base.k === 'tmap') { s = { type: 'object', additionalProperties: this.typeSchema(base.x, f, ctx, 1) }; return { schema: s, approx: ctx.unknownTypes > 0 }; }
    if (base.k === 'tname') {
      const d = this.typeDef({ pkg: base.pkg, name: base.v }, f);
      if (!d || !d.def || (d.def.k !== 'tstruct' && d.def.k !== 'tname' && d.def.k !== 'tmap')) return null;
      if (d.def.k === 'tstruct') s = this.structSchema(d, ctx, 1);
      else s = this.typeSchema(d.def, d.file, ctx, 1);
    } else if (base.k === 'tstruct') s = this.structSchema({ def: base, pkg: f.pkg, file: f }, ctx, 1);
    else return null;
    if (!s || s.type !== 'object') return null;
    return { schema: s, approx: ctx.unknownTypes > 0 };
  };

  // The tools/list entry of a built tool. part flags: _unreadable [inputSchema, description, annotations]; _lost texts.
  function finish(st) {
    if (st.optsUnknown && (st.description === undefined || st.description === '')) st.unreadable.add('description');
    const tool = { name: st.name };
    if (st.title !== undefined && st.title !== '') tool.title = st.title;
    if (st.description !== undefined && st.description !== '') tool.description = st.description;
    let input;
    if (st.input) input = st.input;
    else {
      input = { type: 'object', properties: st.props };
      if (st.flavour === 'mcp-go') input.required = st.required.slice(); else if (st.required.length) input.required = st.required.slice();
      if (st.additionalProperties !== undefined) input.additionalProperties = st.additionalProperties;
    }
    // nested past what a list may hold: unreadable here, rather than the whole list refused by the list limit
    if (tooDeep(input, MAX_JSON_DEPTH) || hasTooDeep(input)) { st.lost.push(...stringsOf(input)); input = { type: 'object', properties: {} }; st.unreadable.add('inputSchema'); }
    tool.inputSchema = input;
    if (st.output && !tooDeep(st.output, MAX_JSON_DEPTH) && !hasTooDeep(st.output)) tool.outputSchema = st.output;
    if (st.annotations && hasTooDeep(st.annotations)) { st.unreadable.add('annotations'); st.annotations = undefined; }
    if (st.annotations && Object.keys(st.annotations).length) tool.annotations = st.annotations;
    const un = Array.from(st.unreadable);
    if (un.length) tool._unreadable = un;
    const lost = st.lost.filter((x) => typeof x === 'string' && x.trim());
    if (lost.length) tool._lost = lost;
    return tool;
  }

  // ------------------------------------------------------------ tool sites
  // mcp.NewTool(name, opts…)
  Repo.prototype.buildNewTool = function (n, sc, depth, extraOpts) {
    const st = newState('mcp-go');
    st.name = this.ev(n.args[0], sc, depth + 1);
    const opts = n.spread && n.args.length === 2 ? [this.ev(n.args[1], sc, depth + 1)] : n.args.slice(1).map((a) => ({ __arg: true, n: a, sc }));
    this.optionList(opts, st, depth).concat(extraOpts || []).forEach((o) => this.applyOption(o, st, depth + 1));
    return st;
  };
  // mcp.NewToolWithRawSchema(name, description, schema)
  Repo.prototype.buildRawTool = function (n, sc, depth) {
    const st = newState('raw');
    st.name = this.ev(n.args[0], sc, depth + 1);
    st.description = this.str(this.ev(n.args[1], sc, depth + 1), st, 'description');
    const c = { unk: false, lost: [] }; const v = this.ev(n.args[2], sc, depth + 1); const j = this.toJson(typeof v === 'string' ? jsonOrUnk(v) : v, c); st.lost.push(...c.lost);
    if (j && typeof j === 'object' && !c.unk) st.input = j; else st.unreadable.add('inputSchema');
    st.inputSet = true;
    return st;
  };
  // A Tool{…} struct value (go-sdk, mcp-go or a repository type).
  Repo.prototype.buildFromStruct = function (v, depth, handler) {
    const sdk = v.type && v.type.sdk;
    const st = newState(sdk === 'go-sdk' ? 'go-sdk' : 'struct');
    let F = v.f;
    const shape = v.type && v.type.name !== 'Tool' ? this.toolShaped().get(v.type.name) : null;
    if (shape) { // a repository's own tool type: its fields by their json tags
      const G = {}; [['Name', shape.name], ['Description', shape.description], ['Title', shape.title], ['InputSchema', shape.input], ['OutputSchema', shape.output], ['Annotations', shape.annotations]].forEach(([k, fld]) => { if (fld && fld in F) G[k] = F[fld]; });
      F = G;
      // a repository's own tool type: whether a conversion the reader cannot follow may change it is decided in run();
      // annotations left unset here but assigned to that field elsewhere (d.Annotations = …) are set at run time
      st.ownType = { name: v.type.name, pkg: (v.def && v.def.pkg) || null };
      if (shape.annotations && !('Annotations' in F) && this.fieldAssigned(shape.annotations)) st.unreadable.add('annotations');
    }
    st.name = F.Name;
    if ('Title' in F) st.title = this.str(F.Title, st, null);
    if ('Description' in F) st.description = this.str(F.Description, st, 'description');
    const c = { unk: false, lost: [] };
    const schemaField = 'InputSchema' in F ? 'InputSchema' : 'RawInputSchema' in F ? 'RawInputSchema' : 'Parameters' in F ? 'Parameters' : 'Schema' in F ? 'Schema' : null;
    if (schemaField) {
      const raw = F[schemaField]; const j = this.toJson(typeof raw === 'string' ? jsonOrUnk(raw) : raw, c);
      st.lost.push(...c.lost);
      // a schema read in part keeps what was read when it has properties (it is graded on them; the rest is lost text)
      if (j && typeof j === 'object' && (!c.unk || hasProps(j))) { st.input = j; if (sdk === 'mcp-go' && st.input.properties === undefined) st.input.properties = {}; }
      else st.unreadable.add('inputSchema');
      st.inputSet = true;
    }
    if ('OutputSchema' in F || 'RawOutputSchema' in F) { const c2 = { unk: false, lost: [] }; const j = this.toJson(F.OutputSchema !== undefined ? F.OutputSchema : F.RawOutputSchema, c2); if (j && typeof j === 'object' && !c2.unk) st.output = j; }
    if ('Annotations' in F) {
      const c3 = { unk: false, lost: [] }; const a = this.toJson(F.Annotations, c3); st.lost.push(...c3.lost);
      if (a && typeof a === 'object') { st.annotations = a; if (sdk === 'go-sdk') { if (!('readOnlyHint' in a)) a.readOnlyHint = false; if (!('idempotentHint' in a)) a.idempotentHint = false; } }
      if (c3.unk) st.unreadable.add('annotations');
    } else if (sdk === 'mcp-go') st.annotations = undefined;
    if (!schemaField) { st.noSchemaField = true; if (handler) this.applyHandler(st, handler); else st.unreadable.add('inputSchema'); }
    return st;
  };
  // The go-sdk before 1.0: mcp.Input(mcp.Property("x", mcp.Description(…), mcp.Required(true), mcp.Enum(…)), …).
  Repo.prototype.applyInputOpts = function (o, st, depth) {
    if (!o) return;
    if (isUnk(o)) { st.lost.push(...(o.lost || [])); return; }
    if (o.__opt !== 'Input') return;
    o.args.forEach((a) => {
      const p = this.ev(a.n, a.sc, depth + 1);
      if (!p || p.__opt !== 'Property') { if (isUnk(p)) { st.lost.push(...p.lost); st.unreadable.add('inputSchema'); } return; }
      const name = p.args[0] ? this.ev(p.args[0].n, p.args[0].sc, depth + 1) : undefined;
      if (typeof name !== 'string') { st.unreadable.add('inputSchema'); return; }
      if (!st.input || typeof st.input !== 'object') return;
      st.input.properties = st.input.properties || {};
      const schema = Object.assign({}, st.input.properties[name] || {});
      p.args.slice(1).forEach((q) => {
        const opt = this.ev(q.n, q.sc, depth + 1);
        if (opt && opt.__opt === 'Required') {
          const b = opt.args[0] ? this.ev(opt.args[0].n, opt.args[0].sc, depth + 1) : true;
          const req = (st.input.required || []).filter((x) => x !== name); if (b !== false) req.push(name);
          if (req.length) st.input.required = req; else delete st.input.required;
        } else this.applyProp(opt, schema, st, depth + 1);
      });
      st.input.properties[name] = schema;
    });
  };
  // go-sdk's generic AddTool: the input (and output) schema of the handler's types.
  Repo.prototype.applyHandler = function (st, handler) {
    const h = this.handlerTypes(handler);
    st.inputSet = true;
    if (h && h.input) {
      const s = this.schemaFor(h.input, h.f, 'google');
      if (s && s.schema) { st.input = s.schema; st.unreadable.delete('inputSchema'); } else st.unreadable.add('inputSchema');
      if (h.output && !st.output) { const o = this.schemaFor(h.output, h.f, 'google'); if (o && o.schema) st.output = Object.assign({}, o.schema); }
    } else st.unreadable.add('inputSchema');
  };

  // The top-level function whose body holds token k (fns sorted by body start; top-level bodies do not overlap).
  function fnAtTok(fns, k) {
    let lo = 0; let hi = fns.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (fns[mid].body[0] < k) lo = mid + 1; else hi = mid; }
    return lo > 0 && fns[lo - 1].body[1] > k ? fns[lo - 1] : null;
  }
  // Every place in a file that may define a tool: [{ kind, i (token), fn (enclosing function) }].
  Repo.prototype.sitesOf = function (f) {
    const t = f.t; const out = [];
    const fns = f.decls.funcs.filter((d) => d.body).sort((a, b) => a.body[0] - b.body[0]);
    let fi = 0;
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.y !== 'id') continue;
      const v = x.v;
      const shaped = v !== 'Tool' && this.toolShaped().has(v);
      if (!(v === 'NewTool' || v === 'NewToolWithRawSchema' || v === 'NewServerTool' || v === 'Tool' || shaped || v === 'AddTool' || v === 'RegisterTool' || (this.wrapperNames && this.wrapperNames.has(v)))) continue;
      while (fi < fns.length && fns[fi].body[1] < k) fi++;
      const fn = fi < fns.length && fns[fi].body[0] < k && fns[fi].body[1] > k ? fns[fi] : null;
      if (fn && /^(Test|Benchmark|Example|Fuzz)/.test(fn.name)) continue;
      const prev = t[k - 1];
      if (isId(prev, 'func') || (isP(prev, ')') && isId(t[k - 2]) === false && false)) continue;
      if (v === 'Tool' || shaped) {
        if (!isP(t[k + 1], '{')) continue;
        const q0 = isP(prev, '.') && isId(t[k - 2]) ? k - 2 : k;
        if (isP(t[q0 - 1], ']') || (isP(t[q0 - 1], '*') && isP(t[q0 - 2], ']'))) { // []Tool{{…}, {…}}: each element
          const lc = f.close[k + 1]; if (lc < 0) continue;
          const pkgQ = q0 < k ? t[k - 2].v : null;
          splitCommas(f, k + 2, lc).forEach(([p, q]) => { const o = isP(t[p], '&') ? p + 1 : p; if (isP(t[o], '{') && f.close[o] === q - 1) out.push({ kind: 'lit', elided: { k: 'tname', pkg: pkgQ, v }, i: o, fn, at: o - 1 }); });
          k = lc; continue;
        }
        if (!(isP(prev, '.') || isP(prev, '&') || isP(prev, '(') || isP(prev, ',') || isP(prev, '=') || isP(prev, ':=') || isP(prev, ':') || isP(prev, '{') || isId(prev, 'return'))) continue;
        out.push({ kind: 'lit', i: isP(prev, '.') ? k - 2 : k, fn, at: k }); continue;
      }
      if (!isP(t[k + 1], '(') && !(isP(t[k + 1], '[') && isP(t[f.close[k + 1] + 1], '('))) continue;
      if (isId(prev, 'func') || (isP(prev, ')') && isId(t[k - 1]))) continue;
      out.push({ kind: v === 'NewTool' ? 'new' : v === 'NewToolWithRawSchema' ? 'raw' : v === 'NewServerTool' ? 'servertool' : v === 'AddTool' ? 'add' : v === 'RegisterTool' ? 'register' : 'wrap', i: isP(prev, '.') && isId(t[k - 2]) ? k - 2 : k, fn, at: k });
    }
    // map literals that hold a tool: {"name": …, "inputSchema": …}
    if (f.text.indexOf('inputSchema') >= 0 || f.text.indexOf('input_schema') >= 0) {
      const stack = [];
      for (let k = 0; k < t.length; k++) {
        const x = t[k];
        if (x.y === 'p' && x.v === '{') { stack.push(k); continue; }
        if (x.y === 'p' && x.v === '}') { stack.pop(); continue; }
        if (x.y === 'str' && (x.v === 'inputSchema' || x.v === 'input_schema') && isP(t[k + 1], ':') && stack.length && !x.raw) {
          const open = stack[stack.length - 1];
          // the literal's type ends just before its '{': map[string]any{ or an elided element
          let i = open; if (isId(t[open - 1]) || isP(t[open - 1], ']')) { let q = open - 1; while (q > 0 && !(t[q].y === 'p' && /^[,({=:]$|^:=$/.test(t[q].v)) && !isId(t[q], 'return')) q--; i = q + 1; }
          const fnAt = fnAtTok(fns, open);
          if (fnAt && /^(Test|Benchmark|Example|Fuzz)/.test(fnAt.name)) continue;
          out.push({ kind: 'map', i, open, fn: fnAt, at: open });
        }
      }
    }
    return out;
  };
  // The call node that starts at token i (its callee ends at `at`).
  Repo.prototype.callAt = function (f, i, at) {
    let open = at + 1; if (isP(f.t[open], '[')) open = f.close[open] + 1;
    const c = f.close[open]; if (c < 0) return null;
    const n = f.P.expr(i, c + 1).n;
    return n && n.k === 'call' ? n : null;
  };
  Repo.prototype.scopeFor = function (site, f) {
    if (site.fn) { const sc = this.fnScope(site.fn); return sc; }
    return this.pkgScope(f.pkg, f);
  };

  // Evaluate one site in scope: [{ st, unresolved, param }] (a site can give several tools through a wrapper).
  Repo.prototype.evalSite = function (site, f, sc, depth, extraOpts) {
    const res = [];
    if (site.kind === 'lit') {
      const open = site.at + 1; const c = f.close[open]; if (c < 0) return res;
      const n = site.elided ? { k: 'lit', type: site.elided, elems: f.P.elems(open, c, 0), s: site.i, open } : f.P.expr(site.i, c + 1).n;
      if (!n || n.k !== 'lit') return res;
      const tn = typeName(n.type);
      if (!tn || (tn.name !== 'Tool' && !this.toolShaped().has(tn.name))) return res;
      if (tn.pkg) { const q = this.qual(f, tn.pkg); if (!q || (!q.pkg && !q.sdk)) return res; if (q.sdk === 'jsonschema') return res; }
      const keys = n.elems.map((e) => (e.key && e.key.k === 'id' ? e.key.v : null));
      const shape = tn.name !== 'Tool' ? this.toolShaped().get(tn.name) : null;
      if (shape) { if (!keys.includes(shape.name) || !keys.includes(shape.input)) return res; }
      else if (!keys.includes('Name') || !keys.some((k) => /^(Description|InputSchema|RawInputSchema|Annotations|Title)$/.test(k))) return res;
      const v = this.ev(n, sc, depth + 1);
      if (!v || !v.__struct) return res;
      res.push(this.siteResult(this.buildFromStruct(v, depth, site.handler || null), sc));
      return res;
    }
    if (site.kind === 'ctor') {
      // a struct of a tool type built here; its methods build the tool from its fields (Name: t.name)
      const open = site.at + 1; const c = f.close[open]; if (c < 0) return res;
      const n = site.elided ? { k: 'lit', type: { k: 'tname', pkg: null, v: site.elided }, elems: f.P.elems(open, c, 0), s: open, open } : f.P.expr(site.i, c + 1).n;
      if (!n || n.k !== 'lit') return res;
      const v = this.ev(n, sc, depth + 1); if (!v || !v.__struct) return res;
      site.recvSites.forEach((rs) => {
        if (promoted(v, rs.field) === undefined) return;
        const bind = (p, k) => ({ val: PARAM(rs.s.fn, p.name) }); bind.recv = { val: v };
        const inner = this.fnScope(rs.s.fn, null, bind); inner.callDepth = (sc.callDepth || 0) + 1;
        this.evalSite(rs.s, rs.f, inner, depth + 1).forEach((r) => {
          if (r.st && isParam(r.st.name) && r.st.name.owner === sc.fn) { r.param = true; delete r.unresolved; delete r.recv; }
          else if (r.st && typeof r.st.name === 'string') { r.name = r.st.name; delete r.unresolved; delete r.recv; }
          res.push(r);
        });
      });
      return res;
    }
    if (site.kind === 'map') {
      const c = f.close[site.open]; if (c < 0) return res;
      const n0 = f.P.expr(site.i, c + 1).n;
      const n = n0 && n0.k === 'lit' ? n0 : { k: 'lit', type: { k: 'tmap', key: { k: 'tname', v: 'string' }, x: { k: 'tname', v: 'any' } }, elems: f.P.elems(site.open, c, 0), s: site.open };
      const v = this.literal(n.type ? n : n, sc, depth + 1, n.type || { k: 'tmap', key: { k: 'tname', v: 'string' }, x: { k: 'tname', v: 'any' } });
      if (!isPlain(v) || !('name' in v)) return res;
      const st = newState('map');
      const c1 = { unk: false, lost: [] };
      st.name = v.name; if ('description' in v) st.description = this.str(v.description, st, 'description'); if ('title' in v) st.title = this.str(v.title, st, null);
      const j = this.toJson(v.inputSchema !== undefined ? v.inputSchema : v.input_schema, c1); st.lost.push(...c1.lost);
      if (j && typeof j === 'object' && (!c1.unk || hasProps(j))) st.input = j; else st.unreadable.add('inputSchema');
      st.inputSet = true;
      if (v.annotations !== undefined) { const c2 = { unk: false, lost: [] }; const a = this.toJson(v.annotations, c2); if (a && typeof a === 'object') st.annotations = a; if (c2.unk) st.unreadable.add('annotations'); }
      if (v.outputSchema !== undefined) { const c3 = { unk: false, lost: [] }; const o = this.toJson(v.outputSchema, c3); if (o && typeof o === 'object' && !c3.unk) st.output = o; }
      res.push(this.siteResult(st, sc)); res.literal = true;
      return res;
    }
    const n = this.callAt(f, site.i, site.at); if (!n) return res;
    if (site.kind !== 'wrap') {
      // a function of the repository named like the SDK's (its own NewTool, AddTool, RegisterTool): a helper when it
      // builds a tool from its parameters; otherwise not read (counted), unless it only passes a Tool literal on
      const rc = this.repoCallee(n, f, sc);
      if (rc) {
        if (this.wrappers && this.wrappers.has(rc)) return this.evalWrapper(rc, n, sc, depth + 1);
        const passesLiteral = n.args.some((a) => { const b = a.k === 'unary' ? a.x : a; const tn = b.k === 'lit' ? typeName(b.type) : null; return !!tn && (tn.name === 'Tool' || this.toolShaped().has(tn.name)); });
        if (passesLiteral || !this.wrappers) return res;
        return [{ st: null, unresolved: true, lost: literals(n).slice(0, 200) }];
      }
    }
    if (site.kind === 'new') {
      if (!n.args.length) return res;
      const callee = n.fn.k === 'index' ? n.fn.x : n.fn;
      const q = callee.k === 'sel' && callee.x.k === 'id' ? this.qual(f, callee.x.v) : null;
      if (callee.k === 'sel' && !q && this.isValue(callee.x, sc)) return res; // a method named NewTool (x.NewTool): not the SDK's
      if (q && q.pkg && this.repoFn(q.pkg, 'NewTool')) return res; // a repository function named NewTool: a wrapper
      if (!q && callee.k === 'id' && f.pkg.funcs.has('NewTool')) return res;
      if (n.fn.k === 'index') return res; // NewTool[T](…) is a generic of the repository, not mcp-go's
      const a0 = n.args[0].k === 'unary' ? n.args[0].x : n.args[0];
      if (a0.k === 'lit') return res; // NewTool(&mcp.Tool{…}, handler) of another library: the literal is read on its own
      if (q && q.sdk === 'go-sdk' && n.args.length >= 3) return this.evalSite(Object.assign({}, site, { kind: 'servertool' }), f, sc, depth);
      // NewTool(name, description, input) of other SDKs (a request struct value or a handler gives the schema)
      if (n.args.length >= 2 && !(q && q.sdk === 'mcp-go')) {
        const d = this.ev(n.args[1], sc, depth + 1);
        if (typeof d === 'string' || (isUnk(d) && d.__partial)) {
          const st = newState('struct');
          st.name = this.ev(n.args[0], sc, depth + 1);
          st.description = this.str(d, st, 'description');
          const rest = n.args.slice(2).map((a) => ({ a, v: this.ev(a, sc, depth + 1) }));
          const sv = rest.find((x) => x.v && x.v.__struct && x.v.type);
          const hv = rest.find((x) => x.v && x.v.__fn);
          if (sv) { const s2 = this.schemaFor({ k: 'tname', pkg: sv.v.type.pkg, v: sv.v.type.name }, f, 'plain'); if (s2 && s2.schema) st.input = s2.schema; else st.unreadable.add('inputSchema'); }
          else if (hv) this.applyHandler(st, hv.v);
          else st.unreadable.add('inputSchema');
          st.inputSet = true;
          res.push(this.siteResult(st, sc));
          return res;
        }
      }
      res.push(this.siteResult(this.buildNewTool(n, sc, depth, extraOpts), sc));
      return res;
    }
    if (site.kind === 'servertool') {
      // the go-sdk before 1.0: mcp.NewServerTool(name, description, handler, mcp.Input(mcp.Property(…)))
      if (n.args.length < 3) return res;
      const st = newState('go-sdk');
      st.name = this.ev(n.args[0], sc, depth + 1);
      st.description = this.str(this.ev(n.args[1], sc, depth + 1), st, 'description');
      this.applyHandler(st, this.ev(n.args[2], sc, depth + 1));
      n.args.slice(3).forEach((a) => this.applyInputOpts(this.ev(a, sc, depth + 1), st, depth + 1));
      res.push(this.siteResult(st, sc));
      return res;
    }
    if (site.kind === 'raw') { if (n.args.length >= 3) res.push(this.siteResult(this.buildRawTool(n, sc, depth), sc)); return res; }
    if (site.kind === 'add') {
      // go-sdk: mcp.AddTool(server, tool, handler) (a package function with three arguments)
      if (n.args.length !== 3 || n.fn.k !== 'sel' && !(n.fn.k === 'index')) return res;
      const sel = n.fn.k === 'index' ? n.fn.x : n.fn;
      if (!sel || sel.k !== 'sel' || sel.x.k !== 'id') return res;
      const q = this.qual(f, sel.x.v); if (q ? q.pkg : this.isValue(sel.x, sc)) return res;
      const tv = this.ev(n.args[1], sc, depth + 1);
      const h = this.ev(n.args[2], sc, depth + 1);
      if (tv && tv.__struct) { res.push(this.siteResult(this.buildFromStruct(tv, depth, h), sc)); res.consumed = [tv.file.path + ':' + tv.pos]; }
      else if (tv && tv.__toolcall) {
        // a helper that returns the tool (tool("name", …)): its tools, with the schema of this handler where it gave none
        this.evalWrapper(tv.d, tv.n, tv.sc, depth + 1).forEach((r) => { if (r.st && r.st.noSchemaField) this.applyHandler(r.st, h); if (r.st) res.push(Object.assign(r, this.siteResult(r.st, sc))); });
        res.consumed = [tv.sc.f.path + ':' + tv.n.s];
      }
      return res;
    }
    if (site.kind === 'register') {
      // mcp-golang: server.RegisterTool(name, description, handler)
      if (n.args.length < 3 || n.fn.k !== 'sel') return res;
      const st = newState('metoro');
      const d1 = this.ev(n.args[1], sc, depth + 1);
      if (d1 && (d1.__fn || d1.__struct || d1.__toolcall)) return res; // RegisterTool(tool, handler, …): the tool is read where it is built
      st.name = this.ev(n.args[0], sc, depth + 1);
      st.description = this.str(d1, st, 'description');
      const h = this.handlerTypes(this.ev(n.args[2], sc, depth + 1));
      if (h && h.input) { const s = this.schemaFor(h.input, h.f, 'invopop', { requiredFromTags: true }); if (s && s.schema) st.input = s.schema; else st.unreadable.add('inputSchema'); }
      else st.unreadable.add('inputSchema');
      st.inputSet = true;
      if (typeof st.name !== 'string' && !isParam(st.name) && !isUnk(st.name)) return res;
      res.push(this.siteResult(st, sc));
      return res;
    }
    if (site.kind === 'wrap') {
      const fv = this.ev(n.fn, sc, depth + 1);
      const d = fv && fv.__fn && !fv.__fn.lit ? fv.__fn : null;
      if (!d || !this.wrappers.has(d)) return res;
      return this.evalWrapper(d, n, sc, depth + 1);
    }
    return res;
  };
  // The repository function (or method) a call names, when it is one: NewTool(…), pkg.NewTool(…), x.AddTool(…).
  // A method counts only when it is a known helper (a value's method may as well be the SDK's).
  Repo.prototype.repoCallee = function (n, f, sc) {
    this.step();
    const c = n.fn.k === 'index' ? n.fn.x : n.fn;
    if (c.k === 'id') { if (sc.lookup(c.v) || this.isValue(c, sc) && !f.pkg.funcs.has(c.v)) return null; const d = f.pkg.funcs.get(c.v); return d ? d[0] : null; }
    if (c.k !== 'sel') return null;
    if (c.x.k === 'id') { const q = this.qual(f, c.x.v); if (q && !this.isValue(c.x, sc)) { const d = q.pkg && q.pkg.funcs.get(c.v); return d ? d[0] : null; } }
    if (!this.wrappers) return null;
    for (const pk of [sc.pkg].concat(Array.from(this.pkgs.values()))) { const ms = pk && pk.methods.get(c.v); const w = ms && ms.find((m) => this.wrappers.has(m)); if (w) return w; }
    return null;
  };
  // Is an identifier a value (a variable, parameter or package-level var) rather than a package qualifier?
  Repo.prototype.isValue = function (n, sc) {
    if (!n || n.k !== 'id') return true;
    if (sc.lookup(n.v)) return true;
    for (let s = sc; s; s = s.parent) { if (s.body && s.fn && this.locals(s.f, s.body).has(n.v)) return true; if (s.isPkg && (s.pkg.vars.has(n.v) || s.pkg.consts.has(n.v))) return true; }
    return false;
  };
  Repo.prototype.siteResult = function (st, sc) {
    const r = { st };
    if (typeof st.name === 'string' && st.name) r.name = st.name;
    else if (isParam(st.name) && sc.fn && st.name.owner === sc.fn && st.name.name === sc.fn.recv && st.name.path.length === 1) { r.recv = st.name.path[0]; r.unresolved = true; }
    else if (isParam(st.name) && sc.fn && st.name.owner === sc.fn) r.param = true;
    else r.unresolved = true;
    return r;
  };
  // A site inside `for … range X` loops of its function: evaluated once per element when X is known (a literal slice
  // or map, or a constant one), with the loop variables bound; otherwise once, the loop variables unknown.
  const MAX_LOOP = 500;
  Repo.prototype.evalInLoops = function (site, f) {
    const base = this.scopeFor(site, f);
    if (!site.fn || !site.fn.body) return this.evalSite(site, f, base, 0);
    const rs = (this.locals(f, site.fn.body).ranges || []).filter((r) => r.open < site.i && r.close > site.i).sort((a, b) => a.open - b.open).slice(-2);
    if (!rs.length) return this.evalSite(site, f, base, 0);
    let scopes = [base];
    for (const r of rs) {
      const next = [];
      for (const sc of scopes) {
        const coll = this.ev(f.P.expr(r.a, r.b).n, sc, 0);
        const entries = Array.isArray(coll) ? coll.map((v, k) => [k, v]) : isPlain(coll) ? Object.keys(coll).filter((k) => k !== '__unkKeys').map((k) => [k, coll[k]]) : null;
        if (!entries || !entries.length || entries.length > MAX_LOOP || next.length + entries.length > MAX_LOOP) { next.push(sc); continue; }
        entries.forEach(([k, v]) => {
          const child = new Scope(sc, f, sc.pkg, null);
          if (r.names[0] && r.names[0] !== '_') child.vars.set(r.names[0], { val: r.names.length === 1 && !Array.isArray(coll) ? k : (r.names.length === 1 ? k : k) });
          if (r.names[1] && r.names[1] !== '_') child.vars.set(r.names[1], { val: v && v.__arg ? this.ev(v.n, v.sc) : v });
          child.callDepth = sc.callDepth; child.stack = sc.stack;
          next.push(child);
        });
      }
      scopes = next;
    }
    const out = [];
    scopes.forEach((sc) => { const got = this.evalSite(site, f, sc, 0); if (got.consumed) out.consumed = (out.consumed || []).concat(got.consumed); out.push(...got); });
    return out;
  };
  // A call to a wrapper: its own sites, with its parameters bound to the call's arguments.
  Repo.prototype.evalWrapper = function (d, n, sc, depth) {
    const out = [];
    // a chain of helpers deeper than followed, or one calling itself again: counted as unresolved, never guessed
    if ((sc.stack || []).includes(d)) return [{ st: null, unresolved: true, capped: 'recursion', lost: literals(n).slice(0, 200) }];
    if (depth > 40 || (sc.callDepth || 0) >= MAX_CALL_DEPTH) return [{ st: null, unresolved: true, capped: 'depth', lost: literals(n).slice(0, 200) }];
    const inner = this.bindCall(d, n, sc);
    inner.stack = (sc.stack || []).concat([d]);
    const info = this.wrappers.get(d);
    // options passed in a variadic …Option parameter apply to the tool, wherever the wrapper applies them
    const vp = (d.sig.params || []).findIndex((p) => p.variadic && /Option$/.test(typeName(p.type.x) ? typeName(p.type.x).name : ''));
    const extra = vp >= 0 ? (n.spread && n.args.length === vp + 1 ? [this.ev(n.args[vp], sc, depth + 1)] : n.args.slice(vp).map((a) => ({ __arg: true, n: a, sc }))) : [];
    const handlerArg = (() => { const hp = (d.sig.params || []).findIndex((p) => p.type && (p.type.k === 'tfunc' || (p.type.k === 'tname' && /Handler|Func$/.test(p.type.v) && (p.type.targs || d.tparams)))); return hp >= 0 && n.args[hp] ? this.ev(n.args[hp], sc, depth + 1) : null; })();
    info.sites.forEach((s) => {
      const passOpts = vp >= 0 && !s.usesVariadic ? extra : null;
      const got = this.evalSite(s, d.file, inner, depth + 1, passOpts);
      got.forEach((r) => {
        if (r.st && passOpts && s.kind !== 'new') this.optionList(passOpts, r.st, depth).forEach((o) => this.applyOption(o, r.st, depth + 1));
        // a wrapper that reflects its generic handler's input type: the schema of that type
        if (r.st && info.reflects && handlerArg && (r.st.unreadable.has('inputSchema') || !r.st.inputSet)) {
          const h = this.handlerTypes(handlerArg);
          const s = h && h.input ? this.schemaFor(h.input, h.f, 'google', { requiredFromTags: true }) : null;
          if (s && s.schema) { r.st.input = s.schema; r.st.inputSet = true; r.st.unreadable.delete('inputSchema'); }
        }
        // text this call passes that the tool could not place (a description through helpers not followed): scanned
        // (only when the description is unreadable or unset, and not the text already placed in the tool)
        if (r.st && (r.st.unreadable.has('description') || r.st.description === undefined || r.st.description === '')) {
          const placed = new Set([r.st.name, r.st.description, r.st.title].filter((x) => typeof x === 'string'));
          r.st.lost.push(...literals(n).slice(0, 200).filter((x) => !placed.has(x)));
        }
        if (r.lost && !r.st) r.lost = r.lost.concat(literals(n).slice(0, 200));
        if (r.st && isParam(r.st.name) && r.st.name.owner === sc.fn) r.param = true;
        else if (r.st && typeof r.st.name === 'string') { r.name = r.st.name; delete r.unresolved; }
        else if (r.st) { r.unresolved = true; delete r.param; }
        out.push(r);
      });
    });
    return out;
  };

  // ------------------------------------------------------------ the whole repository
  Repo.prototype.reflects = function (d, depth, seen) {
    // does the function (or a repository function it calls, a few levels down) build a schema by reflection?
    seen = seen || new Set(); if (!d || !d.body || depth > 4 || seen.has(d)) return false; seen.add(d);
    const t = d.file.t;
    for (let k = d.body[0]; k < d.body[1]; k++) {
      const x = t[k]; if (x.y !== 'id') continue;
      if (/^(Reflect|ReflectFromType|ForType|For|schemaFor|SchemaFor|GenerateSchema|createJSONSchemaFromHandler)$/.test(x.v) && (isP(t[k + 1], '(') || isP(t[k + 1], '['))) return true;
      if (isP(t[k + 1], '(') && !isP(t[k - 1], '.')) { const ds = d.pkg.funcs.get(x.v); if (ds && ds.some((y) => this.reflects(y, depth + 1, seen))) return true; }
    }
    return false;
  };
  Repo.prototype.run = function () {
    const found = []; const unresolved = []; const overBudget = [];
    const fileSites = new Map();
    this.wrappers = new Map(); this.wrapperNames = new Set();
    const seenSite = new Map();
    const all = () => { this.files.forEach((f) => { if (f.failed) return; let got; try { got = this.sitesOf(f); } catch (e) { if (e instanceof OverBudget) throw e; got = []; } fileSites.set(f, got.map((s) => { const key = f.path + ':' + s.i + ':' + s.kind; if (!seenSite.has(key)) seenSite.set(key, s); return seenSite.get(key); })); }); };
    all();
    // methods that build a tool from their receiver's fields (Name: t.name): the struct literals of that type are the
    // sites, each evaluated with the receiver bound to it (the constructor that fills the fields may be a wrapper)
    const recvTypes = new Map();
    this.files.forEach((f) => (fileSites.get(f) || []).forEach((s) => {
      if (!s.fn || !s.fn.recv || !s.fn.recvType) return;
      let got; try { got = this.evalSite(s, f, this.scopeFor(s, f), 0); } catch (e) { if (e instanceof OverBudget) throw e; return; }
      const r = got.find((x) => x.recv); if (!r) return;
      const key = s.fn.pkg.dir + '\u0000' + s.fn.recvType;
      if (!recvTypes.has(key)) recvTypes.set(key, { pkg: s.fn.pkg, type: s.fn.recvType, sites: [] });
      recvTypes.get(key).sites.push({ s, f, field: r.recv });
    }));
    const ctorSites = new Map();
    if (recvTypes.size) {
      const byName = new Map(); recvTypes.forEach((x) => { if (!byName.has(x.type)) byName.set(x.type, []); byName.get(x.type).push(x); });
      this.files.forEach((f) => {
        const t = f.t; const fns = f.decls.funcs.filter((d) => d.body).sort((a, b) => a.body[0] - b.body[0]);
        for (let k = 0; k < t.length - 1; k++) {
          if (t[k].y !== 'id' || !byName.has(t[k].v)) continue;
          const lb = isP(t[k + 1], '[') && f.close[k + 1] > 0 ? f.close[k + 1] + 1 : k + 1; // T[A, B]{…}
          if (!isP(t[lb], '{')) continue;
          const prev = t[k - 1];
          const elemOf = isP(prev, ']') || (isP(prev, '*') && isP(t[k - 2], ']')); // []T{{…}, {…}} or []*T{…}
          if (elemOf && f.close[lb] > 0) {
            const pk0 = f.pkg; const rt0 = byName.get(t[k].v).find((x) => x.pkg === pk0); if (!rt0) continue;
            const fn0 = fnAtTok(fns, k);
            if (!ctorSites.has(f)) ctorSites.set(f, []);
            splitCommas(f, lb + 1, f.close[lb]).forEach(([p, q]) => { const o = isP(t[p], '&') ? p + 1 : p; if (isP(t[o], '{') && f.close[o] === q - 1) ctorSites.get(f).push({ kind: 'ctor', elided: t[k].v, i: o, at: o - 1, fn: fn0, recvSites: rt0.sites }); });
            rt0.used = true; continue;
          }
          const qualified = isP(prev, '.') && isId(t[k - 2]);
          const pk = qualified ? (this.qual(f, t[k - 2].v) || {}).pkg : f.pkg;
          const rt = byName.get(t[k].v).find((x) => x.pkg === pk); if (!rt) continue;
          const before = qualified ? t[k - 3] : prev;
          if (!(isP(before, '&') || isP(before, '(') || isP(before, ',') || isP(before, '=') || isP(before, ':=') || isP(before, ':') || isP(before, '{') || isId(before, 'return'))) continue;
          const fn = fnAtTok(fns, k);
          if (fn && /^(Test|Benchmark|Example|Fuzz)/.test(fn.name)) continue;
          if (!ctorSites.has(f)) ctorSites.set(f, []);
          ctorSites.get(f).push({ kind: 'ctor', i: qualified ? k - 2 : k, at: lb - 1, fn, recvSites: rt.sites });
          rt.used = true;
        }
      });
      recvTypes.forEach((x) => { if (x.used) x.sites.forEach((y) => { y.s.recvBound = true; }); });
      this.files.forEach((f) => { if (ctorSites.has(f)) fileSites.set(f, (fileSites.get(f) || []).concat(ctorSites.get(f))); });
      const prevAll = all;
      void prevAll;
    }
    const allWithCtors = () => { all(); this.files.forEach((f) => { if (ctorSites.has(f)) fileSites.set(f, (fileSites.get(f) || []).concat(ctorSites.get(f))); }); };
    // wrappers: functions with a site whose tool name is one of their parameters; repeated to follow chains
    // Each round looks at the sites not looked at before, and at calls named like a helper found in the last round,
    // so a chain of helpers is followed to its end (up to MAX_HELPER_ROUNDS) in time linear in the sites.
    let fresh = null;
    for (let round = 0; round < MAX_HELPER_ROUNDS; round++) {
      let grew = false; const added = new Set();
      this.files.forEach((f) => {
        (fileSites.get(f) || []).forEach((s) => {
          if (!s.fn || s.inWrapper) return; // already a site of a known helper
          if (s.looked && !(fresh && fresh.has(f.t[s.at] && f.t[s.at].v))) return;
          s.looked = true;
          let got; try { got = this.evalSite(s, f, this.scopeFor(s, f), 0); } catch (e) { if (e instanceof OverBudget) throw e; return; }
          // a helper too: one whose tool name is its parameter, or one that passes its parameters on into a chain
          // too long to follow (its callers' text is then scanned as an unresolved registration)
          if (got.some((r) => r.param || (r.capped && (s.fn.sig.params || []).some((p) => p.name)))) {
            if (!this.wrappers.has(s.fn)) { this.wrappers.set(s.fn, { sites: [], reflects: false }); this.wrapperNames.add(s.fn.name); added.add(s.fn.name); grew = true; }
            const w = this.wrappers.get(s.fn); if (!s.inWrapper) w.sites.push(s);
            s.inWrapper = true;
            s.usesVariadic = (() => { const vp = (s.fn.sig.params || []).find((p) => p.variadic); if (!vp) return false; const n = s.kind === 'lit' ? null : this.callAt(f, s.i, s.at); return !!(n && n.spread && n.args.length && n.args[n.args.length - 1].k === 'id' && n.args[n.args.length - 1].v === vp.name); })();
          }
        });
      });
      if (!grew) break;
      if (round === MAX_HELPER_ROUNDS - 1) { const last = Array.from(this.wrappers.keys()).pop(); overBudget.push({ path: last ? last.file.path : (this.files[0] || {}).path, line: null, why: WHY_CHAIN }); }
      fresh = added;
      this.wrappers.forEach((w, d) => { w.reflects = this.reflects(d, 0); });
      allWithCtors(); // calls to the new wrappers are sites too
    }
    this.wrappers.forEach((w, d) => { w.reflects = this.reflects(d, 0); });
    // every site outside a wrapper (and a wrapper's own sites whose name is not a parameter)
    const consumed = new Set();
    const results = [];
    this.files.forEach((f) => {
      if (f.tag && f.tag.excluded) return;
      const sites = (fileSites.get(f) || []).slice().sort((a, b) => (a.kind === 'add' ? 0 : 1) - (b.kind === 'add' ? 0 : 1) || a.i - b.i);
      sites.forEach((s) => {
        if (s.inWrapper || s.recvBound) return;
        if (overBudget.length) return;
        let got;
        try { got = this.evalInLoops(s, f); } catch (e) { if (e instanceof OverBudget) { overBudget.push({ path: f.path, line: lineAt(f, f.t[s.i].s), why: WHY_WORK }); return; } got = [{ st: null, unresolved: true }]; }
        if (results.length + got.length > MAX_RESULTS) { overBudget.push({ path: f.path, line: lineAt(f, f.t[s.i].s), why: WHY_MANY }); return; }
        if (got.consumed) got.consumed.forEach((x) => consumed.add(x));
        // a chain of helpers deeper than followed: the list would be incomplete, so it is refused
        if (got.some((r) => r.capped === 'depth')) { overBudget.push({ path: f.path, line: lineAt(f, f.t[s.i].s), why: WHY_CHAIN }); return; }
        got.forEach((r) => results.push({ r, f, s }));
      });
    });
    // tool objects inside a string literal that holds JSON (a raw `[{"name": …, "inputSchema": …}]` unmarshalled at start)
    this.files.forEach((f) => {
      if (f.tag && f.tag.excluded) return;
      f.t.forEach((x, k) => {
        if (x.y !== 'str' || x.v.length < 20 || x.v.length > 4 * 1024 * 1024 || x.v.indexOf('"inputSchema"') < 0) return;
        let d; try { d = JSON.parse(x.v); } catch (e) { return; }
        const walk = (v, depth) => {
          if (!v || typeof v !== 'object' || depth > 64) return;
          if (Array.isArray(v)) { v.forEach((y) => walk(y, depth + 1)); return; }
          if (typeof v.name === 'string' && v.inputSchema && typeof v.inputSchema === 'object') {
            const st = newState('json'); st.name = v.name; if (typeof v.description === 'string') st.description = v.description; if (typeof v.title === 'string') st.title = v.title;
            st.input = v.inputSchema; if (v.outputSchema && typeof v.outputSchema === 'object') st.output = v.outputSchema; if (v.annotations && typeof v.annotations === 'object') st.annotations = v.annotations;
            results.push({ r: { st, name: v.name }, f, s: { kind: 'json', i: k } }); return;
          }
          Object.keys(v).forEach((key) => walk(v[key], depth + 1));
        };
        walk(d, 0);
      });
    });
    const subTools = this.subToolTypes(results);
    const converted = this.convertedOwnTypes(results);
    results.forEach(({ r, f, s }) => {
      if ((s.kind === 'lit' || s.kind === 'wrap') && consumed.has(f.path + ':' + s.i)) return;
      const line = lineAt(f, f.t[s.i].s);
      // a tool name that is a parameter of a function not followed as a helper (a chain longer than followed)
      if (r.unresolved || r.param || !r.name) {
        const u = { line };
        if (r.st) { if (typeof r.st.description === 'string') u.description = r.st.description; if (typeof r.st.title === 'string') u.title = r.st.title; if (r.st.lost.length) u.lost = r.st.lost.slice(0, 200); if (isUnk(r.st.name) && r.st.name.lost && r.st.name.lost.length) u.lost = (u.lost || []).concat(r.st.name.lost); }
        if (r.lost && r.lost.length) u.lost = (u.lost || []).concat(r.lost);
        // and the text written at the site itself (a call whose helpers were not followed to the end)
        if (s.kind !== 'lit' && s.kind !== 'json' && s.kind !== 'map' && s.kind !== 'ctor') { try { const cn = this.callAt(f, s.i, s.at); if (cn) u.lost = (u.lost || []).concat(literals(cn).slice(0, 200)); } catch (e) { if (e instanceof OverBudget) throw e; } }
        if (u.lost) u.lost = Array.from(new Set(u.lost)).slice(0, 400);
        unresolved.push(Object.assign({ path: f.path }, u));
        return;
      }
      // a repository's own tool type that code the reader could not follow converts (it reads the type's fields or
      // builds from it where a registration is unresolved): its description may be rewritten and annotations added
      if (r.st.ownType && converted.has(r.st.ownType.name)) { r.st.unreadable.add('description'); r.st.unreadable.add('annotations'); }
      const tool = finish(r.st);
      const marks = [];
      if (f.tag && f.tag.expr) marks.push({ reason: 'conditional-build-tag', detail: f.tag.expr.slice(0, 120), exclude: false });
      // a tool built in a package-level variable or a plain function that nothing in the repository refers to is
      // not registered (as for literal tool objects in the other languages)
      const holder = this.holderOf(f, s);
      if (holder && (this.refCount().get(holder) || 0) <= 1) marks.push({ reason: 'unreferenced-declaration', detail: holder, exclude: true });
      // a tool type built only inside another tool (a unified tool that dispatches to it) is not registered itself
      // a tool type whose registration the reader does not see (built only inside another type, or never visibly
      // built): listed, and marked so the report can say so; never dropped
      const sub = s.fn && s.fn.recvType ? subTools.get(s.fn.pkg.dir + '\u0000' + s.fn.recvType) : null;
      if (sub) marks.push({ reason: 'registration-not-seen', detail: sub, exclude: false });
      found.push({ path: f.path, line, tool, fidelity: 'derived', literal: s.kind === 'lit' && !(r.st.flavour === 'go-sdk'), marks, language: 'Go' });
    });
    return { found, unresolved, overBudget };
  };

  // Tool types (a type whose method builds a tool with a fixed name, such as Definition()) that are not registered:
  // ones the repository only builds inside another tool type (its methods, or the constructor that returns it), the
  // sub-tools a unified tool dispatches to; and, when the repository registers tool types by building them, ones it
  // never builds. Map(pkg dir + type -> why).
  Repo.prototype.subToolTypes = function (results) {
    const out = new Map(); const key = (pk, n) => (pk ? pk.dir : '') + '\u0000' + n;
    const types = new Map();
    results.forEach(({ r, s }) => { if (s && s.fn && s.fn.recvType && r && typeof r.name === 'string') types.set(key(s.fn.pkg, s.fn.recvType), s.fn.recvType); });
    if (types.size < 2) return out;
    // constructors: plain functions returning T or *T of a tool type
    const ctorOf = new Map(); // decl -> type key
    const ctorsByName = new Map(); // name -> [{ pkg, key }]
    this.pkgs.forEach((pk) => pk.funcs.forEach((ds) => ds.forEach((d) => {
      const r0 = d.sig && d.sig.results[0] && d.sig.results[0].type; const b = r0 && r0.k === 'tptr' ? r0.x : r0;
      if (!b || b.k !== 'tname' || b.pkg) return;
      const k = key(pk, b.v); if (!types.has(k)) return;
      ctorOf.set(d, k); if (!ctorsByName.has(d.name)) ctorsByName.set(d.name, []); ctorsByName.get(d.name).push({ pkg: pk, key: k });
    })));
    const containerOf = (d) => (!d ? null : d.recvType ? key(d.pkg, d.recvType) : ctorOf.get(d) || null);
    const sites = new Map(); // type key -> [container key | null]
    const typeNames = new Set(types.values());
    this.files.forEach((f) => {
      const t = f.t; const fns = f.decls.funcs.filter((d) => d.body).sort((a, b) => a.body[0] - b.body[0]);
      for (let k = 0; k < t.length - 1; k++) {
        const x = t[k]; if (x.y !== 'id') continue;
        const qualified = isP(t[k - 1], '.') && isId(t[k - 2]);
        const pk = qualified ? (this.qual(f, t[k - 2].v) || {}).pkg : f.pkg;
        if (qualified && !pk) continue;
        let tk = null;
        const before = t[qualified ? k - 3 : k - 1];
        const valuePlace = isP(before, '&') || isP(before, '(') || isP(before, ',') || isP(before, '=') || isP(before, ':=') || isP(before, ':') || isP(before, '{') || isId(before, 'return');
        if (typeNames.has(x.v) && isP(t[k + 1], '{') && valuePlace) tk = key(pk, x.v); // a composite literal, not a type before a body
        else if (typeNames.has(x.v) && isP(t[k + 1], ')') && (isP(before, '(') && isId(t[qualified ? k - 4 : k - 2], 'new'))) tk = key(pk, x.v); // new(T)
        else if (ctorsByName.has(x.v) && isP(t[k + 1], '(') && !isId(t[k - 1], 'func')) { const c = ctorsByName.get(x.v).find((y) => y.pkg === pk); if (c) tk = c.key; }
        if (!tk || !types.has(tk)) continue;
        const cont = containerOf(fnAtTok(fns, k));
        if (cont === tk) continue; // its own constructor or methods
        if (!sites.has(tk)) sites.set(tk, []); sites.get(tk).push(cont);
      }
    });
    sites.forEach((conts, tk) => { if (conts.length && conts.every((c) => c && types.has(c) && c !== tk)) out.set(tk, 'built only inside ' + types.get(conts[0])); });
    // When the repository visibly registers tool types by building them (some tool type is built outside every tool
    // type, as in registry.Register(&X{}) or AddTool(x.Definition(), …)), a tool type it never builds is unused
    // (superseded code). Without such a sign (reflection, plugin loading) nothing is concluded from its absence.
    const visible = Array.from(sites.values()).some((conts) => conts.some((c) => !c || !types.has(c)));
    if (visible) types.forEach((name, tk) => { if (!out.has(tk) && !(sites.get(tk) || []).length) out.set(tk, 'never built in the source read'); });
    return out;
  };
  // A repository's own tool types (fields tagged json "name" and "inputSchema") that code around an unresolved
  // registration converts: the function holding that registration names the type, reads its description field
  // (spec.Definition.Description), or calls a function that returns it. Set(type name).
  Repo.prototype.convertedOwnTypes = function (results) {
    const out = new Set(); const shaped = this.toolShaped(); if (!shaped.size) return out;
    // (not a site that is itself a literal of the own type with a name known only at run time, nor a function that
    // only builds and returns the own type: those convert nothing)
    const fns = new Map(); // function -> the token indexes of its unresolved sites (a call there builds, not converts)
    results.forEach(({ r, s }) => { if (r && (r.unresolved || r.param || !r.name) && s && s.fn && s.fn.body && s.kind !== 'lit') { if (!fns.has(s.fn)) fns.set(s.fn, new Set()); fns.get(s.fn).add(s.at); } });
    if (!fns.size) return out;
    const returns = new Map(); // function name -> own type it returns (T, *T, []T, []*T)
    const ownOf = (ty) => { for (let k = 0; k < 3 && ty && (ty.k === 'tptr' || ty.k === 'tslice' || ty.k === 'tarray'); k++) ty = ty.x; return ty && ty.k === 'tname' && shaped.has(ty.v) ? ty.v : null; };
    this.pkgs.forEach((pk) => [pk.funcs, pk.methods].forEach((m) => m.forEach((ds) => ds.forEach((d) => { const r0 = d.sig && d.sig.results[0]; const o = r0 && ownOf(r0.type); if (o) returns.set(d.name, o); }))));
    fns.forEach((ats, fn) => {
      const r0 = fn.sig && fn.sig.results[0]; if (r0 && ownOf(r0.type)) return;
      const t = fn.file.t;
      // a call that is itself the unresolved site (dyn(os.Getenv(…)) returning a ToolDef) builds a tool whose name
      // is known only at run time; it converts nothing
      for (let k = fn.body[0]; k < fn.body[1]; k++) {
        const x = t[k]; if (x.y !== 'id') continue;
        if (ats.has(k)) continue;
        if (shaped.has(x.v)) out.add(x.v);
        if (isP(t[k - 1], '.')) shaped.forEach((map, name) => { if (map.description && x.v === map.description) out.add(name); });
        if (isP(t[k + 1], '(') && returns.has(x.v)) out.add(returns.get(x.v));
      }
    });
    return out;
  };
  // Is a struct field of this name assigned anywhere (x.Field = …)? One pass over the files, cached.
  Repo.prototype.fieldAssigned = function (name) {
    if (!this._assigned) {
      const m = new Set();
      this.files.forEach((f) => { const t = f.t; for (let k = 1; k < t.length - 1; k++) if (t[k].y === 'id' && isP(t[k - 1], '.') && isP(t[k + 1], '=')) m.add(t[k].v); });
      this._assigned = m;
    }
    return this._assigned.has(name);
  };
  // How often each identifier occurs in the repository's files (one pass, for unreferenced declarations).
  Repo.prototype.refCount = function () {
    if (this._refs) return this._refs;
    const m = new Map();
    this.files.forEach((f) => f.t.forEach((x) => { if (x.y === 'id') m.set(x.v, (m.get(x.v) || 0) + 1); }));
    return (this._refs = m);
  };
  // The package-level variable or plain function a site is written in (null for methods, init, main and others).
  Repo.prototype.holderOf = function (f, s) {
    if (s.fn) { if (s.fn.recv || /^(init|main)$/.test(s.fn.name) || /^[A-Z]/.test(s.fn.name) && false) return null; return s.fn.name; }
    const v = f.decls.vars.find((d) => d.value && d.value.a <= s.i && s.i < d.value.b);
    return v ? v.name : null;
  };
  // ------------------------------------------------------------ entry
  // files: [[path, text]] of non-test .go files. Returns { found: [{ path, line, tool, fidelity, literal, marks }],
  // unresolved: [{ path, line, description, title, lost }], overBudget: [{ path, line }] }.
  function analyse(files, opts) {
    let repo;
    try { repo = new Repo(files, opts); } catch (e) { if (e instanceof OverBudget) return { found: [], unresolved: [], overBudget: [{ path: (files[0] || [''])[0], line: null, why: WHY_WORK }] }; throw e; }
    try { const r = repo.run(); r.work = (opts && opts.workBudget || DEFAULT_BUDGET) - repo.work.left; if (r.overBudget.length) { r.found = []; r.unresolved = []; r.overBudget = r.overBudget.slice(0, 20); } return r; } catch (e) {
      if (e instanceof OverBudget) return { found: [], unresolved: [], overBudget: [{ path: (files[0] || [''])[0], line: null, why: WHY_WORK }] };
      throw e;
    }
  }
  // Does a Go file look like it defines tools (a cheap test, for choosing files)?
  const TOOL_HINT = /\bNewTool(?:WithRawSchema)?\s*\(|\bTool\s*\{|\bAddTools?\s*\(|\bRegisterTool\s*\(|\bToolOption\b|\bWithDescription\s*\(/;
  function constructsServer(text) { return typeof text === 'string' && CONSTRUCTS.test(text); }

  return { Repo, tokenize, bracketIndex, analyse, constructsServer, TOOL_HINT, parseTag, buildConstraint };
});
