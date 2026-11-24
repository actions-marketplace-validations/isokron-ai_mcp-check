// repo-csharp: reads the tools of an MCP server written in C# from its source, without running it. Browser and Node.
// Used by repo-source.cjs (RepoSource), which decides which files to read; nothing here touches the network.
//
//   RepoCSharp.analyse([[path, text]], { manifests: [[path, text]], workBudget }) -> { found, unresolved, overBudget }
//   RepoCSharp.tokenize(text)                                                    -> tokens
//
// Read, the way the official C# SDK (ModelContextProtocol, 2.x; checked against 2.4.0 with Microsoft.Extensions.AI
// 10.11) lists them:
//   [McpServerTool(Name = …, Title = …, ReadOnly = …, Destructive = …, Idempotent = …, OpenWorld = …,
//   UseStructuredContent = …, IconSource = …)] on methods (static or instance) of classes marked [McpServerToolType],
//   or of classes named in WithTools<T>() / WithTools(typeof(T)). The name is Name, else the method name as the SDK
//   derives it (an "Async" suffix dropped on async methods, then snake_case; the method name itself before
//   0.3.0-preview.2). The description is [Description] (on a partial method without one, its XML doc comment, as the
//   SDK's source generator writes it), with "Returns: …" from [return: Description] unless UseStructuredContent. Title
//   and the four hints become `title` and `annotations` only when one of them is set, as the SDK does. The input
//   schema is built from the parameters as AIJsonUtilities does under the SDK's serializer options: [Description],
//   defaults ([DefaultValue] or `= value`), `required` for parameters without a default, nullable types, integers and
//   numbers, strings and their formats, arrays and lists, string-keyed dictionaries, enums of the repository (as
//   strings), and the data annotations [Range], [MinLength], [MaxLength], [StringLength], [RegularExpression],
//   [EmailAddress], [Url], [Required], [DisplayName]. Parameters the SDK binds itself (CancellationToken, McpServer,
//   RequestContext<…>, IProgress<…>, ClaimsPrincipal, IServiceProvider) and services (interfaces, framework services,
//   types the repository registers with Add{Singleton,Scoped,Transient,HttpClient,…}<T>, [FromKeyedServices]) are
//   left out of the schema.
// Never guessed: a parameter of a type the reader does not know (an argument object, a type from a package) makes the
// input schema unreadable; a name it cannot work out is counted as unresolved (its text is still scanned); a
// description it cannot work out is marked unreadable, its string literals kept for the poisoning checks. The output
// schema (UseStructuredContent) is not read: it depends on the return type's serialised shape and the client's protocol
// version, so it is left out rather than guessed. McpServerTool.Create(…) tools built in code are counted as
// unresolved. Linear in the input: one tokenizer pass, one bracket pass, and a work budget.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoCSharp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STR = 64 * 1024;
  const DEFAULT_BUDGET = 2e6;
  const MAX_TOOLS = 20000;
  class OverBudget extends Error {}
  const WHY_WORK = 'the reader\'s work limit for one repository';
  const UNK = (lost) => ({ __unk: true, lost: (lost || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 2000) });
  const isUnk = (v) => !!v && typeof v === 'object' && v.__unk === true;

  // ------------------------------------------------------------ tokenizer
  // Tokens: { y: 'id' | 'str' | 'num' | 'chr' | 'p' | 'interp', v, s }. Comments are skipped; `///` doc comment lines are
  // kept per file (docs: [{ s, e, text }]) for partial methods. Preprocessor lines (#if, #region, …) are skipped: both
  // branches of an #if are read.
  function tokenize(src) {
    const t = []; const docs = []; const n = src.length; let i = 0;
    let lineStart = true;
    const push = (y, v, s) => { t.push({ y, v, s }); lineStart = false; };
    while (i < n) {
      const c = src[i];
      if (c === '\n') { i++; lineStart = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { i++; continue; }
      if (c === '#' && lineStart) { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        const s = i; while (i < n && src[i] !== '\n') i++;
        if (src[s + 2] === '/' && src[s + 3] !== '/') docs.push({ s, e: i, text: src.slice(s + 3, i).replace(/^ /, '') });
        continue;
      }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      const s = i;
      // string forms: "…", @"…", $"…", $@"…", @$"…", """…""" (raw, with any number of $ before it), and a u8 suffix
      let dollars = 0; let at = false; let j = i;
      while (src[j] === '$' || src[j] === '@') { if (src[j] === '$') dollars++; else at = true; j++; }
      if (src[j] === '"' && (j === i || dollars || at)) {
        let q = 0; while (src[j + q] === '"') q++;
        const r = q >= 3 && !at ? rawString(src, j, q, dollars) : at ? verbatimString(src, j, dollars) : regularString(src, j, dollars);
        i = r.end;
        if (r.parts) { t.push({ y: 'interp', v: r.parts.join('…'), parts: r.parts, exprs: r.exprs, s }); lineStart = false; } else push('str', r.v, s);
        if (src[i] === 'u' && src[i + 1] === '8') i += 2;
        continue;
      }
      if (c === '\'') {
        let v = ''; i++;
        if (src[i] === '\\') { const r = escapeAt(src, i); v = r.v; i = r.end; } else if (i < n) v = src[i++];
        while (i < n && src[i] !== '\'' && src[i] !== '\n') i++;
        i++; push('chr', v, s); continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9_]+)?)([uUlLfFdDmM]{0,3})/.exec(src.slice(i, i + 64));
        const raw = m ? m[1].replace(/_/g, '') : c; i += m ? m[0].length : 1;
        const num = /^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16) : /^0[bB]/.test(raw) ? parseInt(raw.slice(2), 2) : Number(raw);
        t.push({ y: 'num', v: num, s, real: /[.eE]/.test(raw) || /[fFdDmM]/.test(m ? m[2] : '') }); lineStart = false; continue;
      }
      if (c === '@' && /[A-Za-z_]/.test(src[i + 1] || '')) { const m = /^@[A-Za-z_]\w*/.exec(src.slice(i, i + 200)); i += m[0].length; push('id', m[0].slice(1), s); continue; }
      if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127 && /\p{L}/u.test(c)) { const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i, i + 200)); i += m[0].length; push('id', m[0], s); continue; }
      const two = src.substr(i, 2); const three = src.substr(i, 3);
      if (three === '??=' || three === '<<=' || three === '...') { i += 3; push('p', three, s); continue; }
      if (['=>', '??', '?.', '::', '==', '!=', '<=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..'].includes(two)) { i += 2; push('p', two, s); continue; }
      i++; push('p', c, s);
    }
    return { t, docs };
  }
  function escapeAt(src, i) {
    const e = src[i + 1];
    const map = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };
    if (map[e] !== undefined) return { v: map[e], end: i + 2 };
    if (e === 'u') return { v: String.fromCharCode(parseInt(src.substr(i + 2, 4), 16) || 0), end: i + 6 };
    if (e === 'U') { const cp = parseInt(src.substr(i + 2, 8), 16) || 0; let v = ''; try { v = String.fromCodePoint(cp); } catch (x) { v = ''; } return { v, end: i + 10 }; }
    if (e === 'x') { const m = /^[0-9a-fA-F]{1,4}/.exec(src.substr(i + 2, 4)); return { v: m ? String.fromCharCode(parseInt(m[0], 16)) : 'x', end: i + 2 + (m ? m[0].length : 0) }; }
    return { v: e === undefined ? '' : e, end: i + 2 };
  }
  // An interpolation hole {expr[,align][:format]} from i (just past "{"): { expr, end } (end just past "}").
  function holeAt(src, i, braces) {
    const n = src.length; let d = 1; const s = i;
    while (i < n && d) {
      const c = src[i];
      if (c === '"') { i++; while (i < n && src[i] !== '"' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } }
      else if (c === '{') d++;
      else if (c === '}') { d--; if (!d) break; }
      i++;
    }
    let expr = src.slice(s, i);
    const m = /^([\s\S]*?)(?:,\s*-?\d+)?(?::[^:{}"]*)?$/.exec(expr); if (m) expr = m[1];
    return { expr: expr.trim(), end: Math.min(n, i + braces) };
  }
  function regularString(src, i, dollars) {
    const n = src.length; i++; let cur = ''; const parts = []; const exprs = [];
    while (i < n && src[i] !== '"' && src[i] !== '\n') {
      if (src[i] === '\\') { const r = escapeAt(src, i); cur += r.v; i = r.end; continue; }
      if (dollars && src[i] === '{') { if (src[i + 1] === '{') { cur += '{'; i += 2; continue; } const h = holeAt(src, i + 1, 1); parts.push(cur); cur = ''; exprs.push(h.expr); i = h.end; continue; }
      if (dollars && src[i] === '}' && src[i + 1] === '}') { cur += '}'; i += 2; continue; }
      cur += src[i++];
    }
    parts.push(cur);
    return exprs.length ? { parts, exprs, end: i + 1 } : { v: parts[0], end: i + 1 };
  }
  function verbatimString(src, i, dollars) {
    const n = src.length; i++; let cur = ''; const parts = []; const exprs = [];
    while (i < n) {
      if (src[i] === '"') { if (src[i + 1] === '"') { cur += '"'; i += 2; continue; } break; }
      if (dollars && src[i] === '{') { if (src[i + 1] === '{') { cur += '{'; i += 2; continue; } const h = holeAt(src, i + 1, 1); parts.push(cur); cur = ''; exprs.push(h.expr); i = h.end; continue; }
      if (dollars && src[i] === '}' && src[i + 1] === '}') { cur += '}'; i += 2; continue; }
      cur += src[i++];
    }
    parts.push(cur.replace(/\r\n/g, '\n'));
    return exprs.length ? { parts, exprs, end: i + 1 } : { v: parts[0], end: i + 1 };
  }
  // Raw string literal: q quotes; multi-line ones drop the first and last line and the closing line's indentation.
  function rawString(src, i, q, dollars) {
    const n = src.length; const close = '"'.repeat(q); const s = i + q;
    let e = src.indexOf(close, s); if (e < 0) e = n;
    let body = src.slice(s, e).replace(/\r\n/g, '\n');
    let end = e + q; while (src[end] === '"') end++;
    if (body.includes('\n')) {
      const lines = body.split('\n'); const last = lines[lines.length - 1];
      const indent = /^\s*$/.test(last) ? last : '';
      const mid = lines.slice(1, lines.length - 1).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^\s+/, '')));
      body = mid.join('\n');
    }
    if (!dollars) return { v: body, end };
    const open = '{'.repeat(dollars); const parts = []; const exprs = []; let cur = ''; let k = 0;
    while (k < body.length) {
      if (body.startsWith(open, k) && body[k + dollars] !== '{') { const h = holeAt(body, k + dollars, dollars); parts.push(cur); cur = ''; exprs.push(h.expr); k = h.end; continue; }
      cur += body[k++];
    }
    parts.push(cur);
    return exprs.length ? { parts, exprs, end } : { v: parts[0], end };
  }
  const isP = (x, v) => !!x && x.y === 'p' && x.v === v;
  const isId = (x, v) => !!x && x.y === 'id' && (v === undefined || x.v === v);
  // Matching brackets ( ) [ ] { } in one pass: close[i] for an opener, open[i] for a closer (-1 when unmatched).
  function bracketIndex(t) {
    const close = new Int32Array(t.length).fill(-1); const open = new Int32Array(t.length).fill(-1); const st = [];
    const pair = { ')': '(', ']': '[', '}': '{' };
    for (let i = 0; i < t.length; i++) {
      const x = t[i]; if (x.y !== 'p') continue;
      if (x.v === '(' || x.v === '[' || x.v === '{') st.push(i);
      else if (pair[x.v]) {
        // pop to the matching opener (an unmatched one in between is dropped)
        for (let k = st.length - 1; k >= 0; k--) { if (t[st[k]].v === pair[x.v]) { const o = st[k]; st.length = k; close[o] = i; open[i] = o; break; } }
      }
    }
    return { close, open };
  }

  // ------------------------------------------------------------ files
  const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'async', 'virtual', 'override', 'sealed', 'abstract', 'extern', 'unsafe', 'new', 'partial', 'readonly', 'required', 'file', 'const', 'volatile', 'fixed']);
  const TYPE_KW = new Set(['class', 'struct', 'record', 'interface', 'enum']);
  function File(path, text, repo) {
    this.path = path; this.text = text; this.repo = repo;
    const k = tokenize(text); this.t = k.t; this.docs = k.docs;
    repo.spend(this.t.length);
    const b = bracketIndex(this.t); this.close = b.close; this.open = b.open;
    this.lines = null;
  }
  File.prototype.lineAt = function (s) {
    if (!this.lines) { this.lines = [0]; for (let i = 0; i < this.text.length; i++) if (this.text.charCodeAt(i) === 10) this.lines.push(i + 1); }
    let lo = 0; let hi = this.lines.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.lines[m] <= s) lo = m + 1; else hi = m; }
    return lo;
  };
  // Attribute sections ending just before token i (going back over `]`): [{ attrs: [{ name, full, a, b, target }], s, e }].
  File.prototype.sectionsBefore = function (i) {
    const t = this.t; const out = []; let k = i - 1;
    while (k >= 0 && isP(t[k], ']')) { const o = this.open[k]; if (o < 0) break; const sec = this.section(o); if (!sec) break; out.unshift(sec); k = o - 1; }
    return out;
  };
  // One attribute section "[ target: A(args), B ]" at token o ("["), or null when it is not one.
  File.prototype.section = function (o) {
    const t = this.t; const c = this.close[o]; if (c < 0) return null;
    let a = o + 1; let target = null;
    if (isId(t[a]) && isP(t[a + 1], ':') && !isP(t[a + 2], ':')) { target = t[a].v; a += 2; }
    const attrs = [];
    while (a < c) {
      if (!isId(t[a])) return null;
      const segs = [t[a].v]; let j = a + 1;
      while ((isP(t[j], '.') || isP(t[j], '::')) && isId(t[j + 1])) { segs.push(t[j + 1].v); j += 2; }
      let args = null;
      if (isP(t[j], '(')) { const cc = this.close[j]; if (cc < 0 || cc > c) return null; args = [j + 1, cc]; j = cc + 1; }
      const nm = segs[segs.length - 1].replace(/Attribute$/, '');
      attrs.push({ name: nm, full: segs.join('.'), args, target });
      if (isP(t[j], ',')) { j++; } else if (j !== c) return null;
      a = j;
    }
    return { attrs, s: o, e: c };
  };
  // Top-level comma-separated parts of tokens [a, b): [[p, q]], angle brackets after an identifier counted as generics.
  File.prototype.splitTop = function (a, b) {
    const t = this.t; const out = []; let s = a; let angle = 0;
    for (let k = a; k < b; k++) {
      const x = t[k];
      if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{')) { const c = this.close[k]; if (c > 0 && c < b) { k = c; continue; } }
      if (isP(x, '<') && (isId(t[k - 1]) || isP(t[k - 1], '>') || isP(t[k - 1], '?'))) angle++;
      else if (isP(x, '>') && angle > 0) angle--;
      else if (isP(x, ',') && angle === 0) { out.push([s, k]); s = k + 1; }
    }
    if (s < b) out.push([s, b]);
    return out;
  };
  // A type at token i: { ty, end }. ty: { k: 'name', segs, args: [ty], nullable } | { k: 'array', x, nullable } |
  // { k: 'tuple' } | null.
  File.prototype.parseType = function (i, depth) {
    const t = this.t; depth = depth || 0; if (depth > 16) return null;
    let ty;
    if (isP(t[i], '(')) { const c = this.close[i]; if (c < 0) return null; ty = { k: 'tuple' }; i = c + 1; }
    else {
      if (!isId(t[i])) return null;
      if (isId(t[i], 'global') && isP(t[i + 1], '::')) i += 2;
      if (!isId(t[i])) return null;
      const segs = [t[i].v]; i++;
      let args = [];
      for (;;) {
        if (isP(t[i], '<')) {
          const r = this.typeArgs(i, depth); if (!r) return null; args = r.args; i = r.end;
        }
        if ((isP(t[i], '.') || isP(t[i], '::')) && isId(t[i + 1])) { segs.push(t[i + 1].v); i += 2; args = []; continue; }
        break;
      }
      ty = { k: 'name', segs, args };
    }
    for (;;) {
      if (isP(t[i], '?')) { ty = Object.assign({}, ty, { nullable: true }); i++; continue; }
      if (isP(t[i], '[')) { const c = this.close[i]; if (c < 0) return null; let ok = true; for (let k = i + 1; k < c; k++) if (!isP(t[k], ',')) ok = false; if (!ok) return null; ty = { k: 'array', x: ty }; i = c + 1; continue; }
      if (isP(t[i], '*')) { ty = { k: 'pointer' }; i++; continue; }
      break;
    }
    return { ty, end: i };
  };
  File.prototype.typeArgs = function (i, depth) {
    const t = this.t; const args = []; let k = i + 1;
    for (;;) {
      const r = this.parseType(k, depth + 1); if (!r) return null; args.push(r.ty); k = r.end;
      if (isP(t[k], ',')) { k++; continue; }
      if (isP(t[k], '>')) return { args, end: k + 1 };
      return null;
    }
  };
  // Type declarations of the file: { kind, name, s (keyword), body: [open, close] | null, attrs, ctor: [a, b] | null,
  // parent }, and enum members.
  File.prototype.declarations = function () {
    if (this.decls) return this.decls;
    const t = this.t; const decls = [];
    for (let i = 0; i < t.length; i++) {
      if (!isId(t[i]) || !TYPE_KW.has(t[i].v)) continue;
      let k = i + 1; const kind = t[i].v;
      if (kind === 'record' && (isId(t[k], 'class') || isId(t[k], 'struct'))) k++;
      if (!isId(t[k])) continue;
      // a declaration starts a member: before it only modifiers and attribute sections, after a { } ; ] or the start
      let m = i - 1; while (m >= 0 && isId(t[m]) && MODIFIERS.has(t[m].v)) m--;
      if (kind === 'class' && isId(t[i - 1], 'record')) continue;
      if (m >= 0 && !(isP(t[m], '{') || isP(t[m], '}') || isP(t[m], ';') || isP(t[m], ']'))) continue;
      const name = t[k].v; k++;
      if (isP(t[k], '<')) { let d = 0; for (; k < t.length; k++) { if (isP(t[k], '<')) d++; else if (isP(t[k], '>')) { d--; if (!d) { k++; break; } } else if (isP(t[k], '{') || isP(t[k], ';')) break; } }
      let ctor = null;
      if (isP(t[k], '(')) { const c = this.close[k]; if (c > 0) { ctor = [k + 1, c]; k = c + 1; } }
      let body = null;
      for (let q = k; q < t.length && q < k + 400; q++) { if (isP(t[q], '{')) { const c = this.close[q]; if (c > 0) body = [q, c]; break; } if (isP(t[q], ';')) break; if (isP(t[q], '(') || isP(t[q], '[')) { const c = this.close[q]; if (c > 0) q = c; } }
      const attrs = []; this.sectionsBefore(m + 1).forEach((sec) => sec.attrs.forEach((a) => attrs.push(a)));
      const d = { kind, name, s: i, body, attrs, ctor, parent: null, f: this };
      if (kind === 'enum' && body) d.members = this.enumMembers(body[0] + 1, body[1]);
      decls.push(d);
    }
    // parents (innermost enclosing body)
    decls.forEach((d) => { let best = null; decls.forEach((o) => { if (o !== d && o.body && o.body[0] < d.s && o.body[1] > d.s && (!best || o.body[0] > best.body[0])) best = o; }); d.parent = best; });
    this.decls = decls;
    return decls;
  };
  File.prototype.enumMembers = function (a, b) {
    const t = this.t; const out = [];
    this.splitTop(a, b).forEach(([p, q]) => {
      let k = p; const attrs = [];
      while (isP(t[k], '[')) { const sec = this.section(k); if (!sec) return; sec.attrs.forEach((x) => attrs.push(x)); k = sec.e + 1; }
      if (!isId(t[k])) return;
      const nm = attrs.find((x) => x.name === 'JsonStringEnumMemberName' && x.args);
      let wire = t[k].v;
      if (nm) { const s = this.t[nm.args[0]]; wire = s && s.y === 'str' && nm.args[1] === nm.args[0] + 1 ? s.v : null; }
      out.push({ name: t[k].v, wire });
      void q;
    });
    return out;
  };
  // The innermost type declaration whose body holds token k.
  File.prototype.typeAt = function (k) {
    let best = null; this.declarations().forEach((d) => { if (d.body && d.body[0] < k && d.body[1] > k && (!best || d.body[0] > best.body[0])) best = d; });
    return best;
  };

  // ------------------------------------------------------------ the repository
  function Repo(files, opts) {
    opts = opts || {};
    this.budget = opts.workBudget || DEFAULT_BUDGET;
    this.files = [];
    for (const [p, text] of files) {
      if (typeof text !== 'string') continue;
      try { this.files.push(new File(p, text, this)); } catch (e) { if (e instanceof OverBudget) throw e; }
    }
    this.manifests = (opts.manifests || []).filter(([, x]) => typeof x === 'string');
    this.sdk = sdkVersion(this.manifests);
    this.nullable = nullableOn(this.manifests);
    this.index();
  }
  Repo.prototype.spend = function (n) { this.budget -= n; if (this.budget < 0) throw new OverBudget(); };
  Repo.prototype.index = function () {
    this.types = new Map(); // simple name -> [decl]
    this.consts = new Map(); // "Type.NAME" and "NAME" -> [{ f, a, b, owner }]
    this.services = new Set(); this.registered = new Set(); this.fromAssembly = false;
    this.files.forEach((f) => {
      f.declarations().forEach((d) => { if (!this.types.has(d.name)) this.types.set(d.name, []); this.types.get(d.name).push(d); });
      const t = f.t;
      for (let i = 0; i < t.length; i++) {
        const x = t[i]; if (x.y !== 'id') continue;
        // const string NAME = …; / static readonly string NAME = …;
        if ((x.v === 'const' || (x.v === 'readonly' && (isId(t[i - 1], 'static') || isId(t[i + 1], 'static')))) && (i === 0 || !isP(t[i - 1], '.'))) {
          let k = i + 1; if (isId(t[k], 'static')) k++;
          const r = f.parseType(k); if (!r || !isId(t[r.end]) || !isP(t[r.end + 1], '=')) continue;
          const nm = t[r.end].v; let e = r.end + 2; while (e < t.length && !isP(t[e], ';')) { if (t[e].y === 'p' && (t[e].v === '(' || t[e].v === '{' || t[e].v === '[') && f.close[e] > 0) e = f.close[e]; e++; }
          const owner = f.typeAt(i); const entry = { f, a: r.end + 2, b: e, owner };
          [nm, owner ? owner.name + '.' + nm : null].filter(Boolean).forEach((key) => { if (!this.consts.has(key)) this.consts.set(key, []); this.consts.get(key).push(entry); });
          continue;
        }
        // services: AddSingleton<T>, AddScoped<IFoo, Foo>, AddHttpClient<T>, AddDbContext<T>, Configure<T> (IOptions<T>)
        if (/^(Add(?:Keyed)?(?:Singleton|Scoped|Transient)|AddHttpClient|AddDbContext|AddDbContextFactory|AddHostedService|TryAdd(?:Singleton|Scoped|Transient)|AddOptions|Configure)$/.test(x.v) && isP(t[i + 1], '<')) {
          const r = f.typeArgs(i + 1, 0); if (r) r.args.forEach((a) => { if (a && a.k === 'name') this.services.add(a.segs[a.segs.length - 1]); });
          continue;
        }
        if (/^(Add(?:Keyed)?(?:Singleton|Scoped|Transient)|TryAdd(?:Singleton|Scoped|Transient))$/.test(x.v) && isP(t[i + 1], '(')) {
          const c = f.close[i + 1]; if (c < 0) continue;
          let a = i + 2; if (/^AddKeyed/.test(x.v)) { const parts = f.splitTop(i + 2, c); if (parts.length < 2) continue; a = parts[1][0]; }
          const add = (ty) => { if (ty && ty.k === 'name') this.services.add(ty.segs[ty.segs.length - 1]); };
          // typeof(T), new T(…), a lambda returning new T(…), or a variable declared with its type in the same file
          if (isId(t[a], 'typeof') && isP(t[a + 1], '(')) { const r = f.parseType(a + 2); if (r) add(r.ty); continue; }
          let k = a; if (isId(t[k]) && isP(t[k + 1], '=>')) k += 2; else if (isP(t[k], '(') && f.close[k] > 0 && isP(t[f.close[k] + 1], '=>')) k = f.close[k] + 2;
          if (isId(t[k], 'new')) { const r = f.parseType(k + 1); if (r) add(r.ty); continue; }
          if (isId(t[a]) && (isP(t[a + 1], ')') || isP(t[a + 1], ','))) { const ty = varType(f, t[a].v, a); if (ty) add(ty); }
          continue;
        }
        if (x.v === 'WithToolsFromAssembly') { this.fromAssembly = true; continue; }
        if (x.v === 'WithTools' && isP(t[i + 1], '<')) { const r = f.typeArgs(i + 1, 0); if (r) r.args.forEach((a) => { if (a && a.k === 'name') this.registered.add(a.segs[a.segs.length - 1]); }); continue; }
        if (x.v === 'WithTools' && isP(t[i + 1], '(')) {
          const c = f.close[i + 1];
          for (let k = i + 2; k < c && k > 0; k++) if (isId(t[k], 'typeof') && isP(t[k + 1], '(')) { const r = f.parseType(k + 2); if (r && r.ty && r.ty.k === 'name') this.registered.add(r.ty.segs[r.ty.segs.length - 1]); }
        }
      }
    });
  };
  // The type of a variable from its declaration before token `before` in the same file: "T name;", "T name =", or
  // "var name = new T(" / "var name = await T.Create…(" (null when it cannot be told).
  function varType(f, name, before) {
    const t = f.t;
    for (let k = before - 1; k > 0; k--) {
      if (!isId(t[k], name) || !(isP(t[k + 1], ';') || isP(t[k + 1], '=') || isP(t[k + 1], ','))) continue;
      if (isId(t[k - 1], 'var')) {
        if (!isP(t[k + 1], '=')) continue;
        let a = k + 2; if (isId(t[a], 'await')) a++;
        if (isId(t[a], 'new')) { const r = f.parseType(a + 1); return r ? r.ty : null; }
        // T.Create(…) / T.CreateAsync(…): a factory of its own type, by convention
        if (isId(t[a]) && isP(t[a + 1], '.') && isId(t[a + 2]) && /^(Create|CreateAsync|CreateEmpty|Load|LoadAsync|Build|BuildAsync)$/.test(t[a + 2].v)) return { k: 'name', segs: [t[a].v], args: [] };
        return null;
      }
      // "T name": walk back over the type
      let s = k - 1; let depth = 0;
      while (s >= 0) { const x = t[s]; if (isP(x, '>')) depth++; else if (isP(x, '<')) depth--; else if (!(isId(x) || isP(x, '.') || isP(x, '?') || isP(x, ',') && depth > 0 || isP(x, '[') || isP(x, ']'))) break; if (depth === 0 && isId(x) && !(isP(t[s - 1], '.') || isP(t[s - 1], '<') || isP(t[s - 1], ','))) break; s--; }
      const r = f.parseType(s); if (r && r.end === k) return r.ty;
    }
    return null;
  }
  Repo.prototype.typeDecl = function (segs, kind) {
    const xs = this.types.get(segs[segs.length - 1]) || [];
    const ok = xs.filter((d) => !kind || d.kind === kind);
    return ok.length === 1 ? ok[0] : ok.length > 1 && ok.every((d) => JSON.stringify(d.members) === JSON.stringify(ok[0].members)) ? ok[0] : null;
  };

  // ------------------------------------------------------------ constant expressions
  // A value: a string, number, boolean, null, { __enum: decl, member } or UNK(lost). nameof(X.Y) is "Y".
  Repo.prototype.ev = function (f, a, b, depth, scope) {
    const t = f.t; depth = depth || 0; this.spend(b - a + 1);
    if (a >= b) return UNK([]);
    if (depth > 24) return UNK(literalsOf(f, a, b));
    while (b - a > 1 && isP(t[b - 1], '!')) b--; // the null-forgiving operator: x!
    // a + b + … (strings and numbers), at the top level
    const plus = []; let s = a;
    for (let k = a; k < b; k++) {
      const x = t[k];
      if (x.y === 'p' && (x.v === '(' || x.v === '[' || x.v === '{') && f.close[k] > 0 && f.close[k] < b) { k = f.close[k]; continue; }
      if (isP(x, '+') && k > s) { plus.push([s, k]); s = k + 1; }
      if (isP(x, '?') || isP(x, '??') || isP(x, '==') || isP(x, '!=') || isP(x, '&&') || isP(x, '||') || isP(x, '=>')) return UNK(literalsOf(f, a, b));
    }
    if (plus.length) {
      plus.push([s, b]);
      const vs = plus.map(([p, q]) => this.ev(f, p, q, depth + 1, scope));
      if (vs.some(isUnk)) return UNK([].concat(...vs.map((v) => (isUnk(v) ? v.lost : typeof v === 'string' ? [v] : []))));
      if (vs.every((v) => typeof v === 'number')) return vs.reduce((x, y) => x + y, 0);
      return vs.map((v) => (v === null ? '' : typeof v === 'object' ? (v.member || '') : String(v))).join('');
    }
    if (isP(t[a], '(') && f.close[a] === b - 1) return this.ev(f, a + 1, b - 1, depth + 1, scope);
    if (b - a === 1) {
      const x = t[a];
      if (x.y === 'str') return x.v;
      if (x.y === 'chr') return x.v;
      if (x.y === 'num') return x.v;
      if (x.y === 'interp') return this.interp(f, x, depth, scope);
      if (isId(x, 'true')) return true;
      if (isId(x, 'false')) return false;
      if (isId(x, 'null')) return null;
      if (isId(x, 'default')) return { __default: true };
    }
    if (isP(t[a], '-') && b - a === 2 && t[a + 1].y === 'num') return -t[a + 1].v;
    if (isId(t[a], 'nameof') && isP(t[a + 1], '(') && f.close[a + 1] === b - 1) { const k = b - 2; return isId(t[k]) ? t[k].v : UNK([]); }
    // string.Empty
    if (b - a === 3 && isId(t[a], 'string') && isP(t[a + 1], '.') && isId(t[a + 2], 'Empty')) return '';
    // a dotted name: a constant (NAME, Type.NAME) or an enum member (Enum.Member)
    const segs = []; let k = a;
    if (isId(t[k]) && t[k].v === 'global' && isP(t[k + 1], '::')) k += 2;
    while (k < b && isId(t[k])) { segs.push(t[k].v); k++; if (k < b && isP(t[k], '.')) { k++; continue; } break; }
    if (k === b && segs.length) {
      if (segs.length >= 2) {
        const en = this.typeDecl(segs.slice(0, -1), 'enum');
        if (en && en.members && en.members.some((m) => m.name === segs[segs.length - 1])) return { __enum: en, member: segs[segs.length - 1] };
      }
      const key = segs.length >= 2 ? segs.slice(-2).join('.') : segs[0];
      let cs = this.consts.get(key) || [];
      if (segs.length === 1 && scope) { const own = cs.filter((c) => c.owner && (c.owner === scope || (scope.parent && c.owner === scope.parent))); if (own.length) cs = own; }
      if (cs.length === 1 || (cs.length > 1 && cs.every((c) => c.f.text.slice(c.f.t[c.a].s, c.f.t[c.b - 1].s) === cs[0].f.text.slice(cs[0].f.t[cs[0].a].s, cs[0].f.t[cs[0].b - 1].s)))) {
        const c = cs[0]; if (c.busy) return UNK([]);
        c.busy = true; try { return this.ev(c.f, c.a, c.b, depth + 1, c.owner); } finally { c.busy = false; }
      }
    }
    return UNK(literalsOf(f, a, b));
  };
  Repo.prototype.interp = function (f, x, depth, scope) {
    let out = x.parts[0]; const lost = [];
    for (let k = 0; k < x.exprs.length; k++) {
      let v;
      try { const sub = tokenize(x.exprs[k]); const g = { t: sub.t, text: x.exprs[k], close: bracketIndex(sub.t).close, open: null }; Object.setPrototypeOf(g, File.prototype); g.repo = this; v = this.ev(g, 0, sub.t.length, depth + 1, scope); } catch (e) { if (e instanceof OverBudget) throw e; v = UNK([]); }
      if (isUnk(v) || (v && typeof v === 'object' && !v.__enum)) { x.parts.forEach((p) => { if (p.trim()) lost.push(p); }); return UNK(lost.concat(isUnk(v) ? v.lost : [])); }
      out += (v === null ? '' : typeof v === 'object' ? v.member : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v)) + x.parts[k + 1];
    }
    return out;
  };
  function literalsOf(f, a, b) {
    const out = []; for (let k = a; k < b && out.length < 2000; k++) { const x = f.t[k]; if (x.y === 'str' && x.v.trim()) out.push(x.v); else if (x.y === 'interp') x.parts.forEach((p) => { if (p.trim()) out.push(p); }); }
    return out;
  }

  // ------------------------------------------------------------ SDK version and project settings
  // The ModelContextProtocol package version a project pins (PackageReference or central PackageVersion), or null.
  function sdkVersion(manifests) {
    const vs = [];
    manifests.forEach(([, x]) => {
      const re = /<Package(?:Reference|Version)\b([^>]*)>(?:\s*<Version>([^<]*)<\/Version>)?/gi;
      let m; while ((m = re.exec(x))) {
        if (!/\bInclude\s*=\s*"ModelContextProtocol(?:\.Core|\.AspNetCore)?"/i.test(m[1])) continue;
        const a = /\bVersion\s*=\s*"([^"]*)"/i.exec(m[1]); const v = a ? a[1] : m[2]; if (v) vs.push(v.trim());
      }
    });
    // $(Property) from a <Property>value</Property> in the manifests read
    const prop = (name) => { for (const [, x] of manifests) { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '>').exec(x); if (m) return m[1].trim(); } return null; };
    for (let k = 0; k < vs.length; k++) { const m = /^\$\(([\w.]+)\)$/.exec(vs[k]); if (m) { const v = prop(m[1]); if (v) vs[k] = v; } }
    return vs.length ? vs : null;
  }
  // Is a version before 0.3.0-preview.2 (where tool names derived from methods became snake_case)?
  function preSnake(v) {
    const m = /^\[?\s*(\d+)\.(\d+)(?:\.(\d+))?(?:-preview\.(\d+))?/.exec(String(v || '')); if (!m || /[*$]/.test(v)) return false;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)]; const pre = m[4] !== undefined ? Number(m[4]) : null;
    if (maj > 0 || min > 3) return false;
    if (min < 3) return true;
    return pat === 0 && pre !== null && pre < 2;
  }
  function nullableOn(manifests) {
    let on = null; manifests.forEach(([, x]) => { const m = /<Nullable>\s*(enable|disable|warnings|annotations)\s*<\/Nullable>/i.exec(x); if (m) on = on || /^(enable|annotations)$/i.test(m[1]); });
    return on;
  }

  // ------------------------------------------------------------ names
  // System.Text.Json's JsonNamingPolicy.SnakeCaseLower.
  function snakeLower(name) {
    let out = ''; let state = 0; // 0 not started, 1 upper, 2 lower or digit, 3 space
    const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();
    const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase();
    for (let i = 0; i < name.length; i++) {
      const c = name[i];
      if (isUpper(c)) {
        if (state === 2 || state === 3) out += '_';
        else if (state === 1 && i + 1 < name.length && isLower(name[i + 1])) out += '_';
        out += c.toLowerCase(); state = 1;
      } else if (isLower(c) || /[0-9]/.test(c)) {
        if (state === 3) out += '_';
        out += c; state = 2;
      } else if (c === ' ') { if (state !== 0) state = 3; }
      else { out += c; state = 0; }
    }
    return out;
  }
  // The name the SDK gives a method without [McpServerTool(Name = …)].
  function deriveName(method, isAsync, snake) {
    let name = method;
    if (isAsync && name.endsWith('Async') && name.length > 5) name = name.slice(0, -5);
    if (!snake) return name;
    name = name.replace(/[^A-Za-z0-9]/g, '_').replace(/^_+|_+$/g, '');
    if (!name.length) name = method;
    return snakeLower(name);
  }

  // ------------------------------------------------------------ schemas
  const SDK_BOUND = /^(CancellationToken|McpServer|IMcpServer|IMcpServerSession|RequestContext|IProgress|ClaimsPrincipal|IServiceProvider|AIFunctionArguments|IMcpEndpoint)$/;
  const FRAMEWORK_SERVICES = /^(ILogger|ILoggerFactory|IConfiguration|IConfigurationRoot|IHostEnvironment|IWebHostEnvironment|IHostApplicationLifetime|IOptions|IOptionsSnapshot|IOptionsMonitor|IMemoryCache|IDistributedCache|IHttpClientFactory|HttpClient|IServiceScopeFactory|TimeProvider|IHttpContextAccessor|HttpContext|DbContext|IMediator|ISender|IMapper|IFileProvider)$/;
  const COLLECTIONS = /^(List|IList|IEnumerable|ICollection|IReadOnlyList|IReadOnlyCollection|HashSet|ISet|IReadOnlySet|Collection|ReadOnlyCollection|ImmutableArray|ImmutableList|LinkedList|Queue|Stack|SortedSet|ConcurrentBag|IAsyncEnumerable)$/;
  const DICTS = /^(Dictionary|IDictionary|IReadOnlyDictionary|SortedDictionary|ConcurrentDictionary|ImmutableDictionary)$/;
  const INT = /^(int|uint|long|ulong|short|ushort|byte|sbyte|Int16|Int32|Int64|UInt16|UInt32|UInt64|Byte|SByte|nint|nuint|IntPtr|UIntPtr|BigInteger)$/;
  const NUM = /^(double|float|decimal|Double|Single|Decimal|Half)$/;
  const last = (ty) => (ty && ty.k === 'name' ? ty.segs[ty.segs.length - 1] : null);
  // How a parameter type is handled: 'skip' (bound by the SDK or a service) or 'schema'.
  Repo.prototype.paramKind = function (ty, attrs) {
    if (attrs.some((x) => x.name === 'FromKeyedServices' || x.name === 'FromServices')) return 'skip';
    if (!ty || ty.k !== 'name') return 'schema';
    const n = last(ty);
    if (SDK_BOUND.test(n) || FRAMEWORK_SERVICES.test(n) || this.services.has(n)) return 'skip';
    if (COLLECTIONS.test(n) || DICTS.test(n)) return 'schema';
    // an interface (I + capital) that is not a collection cannot be deserialised: a service
    if (/^I[A-Z]/.test(n) && !(this.typeDecl([n]) && this.typeDecl([n]).kind !== 'interface')) return 'skip';
    const d = this.typeDecl([n]); if (d && d.kind === 'interface') return 'skip';
    return 'schema';
  };
  // JSON schema of a type as AIJsonUtilities writes it; null when the reader does not know the type. nullable: the
  // parameter is a nullable reference (string?) or Nullable<T> (int?).
  Repo.prototype.typeSchema = function (ty, depth) {
    depth = depth || 0; if (!ty || depth > 12) return null;
    const withNull = (s, nul) => { if (!nul) return s; const o = Object.assign({}, s); if (typeof o.type === 'string') o.type = [o.type, 'null']; return o; };
    if (ty.k === 'array') { const it = this.typeSchema(ty.x, depth + 1); return it ? withNull({ type: 'array', items: it }, ty.nullable) : null; }
    if (ty.k !== 'name') return null;
    let n = last(ty); const A = ty.args || [];
    let nul = !!ty.nullable;
    if (n === 'Nullable' && A.length === 1) { const inner = this.typeSchema(A[0], depth + 1); return inner ? withNull(inner, true) : null; }
    if (ty.segs.length >= 2 && ty.segs[0] === 'System' && ty.segs.length === 2) n = ty.segs[1];
    if (n === 'string' || n === 'String') return withNull({ type: 'string' }, nul);
    if (n === 'char' || n === 'Char') return withNull({ type: 'string', minLength: 1, maxLength: 1 }, nul);
    if (n === 'bool' || n === 'Boolean') return withNull({ type: 'boolean' }, nul);
    if (INT.test(n)) return withNull({ type: 'integer' }, nul);
    if (NUM.test(n)) return withNull({ type: 'number' }, nul);
    if (n === 'Guid') return withNull({ type: 'string', format: 'uuid' }, nul);
    if (n === 'DateTime' || n === 'DateTimeOffset') return withNull({ type: 'string', format: 'date-time' }, nul);
    if (n === 'DateOnly') return withNull({ type: 'string', format: 'date' }, nul);
    if (n === 'Uri') return withNull({ type: 'string', format: 'uri' }, nul);
    if (n === 'object' || n === 'Object' || n === 'JsonElement' || n === 'JsonNode') return {};
    if (COLLECTIONS.test(n) && A.length === 1) { const it = this.typeSchema(A[0], depth + 1); return it ? withNull({ type: 'array', items: it }, nul) : null; }
    if (DICTS.test(n) && A.length === 2 && (last(A[0]) === 'string' || last(A[0]) === 'String')) { const v = this.typeSchema(A[1], depth + 1); return v ? withNull({ type: 'object', additionalProperties: v }, nul) : null; }
    const en = !A.length ? this.typeDecl(ty.segs, 'enum') : null;
    // a [JsonConverter] other than the plain string-enum converter may write anything: not read
    const plainConverter = (a) => { const f = en.f; const xs = a.args ? f.t.slice(a.args[0], a.args[1]).map((x) => x.v).join(' ') : ''; return /^typeof \( (?:[\w]+ \. )*JsonStringEnumConverter(?: < [\w. ]+ >)? \)$/.test(xs); };
    if (en && en.members && en.members.every((m) => m.wire !== null) && !en.attrs.some((a) => a.name === 'Flags' || (a.name === 'JsonConverter' && !plainConverter(a)))) {
      const names = en.members.map((m) => m.wire);
      return nul ? { type: ['string', 'null'], enum: names.concat([null]) } : { type: 'string', enum: names };
    }
    return null;
  };
  // Data annotations on a parameter, applied as AIJsonUtilities applies them.
  function annotate(s, attrs, repo, f, scope) {
    const arg = (a, k) => { const parts = a.args ? f.splitTop(a.args[0], a.args[1]) : []; const pos = parts.filter(([p]) => !(isId(f.t[p]) && isP(f.t[p + 1], '='))); const p = pos[k]; return p ? repo.ev(f, p[0], p[1], 0, scope) : undefined; };
    const named = (a, key) => { const parts = a.args ? f.splitTop(a.args[0], a.args[1]) : []; const p = parts.find(([q]) => isId(f.t[q], key) && isP(f.t[q + 1], '=')); return p ? repo.ev(f, p[0] + 2, p[1], 0, scope) : undefined; };
    let unk = false; const typeOf = () => (Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type);
    attrs.forEach((a) => {
      if (a.name === 'DisplayName') { const v = arg(a, 0); if (typeof v === 'string') { if (s.title === undefined) s.title = v; } else unk = true; }
      else if (a.name === 'EmailAddress') { if (s.format === undefined) s.format = 'email'; }
      else if (a.name === 'Url') { if (s.format === undefined) s.format = 'uri'; }
      else if (a.name === 'RegularExpression') { const v = arg(a, 0); if (typeof v === 'string') { if (s.pattern === undefined) s.pattern = v; } else unk = true; }
      else if (a.name === 'StringLength') { const mx = arg(a, 0); const mn = named(a, 'MinimumLength'); if (typeof mx !== 'number' || (mn !== undefined && typeof mn !== 'number')) unk = true; else { if (mn > 0 && s.minLength === undefined) s.minLength = mn; if (s.maxLength === undefined) s.maxLength = mx; } }
      else if (a.name === 'MinLength' || a.name === 'MaxLength') { const v = arg(a, 0); if (typeof v !== 'number') { unk = true; return; } const key = (typeOf() === 'string' ? (a.name === 'MinLength' ? 'minLength' : 'maxLength') : (a.name === 'MinLength' ? 'minItems' : 'maxItems')); if (s[key] === undefined) s[key] = v; }
      else if (a.name === 'Range') {
        const mn = arg(a, 0); const mx = arg(a, 1); const exMin = named(a, 'MinimumIsExclusive'); const exMax = named(a, 'MaximumIsExclusive');
        if (typeof mn !== 'number' || typeof mx !== 'number' || (exMin !== undefined && typeof exMin !== 'boolean') || (exMax !== undefined && typeof exMax !== 'boolean')) { unk = true; return; }
        if (!exMin || mn > 0) { const k = exMin ? 'exclusiveMinimum' : 'minimum'; if (s[k] === undefined) s[k] = mn; }
        const k2 = exMax ? 'exclusiveMaximum' : 'maximum'; if (s[k2] === undefined) s[k2] = mx;
      }
    });
    return !unk;
  }

  // ------------------------------------------------------------ XML doc comments (partial methods)
  function xmlDocOf(f, s) {
    // the /// lines right before token position s (only blank space between them)
    const lines = []; let at = s;
    for (let k = f.docs.length - 1; k >= 0; k--) {
      const d = f.docs[k]; if (d.e > at) continue;
      if (/\S/.test(f.text.slice(d.e, at).replace(/\[[^\]]*\]/g, ''))) break;
      lines.unshift(d.text); at = d.s;
    }
    if (!lines.length) return null;
    const xml = lines.join('\n');
    if (/<inheritdoc\b|<include\b/.test(xml)) return { unreadable: true };
    const el = (name) => { const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>').exec(xml); return m ? clean(m[1]) : ''; };
    const params = {}; const re = /<param\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/param>/g; let m;
    while ((m = re.exec(xml))) { const v = clean(m[2]); if (v) params[m[1]] = v; }
    const summary = el('summary'); const remarks = el('remarks');
    return { description: !remarks ? summary : !summary ? remarks : summary + '\n' + remarks, returns: el('returns'), params };
    function clean(x) {
      const text = x.replace(/<[^>]*\/>/g, '').replace(/<\/?[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
      return text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
    }
  }

  // ------------------------------------------------------------ tools
  const TOOL_ATTR = new Set(['McpServerTool']);
  Repo.prototype.run = function () {
    const found = []; const unresolved = []; const overBudget = [];
    const snake = !(this.sdk && this.sdk.length && this.sdk.every(preSnake));
    this.files.forEach((f) => {
      const t = f.t;
      for (let i = 0; i < t.length; i++) {
        // McpServerTool.Create(…): a tool built in code, not read
        if (isId(t[i], 'McpServerTool') && isP(t[i + 1], '.') && isId(t[i + 2], 'Create') && isP(t[i + 3], '(')) {
          const c = f.close[i + 3]; unresolved.push({ path: f.path, line: f.lineAt(t[i].s), lost: c > 0 ? literalsOf(f, i + 4, c) : [] }); continue;
        }
        if (!isP(t[i], '[')) continue;
        const prev = t[i - 1];
        if (prev && !(isP(prev, '{') || isP(prev, '}') || isP(prev, ';') || isP(prev, ']'))) continue;
        const sec = f.section(i); if (!sec) continue;
        // the whole run of sections, then the member after them
        const secs = [sec]; let k = sec.e + 1;
        while (isP(t[k], '[')) { const s2 = f.section(k); if (!s2) break; secs.push(s2); k = s2.e + 1; }
        const attrs = [].concat(...secs.map((x) => x.attrs));
        const toolAttr = attrs.find((a) => TOOL_ATTR.has(a.name) && a.target !== 'return');
        i = k - 1;
        if (!toolAttr) continue;
        if (found.length > MAX_TOOLS) { overBudget.push({ path: f.path, line: f.lineAt(t[k] ? t[k].s : 0), why: 'more than ' + MAX_TOOLS + ' tool definitions' }); return; }
        try { this.tool(f, k, attrs, toolAttr, snake, found, unresolved); } catch (e) { if (e instanceof OverBudget) throw e; unresolved.push({ path: f.path, line: f.lineAt(t[k] ? t[k].s : t[i].s), lost: literalsOf(f, sec.s, k) }); }
      }
    });
    return { found, unresolved, overBudget };
  };
  Repo.prototype.tool = function (f, k, attrs, toolAttr, snake, found, unresolved) {
    const t = f.t; const line = f.lineAt(t[k] ? t[k].s : 0); const k0 = k;
    const mods = new Set(); while (isId(t[k]) && MODIFIERS.has(t[k].v)) mods.add(t[k++].v);
    if (isId(t[k]) && TYPE_KW.has(t[k].v)) return; // on a type: not a tool method
    const rt = f.parseType(k); if (!rt) throw new Error('return type');
    let j = rt.end; if (!isId(t[j])) throw new Error('name');
    const method = t[j].v; j++;
    if (isP(t[j], '<')) { let d = 0; for (; j < t.length; j++) { if (isP(t[j], '<')) d++; else if (isP(t[j], '>')) { d--; if (!d) { j++; break; } } else if (isP(t[j], '(')) break; } }
    if (!isP(t[j], '(')) return; // a property or field
    const pc = f.close[j]; if (pc < 0) throw new Error('params');
    const scope = f.typeAt(k);
    const named = {}; const lostAttr = [];
    if (toolAttr.args) f.splitTop(toolAttr.args[0], toolAttr.args[1]).forEach(([p, q]) => {
      if (isId(t[p]) && isP(t[p + 1], '=')) named[t[p].v] = this.ev(f, p + 2, q, 0, scope);
    });
    Object.keys(named).forEach((key) => { if (isUnk(named[key])) lostAttr.push(...named[key].lost); });
    const retName = last(rt.ty);
    const isAsync = rt.ty && rt.ty.k === 'name' && /^(Task|ValueTask|IAsyncEnumerable)$/.test(retName);
    const st = { unreadable: new Set(), lost: lostAttr.slice() };
    let name;
    if (named.Name !== undefined) {
      if (typeof named.Name === 'string' && named.Name) name = named.Name;
      else if (named.Name === null) name = deriveName(method, isAsync, snake);
      else {
        const u = { path: f.path, line, lost: lostAttr.concat(literalsOf(f, toolAttr.args ? toolAttr.args[0] : k, pc)) };
        unresolved.push(u); return;
      }
    } else name = deriveName(method, isAsync, snake);
    const tool = { name };
    // description: [Description], or the XML doc comment of a partial method; "Returns: …" from [return: Description]
    const descAttr = attrs.find((a) => a.name === 'Description' && a.target !== 'return' && a.args);
    const retAttr = attrs.find((a) => a.name === 'Description' && a.target === 'return' && a.args);
    const doc = mods.has('partial') ? xmlDocOf(f, t[secStart(f, k0)].s) : null;
    let description; let returns;
    if (descAttr) description = this.ev(f, descAttr.args[0], descAttr.args[1], 0, scope);
    else if (doc && doc.unreadable) description = UNK([]);
    else if (doc && doc.description) description = doc.description;
    if (retAttr) returns = this.ev(f, retAttr.args[0], retAttr.args[1], 0, scope);
    else if (doc && !doc.unreadable && doc.returns) returns = doc.returns;
    else {
      // no description of the return value: the return type's own [Description] (Task<T> and ValueTask<T> unwrapped)
      let rty = rt.ty; if (rty && rty.k === 'name' && /^(Task|ValueTask)$/.test(retName) && rty.args && rty.args.length === 1) rty = rty.args[0];
      const rd = rty && rty.k === 'name' && !(rty.args && rty.args.length) ? this.typeDecl(rty.segs) : null;
      const ra = rd && rd.attrs.find((a) => a.name === 'Description' && a.args);
      if (ra) returns = this.ev(rd.f, ra.args[0], ra.args[1], 0, rd);
    }
    const structured = named.UseStructuredContent === true;
    if (named.UseStructuredContent !== undefined && typeof named.UseStructuredContent !== 'boolean') st.unreadable.add('description');
    if (isUnk(description)) { st.unreadable.add('description'); st.lost.push(...description.lost); description = description.lost.join(' … ').slice(0, MAX_STR) || undefined; }
    else if (description !== undefined && typeof description !== 'string') { st.unreadable.add('description'); description = undefined; }
    if (!structured && returns !== undefined) {
      if (isUnk(returns) || typeof returns !== 'string') { st.unreadable.add('description'); if (isUnk(returns)) st.lost.push(...returns.lost); }
      else if (returns.trim()) description = description && description.trim() ? description + '\nReturns: ' + returns : 'Returns: ' + returns;
    }
    if (description !== undefined) tool.description = String(description).slice(0, MAX_STR);
    else if (!st.unreadable.has('description')) tool.description = '';
    // title and annotations: only when one of Title or the hints is set
    const hints = [['ReadOnly', 'readOnlyHint'], ['Destructive', 'destructiveHint'], ['Idempotent', 'idempotentHint'], ['OpenWorld', 'openWorldHint']];
    const set = ['Title'].concat(hints.map((h) => h[0])).filter((key) => named[key] !== undefined && named[key] !== null);
    if (set.length) {
      const ann = {};
      if (named.Title !== undefined && named.Title !== null) { if (typeof named.Title === 'string') { tool.title = named.Title; ann.title = named.Title; } else st.unreadable.add('annotations'); }
      hints.forEach(([key, wire]) => { const v = named[key]; if (v === undefined || v === null) return; if (typeof v === 'boolean') ann[wire] = v; else st.unreadable.add('annotations'); });
      if (Object.keys(ann).length) tool.annotations = ann;
    }
    if (typeof named.IconSource === 'string' && named.IconSource) tool.icons = [{ src: named.IconSource }];
    // the input schema from the parameters
    const props = {}; const required = []; let schemaOk = true;
    f.splitTop(j + 1, pc).forEach(([p, q]) => {
      let a = p; const pattrs = [];
      while (isP(t[a], '[')) { const sec = f.section(a); if (!sec) { schemaOk = false; return; } sec.attrs.forEach((x) => pattrs.push(x)); a = sec.e + 1; }
      while (isId(t[a]) && /^(this|ref|out|in|params|scoped|readonly)$/.test(t[a].v)) a++;
      const r = f.parseType(a); if (!r || !isId(t[r.end])) { schemaOk = false; return; }
      const pname = t[r.end].v; let e = r.end + 1;
      const hasDefault = isP(t[e], '=');
      if (this.paramKind(r.ty, pattrs) === 'skip') return;
      let ty = r.ty;
      if (ty && ty.nullable && ty.k === 'name' && this.nullable === false && !this.isValueType(ty)) ty = Object.assign({}, ty, { nullable: false });
      let s = this.typeSchema(ty);
      if (!s) { schemaOk = false; return; }
      s = Object.assign({}, s);
      const nameAttr = pattrs.find((x) => x.name === 'AIParameterName' && x.args);
      let key = pname;
      if (nameAttr) { const v = this.ev(f, nameAttr.args[0], nameAttr.args[1], 0, scope); if (typeof v === 'string') key = v; else { schemaOk = false; return; } }
      // default: [DefaultValue(x)] first, then "= x"
      const dv = pattrs.find((x) => x.name === 'DefaultValue' && x.args);
      let has = false; let def;
      if (dv) { has = true; def = this.ev(f, dv.args[0], dv.args[1], 0, scope); }
      else if (hasDefault) { has = true; def = this.ev(f, e + 1, q, 0, scope); }
      else if (pattrs.some((x) => x.name === 'Optional')) { has = true; def = null; }
      if (has) {
        if (def && def.__default) def = this.defaultOf(ty);
        if (def && def.__enum) def = (def.__enum.members.find((m) => m.name === def.member) || {}).wire;
        if (isUnk(def) || def === undefined || (def !== null && typeof def === 'object')) { schemaOk = false; return; }
        if (typeof def === 'number' && s.type === 'string' && s.enum) { schemaOk = false; return; }
        s.default = def;
      }
      const pd = pattrs.find((x) => x.name === 'Description' && x.args);
      let pdesc;
      if (pd) { pdesc = this.ev(f, pd.args[0], pd.args[1], 0, scope); if (typeof pdesc !== 'string') { if (isUnk(pdesc)) st.lost.push(...pdesc.lost); schemaOk = false; return; } }
      else if (doc && !doc.unreadable && doc.params[pname]) pdesc = doc.params[pname];
      if (!annotate(s, pattrs, this, f, scope)) { schemaOk = false; return; }
      const ordered = pdesc !== undefined ? Object.assign({ description: pdesc }, s) : s;
      props[key] = ordered;
      if ((!has) || pattrs.some((x) => x.name === 'Required')) required.push(key);
    });
    if (schemaOk) { tool.inputSchema = { type: 'object', properties: props }; if (required.length) tool.inputSchema.required = required; }
    else { tool.inputSchema = { type: 'object' }; st.unreadable.add('inputSchema'); st.lost.push(...literalsOf(f, j + 1, pc)); }
    const un = Array.from(st.unreadable); if (un.length) tool._unreadable = un;
    const lost = st.lost.filter((x) => typeof x === 'string' && x.trim()); if (lost.length) tool._lost = Array.from(new Set(lost));
    // registered? [McpServerToolType] on the class, or the class named in WithTools<T>() / WithTools(typeof(T))
    const marks = [];
    const cls = scope;
    const typeOk = cls && (cls.attrs.some((a) => a.name === 'McpServerToolType') || this.registered.has(cls.name));
    if (!typeOk) marks.push({ reason: 'registration-not-seen', detail: cls ? cls.name + ' has no [McpServerToolType] and is not named in WithTools<T>()' : 'not inside a class', exclude: false });
    found.push({ path: f.path, line, tool, fidelity: 'derived', literal: false, marks, language: 'C#' });
  };
  function secStart(f, k) { let i = k; while (i > 0 && isP(f.t[i - 1], ']') && f.open[i - 1] >= 0) i = f.open[i - 1]; return i; }
  Repo.prototype.isValueType = function (ty) {
    const n = last(ty); if (!n) return false;
    if (INT.test(n) || NUM.test(n) || /^(bool|Boolean|char|Char|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|Nullable)$/.test(n)) return true;
    const d = this.typeDecl(ty.segs); return !!d && (d.kind === 'enum' || d.kind === 'struct');
  };
  Repo.prototype.defaultOf = function (ty) {
    if (ty && ty.nullable) return null;
    const n = last(ty);
    if (INT.test(n) || NUM.test(n)) return 0;
    if (n === 'bool' || n === 'Boolean') return false;
    if (ty && ty.k === 'name') { const en = this.typeDecl(ty.segs, 'enum'); if (en) return { __unk: true, lost: [] }; }
    if (this.isValueType(ty)) return { __unk: true, lost: [] };
    return null;
  };

  function analyse(files, opts) {
    let repo;
    try { repo = new Repo(files, opts || {}); const r = repo.run(); if (r.overBudget.length) { r.found = []; r.unresolved = []; } return r; } catch (e) {
      if (e instanceof OverBudget) return { found: [], unresolved: [], overBudget: [{ path: (files[0] || [''])[0], line: null, why: WHY_WORK }] };
      throw e;
    }
  }
  const TOOL_HINT = /\[\s*(?:[\w.]*\.)?McpServerTool(?:Attribute)?\s*[\](,]|\bMcpServerTool\.Create\s*\(/;
  const CONSTRUCTS = /\.AddMcpServer\s*\(|\bMcpServer\.Create\s*\(|\bMcpServerFactory\.Create\s*\(/;
  function constructsServer(text) { return typeof text === 'string' && CONSTRUCTS.test(text); }
  return { Repo, tokenize, bracketIndex, analyse, constructsServer, TOOL_HINT, snakeLower, deriveName, preSnake };
});
