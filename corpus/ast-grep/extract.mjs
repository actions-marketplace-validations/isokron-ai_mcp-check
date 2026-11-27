// What a registration found by ast-grep says, read from its text: the tool name, and the description and annotations
// where they are literal. Pure functions: a match (rule id, its text, the text after it, the whole file) in, a record
// out. A name that is not a literal (computed, looped, passed in) is `unreadable`, never guessed.
import { annotationsOf, arrayItems, balanced, callArgs, fields, literalBool, literalString, objectBody, splitTop } from './parse.mjs';

/** Files whose text shows they are about MCP, per language (an import, a type or a comment): a `.tool(` call elsewhere is another library's. */
export const GATE = Object.freeze({
  typescript: /mcp|modelcontextprotocol/i,
  python: /mcp|modelcontextprotocol/i,
  go: /mcp|modelcontextprotocol/i,
  rust: /mcp|modelcontextprotocol/i,
  csharp: /ModelContextProtocol/,
});

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();

const found = (idiom, name, nameSource, extra = {}) => ({ idiom, name, name_source: nameSource, description: extra.description ?? null, annotations: extra.annotations ?? null });
const unreadable = (idiom, reason) => ({ idiom, unreadable: reason });

/** The description and annotations from an object's fields (description: "..", annotations: {..}). */
function fromObjectFields(map) {
  const d = map.get('description');
  const a = map.get('annotations');
  const body = a ? objectBody(a) : null;
  return { description: d ? literalString(d) : null, annotations: body !== null ? annotationsOf(fields(body)) : null };
}

/** An argument that is an object literal made only of annotation hints (the positional annotations of server.tool). */
function positionalAnnotations(args) {
  for (const a of args) {
    const body = objectBody(a);
    if (body === null) continue;
    const map = fields(body);
    if (map.size && [...map.keys()].every((k) => /Hint$|^title$/.test(k))) return annotationsOf(map);
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- TypeScript / JS

function tsElements(items, idiom) {
  const out = [];
  for (const item of items) {
    const body = objectBody(item);
    if (body === null) { out.push(unreadable(idiom, 'element_not_literal')); continue; }
    const map = fields(body);
    const name = map.get('name');
    const lit = name ? literalString(name) : null;
    if (lit === null) out.push(unreadable(idiom, 'name_not_literal'));
    else out.push(found(idiom, lit, 'literal', fromObjectFields(map)));
  }
  return out;
}

/** The tools of the handler of a ListToolsRequestSchema: the `tools:` array, written there or in a same-file constant. */
function tsListHandler(argsText, fileText) {
  const idiom = 'ts-list-tools-handler';
  const m = /\btools\s*(:\s*|(?=[,}]))/.exec(argsText);
  if (!m) return [unreadable(idiom, 'no_tools_property')];
  let valueSrc;
  if (m[1].startsWith(':')) {
    const rest = argsText.slice(m.index + m[0].length);
    valueSrc = splitTop(rest.replace(/\}\s*\)?\s*(?:\)|;)?\s*$/, ''), { sep: ',' })[0] ?? '';
    // the first top-level element of what follows; cut at the closing brace of the returned object
    const first = splitTop(rest)[0] ?? '';
    valueSrc = first.replace(/\}[\s\S]*$/, (x) => (balancedClose(first) ? x : '')).trim() || valueSrc;
  } else valueSrc = 'tools';
  let items = arrayItems(cutAtUnbalanced(valueSrc));
  if (items === null) {
    const id = /^[A-Za-z_$][\w$]*$/.exec(cutAtUnbalanced(valueSrc).trim());
    if (id) {
      const decl = new RegExp('(?:const|let|var)\\s+' + id[0] + '\\s*(?::[^=]+)?=\\s*', 'g').exec(fileText);
      if (decl) {
        const at = decl.index + decl[0].length;
        const open = fileText.indexOf('[', at);
        if (open === at || (open > at && /^\s*(?:<[^>]*>)?\s*$/.test(fileText.slice(at, open)))) {
          const inner = balanced(fileText, open);
          if (inner !== null) items = splitTop(inner).filter((x) => x !== '');
        }
      }
    }
  }
  if (items === null) return [unreadable(idiom, 'tools_not_literal')];
  return tsElements(items, idiom);
}
const balancedClose = (s) => (s.match(/[{(\[]/g) || []).length >= (s.match(/[})\]]/g) || []).length;
/** `value` cut where an enclosing bracket closes (a returned object's own closing brace). */
function cutAtUnbalanced(value) {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (/[{(\[]/.test(value[i])) depth++;
    else if (/[})\]]/.test(value[i])) { depth--; if (depth < 0) return value.slice(0, i); }
  }
  return value;
}

function extractTs(m) {
  const args = callArgs(m.text);
  switch (m.ruleId.replace(/-(?:Tsx|JavaScript|TypeScript)$/, '')) {
    case 'ts-server-tool': {
      if (!args.length) return [unreadable('ts-server-tool', 'no_arguments')];
      const name = literalString(args[0]);
      if (name === null) return [unreadable('ts-server-tool', 'name_not_literal')];
      const desc = args[1] !== undefined ? literalString(args[1]) : null;
      return [found('ts-server-tool', name, 'literal', { description: desc, annotations: positionalAnnotations(args.slice(1, -1)) })];
    }
    case 'ts-register-tool': {
      if (!args.length) return [unreadable('ts-register-tool', 'no_arguments')];
      const name = literalString(args[0]);
      if (name === null) return [unreadable('ts-register-tool', 'name_not_literal')];
      const body = args[1] ? objectBody(args[1]) : null;
      return [found('ts-register-tool', name, 'literal', body !== null ? fromObjectFields(fields(body)) : {})];
    }
    case 'ts-add-tool': {
      const body = args[0] ? objectBody(args[0]) : null;
      if (body === null) return [unreadable('ts-add-tool', 'argument_not_literal')];
      const map = fields(body);
      const name = map.get('name') ? literalString(map.get('name')) : null;
      return name === null ? [unreadable('ts-add-tool', 'name_not_literal')] : [found('ts-add-tool', name, 'literal', fromObjectFields(map))];
    }
    case 'ts-list-tools-handler': {
      const open = m.text.indexOf('(');
      const inner = open < 0 ? null : balanced(m.text, open);
      const handler = inner === null ? '' : inner.slice(inner.indexOf(',') + 1);
      return tsListHandler(handler, m.fileText);
    }
    default: return [];
  }
}

// ----------------------------------------------------------------------------------------------- Python

function pyKwargs(args) {
  const map = new Map();
  const positional = [];
  for (const a of args) {
    const k = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (k) map.set(k[1], k[2].trim()); else positional.push(a);
  }
  return { map, positional };
}

function pyAnnotations(src) {
  if (!src) return null;
  const body = objectBody(src);
  if (body !== null) return annotationsOf(fields(body));
  const call = /^[\w.]*(?:ToolAnnotations|Annotations)\s*\(/.exec(src.trim());
  if (call) return annotationsOf(new Map([...pyKwargs(callArgs(src)).map]));
  return null;
}

/** The first string literal in a function body (its docstring): the text after the `:` that ends the def line. */
function pyDocstring(after, defAt) {
  const colon = (() => {
    let depth = 0;
    for (let i = defAt; i < after.length; i++) {
      const c = after[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) return i;
      else if (c === '\n' && depth === 0 && !/\\$/.test(after.slice(0, i))) return -1;
    }
    return -1;
  })();
  if (colon < 0) return null;
  const rest = after.slice(colon + 1);
  const m = /^\s*(?:#[^\n]*\n\s*)*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/.exec(rest);
  if (!m) return null;
  const v = literalString(m[1]);
  if (v === null) return null;
  const lines = v.replace(/\t/g, '        ').split('\n');
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), Infinity);
  return [lines[0].trim(), ...lines.slice(1).map((l) => (Number.isFinite(indent) ? l.slice(indent) : l))].join('\n').trim();
}

function extractPython(m) {
  const id = m.ruleId;
  if (id === 'py-tool-decorator') {
    const args = m.text.includes('(') ? callArgs(m.text, { hash: true }) : [];
    const { map } = pyKwargs(args);
    const defM = /^\s*(?:(?:@[^\n]*|#[^\n]*)\n\s*)*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(m.after);
    let name = null;
    let source = 'literal';
    if (map.has('name')) { name = literalString(map.get('name')); if (name === null) return [unreadable(id, 'name_not_literal')]; }
    else if (args.length && !/^[A-Za-z_]\w*\s*=/.test(args[0])) { name = literalString(args[0]); if (name === null) return [unreadable(id, 'name_not_literal')]; }
    else if (defM) { name = defM[1]; source = 'function_name'; }
    if (name === null) return [unreadable(id, 'no_function')];
    let description = map.has('description') ? literalString(map.get('description')) : null;
    if (description === null && !map.has('description') && defM) description = pyDocstring(m.after, defM.index + defM[0].length);
    return [found(id, name, source, { description, annotations: pyAnnotations(map.get('annotations')) })];
  }
  if (id === 'py-tool-type') {
    const { map } = pyKwargs(callArgs(m.text, { hash: true }));
    if (!map.has('inputSchema') && !map.has('input_schema')) return [];
    const name = map.has('name') ? literalString(map.get('name')) : null;
    if (name === null) return [unreadable(id, 'name_not_literal')];
    return [found(id, name, 'literal', { description: map.has('description') ? literalString(map.get('description')) : null, annotations: pyAnnotations(map.get('annotations')) })];
  }
  if (id === 'py-add-tool' || id === 'py-tool-from-function') {
    const { map, positional } = pyKwargs(callArgs(m.text, { hash: true }));
    if (map.has('name')) {
      const name = literalString(map.get('name'));
      return name === null ? [unreadable(id, 'name_not_literal')] : [found(id, name, 'literal', { description: map.has('description') ? literalString(map.get('description')) : null, annotations: pyAnnotations(map.get('annotations')) })];
    }
    const fn = positional[0] && /^[A-Za-z_]\w*$/.test(positional[0]) ? positional[0] : null;
    return fn ? [found(id, fn, 'function_name', {})] : [unreadable(id, 'name_not_literal')];
  }
  return [];
}

// ----------------------------------------------------------------------------------------------- Go

/** Constants and string variables of the repository's Go files: `Name = "lit"`, `const Name = "lit"`, `var Name = "lit"`. */
export function goConstants(texts) {
  const out = new Map();
  const re = /^\s*(?:(?:const|var)\s+)?([A-Za-z_]\w*)(?:\s+string)?\s*=\s*("(?:[^"\\\n]|\\.)*"|`[^`]*`)\s*$/gm;
  for (const t of texts) for (const m of t.matchAll(re)) { const v = literalString(m[2]); if (v !== null) out.set(m[1], out.has(m[1]) && out.get(m[1]) !== v ? null : v); }
  return out;
}

const GO_HINT_FUNCS = { WithReadOnlyHintAnnotation: 'readOnlyHint', WithDestructiveHintAnnotation: 'destructiveHint', WithIdempotentHintAnnotation: 'idempotentHint', WithOpenWorldHintAnnotation: 'openWorldHint' };
function goAnnotations(text) {
  const out = {};
  for (const [fn, key] of Object.entries(GO_HINT_FUNCS)) {
    const m = new RegExp(fn + '\\(\\s*(true|false)\\s*\\)').exec(text);
    if (m) out[key] = m[1] === 'true';
  }
  const t = /WithTitleAnnotation\(\s*("(?:[^"\\\n]|\\.)*")\s*\)/.exec(text);
  if (t) out.title = literalString(t[1]);
  for (const key of ['ReadOnlyHint', 'DestructiveHint', 'IdempotentHint', 'OpenWorldHint']) {
    const m = new RegExp('\\b' + key + '\\s*:\\s*(?:mcp\\.ToBoolPtr\\(\\s*|ptr\\(\\s*|boolPtr\\(\\s*|&)?(true|false)\\b').exec(text);
    if (m) out[key[0].toLowerCase() + key.slice(1)] = m[1] === 'true';
  }
  return Object.keys(out).length ? out : null;
}
const goDescription = (text) => {
  const m = /WithDescription\(\s*("(?:[^"\\\n]|\\.)*"|`[^`]*`)\s*\)/.exec(text);
  return m ? literalString(m[1]) : null;
};

function extractGo(m, ctx) {
  const id = m.ruleId;
  if (id === 'go-new-tool' || id === 'go-new-tool-raw') {
    const args = callArgs(m.text);
    const first = args[0] ?? '';
    let name = literalString(first);
    let source = 'literal';
    if (name === null && /^[A-Za-z_][\w.]*$/.test(first)) {
      const c = ctx.constants.get(first.split('.').pop());
      if (typeof c === 'string') { name = c; source = 'const'; }
    }
    if (name === null) return [unreadable(id, 'name_not_literal')];
    return [found(id, name, source, { description: goDescription(m.text), annotations: goAnnotations(m.text) })];
  }
  if (id === 'go-tool-literal') {
    const body = objectBody(m.text.replace(/^&\s*/, ''));
    if (body === null) return [unreadable(id, 'literal_not_read')];
    const map = fields(body);
    if (!map.has('Name') && !map.has('InputSchema') && !map.has('Description')) return [];
    const n = map.get('Name');
    let name = n ? literalString(n) : null;
    let source = 'literal';
    if (name === null && n && /^[A-Za-z_][\w.]*$/.test(n)) { const c = ctx.constants.get(n.split('.').pop()); if (typeof c === 'string') { name = c; source = 'const'; } }
    if (name === null) return n === undefined ? [] : [unreadable(id, 'name_not_literal')];
    return [found(id, name, source, { description: map.get('Description') ? literalString(map.get('Description')) : null, annotations: goAnnotations(m.text) })];
  }
  if (id === 'go-register-tool') {
    const args = callArgs(m.text);
    const name = literalString(args[0] ?? '');
    return name === null ? [unreadable(id, 'name_not_literal')] : [found(id, name, 'literal', { description: literalString(args[1] ?? '') })];
  }
  if (id === 'go-add-tool') return [{ idiom: id, site: true }];
  return [];
}

// ----------------------------------------------------------------------------------------------- Rust

function rustAnnotations(map, text) {
  const out = {};
  const m = /annotations\s*\(([\s\S]*)\)/.exec(text);
  if (m) for (const [k, v] of fields(m[1], { sep: '=' })) { const key = k.replace(/_hint$/, '').replace(/_/g, '').toLowerCase(); const canon = key === 'readonly' ? 'readOnlyHint' : key === 'destructive' ? 'destructiveHint' : key === 'idempotent' ? 'idempotentHint' : key === 'openworld' ? 'openWorldHint' : key === 'title' ? 'title' : null; if (!canon || v === null) continue; if (canon === 'title') { const t = literalString(v); if (t !== null) out.title = t; } else { const b = literalBool(v); if (b !== null) out[canon] = b; } }
  return Object.keys(out).length ? out : null;
}

function extractRust(m) {
  const id = m.ruleId;
  if (id === 'rs-tool-attribute') {
    const inner = /^#\[\s*(?:\w+::)*(tool|mcp_tool)\b([\s\S]*)\]$/.exec(m.text.trim());
    const kind = inner ? inner[1] : 'tool';
    const open = m.text.indexOf('(');
    const args = open >= 0 ? splitTop(balanced(m.text, open) ?? '').filter((x) => x !== '') : [];
    const map = new Map();
    for (const a of args) { const k = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a); if (k) map.set(k[1], k[2].trim()); }
    let name = null;
    let source = 'literal';
    if (map.has('name')) { name = literalString(map.get('name')); if (name === null) return [unreadable(id, 'name_not_literal')]; }
    else if (kind === 'tool') {
      // rmcp: the tool is named after the function the attribute is on
      const fn = /^\s*(?:(?:#\[[^\]]*\]|\/\/\/[^\n]*|\/\/![^\n]*|\/\/[^\n]*)\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/.exec(m.after);
      if (!fn) return [unreadable(id, 'no_function')];
      name = fn[1]; source = 'function_name';
    } else return [unreadable(id, 'name_not_literal')];
    return [found(id, name, source, { description: map.has('description') ? literalString(map.get('description')) : null, annotations: rustAnnotations(map, m.text) })];
  }
  if (id === 'rs-tool-new') {
    const args = callArgs(m.text);
    const name = literalString(args[0] ?? '');
    return name === null ? [unreadable(id, 'name_not_literal')] : [found(id, name, 'literal', { description: literalString(args[1] ?? '') })];
  }
  return [];
}

// ----------------------------------------------------------------------------------------------- C#

function extractCsharp(m) {
  const id = m.ruleId;
  // m.text is the attribute without its brackets: McpServerTool or McpServerTool(Name = "x", ReadOnly = true)
  const map = new Map();
  if (m.text.includes('(')) for (const a of callArgs(m.text)) { const k = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a); if (k) map.set(k[1], k[2].trim()); }
  // The method: what follows the attribute lists, up to its parameter list.
  let rest = m.after;
  let skipped = 0;
  let inList = true; // the attribute found sits inside a list: [McpServerTool, Description("..")]
  const eat = (n) => { rest = rest.slice(n); skipped += n; };
  for (let guard = 0; guard < 60; guard++) {
    eat(/^[\s,]*/.exec(rest)[0].length);
    if (inList) {
      if (rest.startsWith(']')) { eat(1); inList = false; continue; }
      const a = /^[A-Za-z_][\w.]*(?:<[^<>]*>)?/.exec(rest);
      if (!a) break;
      eat(a[0].length);
      const t = rest.replace(/^\s*/, '');
      if (t.startsWith('(')) { const inner = balanced(t, 0); if (inner === null) break; eat(rest.length - t.length + inner.length + 2); }
      continue;
    }
    if (rest.startsWith('[')) { const inner = balanced(rest, 0); if (inner === null) break; eat(inner.length + 2); continue; }
    break;
  }
  const head = /^([^(){};=]*?)\(/.exec(rest);
  const ident = head ? /([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*$/.exec(head[1]) : null;
  let name = null;
  let source = 'literal';
  if (map.has('Name')) { name = literalString(map.get('Name')); if (name === null) return [unreadable(id, 'name_not_literal')]; }
  else if (ident) { name = snake(ident[1].replace(/Async$/, '')); source = 'derived'; }
  else return [unreadable(id, 'no_method')];
  // [Description("..")] in the same attribute lists or the ones before the method
  const region = m.before.slice(Math.max(m.before.lastIndexOf('\n\n'), m.before.length - 800)) + m.text + m.after.slice(0, skipped + (head ? head[0].length : 0));
  const d = /\bDescription\(\s*("(?:[^"\\\n]|\\.)*"|@"[^"]*")\s*\)/.exec(region);
  const ann = {};
  for (const [k, v] of map) { const key = ({ ReadOnly: 'readOnlyHint', Destructive: 'destructiveHint', Idempotent: 'idempotentHint', OpenWorld: 'openWorldHint', Title: 'title' })[k]; if (!key) continue; if (key === 'title') { const t = literalString(v); if (t !== null) ann.title = t; } else { const b = literalBool(v); if (b !== null) ann[key] = b; } }
  return [found(id, name, source, { description: map.has('Description') ? literalString(map.get('Description')) : d ? literalString(d[1].replace(/^@/, '')) : null, annotations: Object.keys(ann).length ? ann : null })];
}

// ----------------------------------------------------------------------------------------------- dispatch

export const LANGUAGE_OF_RULE = (ruleId) => (ruleId.startsWith('ts-') ? 'typescript' : ruleId.startsWith('py-') ? 'python' : ruleId.startsWith('go-') ? 'go' : ruleId.startsWith('rs-') ? 'rust' : ruleId.startsWith('cs-') ? 'csharp' : null);

/**
 * The records of one match. m: { ruleId, text, before, after, fileText } (before and after are the text around the
 * match; fileText the whole file). ctx: { constants } for Go. Each record is a tool { idiom, name, name_source,
 * description, annotations }, an { idiom, unreadable: reason }, or for Go AddTool calls an { idiom, site: true }.
 */
export function extractMatch(m, ctx = { constants: new Map() }) {
  switch (LANGUAGE_OF_RULE(m.ruleId)) {
    case 'typescript': return extractTs(m);
    case 'python': return extractPython(m);
    case 'go': return extractGo(m, ctx);
    case 'rust': return extractRust(m);
    case 'csharp': return extractCsharp(m);
    default: return [];
  }
}
