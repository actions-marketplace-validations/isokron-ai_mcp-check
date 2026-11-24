// A small JavaScript tokenizer, enough to find mutation sites without touching comments or the insides of strings:
// identifiers, numbers, punctuators, strings, template parts, regular-expression literals and comments, each with its
// offset. It handles template nesting (`${ ... }`) and tells a regular expression from a division by the token before it.
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const isIdStart = (c) => /[A-Za-z_$\u0080-\uffff]/.test(c);
const isId = (c) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

export function tokenize(src) {
  const toks = [];
  let i = 0; const n = src.length;
  const stack = []; // template nesting: each entry counts open braces inside one ${ }
  let prev = null; // previous significant token
  const push = (t) => { toks.push(t); if (t.type !== 'comment') prev = t; };
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'punct') return ![')', ']', '}'].includes(prev.value) || prev.value === '}';
    if (prev.type === 'ident') return REGEX_AFTER_WORD.has(prev.value);
    if (prev.type === 'template' && prev.value.endsWith('${')) return true;
    return false;
  };
  const readTemplate = (start) => { // from just after ` or }, to the closing ` or ${
    let j = start;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return { end: j + 1, open: false };
      if (c === '$' && src[j + 1] === '{') return { end: j + 2, open: true };
      j++;
    }
    throw new Error('unterminated template at ' + start);
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; push({ type: 'comment', start: i, end, value: src.slice(i, end) }); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated comment'); push({ type: 'comment', start: i, end: e + 2, value: src.slice(i, e + 2) }); i = e + 2; continue; }
    if (c === '#' && i === 0 && src[1] === '!') { const e = src.indexOf('\n'); push({ type: 'comment', start: 0, end: e, value: src.slice(0, e) }); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') throw new Error('newline in string at ' + i); j++; }
      push({ type: 'string', start: i, end: j + 1, value: src.slice(i + 1, j), quote: c }); i = j + 1; continue;
    }
    if (c === '`') { const r = readTemplate(i + 1); push({ type: 'template', start: i, end: r.end, value: src.slice(i, r.end) }); if (r.open) stack.push(0); i = r.end; continue; }
    if (c === '}' && stack.length && stack[stack.length - 1] === 0) { stack.pop(); const r = readTemplate(i + 1); push({ type: 'template', start: i, end: r.end, value: src.slice(i, r.end) }); if (r.open) stack.push(0); i = r.end; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?n?)/.exec(src.slice(i, i + 64));
      push({ type: 'number', start: i, end: i + m[0].length, value: m[0] }); i += m[0].length; continue;
    }
    if (isIdStart(c) || c === '\\') { let j = i + 1; while (j < n && isId(src[j])) j++; push({ type: 'ident', start: i, end: j, value: src.slice(i, j) }); i = j; continue; }
    if (c === '#' && isIdStart(src[i + 1] || '')) { let j = i + 1; while (j < n && isId(src[j])) j++; push({ type: 'ident', start: i, end: j, value: src.slice(i, j) }); i = j; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let cls = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') throw new Error('newline in regex at ' + i);
        if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
        j++;
      }
      const bodyEnd = j; j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      push({ type: 'regex', start: i, end: j, value: src.slice(i, j), body: src.slice(i + 1, bodyEnd), flags: src.slice(bodyEnd + 1, j) }); i = j; continue;
    }
    let p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) p = c;
    if (stack.length) { if (p === '{') stack[stack.length - 1]++; else if (p === '}') stack[stack.length - 1]--; }
    push({ type: 'punct', start: i, end: i + p.length, value: p }); i += p.length;
  }
  return toks;
}
