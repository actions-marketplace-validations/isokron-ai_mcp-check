// Input limits. Every tool argument that carries a tool list goes through readList() before the engine sees it.
export const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB of JSON per list
export const MAX_DEPTH = 64;              // nesting of objects and arrays
export const MAX_TOOLS = 2000;            // tools per list

export class InputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Iterative depth walk, so a hostile list cannot overflow the stack.
export function depthOf(value) {
  let max = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d > max) max = d;
    if (max > MAX_DEPTH) return max;
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) stack.push([v[k], d + 1]);
  }
  return max;
}

// Depth of a JSON text without parsing it (brackets outside strings), so deep text is refused before JSON.parse.
export function textDepth(text) {
  let d = 0, max = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { d++; if (d > max) { max = d; if (max > MAX_DEPTH) return max; } }
    else if (c === 125 || c === 93) d--;
  }
  return max;
}

const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';

// Accepts a tools/list answer as an object/array or as JSON text. Returns the JSON text for the engine.
export function readList(value, label) {
  let text;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_BYTES) throw new InputError('too_large', label + ' is ' + mib(bytes) + '; the limit is ' + mib(MAX_BYTES) + ' of JSON. Check a smaller page of tools/list.');
    const depth = textDepth(value);
    if (depth > MAX_DEPTH) throw new InputError('too_deep', label + ' nests deeper than ' + MAX_DEPTH + ' levels; the limit is ' + MAX_DEPTH + '.');
    text = value;
  } else if (value !== null && typeof value === 'object') {
    const depth = depthOf(value);
    if (depth > MAX_DEPTH) throw new InputError('too_deep', label + ' nests deeper than ' + MAX_DEPTH + ' levels; the limit is ' + MAX_DEPTH + '.');
    text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_BYTES) throw new InputError('too_large', label + ' is ' + mib(bytes) + ' as JSON; the limit is ' + mib(MAX_BYTES) + '. Check a smaller page of tools/list.');
  } else {
    throw new InputError('bad_type', label + ' must be the tools/list answer as a JSON object, array or string.');
  }
  return text;
}
