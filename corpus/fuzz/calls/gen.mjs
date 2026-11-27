/**
 * Input generation for the tools/call fuzz stage: from a tool's inputSchema, cases in four classes.
 *   valid     arguments that satisfy the schema (expect: accept)
 *   boundary  limits of the schema that still satisfy it, and edge values that satisfy it (expect: any: not a crash, a hang or a
 *             malformed answer; a refusal is allowed)
 *   invalid   arguments that violate the schema in one way each (expect: reject)
 *   oversize  a 1 MiB string in each string property that allows one, and one in an unknown property (expect: any)
 * `expect` says what the stage may demand of the answer (invariants.mjs). A schema keyword the generator does not know
 * yields no case for that keyword, never a wrong one. Generation is deterministic: no randomness.
 */
import { typeOf } from './schema.mjs';

export const OVERSIZE_BYTES = 1024 * 1024;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** One value that satisfies `s`, or undefined when the generator cannot make one. */
export function valid(s, depth = 0) {
  if (!isObj(s) || depth > 6) return undefined;
  if (s.const !== undefined) return clone(s.const);
  if (s.enum?.length) return clone(s.enum[0]);
  if (s.default !== undefined) return clone(s.default);
  if (s.examples?.length) return clone(s.examples[0]);
  if (s.anyOf?.length || s.oneOf?.length) return valid((s.anyOf ?? s.oneOf)[0], depth + 1);
  if (s.allOf?.length) return valid(s.allOf[0], depth + 1);
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') ?? s.type[0] : s.type;
  switch (t) {
    case 'string': return 'x'.repeat(Math.max(1, s.minLength ?? 1)).slice(0, Math.max(s.maxLength ?? 64, 0) || 1);
    case 'integer': { const lo = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : undefined); const hi = s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum - 1 : undefined); return lo ?? (hi !== undefined ? Math.min(1, hi) : 1); }
    case 'number': { const lo = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : undefined); return lo ?? (s.maximum !== undefined ? Math.min(1, s.maximum) : 1); }
    case 'boolean': return true;
    case 'null': return null;
    case 'array': { const n = Math.max(s.minItems ?? 0, 0); const item = s.items === undefined ? 'x' : valid(s.items, depth + 1); return item === undefined ? undefined : Array.from({ length: n }, () => clone(item)); }
    case 'object': case undefined: {
      if (t === undefined && s.properties === undefined && s.required === undefined) return undefined;
      const o = {};
      for (const k of s.required ?? []) { const v = valid(s.properties?.[k] ?? {}, depth + 1); if (v === undefined) return undefined; o[k] = v; }
      return o;
    }
    default: return undefined;
  }
}

const WRONG = { string: 123, integer: 'one', number: 'one', boolean: 'yes', array: 'not-an-array', object: 'not-an-object', null: 0 };

function wrongType(s) {
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  return t in WRONG ? WRONG[t] : undefined;
}

/**
 * @returns {{id: string, class: 'valid'|'boundary'|'invalid'|'oversize', expect: 'accept'|'reject'|'any', arguments: any}[]}
 */
export function generate(inputSchema) {
  const s = isObj(inputSchema) ? inputSchema : { type: 'object' };
  const base = valid({ ...s, type: s.type ?? 'object' });
  const cases = [];
  const add = (cls, id, args, expect) => cases.push({ id: `${cls}:${id}`, class: cls, expect, arguments: args });
  const props = isObj(s.properties) ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required : [];
  if (base !== undefined) add('valid', 'minimal', clone(base), 'accept');
  if (base === undefined) add('valid', 'empty-object', {}, required.length ? 'any' : 'accept');

  // boundary
  for (const [k, p] of Object.entries(props)) {
    if (!isObj(p) || base === undefined) continue;
    const put = (id, v) => add('boundary', `${k}-${id}`, { ...clone(base), [k]: v }, 'any');
    if (p.type === 'string' || (p.type === undefined && p.minLength !== undefined)) {
      put('empty', '');
      if (p.minLength !== undefined) put('minLength', 'x'.repeat(p.minLength));
      if (p.maxLength !== undefined && p.maxLength <= 100_000) put('maxLength', 'x'.repeat(p.maxLength));
      put('unicode', 'á\u{1F600}‮\u0000z');
    }
    if (p.type === 'integer' || p.type === 'number') {
      if (p.minimum !== undefined) put('minimum', p.minimum);
      if (p.maximum !== undefined) put('maximum', p.maximum);
      put('zero', 0);
      put('safe-int-max', Number.MAX_SAFE_INTEGER);
    }
    if (p.type === 'array') { put('empty', []); if (p.maxItems !== undefined && p.maxItems <= 1000) put('maxItems', Array.from({ length: p.maxItems }, () => clone(valid(p.items ?? {}) ?? 'x'))); }
  }
  add('boundary', 'empty-object', {}, required.length ? 'reject' : 'any');

  // invalid
  for (const r of required) {
    if (base === undefined) break;
    const a = clone(base); delete a[r];
    add('invalid', `missing-${r}`, a, 'reject');
  }
  for (const [k, p] of Object.entries(props)) {
    if (!isObj(p) || base === undefined) continue;
    const w = wrongType(p);
    if (w !== undefined) add('invalid', `wrong-type-${k}`, { ...clone(base), [k]: w }, 'reject');
    if (p.enum?.length) add('invalid', `not-in-enum-${k}`, { ...clone(base), [k]: '__not_in_enum__' }, 'reject');
  }
  if (s.additionalProperties === false && base !== undefined) add('invalid', 'unexpected-property', { ...clone(base), __unexpected__: 1 }, 'reject');
  add('invalid', 'arguments-is-array', [], 'reject');
  add('invalid', 'arguments-is-string', 'not-an-object', 'reject');

  // oversize: one 1 MiB string in each string property that allows it (at most three), and one big unknown property
  const big = 'A'.repeat(OVERSIZE_BYTES);
  const strings = Object.entries(props).filter(([, p]) => isObj(p) && p.type === 'string' && (p.maxLength === undefined || p.maxLength >= OVERSIZE_BYTES)).slice(0, 3);
  if (base !== undefined) for (const [k] of strings) add('oversize', `${k}-1MiB`, { ...clone(base), [k]: big }, 'any');
  add('oversize', 'unknown-property-1MiB', { ...(base !== undefined ? clone(base) : {}), __big__: big }, 'any');
  return cases;
}

export { typeOf };
