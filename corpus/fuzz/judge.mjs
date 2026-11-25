/**
 * The invariants of the fuzz stage and their pass/fail rules (corpus/FUZZ.md). Pure functions over what the stage
 * recorded (corpus/fuzz/run.mjs); nothing here touches a server.
 *
 * A result is { id, primitive, verdict, kind, fault, reproduced, sessions, evidence }.
 *   verdict   pass | fail | warn | na | inconclusive
 *   fault     'subject' only for a fail or warn the server's own bytes show and that holds up (see `attribute`);
 *             'tool' for everything our environment, our limits or a one-off observation could explain; null otherwise
 *   evidence  counts, hashes and code points only: a server's strings stay in the record's own raw/ file
 */
import { sha256 } from './session.mjs';

export const INVARIANTS = Object.freeze({
  'FZ-CAT-1': 'listing a catalog twice in one session gives the same catalog',
  'FZ-CAT-2': 'listing a catalog in two sessions gives the same catalog',
  'FZ-PAG-1': 'following nextCursor to the end yields every item exactly once',
  'FZ-PAG-2': 'a cursor used a second time gets an error or the page it first gave',
  'FZ-PAG-3': 'a cursor the server never issued gets a JSON-RPC error',
  'FZ-PAG-4': 'a cursor issued in another session gets an error or the page it first gave',
  'FZ-UNI-1': 'no identifier holds an invisible, control, format or ill-formed code point',
  'FZ-UNI-2': 'no two identifiers of one list are the same after Unicode normalisation and confusable folding',
  'FZ-UNI-3': 'every identifier is in Unicode normalisation form NFC',
  'FZ-UNI-4': 'no identifier mixes Latin letters with letters of a look-alike script',
});
/** Invariants that compare observations of a server that may legitimately change: they need a second, independent round. */
export const NEEDS_CONFIRMATION = Object.freeze(new Set(['FZ-CAT-1', 'FZ-CAT-2', 'FZ-PAG-1', 'FZ-PAG-2', 'FZ-PAG-3', 'FZ-PAG-4']));

// Test-only: the mutation check (R-FZ-11) switches one invariant off and shows its regression test then fails.
let MUTED = null;
export function setMutation(id) { MUTED = id; }
const muted = (id) => MUTED === id;

const res = (id, primitive, verdict, kind, evidence = {}, sessions = []) => ({ id, primitive, verdict, kind, fault: null, reproduced: null, sessions, evidence });
const complete = (t) => !!t && t.stop === 'end';
const items = (t) => t.pages.flatMap((p) => (p.ok && p.items ? p.items : []));
const keyOf = (i) => (i.name !== null ? i.name : i.uri);
const orderedHash = (t) => sha256(items(t).map((i) => i.h).join('\n'));
const setHash = (t) => sha256(items(t).map((i) => i.h).sort().join('\n'));
const pageHashes = (p) => (p && p.ok && p.items ? p.items.map((i) => i.h) : null);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const methodNotFound = (t) => !!t && t.pages.length > 0 && !t.pages[0].ok && t.pages[0].error && t.pages[0].error.code === -32601;

/** na / inconclusive for a traversal that is missing or did not finish. null when it is fine to compare. */
function usable(id, primitive, sessions, ...ts) {
  for (const t of ts) {
    if (!t) return res(id, primitive, 'na', 'not_listed', {}, sessions);
    if (methodNotFound(t)) return res(id, primitive, 'na', 'method_not_found', {}, sessions);
    if (!complete(t)) return res(id, primitive, 'inconclusive', 'incomplete_traversal', { stop: t.stop, pages: t.pages.length }, sessions);
  }
  return null;
}

function diff(a, b) {
  const ma = new Map(items(a).map((i) => [keyOf(i), i.h])); const mb = new Map(items(b).map((i) => [keyOf(i), i.h]));
  let added = 0; let removed = 0; let changed = 0;
  for (const [k, h] of mb) { if (!ma.has(k)) added++; else if (ma.get(k) !== h) changed++; }
  for (const k of ma.keys()) if (!mb.has(k)) removed++;
  return { added, removed, changed, count_a: items(a).length, count_b: items(b).length, hash_a: orderedHash(a), hash_b: orderedHash(b) };
}

function compare(id, primitive, a, b, sessions, kindContent, kindOrder) {
  if (muted(id)) return res(id, primitive, 'pass', 'muted', {}, sessions);
  const u = usable(id, primitive, sessions, a, b);
  if (u) return u;
  if (a.notified > 0 || b.notified > 0) return res(id, primitive, 'na', 'list_changed_announced', { notifications: a.notified + b.notified }, sessions);
  if (orderedHash(a) === orderedHash(b)) return res(id, primitive, 'pass', 'equal', { count: items(a).length, hash: orderedHash(a) }, sessions);
  if (setHash(a) === setHash(b)) return res(id, primitive, 'warn', kindOrder, diff(a, b), sessions);
  return res(id, primitive, 'fail', kindContent, diff(a, b), sessions);
}

export const judgeCat1 = (sess, primitive) => compare('FZ-CAT-1', primitive, ((sess.trav || {})[primitive] || [])[0], ((sess.trav || {})[primitive] || [])[1], [sess.label], 'content_unstable', 'order_unstable');
export const judgeCat2 = (a, b, primitive) => compare('FZ-CAT-2', primitive, ((a.trav || {})[primitive] || [])[0], ((b.trav || {})[primitive] || [])[0], [a.label, b.label], 'session_content_unstable', 'session_order_unstable');

export function judgePag1(sess, primitive) {
  const id = 'FZ-PAG-1'; const sessions = [sess.label];
  const t = ((sess.trav || {})[primitive] || [])[0];
  if (muted(id)) return res(id, primitive, 'pass', 'muted', {}, sessions);
  const u = usable(id, primitive, sessions, t);
  if (u) return u;
  if (t.pages.length < 2) return res(id, primitive, 'na', 'not_paginated', {}, sessions);
  const seen = new Map(); let dup = 0; const dupPages = [];
  t.pages.forEach((p, pi) => (p.items || []).forEach((i) => { const k = keyOf(i); if (k === null) return; if (seen.has(k)) { dup++; if (dupPages.length < 10) dupPages.push([seen.get(k), pi]); } else seen.set(k, pi); }));
  if (dup) return res(id, primitive, 'fail', 'duplicate_item', { duplicates: dup, first_and_again_on_pages: dupPages, pages: t.pages.length, items: items(t).length }, sessions);
  return res(id, primitive, 'pass', 'each_once', { pages: t.pages.length, items: items(t).length }, sessions);
}

/** A cursor replayed: an error, or the page it first gave, is fine. */
function replay(id, primitive, probe, sessions, kindOther) {
  if (muted(id)) return res(id, primitive, 'pass', 'muted', {}, sessions);
  if (!probe || !probe.original || !probe.replay) return res(id, primitive, 'na', 'no_cursor_issued', {}, sessions);
  const r = probe.replay;
  if (r.limit) return res(id, primitive, 'inconclusive', 'session_limited', { limit: r.limit }, sessions);
  if (!r.ok) return r.error && !r.malformed ? res(id, primitive, 'pass', 'rejected', { code: r.error.code }, sessions) : res(id, primitive, 'inconclusive', 'malformed_answer', {}, sessions);
  if (same(pageHashes(r), pageHashes(probe.original))) return res(id, primitive, 'pass', 'same_page', { items: r.items.length }, sessions);
  return res(id, primitive, 'fail', kindOther, { cursor_sha256: probe.cursor_sha256, first_page_items: probe.original.items.length, replay_items: r.items.length, first_hash: sha256(pageHashes(probe.original).join()), replay_hash: sha256(pageHashes(r).join()) }, sessions);
}
export const judgePag2 = (sess) => replay('FZ-PAG-2', (sess.probes && sess.probes.spent && sess.probes.spent.primitive) || 'tools', sess.probes && sess.probes.spent, [sess.label], 'spent_cursor_other_page');
export const judgePag4 = (a, b) => replay('FZ-PAG-4', (b.probes && b.probes.foreign && b.probes.foreign.primitive) || 'tools', b.probes && b.probes.foreign, [a.label, b.label], 'foreign_cursor_other_page');

export function judgePag3(sess) {
  const id = 'FZ-PAG-3'; const sessions = [sess.label];
  const list = (sess.probes && sess.probes.invented) || [];
  const primitive = list.length ? list[0].primitive : 'tools';
  if (muted(id)) return res(id, primitive, 'pass', 'muted', {}, sessions);
  if (!list.length) return res(id, primitive, 'na', 'not_paginated', {}, sessions);
  let worst = res(id, primitive, 'pass', 'rejected', { tried: list.length }, sessions);
  const rank = { pass: 0, na: 0, inconclusive: 1, warn: 2, fail: 3 };
  for (const p of list) {
    let r;
    if (p.replay.limit) r = res(id, primitive, 'inconclusive', 'session_limited', { limit: p.replay.limit, cursor_kind: p.cursor_kind }, sessions);
    else if (!p.replay.ok) r = p.replay.error && !p.replay.malformed ? res(id, primitive, 'pass', 'rejected', { code: p.replay.error.code, cursor_kind: p.cursor_kind }, sessions) : res(id, primitive, 'inconclusive', 'malformed_answer', { cursor_kind: p.cursor_kind }, sessions);
    else if (same(pageHashes(p.replay), pageHashes(p.first))) r = res(id, primitive, 'warn', 'cursor_ignored', { cursor_kind: p.cursor_kind, items: p.replay.items.length }, sessions);
    else r = res(id, primitive, 'fail', 'invented_cursor_accepted', { cursor_kind: p.cursor_kind, items: p.replay.items.length, replay_hash: sha256(pageHashes(p.replay).join()) }, sessions);
    if (rank[r.verdict] > rank[worst.verdict]) worst = r;
  }
  return worst;
}

// ------------------------------------------------------------------ Unicode

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]|(?! )\p{Zs}/u;
const cp = (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
/** The look-alikes that matter for a name: Cyrillic and Greek letters drawn like Latin ones. */
const CONFUSABLE = Object.freeze({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'һ': 'h', 'ӏ': 'l', 'ɡ': 'g', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'α': 'a', 'τ': 't', 'υ': 'u', 'κ': 'k', 'ϲ': 'c',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ǀ': 'l', 'Ι': 'I', '１': '1',
});
const stripIgnorable = (s) => s.replace(/[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\p{Cf}]/gu, '');
/** What a person or a client that normalises would take the identifier to be. */
export function skeleton(s) {
  return Array.from(stripIgnorable(String(s)).normalize('NFKC')).map((c) => CONFUSABLE[c] || c).join('');
}
const SCRIPT_LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}]/u;
const LATIN = /\p{Script=Latin}/u;

/** Identifier strings of one primitive's list, as { field, index, value }. */
function identifiers(primitive, t) {
  const out = [];
  items(t).forEach((i, index) => {
    if (typeof i.name === 'string') out.push({ field: 'name', index, value: i.name });
    if ((primitive === 'resources' || primitive === 'templates') && typeof i.uri === 'string') out.push({ field: 'uri', index, value: i.uri });
  });
  return out;
}

/**
 * The four Unicode invariants over what the sessions listed. Deterministic: the bytes are the server's own, read with
 * a strict UTF-8 decoder, so one sighting is evidence enough.
 */
export function judgeUnicode(sessions) {
  const found = { 'FZ-UNI-1': [], 'FZ-UNI-2': [], 'FZ-UNI-3': [], 'FZ-UNI-4': [] };
  const seen = new Set(); let lists = 0;
  const add = (id, rec) => { const key = id + '|' + rec.primitive + '|' + rec.field + '|' + rec.name_sha256 + '|' + rec.kind; if (!seen.has(key)) { seen.add(key); found[id].push(rec); } };
  for (const s of sessions) {
    if (s.invalid_utf8 > 0) add('FZ-UNI-1', { primitive: '*', field: '*', index: null, kind: 'invalid_utf8', codepoints: [], name_sha256: sha256('invalid_utf8:' + s.label), session: s.label, lines: s.invalid_utf8 });
    for (const primitive of Object.keys(s.trav || {})) {
      const t = (s.trav[primitive] || [])[0];
      if (!t || !t.pages.some((p) => p.ok)) continue;
      lists++;
      const ids = identifiers(primitive, t);
      for (const { field, index, value } of ids) {
        const base = { primitive, field, index, name_sha256: sha256(value), session: s.label };
        if (!value.isWellFormed()) { add('FZ-UNI-1', { ...base, kind: 'ill_formed', codepoints: [] }); continue; }
        const bad = Array.from(new Set(Array.from(value).filter((c) => INVISIBLE.test(c)).map(cp)));
        if (bad.length) add('FZ-UNI-1', { ...base, kind: 'invisible_or_control', codepoints: bad.slice(0, 8) });
        else if (value.includes('�')) add('FZ-UNI-1', { ...base, kind: 'replacement_char', codepoints: ['U+FFFD'], severity: 'warn' });
        if (value.normalize('NFC') !== value) add('FZ-UNI-3', { ...base, kind: 'not_nfc', codepoints: [] });
        if (LATIN.test(value) && SCRIPT_LOOKALIKE.test(value)) add('FZ-UNI-4', { ...base, kind: 'mixed_script', codepoints: Array.from(new Set(Array.from(value).filter((c) => SCRIPT_LOOKALIKE.test(c)).map(cp))).slice(0, 8) });
      }
      // Collisions: two different strings, one skeleton (a client that normalises sees one identifier).
      for (const field of ['name', 'uri']) {
        const groups = new Map();
        for (const x of ids.filter((y) => y.field === field)) { const k = skeleton(x.value); if (!groups.has(k)) groups.set(k, new Set()); groups.get(k).add(x.value); }
        for (const [, set] of groups) if (set.size > 1) add('FZ-UNI-2', { primitive, field, index: null, kind: 'collision', codepoints: Array.from(new Set(Array.from(set).join('').split('').filter((c) => c.charCodeAt(0) > 127).map(cp))).slice(0, 8), name_sha256: sha256(Array.from(set).sort().join('\u0000')), group: set.size, session: s.label });
        const folded = new Map();
        for (const x of ids.filter((y) => y.field === field)) { const k = skeleton(x.value).toLowerCase(); if (!folded.has(k)) folded.set(k, new Set()); folded.get(k).add(skeleton(x.value)); }
        for (const [, set] of folded) if (set.size > 1) add('FZ-UNI-2', { primitive, field, index: null, kind: 'collision_case', codepoints: [], name_sha256: sha256(Array.from(set).sort().join('\u0000')), group: set.size, session: s.label, severity: 'warn' });
      }
    }
  }
  const out = [];
  for (const id of Object.keys(found)) {
    if (muted(id)) { out.push(res(id, '*', 'pass', 'muted')); continue; }
    const list = found[id];
    if (!lists) { out.push(res(id, '*', 'na', 'not_listed')); continue; }
    if (!list.length) { out.push(res(id, '*', 'pass', 'clean', { lists })); continue; }
    const verdict = list.some((f) => f.severity !== 'warn') && id !== 'FZ-UNI-3' && id !== 'FZ-UNI-4' ? 'fail' : 'warn';
    const kinds = Array.from(new Set(list.map((f) => f.kind)));
    out.push(res(id, '*', verdict, kinds.join('+'), { count: list.length, findings: list.slice(0, 50) }, Array.from(new Set(list.map((f) => f.session)))));
  }
  return out;
}

// ------------------------------------------------------------------ one round, and the whole record

export const PRIMS = ['tools', 'prompts', 'resources', 'templates'];

/** Every session-dependent invariant over one round's two sessions. */
export function judgeRound(A, B) {
  const out = [];
  if (A && A.init && !A.init.ok) return [res('FZ-CAT-1', '*', 'inconclusive', 'initialize_failed', { limit: A.init.limit || null, code: A.init.error ? A.init.error.code : null }, [A.label])];
  if (A && B && B.init && !B.init.ok) out.push(res('FZ-CAT-2', '*', 'inconclusive', 'second_session_failed', { limit: B.init.limit || null }, [B.label]));
  for (const p of PRIMS) {
    if (A && A.trav && A.trav[p]) out.push(judgeCat1(A, p), judgePag1(A, p));
    if (A && B && A.trav && B.trav && A.trav[p] && B.trav[p]) out.push(judgeCat2(A, B, p));
  }
  if (A) out.push(judgePag2(A), judgePag3(A));
  if (A && B) out.push(judgePag4(A, B));
  return out;
}

const keyOfResult = (r) => r.id + '|' + r.primitive;

/**
 * Round 1 against round 2 (a fresh pair of sessions), and the fault side of every result.
 *  - a fail or warn the second round shows again (same invariant, same kind): reproduced, fault 'subject';
 *  - one it does not show: not reproduced, so unconfirmed: inconclusive, fault 'tool';
 *  - no second round (no time): unconfirmed, fault 'tool';
 *  - Unicode results are the server's own bytes, strictly decoded: fault 'subject' on the first sighting.
 * Never blames a server for what our own limit, a closed or timed-out session or a single observation explains.
 */
export function attribute(first, second, unicode) {
  const out = [];
  const again = new Map((second || []).map((r) => [keyOfResult(r), r]));
  for (const r of first) {
    const x = { ...r };
    if (x.verdict === 'fail' || x.verdict === 'warn') {
      if (!second) { x.reproduced = null; x.confirmation = 'not_run'; }
      else {
        const b = again.get(keyOfResult(x));
        x.reproduced = !!(b && b.verdict === x.verdict && b.kind === x.kind);
        x.confirmation = b ? (x.reproduced ? 'reproduced' : 'differs') : 'not_run';
        if (b && (b.verdict === 'inconclusive' || b.verdict === 'na')) { x.reproduced = null; x.confirmation = 'second_round_inconclusive'; }
      }
      if (x.reproduced === true) x.fault = 'subject';
      else { x.first_seen = { verdict: x.verdict, kind: x.kind }; x.verdict = 'inconclusive'; x.kind = 'unconfirmed_' + x.kind; x.fault = 'tool'; }
    } else if (x.verdict === 'inconclusive') x.fault = 'tool';
    out.push(x);
  }
  for (const u of unicode) { const x = { ...u }; if (x.verdict === 'fail' || x.verdict === 'warn') { x.fault = 'subject'; x.reproduced = null; x.confirmation = 'deterministic'; } out.push(x); }
  return out;
}

/** Counts of the verdicts, and how many results name the subject. */
export function summaryOf(results) {
  const by = { pass: 0, fail: 0, warn: 0, na: 0, inconclusive: 0 };
  for (const r of results) by[r.verdict]++;
  return { ...by, subject_findings: results.filter((r) => r.fault === 'subject').length };
}
