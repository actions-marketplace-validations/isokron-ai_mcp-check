// Which command runs a PyPI package's server.
//
// The sandbox runs `venv/bin/<entry>` after `pip install <package>`. With no entry it falls back to the package
// name, a guess that is often wrong: the console script a package declares frequently has another name (on 25 Nov
// 2026 that guess failed for 5 of the first 20 subjects, all exit 127). This reads the package's own declaration
// from its wheel, before anything is installed: `*.dist-info/entry_points.txt` [console_scripts]. A wheel that
// declares none but ships a top-level `<module>/__main__.py` runs as `python -m <module>`.
//
// The wheel is untrusted input read on the planner host: it is size-capped before and after download, only the
// central directory and one or two small members are read, every offset is bounds-checked, and inflation is capped.
// Nothing here ever executes package code. Any failure gives { entry_source } with no entry: the run then uses the
// old guess, and failureDetail keeps treating a guessed entry as our limit, never the server's fault (R-LP-39).

import { inflateRawSync } from 'node:zlib';

export const WHEEL_CAP = 30 * 1024 * 1024;
const JSON_CAP = 8 * 1024 * 1024;
const MEMBER_CAP = 256 * 1024;
const WHEEL_HOST = 'https://files.pythonhosted.org/';
// Same shape the sandbox accepts for an entry (mcp-surface-corpus src/targets.mjs BIN).
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

/** PEP 503 normalised name. */
export const normName = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');

async function getCapped(fetchImpl, url, { cap, accept, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept, 'user-agent': 'isokron-mcp-check-live-probe' }, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { error: 'fetch_failed' }; }
  if (!res.ok) return { error: res.status === 404 ? 'not_found' : 'http_' + res.status };
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) return { error: 'too_large' };
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); } catch { return { error: 'fetch_failed' }; }
  if (buf.length > cap) return { error: 'too_large' };
  return { buf };
}

/**
 * The members of a zip archive: [{ name, method, csize, usize, offset }], or null when it is not a zip this reads
 * (no end record, zip64, entries outside the buffer). Never throws.
 */
export function zipMembers(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) return null; // zip64: not read
  if (cdOff + cdSize > eocd) return null;
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) return null;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
    if (out.length > 50_000) return null;
  }
  return out;
}

/** One member's bytes (stored or deflated), at most `cap` bytes, or null. Never throws. */
export function zipRead(buf, m, cap = MEMBER_CAP) {
  try {
    if (!m || m.usize > cap || m.csize > buf.length) return null;
    if (m.offset + 30 > buf.length || buf.readUInt32LE(m.offset) !== 0x04034b50) return null;
    const start = m.offset + 30 + buf.readUInt16LE(m.offset + 26) + buf.readUInt16LE(m.offset + 28);
    if (start + m.csize > buf.length) return null;
    const data = buf.subarray(start, start + m.csize);
    if (m.method === 0) return data.length <= cap ? Buffer.from(data) : null;
    if (m.method === 8) return inflateRawSync(data, { maxOutputLength: cap });
    return null;
  } catch { return null; }
}

/** [console_scripts] of an entry_points.txt: [[name, target]] with names the sandbox accepts. */
export function consoleScripts(text) {
  const out = [];
  let inSection = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { inSection = sec[1].trim() === 'console_scripts'; continue; }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const target = line.slice(eq + 1).trim();
    if (BIN.test(name) && target) out.push([name, target.slice(0, 200)]);
  }
  return out.slice(0, 50);
}

/**
 * Pick the server's console script among those a package declares, or null when the choice is not clear.
 * Order: the one named like the package; the only one; the only one with "mcp" in its name; the only one named
 * like the package plus an mcp prefix or suffix (`<pkg>-mcp`, `mcp-<pkg>`, `<pkg>-mcp-server`, `mcp-server-<pkg>`).
 */
export function pickScript(scripts, pkg) {
  if (!scripts.length) return null;
  const want = normName(pkg);
  const exact = scripts.find(([n]) => normName(n) === want);
  if (exact) return exact[0];
  if (scripts.length === 1) return scripts[0][0];
  const mcp = scripts.filter(([n]) => /mcp/i.test(n));
  if (mcp.length === 1) return mcp[0][0];
  const named = new Set([want + '-mcp', 'mcp-' + want, want + '-mcp-server', 'mcp-server-' + want]);
  const affixed = scripts.filter(([n]) => named.has(normName(n)));
  if (affixed.length === 1) return affixed[0][0];
  return null;
}

/** The top-level module with a __main__.py to run as `python -m`, preferring the one named like the package. */
export function pickMainModule(names, pkg) {
  const mods = [...new Set(names.map((n) => /^([^/]+)\/__main__\.py$/.exec(n)).filter(Boolean).map((m) => m[1]))].filter((m) => MODULE.test(m));
  if (!mods.length) return null;
  const want = normName(pkg);
  return mods.find((m) => normName(m) === want) || (mods.length === 1 ? mods[0] : null);
}

/** The wheel to read among a release's files: a pure-Python one first, then the smallest. */
export function pickWheel(files) {
  const wheels = (Array.isArray(files) ? files : []).filter((f) => f && f.packagetype === 'bdist_wheel' && typeof f.url === 'string' && f.url.startsWith(WHEEL_HOST) && !f.yanked);
  if (!wheels.length) return null;
  const pure = wheels.filter((f) => /-none-any\.whl$/.test(String(f.filename || f.url)));
  const pool = pure.length ? pure : wheels;
  return [...pool].sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0];
}

/**
 * How to run a PyPI package: { entry, args_prefix?, entry_source, script_count? }.
 * entry_source: console_script | module_main | ambiguous | no_wheel | no_entry_point | wheel_unreadable | lookup_failed.
 * Only the first two set an entry; the rest leave the run on the package-name guess.
 */
export async function pypiEntry(pkg, version, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const url = 'https://pypi.org/pypi/' + encodeURIComponent(pkg) + (version && version !== 'latest' ? '/' + encodeURIComponent(version) : '') + '/json';
  const meta = await getCapped(fetchImpl, url, { cap: JSON_CAP, accept: 'application/json', timeoutMs });
  if (meta.error) return { entry_source: 'lookup_failed' };
  let j;
  try { j = JSON.parse(meta.buf.toString('utf8')); } catch { return { entry_source: 'lookup_failed' }; }
  const wheel = pickWheel(j && j.urls);
  if (!wheel) return { entry_source: 'no_wheel' };
  if (Number(wheel.size) > WHEEL_CAP) return { entry_source: 'wheel_unreadable' };
  const got = await getCapped(fetchImpl, wheel.url, { cap: WHEEL_CAP, accept: 'application/octet-stream', timeoutMs: timeoutMs * 3 });
  if (got.error) return { entry_source: got.error === 'too_large' ? 'wheel_unreadable' : 'lookup_failed' };
  const members = zipMembers(got.buf);
  if (!members) return { entry_source: 'wheel_unreadable' };
  // Exactly one top-level *.dist-info/entry_points.txt counts; anything else is not a wheel this trusts.
  const eps = members.filter((m) => /^[^/]+\.dist-info\/entry_points\.txt$/.test(m.name));
  if (eps.length > 1) return { entry_source: 'wheel_unreadable' };
  const scripts = eps.length ? consoleScripts((zipRead(got.buf, eps[0]) || Buffer.alloc(0)).toString('utf8')) : [];
  if (scripts.length) {
    const entry = pickScript(scripts, pkg);
    return entry ? { entry, entry_source: 'console_script', script_count: scripts.length } : { entry_source: 'ambiguous', script_count: scripts.length };
  }
  const mod = pickMainModule(members.map((m) => m.name), pkg);
  if (mod) return { entry: 'python', args_prefix: ['-m', mod], entry_source: 'module_main', script_count: 0 };
  return { entry_source: 'no_entry_point', script_count: 0 };
}
