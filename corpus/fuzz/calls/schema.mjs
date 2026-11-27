/**
 * A small JSON Schema reader for the tools/call fuzz stage: input generation and output validation.
 * It knows the common keywords (type, enum, const, required, properties, additionalProperties, items, minimum,
 * maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems, pattern, anyOf, oneOf, allOf, default).
 * A keyword it does not know ($ref, if/then, patternProperties, ...) makes `validate` answer `unsupported`: the stage then
 * records the check as inconclusive and never blames the server for our own limit.
 */
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const KNOWN = new Set(['type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'anyOf', 'oneOf', 'allOf', 'default', 'description', 'title', '$schema', 'examples', 'format', 'uniqueItems', '$id']);

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
const typeOk = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @returns {{ok: boolean, unsupported?: string, errors: string[]}} */
export function validate(schema, value, path = '$') {
  const errors = [];
  let unsupported = null;
  const walk = (s, v, p) => {
    if (s === true || s === undefined) return;
    if (s === false) { errors.push(`${p}: no value is allowed`); return; }
    if (!isObj(s)) { unsupported ??= `${p}: schema is not an object`; return; }
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) unsupported ??= `${p}: keyword ${k}`;
    if (s.type !== undefined) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => typeOk(v, t))) { errors.push(`${p}: type ${typeOf(v)} is not ${ts.join('|')}`); return; }
    }
    if (s.enum !== undefined && !s.enum.some((e) => same(e, v))) errors.push(`${p}: not one of the enum values`);
    if (s.const !== undefined && !same(s.const, v)) errors.push(`${p}: not the const value`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: below minimum`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: above maximum`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push(`${p}: not above exclusiveMinimum`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) errors.push(`${p}: not below exclusiveMaximum`);
    }
    if (typeof v === 'string') {
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) errors.push(`${p}: shorter than minLength`);
      if (s.maxLength !== undefined && len > s.maxLength) errors.push(`${p}: longer than maxLength`);
      if (s.pattern !== undefined) { try { if (!new RegExp(s.pattern, 'u').test(v)) errors.push(`${p}: does not match pattern`); } catch { unsupported ??= `${p}: pattern`; } }
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: fewer than minItems`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: more than maxItems`);
      if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${p}: items are not unique`);
      if (s.items !== undefined) v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    }
    if (isObj(v)) {
      for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) errors.push(`${p}: missing required ${r}`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (Object.hasOwn(v, k)) walk(sub, v[k], `${p}.${k}`);
      if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
        for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties ?? {}, k)) {
          if (s.additionalProperties === false) errors.push(`${p}: unexpected property ${k}`);
          else walk(s.additionalProperties, v[k], `${p}.${k}`);
        }
      }
    }
    if (s.allOf) for (const sub of s.allOf) walk(sub, v, p);
    for (const key of ['anyOf', 'oneOf']) {
      if (!s[key]) continue;
      const hits = s[key].map((sub) => validate(sub, v, p));
      if (hits.some((h) => h.unsupported)) unsupported ??= `${p}: ${key} with an unsupported branch`;
      const n = hits.filter((h) => h.ok).length;
      if (key === 'anyOf' ? n < 1 : n !== 1) errors.push(`${p}: ${key} matched ${n} branch(es)`);
    }
  };
  walk(schema, value, path);
  return unsupported ? { ok: false, unsupported, errors } : { ok: errors.length === 0, errors };
}
