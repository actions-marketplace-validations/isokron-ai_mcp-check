// repo-effects: what a tool's handler touches, read from source without running anything. Browser and Node.
//
//   RepoEffects.analyse(files, found, opts) -> { version, tools: { <tool name>: effects }, summary, limits }
//
//   files   Map or [[path, text]] of the source files the reader read
//   found   the reader's tool records: { path, line, offset?, tool: { name, annotations? } }
//   opts    { depth: 3 (calls followed), maxCalls, disable: ['fs', ...] (sink families, for the mutation checks) }
//
// Per tool: the handler (inline function, referenced function, class method, decorator-registered function, the branch
// of a name switch), the calls it makes followed through the same repository up to `depth` levels, and the sinks
// reached: file writes and deletes, SQL and ORM writes, HTTP with its method, process execution, client calls whose
// effect cannot be seen. Each effect has evidence (file and line) and a tier:
//   definite  a sink call in the handler's own resolved call chain
//   may       an opaque client call, a dynamic method, an unresolved import, a handler found only by name
// TypeScript, JavaScript and Python are read; other languages give status "unsupported_language". Never executes anything,
// never reads outside the files it is given, and every loop is bounded.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoEffects = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const KINDS = ['read', 'write', 'delete', 'unsafe_http', 'exec', 'unknown_call'];
  const MAX_EVIDENCE = 12; // per kind and tool
  const MAX_TEXT = 600000;

  // ------------------------------------------------------------ small helpers
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const langOf = (p) => (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p) ? 'js' : /\.py$/.test(p) ? 'py' : null);
  const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'super', 'import', 'require', 'do', 'try', 'throw', 'case', 'in', 'of', 'void', 'delete', 'yield', 'async', 'class', 'with', 'elif', 'except', 'lambda', 'not', 'and', 'or', 'is', 'print', 'assert', 'raise', 'def', 'from', 'as', 'pass', 'del', 'global', 'nonlocal', 'match', 'finally', 'constructor']);

  function matchClose(code, i) {
    const open = code[i]; const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let d = 0; const end = Math.min(code.length, i + MAX_TEXT);
    for (let k = i; k < end; k++) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return c === close ? k : -1; if (d < 0) return -1; }
    }
    return -1;
  }
  function splitArgs(code, open, close) {
    const out = []; let d = 0; let s = open + 1;
    for (let k = open + 1; k < close; k++) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ',' && d === 0) { out.push([s, k]); s = k + 1; }
    }
    if (code.slice(s, close).trim()) out.push([s, close]);
    return out;
  }
  function trimRange(code, a, b) { while (a < b && /\s/.test(code[a])) a++; while (b > a && /\s/.test(code[b - 1])) b--; return [a, b]; }
  function prevSig(code, i) { let k = i - 1; while (k >= 0 && /\s/.test(code[k])) k--; return k; }
  function nextSig(code, i) { let k = i; while (k < code.length && /\s/.test(code[k])) k++; return k; }

  // ------------------------------------------------------------ masking: comments and string bodies blanked, offsets kept
  // strs: every string literal { s, e, v } (v the text, templates with ${…} as "?"), in order.
  function maskJs(src) {
    const n = src.length; const a = src.split(''); const strs = [];
    const blank = (i, j) => { for (let k = i; k < j && k < n; k++) if (a[k] !== '\n' && a[k] !== '\r') a[k] = ' '; };
    let i = 0; let lastSig = ''; let lastWord = '';
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; blank(i, j); i = j; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1; let v = '';
        while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { v += src[j + 1] === 'n' ? '\n' : src[j + 1] || ''; j += 2; continue; } v += src[j++]; }
        strs.push({ s: i, e: j + 1, v }); blank(i + 1, j); i = j + 1; lastSig = c; lastWord = ''; continue;
      }
      if (c === '`') {
        let j = i + 1; let v = ''; let tail = 0; let seg = i + 1; const lit = [];
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\') { v += src[j + 1] || ''; j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { lit.push([seg, j + 2]); let d = 1; j += 2; while (j < n && d) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } seg = j - 1; v += '?'; continue; }
          v += src[j++];
        }
        tail = j; lit.push([seg, tail]);
        let tg = i - 1; while (tg >= 0 && /[\w$.]/.test(src[tg])) tg--;
        strs.push({ s: i, e: tail + 1, v, tpl: true, tag: src.slice(tg + 1, i) }); lit.forEach(([x, y]) => blank(x, y)); i = tail + 1; lastSig = '`'; lastWord = ''; continue;
      }
      if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || lastWord === 'return' || lastWord === 'typeof' || lastWord === 'case')) {
        let j = i + 1; let cls = false;
        while (j < n && (src[j] !== '/' || cls) && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
        if (src[j] === '/') { blank(i + 1, j); i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; lastSig = '/'; lastWord = ''; continue; }
      }
      if (!/\s/.test(c)) {
        lastSig = c;
        if (/[A-Za-z_$]/.test(c)) { const m = /^[\w$]+/.exec(src.slice(i, i + 40)); lastWord = m[0]; i += m[0].length; lastSig = 'a'; continue; }
        lastWord = '';
      }
      i++;
    }
    return { code: a.join(''), strs };
  }
  function maskPy(src) {
    const n = src.length; const a = src.split(''); const strs = [];
    const blank = (i, j) => { for (let k = i; k < j && k < n; k++) if (a[k] !== '\n' && a[k] !== '\r') a[k] = ' '; };
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === '#') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
      if (c === '"' || c === "'") {
        let pre = i - 1; while (pre >= 0 && /[A-Za-z]/.test(src[pre]) && i - pre <= 2) pre--;
        const prefix = src.slice(pre + 1, i).toLowerCase();
        const triple = src.substr(i, 3) === c.repeat(3);
        let j = i + (triple ? 3 : 1); let v = '';
        const close = triple ? c.repeat(3) : c;
        while (j < n) {
          if (src[j] === '\\' && !prefix.includes('r')) { v += src[j + 1] === 'n' ? '\n' : src[j + 1] || ''; j += 2; continue; }
          if (src.startsWith(close, j)) break;
          if (!triple && src[j] === '\n') break;
          v += src[j++];
        }
        const e = j + close.length;
        // a line that holds only this string is a docstring or a bare expression, never an argument
        let ls = i - 1; while (ls >= 0 && src[ls] !== '\n') ls--;
        const lone = /^\s*[A-Za-z]{0,2}$/.test(src.slice(ls + 1, i));
        strs.push({ s: i, e, v, f: prefix.includes('f'), doc: lone });
        blank(i + (triple ? 3 : 1), j); i = e; continue;
      }
      i++;
    }
    return { code: a.join(''), strs };
  }

  // ------------------------------------------------------------ per-file model
  function lineIndex(text) { const nls = []; for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) nls.push(k); return nls; }
  function lineAt(nls, at) { let lo = 0; let hi = nls.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nls[m] < at) lo = m + 1; else hi = m; } return lo + 1; }

  function prepare(path, text) {
    const lang = langOf(path);
    const m = lang === 'py' ? maskPy(text) : maskJs(text);
    const P = { path, lang, text, code: m.code, strs: m.strs, nls: lineIndex(text), funcs: [], classes: [], imports: new Map(), consts: new Map(), ormFile: false };
    P.line = (at) => lineAt(P.nls, at);
    if (lang === 'js') indexJs(P); else indexPy(P);
    return P;
  }
  function strsIn(P, a, b) { return P.strs.filter((x) => x.s >= a && x.s < b); }
  function strStartingAt(P, at) { const k = nextSig(P.code, at); return P.strs.find((x) => x.s === k) || null; }

  // ---- JS index: functions, classes, imports, constants
  function bodyAfterParams(code, close) {
    // after the parameter list: optional return type, then "{" (block) -- returns the index of "{" or -1
    let k = nextSig(code, close + 1);
    if (code[k] === '{') return k;
    if (code[k] === ':') {
      let d = 0; k++;
      for (let g = 0; g < 400 && k < code.length; g++, k++) {
        const c = code[k];
        if (c === '<' || c === '(' || c === '[') d++;
        else if (c === '>' || c === ')' || c === ']') { if (c === '>' && code[k - 1] === '=') continue; d--; }
        else if (c === '{') {
          const p = prevSig(code, k);
          if (d === 0 && !':|&<,'.includes(code[p] || '') && !(code[p] === '>' && code[p - 1] === '=')) return k;
          const cl = matchClose(code, k); if (cl < 0) return -1; k = cl;
        } else if (c === ';' || (c === '=' && code[k + 1] === '>' && d === 0)) return -1;
      }
    }
    return -1;
  }
  function exprEnd(code, a) {
    let d = 0; const end = Math.min(code.length, a + 20000);
    for (let k = a; k < end; k++) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { if (d === 0) return k; d--; }
      else if ((c === ',' || c === ';') && d === 0) return k;
    }
    return end;
  }
  function addFunc(P, name, openParen, closeParen, cls, startAt) {
    const code = P.code;
    const bs = bodyAfterParams(code, closeParen);
    if (bs >= 0) { const be = matchClose(code, bs); if (be > bs) P.funcs.push({ name, start: startAt, params: [openParen, closeParen], body: [bs + 1, be], cls: cls || null }); return; }
    // arrow: ) [: type] => body
    let k = nextSig(code, closeParen + 1);
    if (code[k] === ':') { while (k < code.length && !(code[k] === '=' && code[k + 1] === '>') && code[k] !== ';' && code[k] !== '\n') k++; }
    if (code[k] === '=' && code[k + 1] === '>') {
      const b0 = nextSig(code, k + 2);
      if (code[b0] === '{') { const be = matchClose(code, b0); if (be > b0) P.funcs.push({ name, start: startAt, params: [openParen, closeParen], body: [b0 + 1, be], cls: cls || null, arrow: true }); }
      else P.funcs.push({ name, start: startAt, params: [openParen, closeParen], body: [b0, exprEnd(code, b0)], cls: cls || null, arrow: true });
    }
  }
  function indexJs(P) {
    const code = P.code; let m;
    // classes
    const reClass = /\bclass\s+([A-Za-z_$][\w$]*)([^{;=]*)\{/g;
    while ((m = reClass.exec(code))) {
      const open = m.index + m[0].length - 1; const close = matchClose(code, open);
      if (close > open) { const ext = /\bextends\s+([\w$.]+)/.exec(m[2]); P.classes.push({ name: m[1], body: [open + 1, close], start: m.index, base: ext ? ext[1] : null }); }
    }
    const clsAt = (at) => { let best = null; P.classes.forEach((c) => { if (at > c.body[0] && at < c.body[1] && (!best || c.body[0] > best.body[0])) best = c; }); return best ? best.name : null; };
    P.clsAt = clsAt;
    // function declarations
    const reFn = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g;
    while ((m = reFn.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close > open) addFunc(P, m[1], open, close, clsAt(m.index), m.index); }
    // name = (async)? function (...) | (…) => | x =>
    const reVar = /(?:\b(?:const|let|var)\s+|[,{]\s*|\n\s*|^|\bthis\.)([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n;{}]{0,200})?\s*[:=]\s*(?:async\s+)?(?:function\b[^(]*\(|\(|([A-Za-z_$][\w$]*)\s*=>)/g;
    while ((m = reVar.exec(code))) {
      const name = m[1]; if (KEYWORDS.has(name)) continue;
      const tail = m[0].slice(-1);
      if (tail === '(') {
        const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close > open) addFunc(P, name, open, close, clsAt(m.index), m.index);
      } else if (m[2]) {
        const arrowAt = m.index + m[0].length; const b0 = nextSig(code, arrowAt);
        const pOpen = m.index + m[0].indexOf(m[2]);
        if (code[b0] === '{') { const be = matchClose(code, b0); if (be > b0) P.funcs.push({ name, start: m.index, params: [pOpen, pOpen + m[2].length], body: [b0 + 1, be], cls: clsAt(m.index), arrow: true }); }
        else P.funcs.push({ name, start: m.index, params: [pOpen, pOpen + m[2].length], body: [b0, exprEnd(code, b0)], cls: clsAt(m.index), arrow: true });
      }
    }
    // anonymous functions and arrows (arguments, callbacks): function (…) {…} and (…) => … / x => …
    const have = new Set(P.funcs.map((f) => f.body[0]));
    const reAnon = /\bfunction\s*\*?\s*\(/g;
    while ((m = reAnon.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close > open) { const bs = bodyAfterParams(code, close); if (bs >= 0 && !have.has(bs + 1)) { const be = matchClose(code, bs); if (be > bs) { P.funcs.push({ name: '<anonymous>', start: m.index, params: [open, close], body: [bs + 1, be], cls: clsAt(m.index), anon: true }); have.add(bs + 1); } } } }
    const reArrow = /=>/g;
    while ((m = reArrow.exec(code))) {
      const k = prevSig(code, m.index); if (k < 0) continue;
      let pOpen = -1; let pClose = k;
      const typed = /\)\s*:\s*[\w$<>\[\],.|&\s'"?]*$/.exec(code.slice(Math.max(0, m.index - 300), m.index));
      if (typed && code[k] !== ')') { pClose = Math.max(0, m.index - 300) + typed.index; }
      if (code[pClose] === ')') { pOpen = -1; let d = 0; for (let g = pClose, n = 0; g >= 0 && n < 4000; g--, n++) { if (code[g] === ')') d++; else if (code[g] === '(') { d--; if (d === 0) { pOpen = g; break; } } } if (pOpen < 0) continue; }
      else if (/[\w$]/.test(code[k])) { let g = k; while (g >= 0 && /[\w$]/.test(code[g])) g--; pOpen = g + 1; }
      else continue;
      const b0 = nextSig(code, m.index + 2);
      let body;
      if (code[b0] === '{') { const be = matchClose(code, b0); if (be < 0) continue; body = [b0 + 1, be]; } else body = [b0, exprEnd(code, b0)];
      if (have.has(body[0])) continue; have.add(body[0]);
      P.funcs.push({ name: '<anonymous>', start: pOpen, params: [pOpen, pClose], body, cls: clsAt(pOpen), anon: true, arrow: true });
    }
    // methods: name(...) { in classes and object literals
    const reM = /(?:^|[;{}\n,])\s*(?:(?:public|private|protected|static|async|override|readonly|get|set|abstract)\s+)*(?:\*\s*)?([A-Za-z_$#][\w$]*|\[[^\]\n]{1,80}\])\s*(?:<[^>()]*>)?\s*\(/g;
    while ((m = reM.exec(code))) {
      const name = m[1]; if (KEYWORDS.has(name)) continue;
      const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close <= open) continue;
      const bs = bodyAfterParams(code, close); if (bs < 0) continue;
      const be = matchClose(code, bs); if (be > bs) P.funcs.push({ name: name.replace(/^#/, ''), start: m.index, params: [open, close], body: [bs + 1, be], cls: clsAt(m.index), method: true });
    }
    // imports
    const imp = (local, spec, name) => { P.imports.set(local, { spec, name }); };
    const reImp = /\bimport\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
    const orig = P.text;
    while ((m = reImp.exec(orig))) {
      const clause = m[1]; const spec = m[2];
      const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause); if (def) imp(def[1], spec, 'default');
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause); if (ns) imp(ns[1], spec, '*');
      const nb = /\{([^}]*)\}/.exec(clause);
      if (nb) nb[1].split(',').forEach((x) => { const pr = x.trim().replace(/^type\s+/, '').split(/\s+as\s+/); if (pr[0]) imp((pr[1] || pr[0]).trim(), spec, pr[0].trim()); });
    }
    const reReq = /(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*(?:await\s+)?require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reReq.exec(orig))) {
      if (m[1]) imp(m[1], m[3], '*'); else m[2].split(',').forEach((x) => { const pr = x.trim().split(/\s*:\s*/); if (pr[0]) imp((pr[1] || pr[0]).trim(), m[3], pr[0].trim()); });
    }
    const reDyn = /(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reDyn.exec(orig))) { if (m[1]) imp(m[1], m[3], '*'); else m[2].split(',').forEach((x) => { const pr = x.trim().split(/\s*:\s*/); if (pr[0]) imp((pr[1] || pr[0]).trim(), m[3], pr[0].trim()); }); }
    // string constants: const NAME = "…"
    const reC = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g;
    while ((m = reC.exec(code))) { const s = P.strs.find((x) => x.s === nextSig(code, m.index + m[0].length)); if (s) P.consts.set(m[1], s); }
    // fs functions bound to a local name: const w = promisify(fs.write); const { rename: mv } = fs.promises; const rm = fsp.rm
    P.fsAliases = new Map();
    const isFsHead = (h) => { const hs = h.replace(/\.promises$/, ''); const im = P.imports.get(hs); return (im && FS_MODS.test(im.spec)) || ['fs', 'fsp', 'fse', 'fsPromises'].includes(hs); };
    const reAl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:(?:util\.)?promisify\(\s*)?([A-Za-z_$][\w$.]*?)\.([A-Za-z_$][\w$]*)\s*(?:\.bind\([^)]*\))?\s*\)?\s*[;\n]/g;
    while ((m = reAl.exec(code))) { if (isFsHead(m[2])) P.fsAliases.set(m[1], m[3]); }
    const reDs = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$.]*)\s*;/g;
    while ((m = reDs.exec(code))) { if (isFsHead(m[2])) m[1].split(',').forEach((x) => { const pr = x.trim().split(/\s*:\s*/); if (pr[0]) P.fsAliases.set((pr[1] || pr[0]).trim(), pr[0].trim()); }); }
    // members: enum A { B = 'x' } and const A = { B: 'x' } -> 'A.B'
    P.members = new Map();
    const reEnum = /\benum\s+([A-Za-z_$][\w$]*)\s*\{/g;
    while ((m = reEnum.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close < 0) continue; const body = code.slice(open + 1, close); const reMem = /([A-Za-z_$][\w$]*)\s*=\s*/g; let mm; while ((mm = reMem.exec(body))) { const st = P.strs.find((x) => x.s === nextSig(code, open + 1 + mm.index + mm[0].length)); if (st) P.members.set(m[1] + '.' + mm[1], st); } }
    const reObj = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;
    while ((m = reObj.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close < 0 || close - open > 20000) continue; const body = code.slice(open + 1, close); const reMem = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*/g; let mm; while ((mm = reMem.exec(body))) { const st = P.strs.find((x) => x.s === nextSig(code, open + 1 + mm.index + mm[0].length)); if (st) P.members.set(m[1] + '.' + mm[1], st); } }
    P.ormFile = /prisma|sequelize|typeorm|mongoose|drizzle|knex|mikro-orm|kysely|bookshelf|objection/i.test(orig);
  }

  // ---- Python index
  function indexPy(P) {
    const code = P.code; const lines = code.split('\n'); let off = 0;
    const lineStart = []; lines.forEach((l) => { lineStart.push(off); off += l.length + 1; });
    P.lines = lines; P.lineStart = lineStart;
    const indentOf = (l) => { const m = /^[ \t]*/.exec(l); return m[0].replace(/\t/g, '    ').length; };
    P.indentOf = indentOf;
    // joins a signature that spans lines: returns the index of the last line of the header (ends with ':')
    const headerEnd = (i) => { let d = 0; for (let k = i; k < lines.length && k < i + 60; k++) { for (const c of lines[k]) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; } if (d <= 0 && /:\s*$/.test(lines[k])) return k; if (d <= 0 && !/[,(\\]\s*$/.test(lines[k]) && k > i) break; } return i; };
    const blockEnd = (hdrLast, ind) => { let k = hdrLast + 1; let last = hdrLast; while (k < lines.length) { const l = lines[k]; if (l.trim() === '') { k++; continue; } if (indentOf(l) <= ind) break; last = k; k++; } return last; };
    P.blockEnd = blockEnd; P.headerEnd = headerEnd;
    const clsStack = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; const ind = indentOf(l);
      while (clsStack.length && l.trim() && ind <= clsStack[clsStack.length - 1].ind) clsStack.pop();
      let m = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(l);
      if (m) { const he = headerEnd(i); const be = blockEnd(he, ind); const c = { name: m[1], ind, line0: i, bases: (m[2] || '').split(',').map((x) => x.trim().split('.').pop()).filter(Boolean), body: [lineStart[he + 1] || P.code.length, (lineStart[be] || 0) + (lines[be] || '').length] }; P.classes.push(c); clsStack.push(c); continue; }
      m = /^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l);
      if (m) {
        const he = headerEnd(i); const be = blockEnd(he, ind);
        // decorators: the lines right above at the same indent (a decorator may span lines)
        const decs = []; let k = i - 1;
        while (k >= 0) {
          const t = lines[k]; if (t.trim() === '') { k--; continue; }
          if (indentOf(t) === ind && /^\s*@/.test(t)) { decs.unshift({ line0: k, text: t.trim() }); k--; continue; }
          if (indentOf(t) === ind && /^\s*[)\]]/.test(t)) { // the end of a decorator that spans lines: find its first line
            let g = k - 1; while (g >= 0 && !(indentOf(lines[g]) === ind && /^\s*@/.test(lines[g])) && k - g < 80) g--;
            if (g >= 0 && /^\s*@/.test(lines[g])) { decs.unshift({ line0: g, text: lines[g].trim() }); k = g - 1; continue; }
          }
          break;
        }
        // a decorator that spans lines: rebuild its text from the original lines up to the def
        const decText = decs.length ? P.text.split('\n').slice(decs[0].line0, i).join('\n') : '';
        const cls = clsStack.length ? clsStack[clsStack.length - 1] : null;
        const hdr = lineStart[i] + lines[i].indexOf('(');
        const hdrClose = matchClose(code, hdr);
        P.funcs.push({ name: m[2], start: lineStart[i], line0: i, ind, params: [hdr, hdrClose], body: [lineStart[he + 1] !== undefined ? lineStart[he + 1] : code.length, be >= he + 1 ? lineStart[be] + lines[be].length : lineStart[he] + lines[he].length], decorators: decs, decText, cls: cls ? cls.name : null, async: !!m[1], headLine0: he });
      }
    }
    // imports
    const imp = (local, mod, name) => { P.imports.set(local, { spec: mod, name }); };
    const joined = P.text.replace(/\\\n/g, ' ');
    let m;
    const reFrom = /^[ \t]*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm;
    while ((m = reFrom.exec(joined))) { const names = m[2].replace(/[()]/g, ' ').split(',').map((x) => x.trim()).filter(Boolean); names.forEach((x) => { const pr = x.split(/\s+as\s+/); if (pr[0] && pr[0] !== '*') imp((pr[1] || pr[0]).trim(), m[1], pr[0].trim()); }); }
    const reI = /^[ \t]*import\s+([^\n]+)/gm;
    while ((m = reI.exec(joined))) { m[1].split(',').forEach((x) => { const pr = x.trim().split(/\s+as\s+/); if (pr[0]) { const mod = pr[0].trim(); imp((pr[1] || mod.split('.')[0]).trim(), mod, '*'); } }); }
    // module constants: NAME = "…"
    const reC = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*/gm;
    while ((m = reC.exec(code))) { const s = P.strs.find((x) => x.s === nextSig(code, m.index + m[0].length)); if (s) P.consts.set(m[1], s); }
    P.members = new Map();
    P.classes.forEach((c) => { const reMem = /^[ \t]+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*/gm; const body = code.slice(c.body[0], c.body[1]); let mm; while ((mm = reMem.exec(body))) { const st = P.strs.find((x) => x.s === nextSig(code, c.body[0] + mm.index + mm[0].length)); if (st) P.members.set(c.name + '.' + mm[1], st); } });
    P.ormFile = /django|sqlalchemy|sqlmodel|peewee|tortoise|mongoengine|beanie|pymongo|psycopg|asyncpg|sqlite3|mysql|databases/i.test(P.text);
  }

  // ------------------------------------------------------------ the repository model
  function makeRepo(files) {
    const all = files instanceof Map ? Array.from(files.entries()) : files;
    const text = new Map(all.filter(([p, t]) => typeof t === 'string' && t.length <= MAX_TEXT && langOf(p)));
    const paths = Array.from(text.keys());
    const pathSet = new Set(paths);
    const prepared = new Map();
    const get = (p) => { if (!text.has(p)) return null; if (!prepared.has(p)) prepared.set(p, prepare(p, text.get(p))); return prepared.get(p); };
    const norm = (p) => { const out = []; p.split('/').forEach((s) => { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }); return out.join('/'); };
    const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.js', '/index.mjs', '/index.tsx'];
    function resolveJs(from, spec) {
      const tryBase = (base) => {
        const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
        for (const b of base === stripped ? [base] : [base, stripped]) for (const e of JS_EXT) if (pathSet.has(b + e)) return b + e;
        return null;
      };
      if (spec.startsWith('.')) return tryBase(norm(dirOf(from) + '/' + spec));
      const m = /^(?:@\/|~\/|#|src\/)(.+)$/.exec(spec);
      if (m) { const rest = m[1]; const hit = paths.filter((p) => JS_EXT.some((e) => p.endsWith('/' + rest + e) || p === 'src/' + rest + e || p === rest + e)); if (hit.length >= 1) return hit.sort((a, b) => a.length - b.length)[0]; }
      return null;
    }
    function resolvePy(from, spec) {
      let rel = 0; while (spec[rel] === '.') rel++;
      const rest = spec.slice(rel).replace(/\./g, '/');
      const cands = [];
      if (rel) { let base = dirOf(from); for (let k = 1; k < rel; k++) base = dirOf(base); const b = norm((base ? base + '/' : '') + rest); cands.push(b + '.py', b + '/__init__.py'); if (!rest) cands.push(norm(base) + '/__init__.py'); }
      else { cands.push(rest + '.py', rest + '/__init__.py'); }
      for (const c of cands) if (pathSet.has(c)) return c;
      if (!rel && rest) { const hit = paths.filter((p) => p.endsWith('/' + rest + '.py') || p.endsWith('/' + rest + '/__init__.py')); if (hit.length) return hit.sort((a, b) => dirOf(a) === dirOf(from) ? -1 : a.length - b.length)[0]; }
      return null;
    }
    return { paths, text, get, resolveJs, resolvePy, norm };
  }

  // ------------------------------------------------------------ handler resolution
  const REG_NAMES = /^(tool|registerTool|registerTools|addTool|add_tool|register|defineTool|createTool|setTool|registerCapability)$/;
  const HANDLER_KEYS = ['handler', 'execute', 'run', 'call', 'callback', 'cb', 'fn', 'func', 'impl', 'invoke', 'callTool', 'handle', 'process', 'exec', '_execute', '_run', 'perform', 'action', 'resolve', 'handleCall', 'runTool', 'executeTool', '__call__', '_call', 'call_tool', 'arun', '_arun', 'forward'];

  function enclosingOpen(code, pos, ch) {
    // the nearest unmatched `ch` before pos
    const close = { '(': ')', '{': '}', '[': ']' }[ch]; let d = 0;
    for (let k = pos - 1, g = 0; k >= 0 && g < 200000; k--, g++) {
      const c = code[k];
      if (c === close) d++;
      else if (c === ch) { if (d === 0) return k; d--; }
    }
    return -1;
  }
  function calleeChain(code, open) {
    let k = open - 1; while (k >= 0 && /\s/.test(code[k])) k--;
    if (code[k] === '>') { const g = code.lastIndexOf('<', k); if (g >= 0 && k - g < 120) { k = g - 1; while (k >= 0 && /\s/.test(code[k])) k--; } }
    let e = k + 1; while (k >= 0 && /[\w$.?\s]/.test(code[k])) { if (/\s/.test(code[k]) && !/[.?]/.test(code[prevSig(code, k)] || '') && !/[.?]/.test(code[nextSig(code, k)] || '')) break; k--; }
    return code.slice(k + 1, e).replace(/\s+/g, '').split(/\??\./).filter(Boolean);
  }

  // the function node of a JS expression range, or null: inline function, arrow, or identifier of a known function
  function funcFromExpr(R, P, a, b, ctx) {
    const code = P.code; [a, b] = trimRange(code, a, b); if (a >= b) return null;
    // inline: take the outermost function starting inside the range
    const inner = P.funcs.filter((f) => !f.method && f.params[0] >= a - 1 && f.body[1] <= b + 1 && f.body[0] >= a).sort((x, y) => x.params[0] - y.params[0] || (y.body[1] - y.body[0]) - (x.body[1] - x.body[0]))[0];
    if (inner) return { P, f: inner, how: 'inline' };
    const id = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?$/.exec(code.slice(a, b));
    if (id) { const r = resolveName(R, P, id[2] ? [id[1], id[2]] : [id[1]], ctx); if (r.length) return { P: r[0].P, f: r[0].f, how: 'ref' }; }
    // a wrapper call: withAuth(handler) / wrap(async () => …): look inside
    const call = /^[A-Za-z_$][\w$.]*\s*\(/.exec(code.slice(a, b));
    if (call) {
      const open = a + call[0].length - 1; const close = matchClose(code, open);
      if (close > 0) for (const [x, y] of splitArgs(code, open, close)) { const r = funcFromExpr(R, P, x, y, ctx); if (r) return r; }
    }
    return null;
  }

  function importTarget(R, P, local) {
    const im = P.imports.get(local); if (!im) return null;
    const file = P.lang === 'js' ? R.resolveJs(P.path, im.spec) : R.resolvePy(P.path, im.spec);
    return { im, file };
  }

  // calls and identifiers: chain -> [{ P, f }] repo functions it runs (never invents; empty when unresolved)
  function resolveName(R, P, chain, ctx) {
    const out = [];
    const head = chain[0];
    const inFile = (Q, name, cls) => Q.funcs.filter((f) => f.name === name && (cls === undefined ? !f.cls || !f.method : f.cls === cls));
    const methodsOf = (Q, cls, name, seen) => {
      seen = seen || new Set(); if (seen.has(Q.path + cls)) return []; seen.add(Q.path + cls);
      let r = Q.funcs.filter((f) => f.name === name && f.cls === cls);
      if (r.length) return r.map((f) => ({ P: Q, f }));
      const c = Q.classes.find((x) => x.name === cls);
      const bases = c ? (Q.lang === 'py' ? c.bases : (c.base ? [c.base.split('.').pop()] : [])) : [];
      for (const bname of bases) {
        const local = Q.classes.find((x) => x.name === bname);
        if (local) { r = methodsOf(Q, bname, name, seen); if (r.length) return r; continue; }
        const t = importTarget(R, Q, bname); if (t && t.file) { const Q2 = R.get(t.file); if (Q2) { r = methodsOf(Q2, t.im.name === 'default' || t.im.name === '*' ? bname : t.im.name, name, seen); if (r.length) return r; } }
      }
      return [];
    };
    const classOf = (Q, cname) => { // a class by local or imported name -> { Q, name }
      if (Q.classes.some((c) => c.name === cname)) return { Q, name: cname };
      const t = importTarget(R, Q, cname); if (t && t.file) { const Q2 = R.get(t.file); if (Q2) { const nm = t.im.name === 'default' || t.im.name === '*' ? cname : t.im.name; if (Q2.classes.some((c) => c.name === nm)) return { Q: Q2, name: nm }; const only = Q2.classes; if (t.im.name === 'default' && only.length === 1) return { Q: Q2, name: only[0].name }; } }
      return null;
    };
    const cur = ctx && ctx.f ? ctx.f : null;
    if (chain.length === 1) {
      const loc = inFile(P, head);
      if (loc.length) return loc.map((f) => ({ P, f }));
      // a class constructor call: Foo(...) / new Foo(...) runs __init__ / constructor, not followed
      const t = importTarget(R, P, head);
      if (t && t.file) {
        const Q = R.get(t.file); if (Q) {
          const nm = t.im.name === 'default' || t.im.name === '*' ? head : t.im.name;
          let r = inFile(Q, nm).map((f) => ({ P: Q, f }));
          if (!r.length && t.im.name === 'default') { const df = Q.funcs.filter((f) => !f.method && !f.cls); if (df.length === 1) r = [{ P: Q, f: df[0] }]; }
          return r;
        }
      }
      return out;
    }
    if (chain.length >= 2) {
      const second = chain[1];
      if ((head === 'this' || head === 'self' || head === 'cls') && cur && cur.cls) {
        if (chain.length === 2) return methodsOf(P, cur.cls, second);
        // this.prop.method(): the type of this.prop
        const ty = propType(P, cur.cls, second);
        if (ty) { const c = classOf(P, ty); if (c) return methodsOf(c.Q, c.name, chain[2]); }
        return out;
      }
      // namespace or module import: ns.fn()
      const t = importTarget(R, P, head);
      if (t && t.file) {
        const Q = R.get(t.file);
        if (Q) {
          if (chain.length === 2) {
            let r = inFile(Q, second).map((f) => ({ P: Q, f })); if (r.length) return r;
            if (t.im.name !== '*' && t.im.name !== 'default') { const nm = t.im.name; r = methodsOf(Q, nm, second); if (r.length) return r; }
            // from pkg import mod  ->  pkg/mod.py
            return [];
          }
          if (Q.classes.some((c) => c.name === second)) return methodsOf(Q, second, chain[2]);
          return [];
        }
        // python: from pkg import mod (a submodule)
        return out;
      }
      if (P.lang === 'py' && t && !t.file && P.imports.get(head)) {
        // from pkg import mod where pkg/mod.py is the module
        const im = P.imports.get(head); const sub = R.resolvePy(P.path, im.spec + '.' + im.name);
        if (sub) { const Q = R.get(sub); if (Q) return inFile(Q, second).map((f) => ({ P: Q, f })); }
      }
      if (P.lang === 'py') { const im = P.imports.get(head); if (im && im.name !== '*') { const sub = R.resolvePy(P.path, im.spec + '.' + im.name); if (sub) { const Q = R.get(sub); if (Q) return inFile(Q, second).map((f) => ({ P: Q, f })); } } }
      // Class.method (static) or instance variable of a class
      const c = classOf(P, head);
      if (c && chain.length === 2) { const r = methodsOf(c.Q, c.name, second); if (r.length) return r; }
      const inst = instanceType(P, head, cur);
      if (inst && chain.length === 2) { const c2 = classOf(P, inst); if (c2) return methodsOf(c2.Q, c2.name, second); }
    }
    return out;
  }
  function propType(P, cls, prop) {
    const c = P.classes.find((x) => x.name === cls); if (!c) return null;
    const body = P.text.slice(c.body[0], c.body[1]);
    let m = new RegExp('(?:this|self)\\.' + prop + '\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?([A-Z][\\w$]*)\\s*\\(').exec(body); if (m) return m[1];
    m = new RegExp('(?:private|public|protected|readonly)\\s+(?:readonly\\s+)?' + prop + '\\s*:\\s*([A-Z][\\w$]*)').exec(body); if (m) return m[1];
    m = new RegExp('\\b' + prop + '\\s*:\\s*([A-Z][\\w$]*)\\b').exec(body); if (m && P.lang === 'py') return m[1];
    return null;
  }
  function instanceType(P, v, cur) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?([A-Z][\\w$]*)\\s*\\(');
    let m = re.exec(P.code); if (m) return m[1];
    m = re.exec(P.text); return m ? m[1] : null;
  }

  // ---- finding a tool's handler regions in its file (and, for dispatch, in the package)
  function jsRegionsIn(R, P, nm, hintAt) {
    const code = P.code; const out = [];
    const lits = valueOccs(P, nm).sort((x, y) => Math.abs(x.s - (hintAt ?? 0)) - Math.abs(y.s - (hintAt ?? 0))).slice(0, 12);
    const regionOfFunc = (r, how, at) => { if (r) out.push({ P: r.P, f: r.f, a: r.f.body[0], b: r.f.body[1], how: r.how || how, at }); };
    const handlerKeyIn = (open, close) => {
      // top-level entries of an object literal / class body: key -> function
      const ents = [];
      const funcs = P.funcs.filter((f) => f.start >= open && f.body[1] <= close);
      for (const key of HANDLER_KEYS) {
        // key: value
        const re = new RegExp('(?:^|[\\s,{;])(?:async\\s+|static\\s+)*' + key + '\\s*(?:[:=]\\s*|\\()', 'g'); let m;
        while ((m = re.exec(code.slice(open, close)))) {
          const at = open + m.index + m[0].length; const kpos = open + m.index;
          if (depthBetween(code, open, kpos) !== 1) continue;
          if (m[0].endsWith('(')) { const f = funcs.find((g) => g.method && g.name === key && g.start >= open + m.index - 1 && g.start <= kpos + 4 + key.length + 12); if (f) ents.push({ P, f, how: 'method', at: kpos }); continue; }
          const a = at; const b = exprEnd(code, a);
          const r = funcFromExpr(R, P, a, b, {}); if (r) ents.push(Object.assign(r, { at: kpos }));
        }
      }
      return ents;
    };
    for (const lit of lits) {
      const p = prevSig(code, lit.s); const ch = code[p];
      if (ch === '(' || ch === ',') {
        // registration call: <callee>(…)
        const open = ch === '(' ? p : enclosingOpen(code, lit.s, '(');
        if (open >= 0) {
          const chain = calleeChain(code, open);
          const close = matchClose(code, open);
          if (close > open && chain.length && REG_NAMES.test(chain[chain.length - 1])) {
            const args = splitArgs(code, open, close);
            for (let i = args.length - 1; i >= 1; i--) {
              const [a, b] = trimRange(code, args[i][0], args[i][1]);
              if (code[a] === '{') { // config object: handler key inside
                const cl = matchClose(code, a); const ents = cl > a ? handlerKeyIn(a, cl) : []; if (ents.length) { ents.forEach((e) => regionOfFunc(e, 'inline', lit.s)); break; }
                continue;
              }
              const r = funcFromExpr(R, P, a, b, {}); if (r) { regionOfFunc(r, r.how, lit.s); break; }
            }
          }
        }
      } else if (ch === ':' || ch === '=') {
        const kp = prevSig(code, p); const key = /[\w$]+$/.exec(code.slice(Math.max(0, kp - 40), kp + 1));
        const k = key ? key[0] : '';
        if (k === 'name' || k === 'toolName' || k === 'tool_name') {
          const open = enclosingOpen(code, lit.s, '{');
          if (open >= 0) {
            const close = matchClose(code, open);
            if (close > open) { handlerKeyIn(open, close).forEach((e) => regionOfFunc(e, e.how, lit.s)); const cls = P.classes.find((c) => c.body[0] === open + 1); if (cls) classHandlers(R, P, cls).forEach((e) => regionOfFunc(e, 'class', lit.s)); }
            // the object may be the argument of a registration call: server.addTool({ name, …}, handler)
            const po = enclosingOpen(code, open, '(');
            if (po >= 0 && out.length === 0) {
              const chain = calleeChain(code, po); const pc = matchClose(code, po);
              if (pc > po && chain.length && REG_NAMES.test(chain[chain.length - 1])) { for (const [a, b] of splitArgs(code, po, pc).reverse()) { if (a <= open && b >= open) continue; const r = funcFromExpr(R, P, a, b, {}); if (r) { regionOfFunc(r, r.how, lit.s); break; } } }
            }
          }
        } else if (k === '' || /^[\w$'"]+$/.test(k)) {
          // a keyed table: { 'x': handler }
          const r = funcFromExpr(R, P, nextSig(code, lit.e) + 1, exprEnd(code, nextSig(code, lit.e) + 1), {});
          if (code[nextSig(code, lit.e)] === ':' && r) regionOfFunc(r, 'map', lit.s);
        }
      } else if (ch === 'e' && /case$/.test(code.slice(Math.max(0, p - 3), p + 1))) {
        const r = caseRegion(code, lit.e); if (r) out.push({ P, a: r[0], b: r[1], how: 'case', at: lit.s, f: P.funcs.find((f) => lit.s >= f.body[0] && lit.s < f.body[1]) || null });
      } else if (code[nextSig(code, lit.e)] === ':' && (ch === '{' || ch === ',')) {
        const a = nextSig(code, lit.e) + 1; const r = funcFromExpr(R, P, a, exprEnd(code, a), {}); if (r) regionOfFunc(r, 'map', lit.s);
      } else {
        // if (name === 'x') { … }  /  name == "x"
        const before = code.slice(Math.max(0, lit.s - 60), lit.s);
        if (/(===?|!==?)\s*$/.test(before) || /^\s*(===?|!==?)/.test(code.slice(lit.e, lit.e + 6))) {
          const neg = /!==?\s*$/.test(before) || /^\s*!==?/.test(code.slice(lit.e, lit.e + 6));
          const po = enclosingOpen(code, lit.s, '(');
          if (po >= 0 && /\bif\s*$/.test(code.slice(Math.max(0, po - 6), po)) && !neg) {
            const pc = matchClose(code, po); const b0 = nextSig(code, pc + 1);
            if (code[b0] === '{') { const be = matchClose(code, b0); if (be > b0) out.push({ P, a: b0 + 1, b: be, how: 'if', at: lit.s, f: P.funcs.find((f) => lit.s >= f.body[0] && lit.s < f.body[1]) || null }); }
            else out.push({ P, a: b0, b: exprEnd(code, b0), how: 'if', at: lit.s, f: P.funcs.find((f) => lit.s >= f.body[0] && lit.s < f.body[1]) || null });
          }
        }
      }
    }
    // an unquoted key or method of that name: { delete_item: async () => {} } / async delete_item(args) {}
    if (!out.length && /^[A-Za-z_$][\w$]*$/.test(nm) && !KEYWORDS.has(nm)) {
      const re = new RegExp('(?:^|[\\s,{;])(?:async\\s+)?' + nm.replace(/\$/g, '\\$') + '\\s*:\\s*', 'g'); let m;
      while ((m = re.exec(code))) { const a = m.index + m[0].length; const r = funcFromExpr(R, P, a, exprEnd(code, a), {}); if (r) { regionOfFunc(r, 'map', m.index); break; } }
      if (!out.length) { const f = P.funcs.find((g) => g.method && g.name === nm); if (f) out.push({ P, f, a: f.body[0], b: f.body[1], how: 'method', at: f.start }); }
    }
    return out;
  }
  // where the tool's name appears as a value: its string literals, uses of the constants that hold it (const name = "x";
  // enum members, members of a constant object)
  function valueOccs(P, nm) {
    const code = P.code; const out = P.strs.filter((x) => x.v === nm && !x.tpl);
    const ids = new Set();
    for (const lit of out.slice()) {
      const p = prevSig(code, lit.s);
      if (code[p] === '=' && code[p - 1] !== '=' && code[p - 1] !== '!' && code[p - 1] !== '<' && code[p - 1] !== '>') { const m = /([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?$/.exec(code.slice(Math.max(0, p - 80), p)); if (m && !/(^|[.])$/.test(code.slice(Math.max(0, p - 80), p - m[0].length))) ids.add(m[1]); }
    }
    ids.forEach((id) => { const re = new RegExp('(?<![\\w$.])' + id.replace(/\$/g, '\\$') + '(?![\\w$])', 'g'); let m; while ((m = re.exec(code))) { if (/^\s*(?::[^:]|=[^=>])/.test(code.slice(m.index + id.length, m.index + id.length + 6)) && /\b(const|let|var)\s*$/.test(code.slice(Math.max(0, m.index - 8), m.index))) continue; out.push({ s: m.index, e: m.index + id.length, v: nm, alias: true }); } });
    P.members.forEach((st, key) => { if (st.v !== nm) return; const [a, b] = key.split('.'); const re = new RegExp('(?<![\\w$.])' + a.replace(/\$/g, '\\$') + '\\s*\\.\\s*' + b.replace(/\$/g, '\\$') + '(?![\\w$])', 'g'); let m; while ((m = re.exec(code))) out.push({ s: m.index, e: m.index + m[0].length, v: nm, alias: true }); });
    return out;
  }
  function depthBetween(code, from, to) { let d = 0; for (let k = from; k < to; k++) { const c = code[k]; if (c === '{' || c === '(' || c === '[') d++; else if (c === '}' || c === ')' || c === ']') d--; } return d; }
  function classHandlers(R, P, cls) {
    const out = [];
    for (const key of HANDLER_KEYS) { const f = P.funcs.find((g) => g.cls === cls.name && g.name === key); if (f) out.push({ P, f, how: 'method', a: f.body[0], b: f.body[1] }); }
    return out;
  }
  // the statements after `case 'x':` up to the next case/default at the same depth or the end of the switch
  function caseRegion(code, from) {
    let k = nextSig(code, from); if (code[k] !== ':') return null;
    const start = k + 1; let d = 0; let end = code.length;
    // fallthrough: skip empty case labels that follow immediately
    for (let g = start, guard = 0; g < code.length && guard < 200000; g++, guard++) {
      const c = code[g];
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') { if (d === 0) { end = g; break; } d--; }
      else if (d === 0 && (code.startsWith('case', g) || code.startsWith('default', g)) && !/[\w$]/.test(code[g - 1] || ' ') && !/[\w$]/.test(code[g + (code[g] === 'c' ? 4 : 7)] || ' ')) {
        // a label directly after only whitespace/another label means fallthrough: keep going
        if (code.slice(start, g).trim() === '' || /^(\s*(case\b[^:\n]*|default)\s*:)*\s*$/.test(code.slice(start, g))) { const colon = code.indexOf(':', g); if (colon > 0) { g = colon; continue; } }
        end = g; break;
      }
    }
    return [start, end];
  }

  function pyRegionsIn(R, P, nm, hintLine) {
    const out = [];
    const toolDeco = /@\s*[\w.]*\.?(tool|add_tool|register_tool|function_tool|mcp_tool)\b/;
    const nameKw = (txt) => {
      let m = /\bname\s*=\s*(['"])([^'"]+)\1/.exec(txt); if (m) return m[2];
      m = /\bname\s*=\s*([A-Za-z_][\w.]*)/.exec(txt);
      if (m) { const e = m[1].replace(/\.value$/, ''); if (P.consts.has(e)) return P.consts.get(e).v; if (P.members.has(e)) return P.members.get(e).v; }
      return null;
    };
    const funcsHere = P.funcs;
    for (const f of funcsHere) {
      if (!f.decorators || !f.decorators.length || !toolDeco.test(f.decText)) continue;
      if (/call_tool|list_tools|prompt|resource/.test(f.decText) && !/\.tool\b/.test(f.decText)) continue;
      const custom = nameKw(f.decText);
      const logical = custom || f.name;
      if (logical === nm || nm.endsWith('_' + logical) || (hintLine && f.decorators[0].line0 + 1 <= hintLine && hintLine <= f.headLine0 + 1 && (!custom || custom === nm))) out.push({ P, f, a: f.body[0], b: f.body[1], how: 'decorator', at: f.start });
    }
    if (out.length) return out;
    // mcp.add_tool(fn, name="x") / Tool.from_function(fn, name=…)
    const reAdd = /\b(?:add_tool|from_function|FunctionTool|register_tool)\s*\(\s*(?:fn\s*=\s*)?([A-Za-z_]\w*)([^)]*)\)/g; let m;
    while ((m = reAdd.exec(P.code))) {
      const f = P.funcs.find((g) => g.name === m[1]); if (!f) continue;
      const kw = nameKw(P.text.slice(m.index, m.index + m[0].length));
      if ((kw || m[1]) === nm) out.push({ P, f, a: f.body[0], b: f.body[1], how: 'ref', at: m.index });
    }
    if (out.length) return out;
    // class tool: name = "x" at class level, handler method
    for (const c of P.classes) {
      const body = P.text.slice(c.body[0], c.body[1]);
      if (new RegExp('^\\s*name\\s*(?::[^=\\n]+)?=\\s*[\'"]' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'm').test(body)) {
        for (const key of HANDLER_KEYS) { const f = P.funcs.find((g) => g.cls === c.name && g.name === key); if (f) { out.push({ P, f, a: f.body[0], b: f.body[1], how: 'class', at: f.start }); break; } }
      }
      const f = P.funcs.find((g) => g.cls === c.name && g.name === nm && g.decorators && g.decorators.length && toolDeco.test(g.decText));
      if (f && !out.length) out.push({ P, f, a: f.body[0], b: f.body[1], how: 'decorator', at: f.start });
    }
    if (out.length) return out;
    // dispatch on the name: if name == "x": / elif / match-case; the operand may be a constant or an enum member
    const resolve = (expr) => { const e = expr.trim().replace(/\.value$/, ''); if (P.consts.has(e)) return P.consts.get(e).v; if (P.members.has(e)) return P.members.get(e).v; return null; };
    const lineIsDispatch = (li) => {
      const l = P.lines[li]; const km = /^\s*(?:el)?if\b|^\s*case\b/.exec(l); if (!km) return false;
      const lit = P.strs.filter((x) => x.s >= P.lineStart[li] && x.s < P.lineStart[li] + l.length);
      const before = l.slice(0, 400);
      if (lit.some((x) => x.v === nm)) { if (/!=/.test(before) && !/==/.test(before)) return false; return true; }
      const names = (before.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+(?:\.value)?|\b[A-Z_][A-Z0-9_]+\b/g) || []);
      return names.some((x) => resolve(x) === nm) && !(/!=/.test(before) && !/==/.test(before));
    };
    P.lines.forEach((l, li) => {
      if (!lineIsDispatch(li)) return;
      const ind = P.indentOf(l); const he = P.headerEnd(li); const be = P.blockEnd(he, ind);
      if (be > he) { const at = P.lineStart[li]; const fn = P.funcs.find((f) => at >= f.body[0] && at <= f.body[1]) || null; out.push({ P, a: P.lineStart[he + 1], b: P.lineStart[be] + P.lines[be].length, how: 'case', at, f: fn }); }
    });
    if (out.length) return out;
    // a keyed table: {"x": fn}
    const qs = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reMap = new RegExp('([\'"])' + qs + '\\1\\s*:\\s*([A-Za-z_][\\w.]*)', 'g');
    while ((m = reMap.exec(P.text))) { const r = resolveName(R, P, m[2].split('.'), {}); if (r.length) out.push({ P: r[0].P, f: r[0].f, a: r[0].f.body[0], b: r[0].f.body[1], how: 'map', at: m.index }); }
    return out;
  }

  // ------------------------------------------------------------ sink catalog
  const FS_MODS = /^(node:)?(fs|fs\/promises|fs-extra|graceful-fs)$/;
  const FS_WRITE = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'truncate', 'truncateSync', 'ftruncate', 'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'outputFile', 'outputFileSync', 'outputJson', 'outputJsonSync', 'writeJson', 'writeJsonSync', 'writeJSON', 'ensureDir', 'ensureFile', 'ensureDirSync', 'ensureFileSync', 'copy', 'copySync', 'move', 'moveSync', 'writev', 'writeSync']);
  const FS_OVERWRITE = new Set(['writeFile', 'writeFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'createWriteStream', 'outputFile', 'outputJson', 'writeJson', 'writeJSON', 'copy', 'move', 'truncate', 'truncateSync']);
  const FS_DELETE = new Set(['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync']);
  const FS_READ = new Set(['readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'readlink', 'createReadStream', 'exists', 'existsSync', 'opendir', 'realpath', 'readJson', 'readJSON', 'pathExists']);
  // Bookkeeping files: logs, audit trails, metrics, state, caches, locks, pid files, temporary files. A write to one of
// these is "may": it is the server's own housekeeping, not the data the tool is about. Words in snake_case, dotted and
// camelCase names.
const BOOK_WORD = /(?:^|[^A-Za-z])(?:log|logs|logging|audit|metric|metrics|state|cache|caches|lock|locks|pid|tmp|temp|scratch|history|journal|telemetry|trace|traces|pending|spool|queue|outbox|staging)(?:[^a-z]|$)/;
const BOOK_CAMEL = /[a-z0-9](?:Log|Audit|Metric|State|Cache|Lock|Pid|Tmp|Temp|Scratch|History|Journal|Telemetry|Trace|Pending|Spool|Queue|Outbox|Staging)(?:[^a-z]|$)/;
const BOOK_OTHER = /\.log\b|tmpdir|mkdtemp|pidfile|lockfile|\.cache\b/i;
// pending, spool, queue, outbox and staging: a server's own files waiting to be sent (QA-40, R-AE-32)
const bookkeeping = (t) => BOOK_WORD.test(t) || BOOK_CAMEL.test(t) || BOOK_OTHER.test(t);
const APPEND_ONLY = new Set(['appendFile', 'appendFileSync']);
// the identifiers a path expression is built from, not counting members (os.path) or strings
const idsOf = (code) => new Set((code.match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) || []));
  const CP_MODS = /^(node:)?child_process$|^(execa|shelljs|cross-spawn|node-pty)$/;
  const CP_FNS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'execa', 'execaSync', 'execaCommand', 'execaCommandSync']);
  const HTTP_JS_MODS = /^(axios|got|ky|superagent|needle|undici|node-fetch|cross-fetch|ofetch|request|request-promise|phin|wretch)$/;
  const HTTP_VERBS_W = new Set(['post', 'put', 'patch', 'delete', 'del']);
    // read-only commands: the program (and sub-command) of a literal command line
  const RO_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'echo', 'pwd', 'which', 'whoami', 'date', 'uname', 'df', 'du', 'ps', 'stat', 'file', 'tree', 'env', 'printenv', 'hostname', 'uptime', 'id', 'sort', 'uniq', 'diff', 'cmp', 'nproc', 'free', 'lsof', 'netstat', 'ping', 'dig', 'nslookup', 'host', 'curl_head', 'jq', 'basename', 'dirname', 'realpath', 'readlink', 'type', 'command', 'tput', 'sw_vers', 'lscpu', 'top', 'vmstat', 'find']);
  const RO_SUB = { git: new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'ls-files', 'ls-tree', 'blame', 'describe', 'remote', 'config', 'shortlog', 'rev-list', 'cat-file', 'grep', 'tag', 'version', 'ls-remote', 'stash_list']), docker: new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info', 'stats', 'top', 'port', 'diff', 'history', 'ls']), kubectl: new Set(['get', 'describe', 'logs', 'version', 'top', 'explain', 'api-resources', 'cluster-info', 'config']), npm: new Set(['ls', 'list', 'view', 'outdated', 'audit', 'search', 'config', 'root', 'prefix', 'whoami']), pip: new Set(['list', 'show', 'freeze', 'check', 'search']), node: new Set(['--version', '-v']), python: new Set(['--version', '-V']), python3: new Set(['--version', '-V']), brew: new Set(['list', 'info', 'search', 'outdated']), gh: new Set(['view', 'list', 'status', 'search', 'api']), terraform: new Set(['plan', 'show', 'validate', 'version', 'output', 'fmt']) };
  const SQL_RE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:(insert\s+(?:or\s+\w+\s+)?into|replace\s+into|upsert\s+into|merge\s+into)\b|(update\s+[\w."`\[\]$:{}?]+\s+set)\b|(delete\s+from\s+[\w."`\[\]$:{}?]+)|(drop\s+(?:table|database|schema|index|view|column|trigger)|truncate(?:\s+table)?\s+[\w."`\[\]$:{}?]+)|(alter\s+table\s+[\w."`\[\]$:{}?]+|create\s+(?:or\s+replace\s+)?(?:table|index|database|view|trigger)\b)|(select\b[\s\S]*\bfrom\b|select\s+[\w*]+\s*$|pragma\s+table_info|show\s+\w+|explain\b))/i;
  const SQL_WITH_WRITE = /\b(insert\s+into|update\s+[\w."`$]+\s+set|delete\s+from)\b/i;
  function sqlKind(v) {
    if (typeof v !== 'string' || v.length < 10) return null;
    let m = SQL_RE.exec(v);
    if (!m) { if (/^\s*with\b/i.test(v) && SQL_WITH_WRITE.test(v)) return { kind: 'write', verb: 'with-write' }; return null; }
    if (m[3] || m[4]) return { kind: 'delete', verb: (m[3] || m[4]).trim().split(/\s+/)[0].toLowerCase() };
    if (m[1] || m[2] || m[5]) return { kind: 'write', verb: (m[1] || m[2] || m[5]).trim().split(/\s+/)[0].toLowerCase() };
    return { kind: 'read', verb: 'select' };
  }
  const DB_NOT_CALLS = /^(print|console|logger|log|logging|warn|warning|error|info|debug|Error|Exception|ValueError|TypeError|RuntimeError|assert|repr|len|str|isinstance|dedent|strip)$/;
  const DB_EXEC = new Set(['execute', 'executemany', 'executescript', 'exec', 'run', 'query', 'raw', 'prepare', 'all', 'get', 'each', 'unsafe', 'queryRaw', 'executeRaw', '$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'sql', 'text', 'fetch', 'fetchrow', 'fetchval', 'fetchall', 'fetchone', 'execute_many', 'cursor', 'mappings', 'exec_driver_sql', 'queryOne', 'any', 'none', 'one', 'many', 'oneOrNone', 'manyOrNone']);
  const PRISMA_W = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
  const PRISMA_D = new Set(['delete', 'deleteMany']);
  const MONGO_W = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndReplace', 'bulkWrite', 'bulkCreate', 'findAndModify', 'save']);
  const MONGO_D = new Set(['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'findByIdAndRemove', 'destroy', 'drop', 'dropCollection', 'dropDatabase']);
  const REDIS_W = new Set(['set', 'setex', 'setnx', 'hset', 'hmset', 'lpush', 'rpush', 'sadd', 'zadd', 'expire', 'incr', 'decr', 'incrby', 'publish', 'xadd', 'append', 'mset', 'flushall', 'flushdb']);
  const REDIS_D = new Set(['del', 'unlink', 'hdel', 'srem', 'zrem', 'lpop', 'rpop', 'flushall', 'flushdb']);
  const SDK_VERBS = new Set(['create', 'update', 'delete', 'remove', 'send', 'merge', 'archive', 'cancel', 'revoke', 'publish', 'deploy', 'destroy', 'drop', 'truncate', 'insert', 'upload', 'trigger', 'invite', 'assign', 'transfer', 'reset', 'restart', 'terminate', 'kill', 'rollback', 'enable', 'disable', 'activate', 'deactivate', 'refund', 'charge', 'pay', 'approve', 'reject', 'submit', 'push', 'schedule', 'enqueue', 'upsert', 'patch', 'put', 'post', 'write', 'setup', 'start', 'stop', 'sync', 'import', 'unsubscribe', 'subscribe', 'comment', 'reply', 'react', 'star', 'fork', 'lock', 'unlock', 'grant', 'deny', 'ban', 'unban', 'mute', 'unmute', 'pin', 'unpin', 'rename', 'move', 'copy', 'clone', 'attach', 'detach', 'resize', 'scale', 'apply', 'install', 'uninstall', 'sign', 'issue', 'register', 'unregister', 'add_member', 'addMember', 'removeMember']);
  const SDK_DELETE_VERBS = new Set(['delete', 'remove', 'destroy', 'drop', 'truncate', 'terminate', 'kill', 'revoke', 'cancel', 'archive', 'purge', 'unsubscribe', 'deregister', 'unregister', 'uninstall', 'detach']);
  const CLIENTISH = /client|api|sdk|octokit|stripe|github|gitlab|\bgh\b|service|svc|\bdb\b|database|slack|notion|jira|linear|aws|s3|gcs|bucket|sns|sqs|dynamo|redis|mailer|mail|smtp|twilio|supabase|firebase|k8s|kube|docker|openai|anthropic|resend|sendgrid|shopify|hubspot|salesforce|airtable|trello|asana|discord|telegram|stripe|paypal|plaid|cloudflare|vercel|netlify|heroku|azure|gcp|google|drive|gmail|calendar|sheets|contentful|sanity|strapi|wordpress|posthog|grafana|prometheus|datadog|sentry|pagerduty|okta|auth0|clerk|neon|planetscale|turso|mongo|collection|kv|gateway/i;
  const NEVER_SDK = /^(server|mcpServer|mcp|app|router|Object|Array|Math|JSON|console|Promise|path|Set|Map|WeakMap|WeakSet|String|Number|Date|Buffer|URL|URLSearchParams|process|util|Intl|crypto|os|Symbol|Reflect|Proxy|Error|RegExp|results?|arr|list|items?|params|searchParams|headers|args|opts|options|data|body|text|res|result|response|req|request|output|lines|parts|keys|values|out|acc|map|set|cache|memo|seen|visited|queue|stack|logger|log|self|cls|time|datetime|re|json|logging|random|itertools|functools|collections|typing|asyncio|textwrap|string|base64|hashlib|uuid|copy|math|operator|inspect|traceback|warnings|contextlib|dataclasses|enum|abc)$/;

  // ------------------------------------------------------------ reachability
  // Reachability is not modelled, so a sink is "definite" only on the straight-line path of a function: not inside an
  // if/else/loop/switch/catch/finally body, a callback, a ternary or the right side of && || ??. Everything else is "may".
  function condRangesJs(P) {
    if (P._cond) return P._cond;
    const code = P.code; const out = []; let m;
    const body = (from) => { const b0 = nextSig(code, from); if (code[b0] === '{') { const e = matchClose(code, b0); if (e > b0) out.push([b0, e]); } else { const e = exprEnd(code, b0); out.push([b0, e]); } };
    const reCtl = /\b(if|while|for)\s*(?:await\s*)?\(/g;
    while ((m = reCtl.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close > open) body(close + 1); }
    const reElse = /\belse\b(?!\s*if\b)/g;
    while ((m = reElse.exec(code))) body(m.index + 4);
    const reTry = /\b(?:catch\s*(?:\([^)]*\))?|finally)\s*\{/g;
    while ((m = reTry.exec(code))) { const open = m.index + m[0].length - 1; const e = matchClose(code, open); if (e > open) out.push([open, e]); }
    const reSw = /\bswitch\s*\(/g;
    while ((m = reSw.exec(code))) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close > open) body(close + 1); }
    // a callback may never run; the executor of new Promise(...) runs at once
    P.funcs.filter((f) => f.anon && !/\bnew\s+Promise\s*\(\s*(?:async\s*)?$/.test(code.slice(Math.max(0, f.start - 40), f.start))).forEach((f) => out.push([f.body[0], f.body[1]]));
    P._cond = out; return out;
  }
  function isCond(P, pos, a, b) {
    if (P.lang === 'js') {
      if (condRangesJs(P).some((r) => r[0] >= a && r[0] <= pos && pos < r[1] && !(r[0] === a && r[1] === b))) return true;
      let k = pos - 1; const lim = Math.max(a, pos - 300);
      while (k > lim && !';{}'.includes(P.code[k])) k--;
      return /&&|\|\||\?\?|\?(?![.:])/.test(P.code.slice(k + 1, pos));
    }
    const li = P.line(pos) - 1; const li0 = Math.max(0, P.line(a) - 1);
    let cur = P.indentOf(P.lines[li]);
    for (let k = li - 1; k >= li0; k--) {
      const l = P.lines[k]; if (!l.trim()) continue;
      const ind = P.indentOf(l);
      if (ind < cur) { if (/^\s*(if|elif|else|for|while|except|finally|case|match|async\s+for)\b/.test(l)) return true; cur = ind; }
    }
    const lineStart = P.lineStart[li]; const pre = P.code.slice(lineStart, pos);
    return /\b(if|and|or|for|lambda)\b/.test(pre);
  }

  // Is there an early `return` before pos in this function, inside an `if` whose condition no argument of the tool
  // reaches? Then pos runs only in one mode (`if not use_ssh: yield; return`), not on every call. A guard on the tool's
  // own arguments (`if (!path) return error`) is validation: the path after it is still the tool's normal path.
  function earlyExit(P, pos, a, b, taint) {
    if (P.lang === 'js') {
      const code = P.code; const re = /\bif\s*\(/g; re.lastIndex = a; let m;
      const anon = P.funcs.filter((g) => g.anon && g.body && g.body[0] > a && g.body[1] < b);
      while ((m = re.exec(code)) && m.index < pos) {
        if (anon.some((g) => g.body[0] <= m.index && m.index < g.body[1])) continue;
        const open = m.index + m[0].length - 1; const close = matchClose(code, open); if (close < open || close >= pos) continue;
        const b0 = nextSig(code, close + 1); const end = code[b0] === '{' ? matchClose(code, b0) : exprEnd(code, b0);
        if (end < b0 || end >= pos) continue;
        if (!/\breturn\b/.test(code.slice(b0, end + 1))) continue;
        if (taintedIn(code.slice(open + 1, close), taint)) continue;
        return true;
      }
      return false;
    }
    // python: `if <cond>: return` or an `if <cond>:` block holding a return, ended before pos
    const li = P.line(pos) - 1; const li0 = Math.max(0, P.line(a) - 1);
    for (let k = li0; k < li; k++) {
      const l = P.lines[k]; const m = /^\s*if\s+(.*?):\s*(.*)$/.exec(l); if (!m) continue;
      const ind = P.indentOf(l); let body = m[2]; let j = k + 1;
      if (!body.trim()) { while (j < P.lines.length && (!P.lines[j].trim() || P.indentOf(P.lines[j]) > ind)) { body += '\n' + P.lines[j]; j++; } }
      if (j > li) continue; // pos is inside this if's body
      if (!/(^|\n)\s*return\b/.test(body)) continue;
      if (taintedIn(m[1], taint)) continue;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ scanning a region
  function callsIn(P, a, b) {
    const out = []; const code = P.code;
    const re = /(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$#][\w$]*)*)\s*(?:<[^<>()\n]{0,80}>)?\s*\(/g;
    re.lastIndex = a; let m;
    while ((m = re.exec(code)) && m.index < b) {
      const chain = m[1].replace(/\s+/g, '').split(/\??\./).filter(Boolean);
      const open = m.index + m[0].length - 1;
      const first = chain[0];
      if (chain.length === 1 && (KEYWORDS.has(first) && !(first === 'print' || first === 'delete'))) { re.lastIndex = open + 1; continue; }
      if (first === 'def' || first === 'class') { re.lastIndex = open + 1; continue; }
      const before = code.slice(Math.max(0, m.index - 8), m.index);
      const isNew = /\bnew\s+$/.test(before);
      const isDef = P.lang === 'js' ? /\bfunction\s*\*?\s*$/.test(before) : /\b(def|class)\s+$/.test(before);
      if (isDef) { re.lastIndex = open + 1; continue; }
      const close = matchClose(code, open);
      out.push({ chain, at: m.index, open, close: close > open ? close : Math.min(code.length, open + 2000), isNew });
      re.lastIndex = open + 1;
    }
    // chained calls after a call: x(…).delete(…)
    const reC = /\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g; reC.lastIndex = a;
    while ((m = reC.exec(code)) && m.index < b) { const open = m.index + m[0].length - 1; const close = matchClose(code, open); out.push({ chain: ['<expr>', m[1]], at: m.index + 1, open, close: close > open ? close : open + 1, chained: true }); }
    return out;
  }

  function argTexts(P, call) { return splitArgs(P.code, call.open, call.close).map(([a, b]) => trimRange(P.code, a, b)); }
  function origSlice(P, a, b) { return P.text.slice(a, b); }

  // the method of a fetch-like call: [method|null (dynamic), staticOrNot]
  function httpMethodOf(P, call, def) {
    const args = argTexts(P, call);
    for (let i = 1; i < args.length; i++) {
      const [a, b] = args[i]; const seg = P.code.slice(a, b);
      const m = /\bmethod\s*:\s*/.exec(seg);
      if (m) {
        const at = a + m.index + m[0].length; const s = P.strs.find((x) => x.s === nextSig(P.code, at));
        if (s) return { method: s.v.toUpperCase(), dynamic: false };
        return { method: null, dynamic: true };
      }
    }
    return { method: def, dynamic: false };
  }

  function evOf(P, at, sink, conf, via, note, kind) { return { file: P.path, line: P.line(at), sink, kind, confidence: conf, via: via.slice(), ...(note ? { note } : {}) }; }

  function classify(R, P, call, region, state) {
    const out = []; const chain = call.chain; const last = chain[chain.length - 1]; const head = chain[0];
    const dis = state.disable; const via = region.via;
    const emit = (kind, conf, sink, note, at) => { if (!dis.has(state.family)) out.push({ kind, conf, sink, note, at: at === undefined ? call.at : at, P, heur: state.family === 'sdk' || state.family === 'orm' && conf !== 'definite' }); };
    const fam = (f) => { state.family = f; };
    const imp = P.imports.get(head);
    const impMod = imp ? imp.spec : null;
    if (P.lang === 'js') {
      // ---- fs
      let fsName = null;
      if (imp && FS_MODS.test(impMod)) { if (chain.length === 1 && imp.name !== '*' && imp.name !== 'default') fsName = imp.name; else if (chain.length === 2) fsName = last; else if (chain.length === 3 && chain[1] === 'promises') fsName = last; }
      else if (chain.length === 1 && P.fsAliases && P.fsAliases.has(head) && !P.funcs.some((g) => g.name === head)) fsName = P.fsAliases.get(head);
      else if (!imp && ['fs', 'fsp', 'fse', 'fsPromises'].includes(head) && chain.length <= 3 && chain.length >= 2) fsName = last;
      if (fsName) {
        fam('fs');
        const pathArg = argTexts(P, call)[0]; const pathText = pathText0(P, region, pathArg);
        const why = softFs(P, region, fsName, pathArg, pathText, APPEND_ONLY.has(fsName));
        if (FS_DELETE.has(fsName)) emit('delete', why ? 'may' : 'definite', 'fs.' + fsName, why || '');
        else if (FS_WRITE.has(fsName)) emit('write', why ? 'may' : 'definite', 'fs.' + fsName, why || (FS_OVERWRITE.has(fsName) ? 'overwrite' : ''));
        else if (FS_READ.has(fsName)) emit('read', 'definite', 'fs.' + fsName, '');
        if (FS_DELETE.has(fsName) || FS_WRITE.has(fsName) || FS_READ.has(fsName)) return out;
      }
      if (chain.length === 2 && ['write', 'writeFile', 'truncate', 'appendFile', 'writev', 'sync'].includes(last) && last !== 'sync' && state.fileHandles(P).has(head)) { fam('fs'); emit('write', 'definite', 'fs.handle.' + last, 'overwrite'); return out; }
      if (/^Deno$/.test(head) && chain.length === 2) { fam('fs'); if (/^(remove|removeSync)$/.test(last)) { emit('delete', 'definite', 'fs.Deno.' + last); return out; } if (/^(writeTextFile|writeFile|mkdir|rename|copyFile|truncate|writeTextFileSync|writeFileSync)$/.test(last)) { emit('write', 'definite', 'fs.Deno.' + last); return out; } if (/^(readTextFile|readFile|readDir|stat)$/.test(last)) { emit('read', 'definite', 'fs.Deno.' + last); return out; } }
      if (head === 'Bun' && last === 'write' && chain.length === 2) { fam('fs'); emit('write', 'definite', 'fs.Bun.write'); return out; }
      // ---- exec
      if ((imp && CP_MODS.test(impMod) && ((chain.length === 1 && (imp.name === '*' || imp.name === 'default' ? CP_FNS.has(head) : CP_FNS.has(imp.name))) || (chain.length === 2 && (imp.name === '*' || imp.name === 'default') && CP_FNS.has(last)))) || (head === 'Bun' && last === 'spawn') || (head === 'Deno' && last === 'Command')) {
        fam('exec'); execEffect(P, call, region, 'exec.' + (chain.length === 1 ? (imp && imp.name !== '*' && imp.name !== 'default' ? imp.name : head) : last), emit);
        return out;
      }
      // ---- http
      if (head === 'fetch' && chain.length === 1) {
        fam('http'); const m = httpMethodOf(P, call, 'GET');
        const urlArg = argTexts(P, call)[0]; const urlText = urlArg ? origSlice(P, urlArg[0], urlArg[1]) : '';
        return out.concat(httpEffects(P, call, 'fetch', m, urlText, state, region));
      }
      if (imp && HTTP_JS_MODS.test(impMod) && chain.length === 2 && HTTP_VERBS_W.has(last)) { fam('http'); const urlArg = argTexts(P, call)[0]; return out.concat(httpEffects(P, call, impMod + '.' + last, { method: last === 'del' ? 'DELETE' : last.toUpperCase(), dynamic: false }, urlArg ? origSlice(P, urlArg[0], urlArg[1]) : '', state, region)); }
      if (imp && HTTP_JS_MODS.test(impMod) && chain.length === 2 && last === 'get') { fam('http'); emit('read', 'definite', 'http.GET', impMod); return out; }
      if (imp && HTTP_JS_MODS.test(impMod) && chain.length === 1 && ['axios', 'got', 'ky', 'request', 'ofetch', 'undici'].includes(head) || (chain.length === 1 && head === 'axios')) {
        fam('http'); const m = httpMethodOf(P, call, 'GET');
        return out.concat(httpEffects(P, call, head, m, '', state, region));
      }
      // axios.create() instances and http clients assigned in this file
      if (chain.length === 2 && HTTP_VERBS_W.has(last) && state.httpClients(P).has(head)) { fam('http'); const urlArg = argTexts(P, call)[0]; return out.concat(httpEffects(P, call, head + '.' + last, { method: last === 'del' ? 'DELETE' : last.toUpperCase(), dynamic: false }, urlArg ? origSlice(P, urlArg[0], urlArg[1]) : '', state, region)); }
      if (chain.length === 2 && last === 'request' && /^https?$/.test(head)) { fam('http'); const m = httpMethodOf(P, call, 'GET'); return out.concat(httpEffects(P, call, head + '.request', m, '', state, region)); }
    } else {
      // ---- python fs
      const impHead = imp ? imp.spec : null;
      if (head === 'open' && chain.length === 1) {
        fam('fs'); const args = argTexts(P, call); const modeArg = args[1] ? origSlice(P, args[1][0], args[1][1]) : (args.find(([a, b]) => /^mode\s*=/.test(P.code.slice(a, b))) ? origSlice(P, ...args.find(([a, b]) => /^mode\s*=/.test(P.code.slice(a, b)))).replace(/^mode\s*=\s*/, '') : '');
        const pathText = pathText0(P, region, args[0]);
        const lit = /^\s*[rbu]*(['"])([^'"]*)\1\s*$/.exec(modeArg);
        if (!modeArg) { emit('read', 'definite', 'fs.open'); return out; }
        if (lit) { if (/[wax+]/.test(lit[2])) { const why = softFs(P, region, 'open', args[0], pathText, /^[rb]*a[b]*$/.test(lit[2])); emit('write', why ? 'may' : 'definite', 'fs.open', why || 'mode ' + lit[2]); } else emit('read', 'definite', 'fs.open'); return out; }
        emit('write', 'may', 'fs.open', 'mode is not a literal'); return out;
      }
      if ((head === 'os' || (imp && /^os$/.test(impHead))) && chain.length === 2) {
        fam('fs'); if (/^(remove|unlink|rmdir|removedirs)$/.test(last)) { emit('delete', 'definite', 'fs.os.' + last); return out; }
        if (/^(rename|replace|mkdir|makedirs|truncate|symlink|link|chmod|chown|utime|renames)$/.test(last)) { const why = softFs(P, region, last, argTexts(P, call)[0], pathText0(P, region, argTexts(P, call)[0]), false); emit('write', why ? 'may' : 'definite', 'fs.os.' + last, why || ''); return out; }
        if (/^(system|popen|execv|execve|execvp|execl|execlp|spawnl|spawnv|spawnlp|spawnvp|startfile)$/.test(last)) { fam('exec'); execEffect(P, call, region, 'exec.os.' + last, emit); return out; }
        if (/^(listdir|scandir|stat|walk|getcwd|getenv|readlink|access)$/.test(last)) { emit('read', 'definite', 'fs.os.' + last); return out; }
      }
      if ((head === 'shutil' || (imp && /^shutil$/.test(impHead))) && chain.length === 2) {
        fam('fs'); if (/^rmtree$/.test(last)) { emit('delete', 'definite', 'fs.shutil.rmtree'); return out; }
        if (/^(move|copy|copy2|copyfile|copytree|copyfileobj|make_archive|unpack_archive|chown|copymode)$/.test(last)) { emit('write', 'definite', 'fs.shutil.' + last, /^(move|copyfile|copy|copy2)$/.test(last) ? 'overwrite' : ''); return out; }
      }
      if (imp && /^(os|shutil)$/.test(impHead) && chain.length === 1 && imp.name !== '*') {
        fam('fs'); if (/^(remove|unlink|rmdir|removedirs|rmtree)$/.test(imp.name)) { emit('delete', 'definite', 'fs.' + impHead + '.' + imp.name); return out; }
        if (/^(rename|replace|mkdir|makedirs|move|copy|copy2|copyfile|copytree)$/.test(imp.name)) { emit('write', 'definite', 'fs.' + impHead + '.' + imp.name); return out; }
      }
      if (chain.length >= 2) {
        if (/^(write_text|write_bytes|touch|symlink_to|hardlink_to)$/.test(last)) { fam('fs'); const why = bookkeeping(P.text.slice(Math.max(0, call.at - 160), call.open)) ? 'path looks like a log, state, cache, lock or temporary file' : null; emit('write', why ? 'may' : 'definite', 'fs.pathlib.' + last, why || ''); return out; }
        if (/^(mkdir)$/.test(last) && chain.length >= 2 && state.pathlibish(P, chain)) { fam('fs'); emit('write', 'may', 'fs.pathlib.mkdir', 'creates a directory'); return out; }
        if (/^(unlink|rmdir)$/.test(last) && state.pathlibish(P, chain)) { fam('fs'); emit('delete', 'definite', 'fs.pathlib.' + last); return out; }
        if (/^(read_text|read_bytes|iterdir|glob|rglob|exists|is_file|is_dir|stat)$/.test(last) && state.pathlibish(P, chain)) { fam('fs'); emit('read', 'definite', 'fs.pathlib.' + last); return out; }
      }
      // ---- python exec
      if ((head === 'subprocess' || (imp && /^subprocess$/.test(impHead))) && (chain.length === 2 || (imp && imp.name !== '*' && chain.length === 1))) {
        const fn = chain.length === 2 ? last : imp.name;
        if (/^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(fn)) { fam('exec'); execEffect(P, call, region, 'exec.subprocess.' + fn, emit); return out; }
      }
      if (head === 'asyncio' && /^create_subprocess_(exec|shell)$/.test(last)) { fam('exec'); execEffect(P, call, region, 'exec.asyncio.' + last, emit); return out; }
      if (chain.length === 1 && (head === 'exec' || head === 'eval') && !state.localDef(P, head)) { fam('exec'); emit('exec', 'may', 'exec.' + head, 'dynamic code'); return out; }
      // ---- python http
      const httpMod = (head === 'requests' || head === 'httpx' || head === 'aiohttp' || head === 'urllib3' || (imp && /^(requests|httpx|aiohttp)$/.test(impHead)));
      if (httpMod && chain.length === 2) {
        fam('http'); const urlArg = argTexts(P, call)[0]; const urlText = urlArg ? origSlice(P, urlArg[0], urlArg[1]) : '';
        if (HTTP_VERBS_W.has(last)) return out.concat(httpEffects(P, call, head + '.' + last, { method: last.toUpperCase(), dynamic: false }, urlText, state, region));
        if (last === 'get' || last === 'head') { emit('read', 'definite', 'http.GET', head); return out; }
        if (last === 'request') { const a0 = argTexts(P, call)[0]; const s = a0 && P.strs.find((x) => x.s === a0[0]); return out.concat(httpEffects(P, call, head + '.request', s ? { method: s.v.toUpperCase(), dynamic: false } : { method: null, dynamic: true }, '', state, region)); }
      }
      if (chain.length >= 2 && HTTP_VERBS_W.has(last) && (state.httpClients(P).has(chain.slice(0, -1).join('.')) || state.httpClients(P).has(chain[chain.length - 2]))) { fam('http'); const urlArg = argTexts(P, call)[0]; return out.concat(httpEffects(P, call, chain.join('.'), { method: last.toUpperCase(), dynamic: false }, urlArg ? origSlice(P, urlArg[0], urlArg[1]) : '', state, region)); }
      if (chain.length >= 2 && (last === 'get') && state.httpClients(P).has(chain.slice(0, -1).join('.'))) { fam('http'); emit('read', 'definite', 'http.GET', chain.join('.')); return out; }
      if (chain.length >= 2 && last === 'request' && state.httpClients(P).has(chain.slice(0, -1).join('.'))) { fam('http'); const a0 = argTexts(P, call)[0]; const s = a0 && P.strs.find((x) => x.s === a0[0]); return out.concat(httpEffects(P, call, chain.join('.'), s ? { method: s.v.toUpperCase(), dynamic: false } : { method: null, dynamic: true }, '', state, region)); }
    }
    // ---- a Redis client from a factory, an attribute or an annotation (before the name-based Redis rules below)
    fam('sdk');
    if (clientCall(R, P, call, region, emit, true)) return out;
    // ---- ORM and document stores (both languages)
    fam('orm');
    if (chain.length >= 2) {
      const mid = chain.slice(0, -1).join('.');
      if (P.lang === 'js') {
        if (chain.length >= 3 && PRISMA_W.has(last) && /prisma/i.test(mid)) { emit(PRISMA_D.has(last) ? 'delete' : 'write', 'definite', 'orm.prisma.' + last); return out; }
        if (/^\$(executeRaw|executeRawUnsafe)$/.test(last)) { emit('write', 'may', 'orm.prisma.' + last, 'raw SQL'); return out; }
        if (MONGO_D.has(last) && chain.length >= 2 && !/^(this|Object|Array)$/.test(head)) { emit('delete', P.ormFile || /collection|model|mongo|db/i.test(mid) ? 'definite' : 'may', 'orm.' + last); return out; }
        if (MONGO_W.has(last) && last !== 'save' && chain.length >= 2) { emit('write', P.ormFile || /collection|model|mongo|db/i.test(mid) ? 'definite' : 'may', 'orm.' + last); return out; }
        if ((last === 'save' || last === 'destroy') && P.ormFile && chain.length === 2) { emit(last === 'destroy' ? 'delete' : 'write', 'definite', 'orm.' + last); return out; }
        if (/^(db|database|drizzle|tx|trx)$/.test(head) && chain.length === 2 && /^(insert|update|delete)$/.test(last) && P.ormFile) { emit(last === 'delete' ? 'delete' : 'write', 'definite', 'orm.drizzle.' + last); return out; }
        if (/redis|ioredis|cache|kv/i.test(mid) && /redis/i.test(P.text) && (REDIS_W.has(last) || REDIS_D.has(last)) && !/^(map|set|weak)/i.test(head)) { emit(REDIS_D.has(last) ? 'delete' : 'write', /redis/i.test(mid) ? 'definite' : 'may', 'orm.redis.' + last); return out; }
      } else {
        if (/^(session|db_session|sess|db\.session|self\.session|self\.db|conn|connection)$/.test(mid) || /session/i.test(head)) {
          if (/^(add|add_all|merge|bulk_save_objects|bulk_insert_mappings|bulk_update_mappings|flush|refresh_write)$/.test(last)) { emit('write', 'definite', 'orm.sqlalchemy.' + last); return out; }
          if (/^(delete|expunge)$/.test(last)) { emit('delete', 'definite', 'orm.sqlalchemy.' + last); return out; }
          if (last === 'commit') { emit('write', 'may', 'orm.sqlalchemy.commit', 'commit without a visible write'); return out; }
        }
        if (/\.objects$|^objects$/.test(mid) || /(^|\.)objects$/.test(mid)) {
          if (/^(create|bulk_create|update_or_create|get_or_create|bulk_update|update)$/.test(last)) { emit('write', 'definite', 'orm.django.' + last); return out; }
          if (/^delete$/.test(last)) { emit('delete', 'definite', 'orm.django.delete'); return out; }
        }
        if (/^(insertOne|insert_one|insert_many|update_one|update_many|replace_one|find_one_and_update|find_one_and_replace|bulk_write)$/.test(last) && P.ormFile) { emit('write', 'definite', 'orm.pymongo.' + last); return out; }
        if (/^(delete_one|delete_many|find_one_and_delete|drop|drop_collection|drop_database)$/.test(last) && P.ormFile) { emit('delete', 'definite', 'orm.pymongo.' + last); return out; }
        if (REDIS_D.has(last) && /redis/i.test(mid + P.text.slice(0, 3000))) { emit('delete', /redis/i.test(mid) ? 'definite' : 'may', 'orm.redis.' + last); return out; }
        if (REDIS_W.has(last) && /redis/i.test(mid)) { emit('write', 'definite', 'orm.redis.' + last); return out; }
      }
    }
    if (call.chained && chain.length === 2) {
      if (/^(delete|del|destroy|truncate|deleteMany|remove)$/.test(last) && P.ormFile) { emit('delete', 'definite', 'orm.' + last); return out; }
      if (/^(update|insert|updateMany|save|bulk_update)$/.test(last) && P.ormFile) { emit('write', 'definite', 'orm.' + last); return out; }
    }
    if (P.lang === 'py' && chain.length === 1 && P.imports.get(head) && /sqlalchemy|sqlmodel/.test(P.imports.get(head).spec) && /^(insert|update|delete)$/.test(P.imports.get(head).name)) { emit(P.imports.get(head).name === 'delete' ? 'delete' : 'write', 'definite', 'orm.sqlalchemy.core.' + P.imports.get(head).name); return out; }
    if (P.lang === 'py' && chain.length >= 2 && P.ormFile && (last === 'delete' || last === 'save') && call.close - call.open <= 2 && !/^(self|cls)$/.test(head)) { emit(last === 'delete' ? 'delete' : 'write', 'definite', 'orm.' + last); return out; }
    // ---- client objects whose library the reader can see (a factory, an attribute, an annotation)
    fam('sdk');
    if (clientCall(R, P, call, region, emit)) return out;
    // ---- client verbs: lower confidence
    if (chain.length >= 2) {
      const mid = chain.slice(0, -1);
      const upper = /^[A-Z]/.test(last);
      const verbOk = !upper && SDK_VERBS.has(last) || SDK_VERBS.has(last.replace(/[A-Z].*$/, ''));
      const headOk = !NEVER_SDK.test(head) && !(head === 'this' && chain.length === 2);
      const isHttpVar = state.httpClients(P).has(mid.join('.')) || state.httpClients(P).has(mid[mid.length - 1]);
      const clientish = !upper && !isHttpVar && (CLIENTISH.test(mid.join('.')) || (P.lang === 'js' && imp && !imp.spec.startsWith('.') && !state.stdlib(imp.spec)));
      if (verbOk && headOk && clientish) {
        const verb = SDK_VERBS.has(last) ? last : last.replace(/[A-Z].*$/, '');
        emit(SDK_DELETE_VERBS.has(verb) ? 'delete' : 'write', 'may', 'sdk.' + chain.join('.'), 'a client method named like a ' + (SDK_DELETE_VERBS.has(verb) ? 'delete' : 'write'));
        return out;
      }
      if (headOk && clientish && !/^(get|list|find|fetch|read|search|query|select|describe|retrieve|count|exists|has|head|lookup|stat|status|info|show|view|check|validate|load|ping|first|last|all|one|many|keys|values|entries|items|map|filter|forEach|some|every|reduce|then|catch|finally|toString|toJSON|join|slice|split|trim|replace|includes|startsWith|endsWith|indexOf|toLowerCase|toUpperCase|parse|stringify|log|info|warn|error|debug)$/.test(last)) {
        emit('unknown_call', 'may', 'client.' + chain.join('.'), 'a client method whose effect is not visible');
        return out;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ client objects from factories and attributes
  // The library a receiver comes from, when the reader can see it: a constructor or factory imported from a client
  // library, a repository function whose return annotation or return value is one, an attribute (self.x, this.x) the
  // class assigns one, a parameter annotated with one, or an object obtained from such a client (client.volumes.get(x)).
  const CLIENT_LIBS = [[/^(redis|redis\.asyncio|redis\.client|redis\.cluster|ioredis|@redis\/client|@upstash\/redis)$/, 'redis'], [/^(docker|dockerode)$/, 'docker'], [/^(boto3|aioboto3|botocore(\..*)?|@aws-sdk\/.*)$/, 'aws'], [/^atlassian(\..*)?$/, 'atlassian']];
  // a module of the repository itself (`from src.common.connection import X`), not a library
  function repoSpec(R, P, spec) { try { return !!(P.lang === 'js' ? R.resolveJs(P.path, spec) : R.resolvePy(P.path, spec)); } catch (e) { return false; } }
  function libOfSpec(spec, name) {
    if (!spec || spec.startsWith('.') || stdlibJs(spec)) return null;
    for (const [re, k] of CLIENT_LIBS) if (re.test(spec)) return k;
    if (CLIENTISH.test(spec) || /(Client|Session|Connection|Api|API|Service|Manager)$/.test(name || '')) return 'sdk:' + spec;
    return null;
  }
  // the library of the first imported identifier in a type or expression text
  function libOfIds(R, P, text) {
    for (const id of (text.match(/[A-Za-z_$][\w$]*/g) || [])) { const im = P.imports.get(id); if (im && !repoSpec(R, P, im.spec)) { const l = libOfSpec(im.spec, im.name === '*' || im.name === 'default' ? id : im.name); if (l) return l; } }
    return null;
  }
  function clientOfExpr(R, P, f, text, depth, seen) {
    const t = text.trim().replace(/^await\s+/, '').replace(/^new\s+/, '');
    if (depth > 3 || !t) return null;
    const m = /^([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/.exec(t); if (!m) return null;
    const head = m[1]; const chain = (head + m[2]).replace(/\s+/g, '').split('.');
    if (/^(self|this|cls)$/.test(head) && chain.length >= 2) return clientOfAttr(R, P, chain[1], depth + 1, seen);
    const im = P.imports.get(head);
    if (im && !im.spec.startsWith('.') && !repoSpec(R, P, im.spec)) return libOfSpec(im.spec, chain[chain.length - 1]) || libOfSpec(im.spec, im.name === '*' || im.name === 'default' ? head : im.name);
    const called = t.charAt(m[0].length) === '(' || /^\s*\(/.test(t.slice(m[0].length));
    if (!called || chain.length > 1) { const v = clientOfVar(R, P, f, head, depth + 1, seen); if (v) return v; }
    if (!called) return null;
    // a factory in the repository: its return annotation, or what it returns
    let targets = []; try { targets = resolveName(R, P, chain, { f }); } catch (e) { targets = []; }
    for (const tg of targets.slice(0, 3)) {
      const key = tg.P.path + ':' + tg.f.start; if (seen.has(key)) continue; seen.add(key);
      const Q = tg.P; const after = tg.f.params ? Q.text.slice(tg.f.params[1] + 1, tg.f.body ? Math.min(tg.f.body[0] + 1, tg.f.params[1] + 200) : tg.f.params[1] + 200) : '';
      const ann = Q.lang === 'py' ? /^\s*->\s*([^:]+):/.exec(after) : /^\s*:\s*([^={]+?)\s*(?:=>|\{)/.exec(after);
      if (ann) { const l = libOfIds(R, Q, ann[1]); if (l) return l; }
      if (!tg.f.body) continue;
      const body = Q.code.slice(tg.f.body[0], tg.f.body[1]); const re = /\breturn\s+([^\n;]+)/g; let r;
      while ((r = re.exec(body))) { const l = clientOfExpr(R, Q, tg.f, r[1], depth + 1, seen); if (l) return l; }
    }
    return null;
  }
  function clientOfVar(R, P, f, name, depth, seen) {
    if (depth > 3 || !f) return null;
    if (f.params) { const ptxt = P.text.slice(f.params[0], f.params[1] + 1); const a = new RegExp('(?<![\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\??\\s*:\\s*([^,=)]+)').exec(ptxt); if (a) { const l = libOfIds(R, P, a[1]); if (l) return l; } }
    if (!f.body) return null;
    const body = P.code.slice(f.body[0], f.body[1]);
    const re = new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*(?::\\s*([^=\\n]+))?=(?![=>])\\s*([^;\\n]+)', 'g'); let m;
    while ((m = re.exec(body))) {
      if (m[1]) { const l = libOfIds(R, P, m[1]); if (l) return l; }
      const l = clientOfExpr(R, P, f, m[2], depth + 1, seen); if (l) return l;
    }
    return null;
  }
  function clientOfAttr(R, P, attr, depth, seen) {
    if (depth > 3) return null;
    const key = P.path + '#' + attr; if (seen.has(key)) return null; seen.add(key);
    const esc = attr.replace(/\$/g, '\\$');
    // a declared type: `attr: Optional[Redis]`, `private attr: S3Client`
    const decl = new RegExp('^\\s*(?:(?:private|public|protected|readonly|static)\\s+)*' + esc + '\\s*\\??\\s*:\\s*([^=;\\n]+)', 'gm'); let m;
    while ((m = decl.exec(P.text))) { const l = libOfIds(R, P, m[1]); if (l) return l; }
    const re = new RegExp('\\b(?:self|this|cls)\\s*\\.\\s*' + esc + '\\s*(?::\\s*([^=\\n]+))?=(?![=>])\\s*([^;\\n]+)', 'g');
    while ((m = re.exec(P.code))) {
      if (m[1]) { const l = libOfIds(R, P, m[1]); if (l) return l; }
      const at = m.index; const f = P.funcs.filter((g) => g.body && g.body[0] <= at && at < g.body[1]).sort((x, y) => (x.body[1] - x.body[0]) - (y.body[1] - y.body[0]))[0] || null;
      const l = clientOfExpr(R, P, f, m[2], depth + 1, seen); if (l) return l;
    }
    return null;
  }
  const REDIS_W2 = new Set([...REDIS_W, 'lset', 'linsert', 'rpoplpush', 'lmove', 'hincrby', 'hincrbyfloat', 'zincrby', 'setrange', 'getset', 'rename', 'renamenx', 'persist', 'pexpire', 'expireat', 'xgroup_create', 'xack', 'smove', 'hsetnx', 'psetex', 'restore', 'copy']);
  const REDIS_D2 = new Set([...REDIS_D, 'delete', 'xdel', 'lrem', 'getdel', 'xtrim', 'ltrim', 'xgroup_destroy', 'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex', 'spop', 'zpopmin', 'zpopmax']);
  const CLIENT_EXTRA_VERBS = new Set(['run', 'build', 'pull', 'put', 'add', 'edit', 'set', 'execute', 'exec', 'append', 'overwrite', 'prune']);
  // A call on a client object of a known library: Redis writes and deletes by command name ("definite" only when an
  // argument of the tool reaches the call), any other client's write- or delete-named method as "may".
  function clientCall(R, P, call, region, emit, onlyRedis) {
    const chain = call.chain; if (chain.length < 2 || chain[0] === '<expr>') return false;
    const last = chain[chain.length - 1]; const head = chain[0];
    const seen = new Set(); let lib = null;
    if (/^(self|this|cls)$/.test(head)) { if (chain.length < 3) return false; lib = clientOfAttr(R, P, chain[1], 0, seen); }
    else if (!P.imports.get(head)) lib = clientOfVar(R, P, region.f, head, 0, seen);
    if (!lib || (onlyRedis && lib !== 'redis')) return false;
    if (lib === 'redis') {
      const del = REDIS_D2.has(last); if (!del && !REDIS_W2.has(last)) return false;
      const from = taintedIn(P.code.slice(call.open, call.close), region.taint || new Set());
      emit(del ? 'delete' : 'write', from ? 'definite' : 'may', 'client.redis.' + last, from ? 'a Redis command on a client from ' + (head === 'self' || head === 'this' ? 'an attribute' : 'a factory or constructor') : 'a Redis command whose key does not come from the tool\'s arguments');
      return true;
    }
    const verb = last.replace(/[A-Z_].*$/, '').toLowerCase();
    const del = SDK_DELETE_VERBS.has(verb);
    if (!del && !SDK_VERBS.has(verb) && !CLIENT_EXTRA_VERBS.has(verb)) return false;
    emit(del ? 'delete' : 'write', 'may', 'client.' + lib.replace(/^sdk:/, '') + '.' + chain.slice(1).join('.'), 'a client method (' + lib.replace(/^sdk:/, '') + ') named like a ' + (del ? 'delete' : 'write'));
    return true;
  }

  // Why a file write or delete is only a "may": a bookkeeping file, a directory made on the way, an append to a file the
  // tool's arguments do not name. null when none applies.
  function softFs(P, region, fsName, pathArg, pathText, appendOnly) {
    if (bookkeeping(pathText)) return 'path looks like a log, state, cache, lock or temporary file';
    if (/^(mkdir|mkdirSync|makedirs|ensureDir|ensureDirSync|ensureFile|ensureFileSync)$/.test(fsName) || fsName === 'mkdir') return 'creates a directory';
    if (appendOnly) {
      const ids = pathArg ? idsOf(P.code.slice(pathArg[0], pathArg[1])) : new Set();
      const fromArgs = Array.from(ids).some((x) => region.params && region.params.has(x));
      if (!fromArgs) return 'appends to a file the tool\'s arguments do not name';
    }
    return null;
  }

  // the text of a path argument, plus the right-hand side of its variable's assignment in the same function
  function pathText0(P, region, arg) {
    if (!arg) return '';
    let t = origSlice(P, arg[0], arg[1]);
    const ids = t.match(/[A-Za-z_$][\w$]*/g) || [];
    const seg = P.text.slice(region.a, region.b);
    ids.slice(0, 4).forEach((id) => { const m = new RegExp('(?<![\\w$.])' + id.replace(/\$/g, '\\$') + '\\s*(?::[^=\\n]+)?=(?!=)\\s*([^;\\n]{0,200})').exec(seg); if (m) t += ' ' + m[1]; });
    return t;
  }

  function httpEffects(P, call, sink, m, urlText, state, region) {
    const out = []; const mk = (kind, conf, s, note) => out.push({ kind, conf, sink: s, note, at: call.at, P });
    if (state.disable.has('http')) return out;
    if (m.dynamic || m.method === null) { mk('unsafe_http', 'may', 'http.' + sink, 'method is not a literal'); return out; }
    const meth = m.method;
    if (meth === 'GET' || meth === 'HEAD' || meth === 'OPTIONS') { mk('read', 'definite', 'http.' + meth, sink); return out; }
    // Only DELETE, a GraphQL mutation written in the call, or a URL that names a write is certain. POST, PUT and PATCH are
    // also how GraphQL, JSON-RPC, search and login calls are sent, so on their own they are "may".
    const callText = P.text.slice(call.open, call.close);
    const mutation = /\bmutation\b\s*[\w({]/.test(callText);
    const writeUrl = /\/(create|delete|remove|destroy|send|publish|upload|refund|cancel|revoke|purge)(\/|\?|["'`]|$)/i.test(urlText.replace(/\$\{[^}]*\}/g, ''));
    const certain = meth === 'DELETE' || mutation || writeUrl;
    const note = certain ? (mutation ? 'a GraphQL mutation' : writeUrl ? 'a URL that names a write' : '') : meth + ' may be a read (GraphQL, RPC, search)';
    mk('unsafe_http', certain ? 'definite' : 'may', 'http.' + meth, note);
    if (meth === 'DELETE') mk('delete', 'definite', 'http.DELETE', sink);
    return out;
  }

  // The literal value of an argument expression: a string ({ s }), or an array ({ arr, full }: its literal strings, and
  // whether every element is one). An identifier is looked up in the literals its caller passed (region.lits, one value
  // per parameter, forwarded through every level of wrappers) and then in its own assignment in this function, with the
  // literal strings later pushed onto it. null when the value is not a literal.
  function litValue(P, region, range) {
    if (!range) return null;
    const [a, b] = trimRange(P.code, range[0], range[1]); if (a >= b) return null;
    const s = P.strs.find((x) => x.s === a);
    if (s && s.e >= b) return s.tpl && /\$\{/.test(P.text.slice(s.s, s.e)) ? null : { s: s.v };
    if (P.code[a] === '[' && matchClose(P.code, a) === b - 1) {
      const parts = splitArgs(P.code, a, b - 1).map(([x, y]) => trimRange(P.code, x, y)).filter(([x, y]) => x < y);
      const arr = []; let full = true;
      for (const [x, y] of parts) { const q = P.strs.find((z) => z.s === x); if (q && q.e >= y && !(q.tpl && /\$\{/.test(P.text.slice(q.s, q.e)))) arr.push(q.v); else full = false; }
      return { arr, full };
    }
    const id = P.code.slice(a, b);
    if (!/^[A-Za-z_$][\w$]*$/.test(id)) return null;
    if (region && region.lits && region.lits.has(id)) return region.lits.get(id);
    if (!region) return null;
    const fa = region.f && region.f.body ? region.f.body[0] : region.a; const fb = region.f && region.f.body ? region.f.body[1] : region.b;
    const seg = P.code.slice(fa, fb); const esc = id.replace(/\$/g, '\\$');
    const m = new RegExp('(?<![\\w$.])' + esc + '\\s*(?::[^=\\n]+)?=(?![=>])\\s*').exec(seg);
    if (!m) return P.consts.has(id) ? { s: P.consts.get(id).v } : null;
    const at = fa + m.index + m[0].length; const end = P.code[at] === '[' ? matchClose(P.code, at) + 1 : exprEnd(P.code, at);
    if (end <= at) return null;
    const v = litValue(P, null, [at, end]);
    if (v && v.arr) {
      // args.push("--recursive"), args.append("x"), args.extend([...]): later literal elements, in order
      const re = new RegExp('(?<![\\w$.])' + esc + '\\s*\\.\\s*(push|append|extend|unshift|insert)\\s*\\(', 'g'); let mm; const arr = v.arr.slice(); let full = v.full;
      while ((mm = re.exec(seg))) {
        const o = fa + mm.index + mm[0].length - 1; const c = matchClose(P.code, o); if (c < o) { full = false; continue; }
        if (mm[1] === 'unshift' || mm[1] === 'insert') { full = false; continue; }
        for (const [x, y] of splitArgs(P.code, o, c)) { const w = litValue(P, null, [x, y]); if (w && w.s !== undefined) arr.push(w.s); else if (w && w.arr) { arr.push(...w.arr); full = full && w.full; } else full = false; }
      }
      return { arr, full };
    }
    return v;
  }
  // The words of a command line: the program and the arguments that are literals at the call or in what its callers
  // passed. full: every word is known.
  function cmdWords(P, call, region) {
    const args = argTexts(P, call); if (!args.length) return { words: null };
    const v0 = litValue(P, region, args[0]);
    // list form: ["git", "status"]
    if (v0 && v0.arr) return { words: v0.arr.length ? v0.arr : null, full: v0.full };
    if (v0 && v0.s !== undefined) {
      let words = v0.s.trim().split(/\s+/).filter(Boolean); let full = true;
      // spawn("git", ["status"]), create_subprocess_exec("git", "status", ...)
      const v1 = args[1] ? litValue(P, region, args[1]) : null;
      if (v1 && v1.arr) { words = words.concat(v1.arr); full = v1.full; }
      else if (v1 && v1.s !== undefined) { for (let i = 1; i < args.length; i++) { const w = litValue(P, region, args[i]); if (w && w.s !== undefined) words.push(w.s); else { if (!/^\s*(?:\{|[A-Za-z_]\w*\s*=)/.test(P.code.slice(args[i][0], args[i][1]))) full = false; break; } } }
      else if (args[1] && !/^\s*(?:\{|[A-Za-z_]\w*\s*=)/.test(P.code.slice(args[1][0], args[1][1]))) full = false;
      return { words: words.length ? words : null, whole: v0.s, full };
    }
    return { words: null };
  }
  // A process call. A known read-only command is a read. Otherwise it is "definite" only when the program is known (a
  // literal at the call or passed as one by the callers that reach it) with its sub-command where the program has
  // read-only sub-commands, or when the command itself comes from the tool's arguments. Anything else is "may".
  function execEffect(P, call, region, sink, emit) {
    const w = cmdWords(P, call, region);
    if (w.words && roCommand(w.words)) { emit('read', 'definite', 'exec.readonly', w.words.slice(0, 3).join(' ')); return; }
    const args = argTexts(P, call);
    const taint = region.taint || new Set();
    const cmdTainted = args.length > 0 && taintedIn(P.code.slice(args[0][0], args[0][1]), taint);
    const prog = w.words ? w.words[0].split('/').pop() : null;
    const known = !!prog && (!RO_SUB[prog] || w.words.slice(1).some((x) => !x.startsWith('-')) || w.full === true);
    const label = w.words ? w.words.slice(0, 3).join(' ') : '';
    if (!known && !cmdTainted) { emit('exec', 'may', sink, (label ? label + '; ' : '') + (prog ? 'the sub-command is not a literal' : 'command is not a literal')); return; }
    if (!taintedIn(P.code.slice(call.open, call.close), taint)) { emit('exec', 'may', sink, (label ? label + '; ' : '') + 'the command does not come from the tool\'s arguments'); return; }
    emit('exec', 'definite', sink, label || 'the command comes from the tool\'s arguments');
  }
  function roCommand(words) {
    if (!words || !words.length) return false;
    const prog = words[0].split('/').pop();
    if (/[|;&><`$]/.test(words.join(' ')) ) return false;
    if (prog === 'find' && words.some((w) => /^-(delete|exec|execdir|ok)$/.test(w))) return false;
    if (RO_CMDS.has(prog) && prog !== 'curl_head') return true;
    const sub = words.slice(1).find((w) => !w.startsWith('-'));
    if (RO_SUB[prog] && (sub === undefined ? ['node', 'python', 'python3'].includes(prog) && words.some((w) => RO_SUB[prog].has(w)) : RO_SUB[prog].has(sub) || words.some((w) => RO_SUB[prog].has(w) && w.startsWith('-')))) {
      if (prog === 'git' && sub === 'branch' && words.some((w) => /^-(d|D|m|M|c|C|-delete|-move)$/.test(w))) return false;
      if (prog === 'git' && (sub === 'config' || sub === 'tag' || sub === 'remote') && words.length > 2 && !words.some((w) => /^(--get|--list|-l|-n|-v|show|get-url)$/.test(w)) && sub !== 'tag') return false;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ one tool
  // ------------------------------------------------------------ data flow from the tool's arguments
  // The names a parameter list binds: `(a, { b, c: d }, ...e)` -> a, b, d, e.
  // The names an object or array pattern binds: `a, b: c, ...d` -> a, c, d.
  function destructNames(inner) {
    const out = new Set(); let d = 0; let cur = ''; const parts = [];
    for (const c of inner) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c; }
    if (cur.trim()) parts.push(cur);
    parts.forEach((x) => { const m = /^\s*(?:\.\.\.)?[\w$]+\s*:\s*([A-Za-z_$][\w$]*)/.exec(x) || /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(x); if (m) out.add(m[1]); });
    return out;
  }
  function paramNames(text) {
    const out = new Set();
    const names = (seg) => {
      let d = 0; let cur = ''; const parts = [];
      for (const c of seg) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c; }
      if (cur.trim()) parts.push(cur);
      return parts;
    };
    for (let part of names(text)) {
      part = part.trim().replace(/^(?:\.\.\.|\*\*?)/, '').trim();
      if (part[0] === '{' || part[0] === '[') { const close = matchClose(part, 0); const inner = part.slice(1, close > 0 ? close : part.length); names(inner).forEach((x) => { const m = /^\s*(?:\.\.\.)?[\w$]+\s*:\s*([A-Za-z_$][\w$]*)/.exec(x) || /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(x); if (m) out.add(m[1]); }); continue; }
      const m = /^([A-Za-z_$][\w$]*)/.exec(part); if (m && !/^(self|cls|this)$/.test(m[1])) out.add(m[1]);
    }
    return out;
  }
  function paramList(Q, f) {
    if (!f || !f.params) return [];
    const [o, c] = f.params; const text = Q.code[o] === '(' ? Q.code.slice(o + 1, c) : (/^[A-Za-z_$][\w$]*/.exec(Q.code.slice(o, o + 80)) || [''])[0];
    const out = []; let d = 0; let cur = '';
    for (const ch of text) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
    if (cur.trim()) out.push(cur);
    return out.map((x) => Array.from(paramNames(x)));
  }
  // Variables that carry an argument: assignments, destructuring and loops over something tainted, to a fixpoint.
  function propagate(P, a, b, taint) {
    const code = P.code.slice(a, b); const t = new Set(taint);
    const rules = P.lang === 'js'
      ? [[/(?:\b(?:const|let|var)\s+)?(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,60})?=(?![=>])\s*([^;\n]{0,300})/g, (m) => [[m[1]], m[2]]],
         [/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=\s*([^;\n]{0,300})/g, (m) => [Array.from(destructNames(m[1])), m[2]]],
         [/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\s+([^)]{0,200})\)/g, (m) => [[m[1]], m[2]]],
         [/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|splice)\s*\(([^;\n]{0,300})/g, (m) => [[m[1]], m[2]]]]
      : [[/^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)\s*(.*)$/gm, (m) => [[m[1]], m[2]]],
         [/^[ \t]*for\s+([A-Za-z_]\w*)\s+in\s+(.*):\s*$/gm, (m) => [[m[1]], m[2]]],
         [/\bas\s+([A-Za-z_]\w*)\s*[:,]/g, (m) => [[m[1]], code.slice(Math.max(0, m.index - 200), m.index)]],
         [/^[ \t]*([A-Za-z_]\w*)\s*\.\s*(?:append|extend|insert)\s*\((.*)$/gm, (m) => [[m[1]], m[2]]]];
    for (let round = 0; round < 4; round++) {
      let grew = false;
      for (const [re, pick] of rules) { re.lastIndex = 0; let m; while ((m = re.exec(code))) { const [lhs, rhs] = pick(m); if (!lhs.some((x) => !t.has(x))) continue; if (Array.from(idsOf(rhs)).some((x) => t.has(x))) lhs.forEach((x) => { if (!t.has(x)) { t.add(x); grew = true; } }); } }
      if (!grew) break;
    }
    return t;
  }
  // the whole statement around a call, with the calls chained after it: `db.prepare("UPDATE ...").run(id)`
  function stmtWindow(P, call) {
    const code = P.code; let st = call.at; let depth = 0;
    for (let k = call.at - 1, n = 0; k >= 0 && n < 400; k--, n++) {
      const c = code[k];
      if (')}]'.includes(c)) depth++;
      else if ('({['.includes(c)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ';' || (P.lang === 'py' && c === '\n'))) break;
      st = k;
    }
    let end = call.close > call.open ? call.close + 1 : call.open + 1;
    for (let g = 0; g < 8; g++) { const m = /^\s*\??\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(code.slice(end, end + 120)); if (!m) break; const o = end + m[0].length - 1; const c = matchClose(code, o); if (c < 0) break; end = c + 1; }
    return code.slice(st, end);
  }
  const taintedIn = (text, taint) => Array.from(idsOf(text)).some((x) => taint.has(x));
  const WRITE_KINDS = new Set(['write', 'delete', 'unsafe_http']);
  // Is the target of this sink built from the tool's arguments? true / false; null when the rule does not apply.
  function targetFromArgs(P, call, e, taint, state) {
    if (!WRITE_KINDS.has(e.kind) || e.conf !== 'definite') return null;
    const sink = e.sink;
    if (/^fs\.handle\./.test(sink)) { const h = state.fileHandles(P).get(call.chain[0]); return h ? taintedIn(h, taint) : false; }
    if (/^fs\./.test(sink)) {
      if (call.chain[0] === '<expr>' || /^fs\.pathlib\./.test(sink)) return taintedIn(stmtWindow(P, call), taint);
      return splitArgs(P.code, call.open, call.close).slice(0, 2).some(([x, y]) => taintedIn(P.code.slice(x, y), taint));
    }
    if (/^http\./.test(sink)) return taintedIn(P.code.slice(call.open, call.close), taint) || taintedIn(stmtWindow(P, call), taint);
    if (/^(sql|orm)\./.test(sink)) return taintedIn(stmtWindow(P, call), taint);
    return null;
  }

  // The parameters a call's positional arguments bind: a Python method called on an object (obj.m(a)) binds `self`
  // (or `cls`) without an argument, so its first argument goes to the second parameter.
  function boundParams(t, call) {
    const plist = paramList(t.P, t.f);
    if (t.P.lang !== 'py' || call.chain.length < 2 || !t.f || !t.f.params || !plist.length || plist[0].length) return plist;
    const first = t.P.code.slice(t.f.params[0] + 1, t.f.params[1]).split(',')[0].trim();
    return /^(self|cls)\b/.test(first) ? plist.slice(1) : plist;
  }

  function scanTool(R, regions, how, state) {
    const idsOfParams = (Q, f) => new Set(paramList(Q, f).flat());
    const fx = { read: [], write: [], delete: [], unsafe_http: [], exec: [], unknown_call: [] };
    const seenEv = new Set(); const visited = new Set(); const unresolved = [];
    // the functions (by region key) whose walk reached a file write, for "a delete of a file this function wrote"
    const fnWrites = new Map(); const active = [];
    const add = (e, via, capMay, cond) => {
      if (e.kind === 'write' && /^fs\./.test(e.sink)) active.forEach((k) => fnWrites.set(k, true));
      let conf = capMay && e.conf === 'definite' ? 'may' : e.conf;
      if (cond && conf === 'definite') { conf = 'may'; e = Object.assign({}, e, { note: (e.note ? e.note + '; ' : '') + 'on a conditional path' }); }
      const key = e.P.path + ':' + e.P.line(e.at) + ':' + e.sink + ':' + e.kind;
      if (seenEv.has(key)) return; seenEv.add(key);
      if (fx[e.kind].length >= MAX_EVIDENCE) return;
      fx[e.kind].push(evOf(e.P, e.at, e.sink, conf, via, e.note, e.kind));
    };
    const capMay = how === 'by-name';
    let calls = 0;
    const walk = (P, a, b, depth, via, f, cond, params, taintIn, litsIn) => {
      const key = P.path + ':' + a + ':' + b; if (visited.has(key)) return; visited.add(key);
      active.push(key); try { walkBody(P, a, b, depth, via, f, cond, params, taintIn, litsIn, key); } finally { active.pop(); }
    };
    const walkBody = (P, a, b, depth, via, f, cond, params, taintIn, litsIn, key) => {
      if (state.deadline && Date.now() > state.deadline) { state.timedOut = true; return; }
      params = new Set([...(params || []), ...idsOfParams(P, f)]);
      const calleeTaint = (Q, call, t, tn) => {
        const plist = boundParams(t, call); const args = splitArgs(Q.code, call.open, call.close); const out = new Set();
        args.forEach(([x, y], i) => {
          const txt = Q.code.slice(x, y); const kw = Q.lang === 'py' ? /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(txt) : null;
          if (!taintedIn(kw ? kw[2] : txt, tn)) return;
          if (kw) out.add(kw[1]); else (plist[i] || []).forEach((n) => out.add(n));
        });
        return out;
      };
      const taint = propagate(P, f && f.body && f.body[0] <= a && f.body[1] >= b ? f.body[0] : a, f && f.body && f.body[0] <= a && f.body[1] >= b ? f.body[1] : b, taintIn || idsOfParams(P, f));
      const region = { P, a, b, via, f, params, taint, lits: litsIn || new Map() };
      const condAt = (pos) => isCond(P, pos, a, b) || earlyExit(P, pos, a, b, taint);
      // the literal values this call passes to the callee's parameters (a program name, an argv array)
      const calleeLits = (call, t) => {
        const plist = boundParams(t, call); const out = new Map();
        splitArgs(P.code, call.open, call.close).forEach(([x, y], i) => {
          const txt = P.code.slice(x, y); const kw = P.lang === 'py' ? /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*/.exec(txt) : null;
          const v = litValue(P, region, kw ? [x + kw[0].length, y] : [x, y]); if (!v) return;
          const names = kw ? [kw[1]] : (plist[i] || []); if (names.length === 1) out.set(names[0], v);
        });
        return out;
      };
      const cs = callsIn(P, a, b);
      const strs = strsIn(P, a, b);
      // SQL: strings that are arguments of a call (definite when it is not a log or error), others "may"
      const claimed = new Set(); const sqlSeen = new Set();
      const regionStrs = (x, y) => P.strs.filter((q) => q.s >= x && q.s < y);
      const localStr = (id) => {
        const re = new RegExp('(?<![\\w$.])' + id.replace(/\$/g, '\\$') + '\\s*(?::[^=\\n]+)?=(?!=)\\s*', 'g'); let mm; const seg = P.code.slice(a, b);
        while ((mm = re.exec(seg))) { const s = P.strs.find((q) => q.s === nextSig(P.code, a + mm.index + mm[0].length)); if (s) return s; }
        return P.consts.get(id) || null;
      };
      // strings handed to a logger, print or an error constructor are messages, never queries
      for (const c of cs) { const l = c.chain[c.chain.length - 1]; if (DB_NOT_CALLS.test(c.chain[0]) || DB_NOT_CALLS.test(l)) regionStrs(c.open, c.close).forEach((q) => claimed.add(q.s)); }
      // identifiers this function passed as the path of a file write, directly or to a callee that wrote a file
      const wroteIds = new Set();
      const firstId = (call) => { const r = argTexts(P, call)[0]; const t = r ? P.code.slice(r[0], r[1]).trim() : ''; return /^[A-Za-z_$][\w$]*$/.test(t) && !/^(self|this)$/.test(t) ? t : null; };
      for (const call of cs) {
        if (++calls > state.maxCalls) { state.truncated = true; return; }
        let effs = classify(R, P, call, region, state);
        const targets = call.chained ? [] : resolveName(R, P, call.chain, { f });
        // a call the repository resolves is followed, not guessed at from its name
        if (targets.length) effs = effs.filter((e) => !e.heur);
        // SQL in this call's arguments
        const lastSeg = call.chain[call.chain.length - 1];
        let sqlHere = false;
        if (!DB_NOT_CALLS.test(call.chain[0]) && !DB_NOT_CALLS.test(lastSeg) && !state.disable.has('sql')) {
          const argStrs = regionStrs(call.open, call.close);
          const cand = argStrs.map((x) => x).concat(
            argTexts(P, call).map(([x, y]) => { const t = P.code.slice(x, y).trim(); return /^[A-Za-z_$][\w$]*$/.test(t) && DB_EXEC.has(lastSeg) ? localStr(t) : null; }).filter(Boolean));
          for (const s of cand) {
            if (sqlSeen.has(s.s)) continue; const k = sqlKind(s.v); if (!k) continue; sqlSeen.add(s.s); claimed.add(s.s); sqlHere = true;
            const se = { kind: k.kind, conf: 'definite', sink: 'sql.' + k.verb, note: s.v.replace(/\s+/g, ' ').slice(0, 60), at: s.s, P };
            const from = targetFromArgs(P, call, se, taint, state);
            add(from === false ? Object.assign(se, { conf: 'may', note: se.note + '; no argument of the tool reaches the statement' }) : se, via, capMay, cond || condAt(s.s));
          }
        }
        if (sqlHere) effs = effs.filter((e) => e.kind !== 'unknown_call');
        const condCall = cond || condAt(call.at);
        const fid = firstId(call);
        effs.forEach((e) => {
          const from = targetFromArgs(P, call, e, taint, state);
          let e2 = from === false ? Object.assign({}, e, { conf: 'may', note: (e.note ? e.note + '; ' : '') + 'the target does not come from the tool\'s arguments' }) : e;
          // removing a file this function wrote earlier (a pending record, a temporary copy) undoes its own write
          if (e2.kind === 'delete' && /^fs\./.test(e2.sink) && fid && wroteIds.has(fid) && e2.conf === 'definite') e2 = Object.assign({}, e2, { conf: 'may', note: (e2.note ? e2.note + '; ' : '') + 'removes a file this function wrote' });
          add(e2, via, capMay, condCall);
        });
        if (fid && effs.some((e) => e.kind === 'write' && /^fs\./.test(e.sink))) wroteIds.add(fid);
        // follow into the repository
        if (depth < state.depth && !call.chained) {
          for (const t of targets.slice(0, 3)) { const nm = t.f.name; const tkey = t.P.path + ':' + t.f.body[0] + ':' + t.f.body[1]; walk(t.P, t.f.body[0], t.f.body[1], depth + 1, via.concat(nm + '@' + t.P.path + ':' + t.P.line(t.f.start)), t.f, condCall, params, calleeTaint(P, call, t, taint), calleeLits(call, t)); if (fnWrites.get(tkey)) argTexts(P, call).forEach(([x, y]) => { const id = P.code.slice(x, y).trim(); if (/^[A-Za-z_$][\w$]*$/.test(id)) wroteIds.add(id); }); }
          if (!targets.length && call.chain.length >= 1 && P.imports.get(call.chain[0])) {
            const imp = P.imports.get(call.chain[0]);
            if (imp.spec.startsWith('.') || (P.lang === 'py' && imp.spec.startsWith('.'))) {
              const file = P.lang === 'js' ? R.resolveJs(P.path, imp.spec) : R.resolvePy(P.path, imp.spec);
              if (!file) { unresolved.push({ file: P.path, line: P.line(call.at), call: call.chain.join('.'), spec: imp.spec }); add({ kind: 'unknown_call', conf: 'may', sink: 'import.unresolved.' + call.chain.join('.'), note: 'the module ' + imp.spec + ' is not in the files read', at: call.at, P }, via, capMay); }
            }
          }
        }
      }
      // SQL strings in the region that no call claimed: may (a query built here and run elsewhere)
      if (!state.disable.has('sql')) for (const s of strs) {
        if (claimed.has(s.s) || sqlSeen.has(s.s) || s.doc) continue;
        const k = sqlKind(s.v); if (!k || k.kind === 'read') continue;
        if (s.tpl && /sql|execute|query/i.test(s.tag || '')) { sqlSeen.add(s.s); const from = taintedIn(P.code.slice(Math.max(a, s.s - 200), s.e + 100), taint); add({ kind: k.kind, conf: from ? 'definite' : 'may', sink: 'sql.' + k.verb, note: s.v.replace(/\s+/g, ' ').slice(0, 60) + (from ? '' : '; no argument of the tool reaches the statement'), at: s.s, P }, via, capMay, cond || condAt(s.s)); continue; }
        sqlSeen.add(s.s); add({ kind: k.kind, conf: 'may', sink: 'sql.' + k.verb, note: 'a SQL string that no call in this function receives', at: s.s, P }, via, capMay, cond || condAt(s.s));
      }
    };
    for (const r of regions) {
      const via0 = [(r.f ? r.f.name : 'handler') + '@' + r.P.path + ':' + r.P.line(r.a)];
      walk(r.P, r.a, r.b, 0, via0, r.f, false, new Set());
    }
    return { fx, unresolved, calls };
  }

  function stdlibJs(spec) { return /^(node:)?(fs|path|os|util|url|crypto|events|stream|buffer|zlib|assert|readline|http|https|net|tls|dns|querystring|string_decoder|timers|perf_hooks|worker_threads|child_process|process|module|vm|v8)(\/.*)?$/.test(spec) || spec === 'zod' || /^@modelcontextprotocol\//.test(spec) || /^(os|sys|re|json|time|datetime|typing|pathlib|logging|asyncio|collections|functools|itertools|math|random|string|textwrap|base64|hashlib|uuid|copy|enum|dataclasses|abc|contextlib|inspect|traceback|warnings|io|csv|urllib|operator|mcp|pydantic|fastmcp|typing_extensions)(\..*)?$/.test(spec); }

  // ------------------------------------------------------------ the whole repository
  function analyse(files, found, opts) {
    opts = opts || {};
    const R = makeRepo(files);
    const state = {
      depth: Number.isInteger(opts.depth) ? Math.max(0, Math.min(6, opts.depth)) : 3,
      maxCalls: opts.maxCalls || 3000, disable: new Set(opts.disable || []), family: '', truncated: false,
      deadline: Date.now() + (Number.isFinite(opts.timeBudgetMs) ? opts.timeBudgetMs : 20000), timedOut: false,
      stdlib: stdlibJs,
      fileHandles: (P) => { if (P._fh) return P._fh; const s = new Map(); const re = /\b(?:const|let|var|using)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[\w$.]+\.)?open(?:Sync)?\s*\(/g; let m; while ((m = re.exec(P.code))) { const o = m.index + m[0].length - 1; const c = matchClose(P.code, o); s.set(m[1], P.code.slice(o, c > o ? c : o + 200)); } P._fh = s; return s; },
      localDef: (P, n) => P.funcs.some((f) => f.name === n),
      pathlibish: (P, chain) => /path|dir|file|folder|root|\bp\b|cwd|home|target|dest|src|base/i.test(chain.slice(0, -1).join('.')) || /pathlib|Path\(/.test(P.text),
      httpClients: (P) => {
        if (P._httpClients) return P._httpClients; const s = new Set(); let m;
        if (P.lang === 'js') { const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:axios\.create|got\.extend|ky\.create|ky\.extend|superagent|wretch|ofetch\.create|create(?:Client|Axios))\s*\(/g; while ((m = re.exec(P.code))) s.add(m[1]); const re2 = /(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*axios\.create\s*\(/g; while ((m = re2.exec(P.code))) s.add(m[1]); }
        else {
          const re = /([A-Za-z_][\w.]*)\s*=\s*(?:await\s+)?(?:httpx|requests|aiohttp)\.(?:Async)?(?:Client|Session|ClientSession)\s*\(/g; while ((m = re.exec(P.code))) { s.add(m[1]); s.add(m[1].replace(/^self\./, '')); }
          const re2 = /\bas\s+([A-Za-z_]\w*)\s*:/g; const txt = P.code; while ((m = re2.exec(txt))) { const ln = txt.slice(txt.lastIndexOf('\n', m.index) + 1, m.index); if (/(httpx|requests|aiohttp)\.(Async)?(Client|Session|ClientSession)\s*\(/.test(ln)) s.add(m[1]); }
        }
        P._httpClients = s; return s;
      },
    };
    const tools = {}; let n = 0; let withHandler = 0; let totalCalls = 0;
    for (const f of found || []) {
      const name = f && f.tool && f.tool.name; if (typeof name !== 'string' || has(tools, name)) continue;
      n++;
      if (Date.now() > state.deadline) { tools[name] = { status: 'time_budget' }; state.timedOut = true; continue; }
      const lang = langOf(f.path || '');
      if (!lang || (f.language && f.language !== 'TypeScript' && f.language !== 'JavaScript' && f.language !== 'Python' && !/^(typescript|javascript|python)$/i.test(f.language))) { tools[name] = { status: 'unsupported_language', language: f.language || null }; continue; }
      const P = R.get(f.path);
      if (!P) { tools[name] = { status: 'file_not_read' }; continue; }
      let regions = []; let how = 'none';
      try {
        regions = lang === 'js' ? jsRegionsIn(R, P, name, f.offset) : pyRegionsIn(R, P, name, f.line);
        if (!regions.length) {
          // dispatch elsewhere in the same package: a switch or table in another file
          const pkg = packageDir(R, f.path);
          const others = R.paths.filter((p) => p !== f.path && langOf(p) === lang && (pkg === '' || p.startsWith(pkg + '/')) && R.text.get(p).includes(name)).slice(0, 60);
          for (const p of others) { const Q = R.get(p); const rs = lang === 'js' ? jsRegionsIn(R, Q, name, null) : pyRegionsIn(R, Q, name, null); const keep = rs.filter((r) => /^(case|if|map)$/.test(r.how) || (lang === 'py' && r.how === 'decorator')); regions = regions.concat(keep); if (regions.length) break; }
        }
        if (!regions.length) {
          // last: a function of the tool's name, in the registration file or the package (lower confidence)
          const cand = []; const fn = (Q) => Q.funcs.filter((g) => g.name === name || (lang === 'js' && g.name === camel(name)) || g.name === 'handle_' + name || g.name === 'handle' + camel(name, true) || g.name === name + '_handler');
          fn(P).forEach((g) => cand.push({ P, f: g, a: g.body[0], b: g.body[1], how: 'by-name' }));
          if (!cand.length) { const pkg = packageDir(R, f.path); R.paths.filter((p) => p !== f.path && langOf(p) === lang && (pkg === '' || p.startsWith(pkg + '/'))).slice(0, 80).forEach((p) => { const Q = R.get(p); fn(Q).forEach((g) => cand.push({ P: Q, f: g, a: g.body[0], b: g.body[1], how: 'by-name' })); }); }
          if (cand.length === 1) regions = cand;
        }
      } catch (e) { tools[name] = { status: 'reader_error' }; continue; }
      if (!regions.length) { tools[name] = { status: 'handler_not_found' }; continue; }
      // dedupe regions
      const seen = new Set(); regions = regions.filter((r) => { const k = r.P.path + ':' + r.a + ':' + r.b; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
      how = regions[0].how;
      let res;
      try { res = scanTool(R, regions, regions.every((r) => r.how === 'by-name') ? 'by-name' : how, state); } catch (e) { tools[name] = { status: 'reader_error' }; continue; }
      withHandler++; totalCalls += res.calls;
      const cut = state.timedOut;
      const fx = res.fx;
      const def = (k) => fx[k].filter((e) => e.confidence === 'definite');
      const may = (k) => fx[k].filter((e) => e.confidence !== 'definite');
      const definiteWrite = def('write').length + def('delete').length + def('unsafe_http').length + def('exec').length > 0;
      const mayWrite = may('write').length + may('delete').length + may('unsafe_http').length + may('exec').length > 0;
      const overwrite = def('write').some((e) => /overwrite/.test(e.note || ''));
      const noSink = !cut && !definiteWrite && !mayWrite && !fx.unknown_call.length && !res.unresolved.length;
      tools[name] = {
        status: 'analysed',
        handler: { file: regions[0].P.path, line: regions[0].P.line(regions[0].a), how: regions[0].how, regions: regions.length },
        effects: fx,
        derived: {
          readOnlyHint: definiteWrite ? { value: false, confidence: 'definite' } : mayWrite ? { value: null, confidence: 'may', why: 'may write' } : noSink ? { value: true, confidence: 'no_sink_found' } : { value: null, confidence: 'unknown' },
          destructiveHint: def('delete').length ? { value: true, confidence: 'definite' } : may('delete').length ? { value: null, confidence: 'may', why: 'may delete' } : overwrite ? { value: true, confidence: 'may', why: 'overwrites' } : { value: null, confidence: 'none' },
        },
        unresolved: res.unresolved.slice(0, 10),
        ...(cut ? { truncated: true } : {}),
      };
    }
    return { version: VERSION, tools, summary: { tools: n, handlers_found: withHandler, calls_scanned: totalCalls, depth: state.depth, truncated: state.truncated || state.timedOut, ...(state.timedOut ? { time_budget_hit: true } : {}) }, limits: LIMITS };
  }
  const camel = (s, up) => { const c = s.replace(/[_-]+([a-z0-9])/g, (_, x) => x.toUpperCase()); return up ? c[0].toUpperCase() + c.slice(1) : c; };
  function packageDir(R, p) {
    let d = dirOf(p);
    for (;;) { if (R.text.has((d ? d + '/' : '') + 'package.json') || R.paths.includes((d ? d + '/' : '') + 'pyproject.toml')) return d; if (!d) return ''; d = dirOf(d); }
  }
  const LIMITS = [
    'Static reading only: nothing is run, so a call through a variable, a plugin, a generated client or reflection is not followed.',
    'A remote API behind an HTTP call or an SDK method is opaque: such calls are "may", never "definite".',
    'Handlers are resolved for inline functions, referenced functions, class methods, decorator-registered functions and name switches; calls are followed through files in the repository up to the set depth.',
    'A write to a path that looks temporary, a POST to a URL that looks like a query, and a handler found only by its function name are "may".',
  ];

  return { VERSION, KINDS, analyse, LIMITS, _internal: { maskJs, maskPy, prepare, sqlKind, roCommand, makeRepo } };
});
