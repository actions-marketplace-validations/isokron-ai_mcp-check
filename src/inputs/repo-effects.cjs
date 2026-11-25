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
        let j = i + 1; let v = ''; let tail = 0;
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\') { v += src[j + 1] || ''; j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { let d = 1; j += 2; while (j < n && d) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } v += '?'; continue; }
          v += src[j++];
        }
        tail = j;
        let tg = i - 1; while (tg >= 0 && /[\w$.]/.test(src[tg])) tg--;
        strs.push({ s: i, e: tail + 1, v, tpl: true, tag: src.slice(tg + 1, i) }); blank(i + 1, tail); i = tail + 1; lastSig = '`'; lastWord = ''; continue;
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
  const TEMPISH = /tmp|temp|cache|scratch|mkdtemp|\.cache|os\.tmpdir|lock|\.pid\b|pidfile/i; // temporary files, caches, lock and pid files: bookkeeping, not the tool's data
  const CP_MODS = /^(node:)?child_process$|^(execa|shelljs|cross-spawn|node-pty)$/;
  const CP_FNS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'execa', 'execaSync', 'execaCommand', 'execaCommandSync']);
  const HTTP_JS_MODS = /^(axios|got|ky|superagent|needle|undici|node-fetch|cross-fetch|ofetch|request|request-promise|phin|wretch)$/;
  const HTTP_VERBS_W = new Set(['post', 'put', 'patch', 'delete', 'del']);
  const READISH_URL = /search|query|graphql|lookup|find|list|fetch|read|get|embed|complet|token|oauth|auth|count|check|validate|verify|preview|dry|calculate|estimate|translate|classif|analy[sz]e|infer|rank|retriev|batchGet/i;
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

  function evOf(P, at, sink, conf, via, note) { return { file: P.path, line: P.line(at), sink, confidence: conf, via: via.slice(), ...(note ? { note } : {}) }; }

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
        const temp = TEMPISH.test(pathText);
        if (FS_DELETE.has(fsName)) emit('delete', temp ? 'may' : 'definite', 'fs.' + fsName, temp ? 'path looks temporary or a lock file' : '');
        else if (FS_WRITE.has(fsName)) emit('write', temp ? 'may' : 'definite', 'fs.' + fsName, temp ? 'path looks temporary or a lock file' : (FS_OVERWRITE.has(fsName) ? 'overwrite' : ''));
        else if (FS_READ.has(fsName)) emit('read', 'definite', 'fs.' + fsName, '');
        if (FS_DELETE.has(fsName) || FS_WRITE.has(fsName) || FS_READ.has(fsName)) return out;
      }
      if (chain.length === 2 && ['write', 'writeFile', 'truncate', 'appendFile', 'writev', 'sync'].includes(last) && last !== 'sync' && state.fileHandles(P).has(head)) { fam('fs'); emit('write', 'definite', 'fs.handle.' + last, 'overwrite'); return out; }
      if (/^Deno$/.test(head) && chain.length === 2) { fam('fs'); if (/^(remove|removeSync)$/.test(last)) { emit('delete', 'definite', 'fs.Deno.' + last); return out; } if (/^(writeTextFile|writeFile|mkdir|rename|copyFile|truncate|writeTextFileSync|writeFileSync)$/.test(last)) { emit('write', 'definite', 'fs.Deno.' + last); return out; } if (/^(readTextFile|readFile|readDir|stat)$/.test(last)) { emit('read', 'definite', 'fs.Deno.' + last); return out; } }
      if (head === 'Bun' && last === 'write' && chain.length === 2) { fam('fs'); emit('write', 'definite', 'fs.Bun.write'); return out; }
      // ---- exec
      if ((imp && CP_MODS.test(impMod) && ((chain.length === 1 && (imp.name === '*' || imp.name === 'default' ? CP_FNS.has(head) : CP_FNS.has(imp.name))) || (chain.length === 2 && (imp.name === '*' || imp.name === 'default') && CP_FNS.has(last)))) || (head === 'Bun' && last === 'spawn') || (head === 'Deno' && last === 'Command')) {
        fam('exec'); const w = cmdWords(P, call);
        if (w.words && roCommand(w.words)) emit('read', 'definite', 'exec.readonly', w.words.slice(0, 3).join(' '));
        else emit('exec', 'definite', 'exec.' + (chain.length === 1 ? (imp && imp.name !== '*' && imp.name !== 'default' ? imp.name : head) : last), w.words ? w.words.slice(0, 3).join(' ') : 'command is not a literal');
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
        if (lit) { if (/[wax+]/.test(lit[2])) emit('write', TEMPISH.test(pathText) ? 'may' : 'definite', 'fs.open', TEMPISH.test(pathText) ? 'path looks temporary or a lock file' : 'mode ' + lit[2]); else emit('read', 'definite', 'fs.open'); return out; }
        emit('write', 'may', 'fs.open', 'mode is not a literal'); return out;
      }
      if ((head === 'os' || (imp && /^os$/.test(impHead))) && chain.length === 2) {
        fam('fs'); if (/^(remove|unlink|rmdir|removedirs)$/.test(last)) { emit('delete', 'definite', 'fs.os.' + last); return out; }
        if (/^(rename|replace|mkdir|makedirs|truncate|symlink|link|chmod|chown|utime|renames)$/.test(last)) { emit('write', 'definite', 'fs.os.' + last); return out; }
        if (/^(system|popen|execv|execve|execvp|execl|execlp|spawnl|spawnv|spawnlp|spawnvp|startfile)$/.test(last)) { fam('exec'); const w = cmdWords(P, call); if (w.words && roCommand(w.words)) emit('read', 'definite', 'exec.readonly', w.words.slice(0, 3).join(' ')); else emit('exec', 'definite', 'exec.os.' + last, w.words ? w.words.slice(0, 3).join(' ') : 'command is not a literal'); return out; }
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
        if (/^(write_text|write_bytes|touch|symlink_to|hardlink_to)$/.test(last)) { fam('fs'); emit('write', 'definite', 'fs.pathlib.' + last); return out; }
        if (/^(mkdir)$/.test(last) && chain.length >= 2 && state.pathlibish(P, chain)) { fam('fs'); emit('write', 'definite', 'fs.pathlib.mkdir'); return out; }
        if (/^(unlink|rmdir)$/.test(last) && state.pathlibish(P, chain)) { fam('fs'); emit('delete', 'definite', 'fs.pathlib.' + last); return out; }
        if (/^(read_text|read_bytes|iterdir|glob|rglob|exists|is_file|is_dir|stat)$/.test(last) && state.pathlibish(P, chain)) { fam('fs'); emit('read', 'definite', 'fs.pathlib.' + last); return out; }
      }
      // ---- python exec
      if ((head === 'subprocess' || (imp && /^subprocess$/.test(impHead))) && (chain.length === 2 || (imp && imp.name !== '*' && chain.length === 1))) {
        const fn = chain.length === 2 ? last : imp.name;
        if (/^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(fn)) { fam('exec'); const w = cmdWords(P, call); if (w.words && roCommand(w.words)) emit('read', 'definite', 'exec.readonly', w.words.slice(0, 3).join(' ')); else emit('exec', 'definite', 'exec.subprocess.' + fn, w.words ? w.words.slice(0, 3).join(' ') : 'command is not a literal'); return out; }
      }
      if (head === 'asyncio' && /^create_subprocess_(exec|shell)$/.test(last)) { fam('exec'); emit('exec', 'definite', 'exec.asyncio.' + last); return out; }
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
    // ---- client verbs: lower confidence
    fam('sdk');
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
    const readish = meth === 'POST' && READISH_URL.test(urlText);
    const conf = meth === 'POST' && readish ? 'may' : 'definite';
    const note = readish ? 'POST to a URL that looks like a query' : '';
    mk('unsafe_http', conf, 'http.' + meth, note);
    if (meth === 'DELETE') mk('delete', 'definite', 'http.DELETE', sink);
    return out;
  }

  function cmdWords(P, call) {
    const args = argTexts(P, call); if (!args.length) return { words: null };
    const [a, b] = args[0]; const s = P.strs.find((x) => x.s === nextSig(P.code, a));
    // list form: ["git", "status"]  /  spawn("git", ["status"])
    const lit = (x, y) => P.strs.filter((q) => q.s >= x && q.s < y).map((q) => q.v);
    if (P.code[nextSig(P.code, a)] === '[') { const w = lit(a, b); return { words: w.length ? w : null }; }
    if (s && s.s === nextSig(P.code, a) && trimRange(P.code, s.e, b)[0] >= b) {
      let words = s.v.trim().split(/\s+/);
      if (args[1] && P.code[nextSig(P.code, args[1][0])] === '[') words = words.concat(lit(args[1][0], args[1][1]));
      return { words, whole: s.v };
    }
    return { words: null };
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
  function scanTool(R, regions, how, state) {
    const fx = { read: [], write: [], delete: [], unsafe_http: [], exec: [], unknown_call: [] };
    const seenEv = new Set(); const visited = new Set(); const unresolved = [];
    const add = (e, via, capMay) => {
      const conf = capMay && e.conf === 'definite' ? 'may' : e.conf;
      const key = e.P.path + ':' + e.P.line(e.at) + ':' + e.sink + ':' + e.kind;
      if (seenEv.has(key)) return; seenEv.add(key);
      if (fx[e.kind].length >= MAX_EVIDENCE) return;
      fx[e.kind].push(evOf(e.P, e.at, e.sink, conf, via, e.note));
    };
    const capMay = how === 'by-name';
    let calls = 0;
    const walk = (P, a, b, depth, via, f) => {
      const key = P.path + ':' + a + ':' + b; if (visited.has(key)) return; visited.add(key);
      const region = { P, a, b, via, f };
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
            add({ kind: k.kind, conf: 'definite', sink: 'sql.' + k.verb, note: s.v.replace(/\s+/g, ' ').slice(0, 60), at: s.s, P }, via, capMay);
          }
        }
        if (sqlHere) effs = effs.filter((e) => e.kind !== 'unknown_call');
        effs.forEach((e) => add(e, via, capMay));
        // follow into the repository
        if (depth < state.depth && !call.chained) {
          for (const t of targets.slice(0, 3)) { const nm = t.f.name; walk(t.P, t.f.body[0], t.f.body[1], depth + 1, via.concat(nm + '@' + t.P.path + ':' + t.P.line(t.f.start)), t.f); }
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
        if (s.tpl && /sql|execute|query/i.test(s.tag || '')) { sqlSeen.add(s.s); add({ kind: k.kind, conf: 'definite', sink: 'sql.' + k.verb, note: s.v.replace(/\s+/g, ' ').slice(0, 60), at: s.s, P }, via, capMay); continue; }
        sqlSeen.add(s.s); add({ kind: k.kind, conf: 'may', sink: 'sql.' + k.verb, note: 'a SQL string that no call in this function receives', at: s.s, P }, via, capMay);
      }
    };
    for (const r of regions) {
      const via0 = [(r.f ? r.f.name : 'handler') + '@' + r.P.path + ':' + r.P.line(r.a)];
      walk(r.P, r.a, r.b, 0, via0, r.f);
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
      stdlib: stdlibJs,
      fileHandles: (P) => { if (P._fh) return P._fh; const s = new Set(); const re = /\b(?:const|let|var|using)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[\w$.]+\.)?open(?:Sync)?\s*\(/g; let m; while ((m = re.exec(P.code))) s.add(m[1]); P._fh = s; return s; },
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
      const fx = res.fx;
      const def = (k) => fx[k].filter((e) => e.confidence === 'definite');
      const may = (k) => fx[k].filter((e) => e.confidence !== 'definite');
      const definiteWrite = def('write').length + def('delete').length + def('unsafe_http').length + def('exec').length > 0;
      const mayWrite = may('write').length + may('delete').length + may('unsafe_http').length + may('exec').length > 0;
      const overwrite = def('write').some((e) => /overwrite/.test(e.note || ''));
      const noSink = !definiteWrite && !mayWrite && !fx.unknown_call.length && !res.unresolved.length;
      tools[name] = {
        status: 'analysed',
        handler: { file: regions[0].P.path, line: regions[0].P.line(regions[0].a), how: regions[0].how, regions: regions.length },
        effects: fx,
        derived: {
          readOnlyHint: definiteWrite ? { value: false, confidence: 'definite' } : mayWrite ? { value: null, confidence: 'may', why: 'may write' } : noSink ? { value: true, confidence: 'no_sink_found' } : { value: null, confidence: 'unknown' },
          destructiveHint: def('delete').length ? { value: true, confidence: 'definite' } : may('delete').length ? { value: null, confidence: 'may', why: 'may delete' } : overwrite ? { value: true, confidence: 'may', why: 'overwrites' } : { value: null, confidence: 'none' },
        },
        unresolved: res.unresolved.slice(0, 10),
      };
    }
    return { version: VERSION, tools, summary: { tools: n, handlers_found: withHandler, calls_scanned: totalCalls, depth: state.depth, truncated: state.truncated }, limits: LIMITS };
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
