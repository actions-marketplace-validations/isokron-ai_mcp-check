// How the live-probe lane runs an MCP Bundle (.mcpb, registry type `mcpb`): a zip archive with manifest.json at its
// root that names the server's runtime (server.type node, python, binary or uv) and how a client starts it
// (server.mcp_config: command, args, env, platform_overrides; ${__dirname}, ${HOME}, ${user_config.*} and the like).
//
// The planner reads the bundle here, before anything is installed, as untrusted data: downloaded from the GitHub release
// asset the registry lists (github.com and its two release-asset hosts only, every redirect checked, at most
// MCPB_MAX_BYTES, read as a stream), its sha256 checked against the registry's fileSha256 when there is one, the zip's
// central directory and its entry names checked, and only manifest.json (at most 1 MiB) and the first bytes of a binary
// read. Nothing of it runs on the planner. The launch it returns pins the bundle's sha256, so the sandbox
// (mcp-surface-corpus sandbox/mcpb-fetch.mjs) unpacks exactly these bytes.
//
// What a client would do, done the same way where we can and refused where we cannot: a required user_config value with
// no default is configuration we do not have (start_needs_config, ours), never a guessed value; an optional one with no
// default is left out with the flag it belongs to; a binary runs only when the manifest allows linux and the file is a
// linux/amd64 ELF; a manifest that names nothing runnable is the bundle's own lack.
import { createHash } from 'node:crypto';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import { zipMembers, zipRead } from './pypi-entry.mjs';

export const MCPB_MAX_BYTES = 200 * 1024 * 1024;
export const MCPB_HOSTS = Object.freeze(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
// The sandbox's own check of the URL (mcp-surface-corpus src/targets.mjs MCPB_URL).
export const MCPB_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/releases\/download\/[A-Za-z0-9._+@-]{1,128}\/[A-Za-z0-9._+@-]{1,200}$/;
const MANIFEST_CAP = 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Where the sandbox unpacks the bundle, and the server's home (mcp-surface-corpus: P.work/pkg, runEnv HOME). */
export const BUNDLE_DIR = '/work/pkg';
const HOME = '/tmp/home';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Names the sandbox owns (mcp-surface-corpus src/targets.mjs RESERVED_ENV); PYTHONPATH goes through launch.pythonpath.
const RESERVED_ENV = /^(PATH|HOME|TMPDIR|LD_[A-Z_]+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PYTHON(PATH|HOME|STARTUP)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|DOCKER_.*|GITHUB_.*|ACTIONS_.*|RUNNER_.*|SURFACE_.*|CORPUS_.*)$/i;
const BUNDLE_PATH = /^(?![/.])(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ /-]{1,300}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
/** Launchers a client would find on the user's machine: never a bundle's own binary (R-LP-72). */
const LAUNCHERS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'docker', 'podman', 'uvx', 'pipx', 'env', 'java', 'dotnet', 'go', 'cargo', 'ruby', 'php', 'perl']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);

/** A URL the planner may fetch a bundle from: https, one of MCPB_HOSTS, the default port, no credentials. */
export function allowedUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && MCPB_HOSTS.includes(x.hostname) && !x.port && !x.username && !x.password ? x : null; } catch { return null; }
}

/**
 * The bundle's bytes: { buf, sha256 }. Throws { detail }: bundle_unavailable (github.com's own 404), rate_limited,
 * upstream_error (another failure of the host, retried), bundle_host_not_allowed (a redirect elsewhere), bundle_too_large.
 */
export async function fetchBundle(url, { fetch: fetchImpl = globalThis.fetch, cap = MCPB_MAX_BYTES, timeoutMs = 120_000 } = {}) {
  let u = allowedUrl(url);
  if (!u) throw fail('bundle_host_not_allowed');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try { res = await fetchImpl(u.href, { headers: { accept: 'application/octet-stream', 'user-agent': 'isokron-mcp-check-live-probe' }, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) }); } catch { throw fail('upstream_error'); }
    const get = (h) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(h) : null);
    if (res.status >= 300 && res.status < 400) {
      let next;
      try { next = new URL(String(get('location') || ''), u); } catch { throw fail('bundle_host_not_allowed'); }
      u = allowedUrl(next.href);
      if (!u) throw fail('bundle_host_not_allowed');
      continue;
    }
    // Only the release page's own 404 says the asset is not there; a 404 from a redirect target is not its answer.
    if (res.status === 404 && u.hostname === 'github.com') throw fail('bundle_unavailable');
    if (res.status === 429 || (res.status === 403 && String(get('x-ratelimit-remaining')) === '0')) throw fail('rate_limited');
    if (!res.ok) throw fail('upstream_error', { status: res.status });
    const len = Number(get('content-length'));
    if (Number.isFinite(len) && len > cap) throw fail('bundle_too_large');
    const parts = []; let total = 0;
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw fail('bundle_too_large'); }
          parts.push(Buffer.from(value));
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer());
        total = b.length;
        if (total > cap) throw fail('bundle_too_large');
        parts.push(b);
      }
    } catch (e) { if (e && e.detail) throw e; throw fail('upstream_error'); }
    const buf = Buffer.concat(parts, total);
    return { buf, sha256: createHash('sha256').update(buf).digest('hex') };
  }
  throw fail('bundle_host_not_allowed');
}

/** An entry name the sandbox would unpack (mcp-surface-corpus sandbox/mcpb-fetch.mjs safeEntryName), or null. */
export function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || /[\u0000-\u001f\u007f\\:]/.test(name) || name.startsWith('/')) return null;
  const segs = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (!segs.length || segs.length > 64 || segs.some((s) => s === '' || s === '.' || s === '..' || s.length > 255)) return null;
  return segs.join('/');
}

/** The manifest and the member list of a bundle's bytes. Throws { detail }. */
export function readBundle(buf) {
  const members = zipMembers(buf);
  if (!members) {
    // No zip record at all: the file is no archive (a bare binary, a tarball). A zip we do not read (zip64) is ours.
    if (buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) < 0 && buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < 0) throw fail('bundle_invalid', { why: 'not_a_zip' });
    throw fail('bundle_unreadable', { why: 'zip' });
  }
  const names = new Set();
  for (const m of members) {
    const n = safeName(m.name);
    if (!n) {
      // Only a name that leaves the bundle (absolute, or a .. segment) is the bundle's own fault; one our rules merely do
      // not take (a backslash, a colon, a control character, our length and depth limits) is ours.
      const escapes = typeof m.name === 'string' && (m.name.startsWith('/') || m.name.split(/[/\\]/).includes('..'));
      throw fail(escapes ? 'bundle_invalid' : 'bundle_unreadable', { why: 'unsafe_path' });
    }
    names.add(n);
  }
  const mf = members.find((m) => m.name === 'manifest.json');
  if (!mf) throw fail('package_not_runnable', { why: 'no_manifest' });
  if (mf.usize > MANIFEST_CAP) throw fail('bundle_unreadable', { why: 'manifest_too_large' });
  const raw = zipRead(buf, mf, MANIFEST_CAP);
  if (!raw) throw fail('bundle_unreadable', { why: 'manifest' });
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch { throw fail('package_not_runnable', { why: 'manifest_not_json' }); }
  if (!isObj(manifest)) throw fail('package_not_runnable', { why: 'manifest_not_object' });
  return { manifest, members, names };
}

/** The first bytes of a member (at most 4 KiB of its compressed data inflated), or null. Never throws. */
export function memberHead(buf, m, want = 64) {
  try {
    if (m.offset + 30 > buf.length || buf.readUInt32LE(m.offset) !== 0x04034b50) return null;
    const start = m.offset + 30 + buf.readUInt16LE(m.offset + 26) + buf.readUInt16LE(m.offset + 28);
    const data = buf.subarray(start, Math.min(buf.length, start + Math.min(m.csize, 4096)));
    if (m.method === 0) return Buffer.from(data.subarray(0, want));
    if (m.method === 8) return inflateRawSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 }).subarray(0, want);
    return null;
  } catch { return null; }
}

/** Whether a member is a linux/amd64 ELF executable: ELF magic, 64-bit, machine x86-64. */
export function isLinuxAmd64(buf, member) {
  const head = memberHead(buf, member);
  return !!(head && head.length >= 20 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head.readUInt16LE(18) === 0x3e);
}

/**
 * One manifest value with the client's variables put in. `config` maps each user_config key to { value } (a string or a
 * list of strings), { missing: 'required' } or { missing: 'optional' }. Returns { value } or { missing } or { bad }.
 */
export function substitute(s, config) {
  if (typeof s !== 'string') return { bad: 'not a string' };
  const fixed = { __dirname: BUNDLE_DIR, HOME, DESKTOP: `${HOME}/Desktop`, DOCUMENTS: `${HOME}/Documents`, DOWNLOADS: `${HOME}/Downloads`, pathSeparator: '/', '/': '/' };
  let missing = null; let list = null; let bad = null;
  const out = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]{0,100}|\/)\}/g, (all, name) => {
    if (Object.prototype.hasOwnProperty.call(fixed, name)) return fixed[name];
    const m = /^user_config\.([A-Za-z0-9_-]{1,100})$/.exec(name);
    if (!m) { bad = 'unknown variable'; return ''; }
    const c = config[m[1]];
    if (!c) { missing = missing === 'required' ? missing : 'optional'; return ''; }
    if (c.missing) { if (c.missing === 'required' || missing !== 'required') missing = c.missing; return ''; }
    if (Array.isArray(c.value)) { if (all === s) list = c.value; return c.value.join(' '); }
    return c.value;
  });
  if (bad) return { bad };
  if (missing) return { missing };
  return list ? { value: list } : { value: out };
}

/** user_config as substitution values: defaults (themselves substituted), required ones with none, optional ones with none. */
export function configValues(userConfig) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(userConfig) ? userConfig : {}).slice(0, 100)) {
    if (!isObj(v)) continue;
    const d = v.default;
    const asText = (x) => (typeof x === 'string' ? substitute(x, {}).value ?? null : typeof x === 'number' || typeof x === 'boolean' ? String(x) : null);
    if (d !== undefined && d !== null) {
      const val = Array.isArray(d) ? d.map(asText).filter((x) => typeof x === 'string') : asText(d);
      if (val !== null && !(Array.isArray(val) && !val.length && d.length)) { out[k] = { value: val }; continue; }
    }
    out[k] = { missing: v.required === true ? 'required' : 'optional' };
  }
  return out;
}

/** The args with variables put in: a value that is missing (optional) is left out, with the flag right before it. */
function args(list, config) {
  const out = [];
  for (const a of Array.isArray(list) ? list.slice(0, 60) : []) {
    const r = substitute(a, config);
    if (r.bad) throw fail('launch_invalid', { why: 'mcp_config.args' });
    if (r.missing === 'required') throw fail('start_needs_config', { why: 'user_config' });
    if (r.missing) { if (out.length && /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out[out.length - 1]) && typeof a === 'string' && /^\$\{user_config\.[^}]+\}$/.test(a)) out.pop(); continue; }
    if (Array.isArray(r.value)) out.push(...r.value); else out.push(r.value);
  }
  if (out.length > 40 || out.some((x) => typeof x !== 'string' || !x.length || x.length > 2000 || /[\u0000\n\r]/.test(x))) throw fail('launch_invalid', { why: 'args' });
  return out;
}

/** A path the manifest gives (after substitution) as a path inside the bundle, or null. */
function inBundle(p) {
  if (typeof p !== 'string') return null;
  const rel = p === BUNDLE_DIR ? '.' : p.startsWith(BUNDLE_DIR + '/') ? p.slice(BUNDLE_DIR.length + 1).replace(/\/+$/, '') : null;
  if (rel === '.') return '.';
  return rel && BUNDLE_PATH.test(rel) ? rel : null;
}

/** `uv run [options] <target> [args]` as uv would run it in the bundle: { console } or { python: args }, extras, or null. */
export function uvRun(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'run') return null;
  const extras = []; let i = 1; let dir = null;
  const withValue = new Set(['--directory', '--project', '--extra', '--python', '-p', '--group']);
  const flags = new Set(['--frozen', '--locked', '--no-dev', '--no-editable', '--quiet', '-q', '--no-sync', '--isolated', '--no-project', '--all-extras', '--offline']);
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (flags.has(a)) continue;
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : withValue.has(a) ? [a, argv[++i]] : [null, null];
    if (!k) { if (a.startsWith('-')) return null; break; }
    if (typeof v !== 'string') return null;
    if (k === '--directory' || k === '--project') { if (!inBundle(v)) return null; dir = inBundle(v); }
    else if (k === '--extra') { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(v)) return null; extras.push(v); }
    // --python and --group: the sandbox's own interpreter, the project's default dependencies.
  }
  const rest = argv.slice(i);
  if (!rest.length) return null;
  const [t, ...more] = rest;
  const base = dir && dir !== '.' ? `${BUNDLE_DIR}/${dir}` : BUNDLE_DIR;
  if (/\.py$/.test(t)) return { python: [t.startsWith('/') ? t : `${base}/${t}`, ...more], extras, dir: dir || '.' };
  if (t === 'python' || t === 'python3') return { python: more, extras, dir: dir || '.' };
  if (BIN.test(t)) return { console: t, args: more, extras, dir: dir || '.' };
  return null;
}

/**
 * The sandbox launch for a bundle's manifest: { launch, info } or throws { detail }. `pkg` is the registry or seed
 * package (identifier: the URL; fileSha256), `bundle` what readBundle returned, `buf` its bytes, `sha256` their digest.
 */
export function bundleLaunch({ manifest, names, members }, { url, sha256, buf, transportArgs = [], env: declaredEnv = {} } = {}) {
  const server = isObj(manifest.server) ? manifest.server : null;
  if (!server) throw fail('package_not_runnable', { why: 'no_server' });
  const type = server.type;
  if (typeof type !== 'string') throw fail('package_not_runnable', { why: 'no_server_type' });
  if (!['node', 'python', 'binary', 'uv'].includes(type)) throw fail('bundle_runtime_unsupported', { why: 'server_type' });
  const compat = isObj(manifest.compatibility) ? manifest.compatibility : {};
  const platforms = Array.isArray(compat.platforms) ? compat.platforms.filter((p) => typeof p === 'string') : null;
  const linuxListed = !platforms || platforms.includes('linux');
  let mc = isObj(server.mcp_config) ? { ...server.mcp_config } : null;
  const over = mc && isObj(mc.platform_overrides) && isObj(mc.platform_overrides.linux) ? mc.platform_overrides.linux : null;
  if (over) mc = { ...mc, ...(over.command !== undefined ? { command: over.command } : {}), ...(over.args !== undefined ? { args: over.args } : {}), ...(over.env !== undefined ? { env: { ...(isObj(mc.env) ? mc.env : {}), ...(isObj(over.env) ? over.env : {}) } } : {}) };
  const entryPoint = typeof server.entry_point === 'string' ? server.entry_point.replace(/^\.\//, '') : null;
  // A uv bundle may leave mcp_config out: the host runs `uv run <entry_point>` in the bundle.
  if (!mc && type === 'uv' && entryPoint) mc = { command: 'uv', args: ['run', '--directory', '${__dirname}', entryPoint] };
  // An mcp_config-less node or python bundle: the runtime and the entry point, as the spec's examples write it.
  if (!mc && entryPoint && (type === 'node' || type === 'python')) mc = { command: type, args: [`\${__dirname}/${entryPoint}`] };
  if (!mc && entryPoint && type === 'binary') mc = { command: `\${__dirname}/${entryPoint}`, args: [] };
  if (!mc || typeof mc.command !== 'string' || !mc.command) throw fail('package_not_runnable', { why: 'no_command' });
  const config = configValues(manifest.user_config);
  const cmd = substitute(mc.command, config);
  if (cmd.bad || Array.isArray(cmd.value)) throw fail('launch_invalid', { why: 'mcp_config.command' });
  if (cmd.missing) throw fail('start_needs_config', { why: 'user_config' });
  const argv = [...args(mc.args, config), ...transportArgs];
  // Environment: literal or substituted values; a required one with no value is configuration we do not have.
  const env = { ...declaredEnv }; let pythonpath = null;
  for (const [k, v] of Object.entries(isObj(mc.env) ? mc.env : {}).slice(0, 60)) {
    const r = substitute(typeof v === 'number' || typeof v === 'boolean' ? String(v) : v, config);
    if (r.bad) throw fail('launch_invalid', { why: 'mcp_config.env' });
    // A list (a user_config with multiple) has no one way into a variable: left out, never guessed.
    if (Array.isArray(r.value)) continue;
    if (r.missing === 'required') throw fail('start_needs_config', { why: 'user_config' });
    if (r.missing) continue;
    if (k === 'PYTHONPATH') {
      const parts = r.value.split(/[:;]/).filter(Boolean).map(inBundle);
      if (parts.some((p) => p === null)) throw fail('launch_invalid', { why: 'PYTHONPATH outside the bundle' });
      pythonpath = parts.slice(0, 8);
      continue;
    }
    if (!ENV_NAME.test(k) || RESERVED_ENV.test(k) || r.value.length > 500 || /[\u0000\n\r]/.test(r.value)) continue;
    env[k] = r.value;
  }
  const c = cmd.value;
  const base = { kind: 'mcpb', url, sha256, workdir: '.', ...(Object.keys(env).length ? { env } : {}) };
  const scriptIn = (a) => { const rel = inBundle(a); return rel && rel !== '.' ? rel : null; };
  const needFile = (rel) => { if (rel && !names.has(rel)) throw fail('package_not_runnable', { why: 'entry_missing' }); };
  let launch;
  if (c === 'uv' || /\/uv$/.test(c)) {
    const u = uvRun(argv);
    if (!u) throw fail('bundle_runtime_unsupported', { why: 'uv_run' });
    if (u.dir !== '.') throw fail('bundle_runtime_unsupported', { why: 'uv_project_subfolder' });
    if (u.python) needFile(scriptIn(u.python[0]));
    if (!names.has('pyproject.toml')) {
      // No project: `uv run <script>` runs the script with no dependencies installed, as plain python does.
      if (!u.python) throw fail('package_not_runnable', { why: 'no_pyproject' });
      launch = { ...base, runtime: 'python', args: u.python, pythonpath: pythonpath ?? ['.'] };
    } else launch = { ...base, runtime: 'uv', args: u.python ?? u.args, ...(u.console ? { console: u.console } : {}), ...(u.extras.length ? { extras: u.extras.slice(0, 8) } : {}), pythonpath: pythonpath ?? ['.'] };
  } else if (c === 'node' || c === 'nodejs') {
    needFile(scriptIn(argv[0]));
    launch = { ...base, runtime: 'node', args: argv };
  } else if (c === 'python' || c === 'python3') {
    if (argv[0] !== '-m') needFile(scriptIn(argv[0]));
    launch = { ...base, runtime: 'python', args: argv, ...(pythonpath ? { pythonpath } : {}) };
  } else {
    // A binary: a file of the bundle (by ${__dirname}, or a path relative to the bundle), linux/amd64, and the manifest
    // must allow linux. Anything else the client would run (sh, npx, a path outside) is not ours to start.
    // A bare name (npx, sh, bash, bun, deno, docker, uvx ...) is a launcher on the user's machine, not a file of the
    // bundle: not ours to start, and no fault of the bundle. A shell stays refused even when the bundle ships one.
    if (LAUNCHERS.has(c.split('/').pop()) || (!c.includes('/') && !names.has(c))) throw fail('bundle_runtime_unsupported', { why: 'launcher' });
    const rel = c.startsWith('/') ? scriptIn(c) : BUNDLE_PATH.test(c) ? c : null;
    if (!rel) throw fail('bundle_runtime_unsupported', { why: 'command' });
    if (!names.has(rel)) throw fail(linuxListed ? 'package_not_runnable' : 'platform_unsupported', { why: 'binary_missing' });
    if (!linuxListed) throw fail('platform_unsupported', { why: 'platforms' });
    const m = members.find((x) => x.name === rel);
    if (!m || !isLinuxAmd64(buf, m)) throw fail('platform_unsupported', { why: 'not_linux_amd64' });
    launch = { ...base, runtime: 'binary', entry: rel, args: argv };
  }
  if (!launch.args.length) delete launch.args;
  // A crash is evidence against the bundle only where it runs as shipped: a node bundle (its node_modules) or a binary, on
  // a platform its manifest lists. A python or uv bundle runs on an environment we rebuilt (our Python, our pip install of
  // what we read from its pyproject; uv would also read a script's inline metadata), so its crash may be ours (R-LP-74).
  const crashNotEvidence = !linuxListed || launch.runtime === 'python' || launch.runtime === 'uv';
  return { launch, info: { server_type: type, runtime: launch.runtime, platform_unlisted: !linuxListed, crash_not_evidence: crashNotEvidence, manifest_version: typeof manifest.manifest_version === 'string' ? manifest.manifest_version.slice(0, 16) : typeof manifest.dxt_version === 'string' ? manifest.dxt_version.slice(0, 16) : null } };
}

/** The whole resolution of a registry or seed package of type mcpb: { launch, info } or throws { detail }. */
/** The pause before the release page's 404 is asked again (the tests set it to 0). */
export const RETRY = { ms: 3000 };

export async function mcpbLaunch(pkg, { fetch: fetchImpl = globalThis.fetch, transportArgs = [], env = {}, retryMs = RETRY.ms } = {}) {
  const url = typeof pkg.identifier === 'string' ? pkg.identifier.trim() : '';
  if (!MCPB_URL.test(url)) throw fail('bundle_host_not_allowed');
  const want = typeof pkg.fileSha256 === 'string' && /^[0-9a-f]{64}$/i.test(pkg.fileSha256) ? pkg.fileSha256.toLowerCase() : null;
  // The release page's 404 once more after a pause before it counts: an asset that is being replaced can be missing a moment.
  let got;
  try { got = await fetchBundle(url, { fetch: fetchImpl }); } catch (e) {
    if (!e || e.detail !== 'bundle_unavailable') throw e;
    await new Promise((r) => setTimeout(r, retryMs));
    got = await fetchBundle(url, { fetch: fetchImpl });
  }
  const { buf, sha256 } = got;
  // The registry vouches for these bytes; other bytes at that URL are the publisher's to explain.
  if (want && want !== sha256) throw fail('bundle_hash_mismatch');
  const b = readBundle(buf);
  const r = bundleLaunch(b, { url, sha256, buf, transportArgs, env });
  r.info.bytes = buf.length; r.info.sha256_from = want ? 'registry' : 'planner';
  return r;
}
