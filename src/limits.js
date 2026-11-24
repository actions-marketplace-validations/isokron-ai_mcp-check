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

/**
 * Bytes of JSON.stringify(value) (UTF-8), counted without building the text, and given up at `cap`: returns cap + 1
 * as soon as the count passes it. A list whose tools share one large object expands to far more than its source
 * (each use is written out again) and can be too large for one string; this never builds more than one value's
 * own key or string at a time.
 */
export function jsonBytesUpTo(value, cap) {
  let n = 0;
  const over = () => n > cap;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.length > cap) return cap + 1;
      n += Buffer.byteLength(JSON.stringify(v), 'utf8');
    } else if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      n += String(JSON.stringify(v)).length;
    } else if (v && typeof v === 'object' && typeof v.toJSON === 'function') {
      stack.push(v.toJSON());
    } else if (Array.isArray(v)) {
      n += 2 + Math.max(0, v.length - 1);
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i];
        stack.push(x === undefined || typeof x === 'function' || typeof x === 'symbol' ? null : x);
      }
    } else if (v && typeof v === 'object') {
      n += 2;
      let first = true;
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
        n += (first ? 0 : 1) + Buffer.byteLength(JSON.stringify(k), 'utf8') + 1;
        first = false;
        stack.push(x);
      }
    } else {
      n += 4; // null
    }
    if (over()) return cap + 1;
  }
  return n;
}

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
    // Measured before the text is built (R-SS-11): a list too large for one string is refused, not a RangeError.
    const bytes = jsonBytesUpTo(value, MAX_BYTES);
    if (bytes > MAX_BYTES) throw new InputError('too_large', label + ' is over ' + mib(MAX_BYTES) + ' as JSON; the limit is ' + mib(MAX_BYTES) + '. Check a smaller page of tools/list.');
    text = JSON.stringify(value);
  } else {
    throw new InputError('bad_type', label + ' must be the tools/list answer as a JSON object, array or string.');
  }
  return text;
}
