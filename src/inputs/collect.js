// Turns the CLI's input options into tool lists to grade. Each item is
//   { label, text }                       a file or stdin, graded as given
//   { label, data, source }               a fetched list: data is what the engine's parseData accepts
//   { label, error, code }                a server that could not be listed (code 'unreachable' or 'usage')
// Live inputs run or call the user's own servers from this machine; static inputs read published source or a local folder.
// Nothing is sent to IsoKron. Header values are never printed: notes name the headers only.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { capture, CaptureError, splitCommand } from '../capture.js';

const require = createRequire(import.meta.url);
const Client = require('./mcp-client.cjs');
const Config = require('./mcp-config.cjs');
const Repo = require('./repo-source.cjs');

export class InputFailure extends Error {
  /** code: 'unreachable' (exit 3) or 'usage' (exit 2) */
  constructor(message, code = 'unreachable', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** One line of text from a server or a file, safe to print: no control characters, bounded length. */
export const line = (s, n = 300) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, n);

/** "$TOKEN" / "${TOKEN}" in a header value is read from the environment, so secrets stay out of shell history. */
export function expandEnv(v, env = process.env) {
  return v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, n) => (env[n] !== undefined ? env[n] : m));
}

export const FIDELITY = {
  exact: (c) => 'exact: ' + (c.kind === 'snapshots' ? 'committed tool snapshots' : c.kind === 'mcpb' ? 'MCPB manifest static tools/list' : c.kind === 'catalog' ? 'committed mcp-catalog-snap snapshot ' + c.path + (c.foreign ? ' of ' + line(c.server || 'an unnamed server', 100) + ', which may not be this repository\'s server' : '') : 'committed tool list ' + c.path),
  literal: () => 'literal: tool definitions written as literals in the source',
  derived: () => 'derived: reproduced from SDK registrations in the source; schemas follow the SDK\'s output and may differ in detail',
  names: () => 'names only: an MCPB manifest lists names and descriptions; schema checks do not apply',
};

/** The provenance of a repository list: its fidelity, then the tools left out as off by default and the ones kept under a condition. */
export function repoProvenance(c) {
  const left = Array.isArray(c.excluded) ? c.excluded : [];
  const cond = (Array.isArray(c.marked) ? c.marked : []).filter((m) => !m.excluded && m.reasons.some((x) => /^conditional-/.test(x)));
  const reasons = [...new Set(left.flatMap((x) => x.reasons.map((y) => y.replace(/ \(.*$/, ''))))];
  const extra = (left.length ? '; ' + left.length + ' tool' + (left.length === 1 ? '' : 's') + ' left out (' + reasons.join(', ') + ')' : '') + (cond.length ? '; ' + cond.length + ' kept but registered under a condition' : '');
  return { provenance: FIDELITY[c.fidelity](c) + extra, left, cond };
}

const withDeadline = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Client.McpFetchError('timeout', what + ' did not finish within the time limit of ' + Math.round(ms / 1000) + ' s.')), ms); })]).finally(() => clearTimeout(t));
};

function mapCapture(e) {
  if (e instanceof CaptureError) {
    if (e.code === 'usage') return new InputFailure(e.message, 'usage');
    return new InputFailure(e.message, 'unreachable', { stderr: e.stderr || '' });
  }
  return e;
}

async function fromStdio(argv, opt, extra = {}) {
  try {
    const r = await capture(argv, { timeoutMs: opt.timeout * 1000, cwd: extra.cwd, extraEnv: extra.env || null, stderr: opt.serverStderr === false ? null : process.stderr });
    return { data: r.answers, source: { kind: 'stdio', command: argv.join(' '), era: r.era, protocolVersion: r.protocolVersion, serverInfo: r.serverInfo } };
  } catch (e) { throw mapCapture(e); }
}

async function fromUrl(url, headers, opt, { requireHttps = false } = {}) {
  if (requireHttps && !/^https:\/\//i.test(url)) throw new InputFailure('only https URLs from the registry are used: ' + line(url), 'unreachable');
  try {
    // With headers set, redirects are refused, so a header value never goes to a host it was not meant for.
    const r = await withDeadline(Client.listToolsHttp(url, { headers, protocol: opt.protocol, timeoutMs: Math.min(opt.timeout, 30) * 1000, redirect: Object.keys(headers).length ? 'error' : 'follow' }), opt.timeout * 1000, 'Listing tools at ' + url);
    return { data: r.pages, source: { kind: 'http', url: r.url, era: r.era, protocolVersion: r.protocolVersion, serverInfo: r.serverInfo } };
  } catch (e) {
    if (e instanceof Client.McpFetchError) {
      const code = e.code === 'bad_url' ? 'usage' : 'unreachable';
      throw new InputFailure(e.message.replace(/ In a browser this usually means[\s\S]*$/, ''), code, { auth: e.code === 'auth' });
    }
    throw e;
  }
}

async function fromRepo(ref, opt, via = null) {
  const token = opt.githubTokenEnv ? process.env[opt.githubTokenEnv] : undefined;
  if (opt.githubTokenEnv && !token) throw new InputFailure('--github-token-env ' + opt.githubTokenEnv + ' is not set in the environment', 'usage');
  let r;
  try { r = await withDeadline(Repo.fromGitHub(ref, { githubToken: token }), opt.timeout * 1000, 'Reading ' + ref); } catch (e) {
    if (e && /Not a GitHub repository URL/.test(e.message)) throw new InputFailure(e.message + ' Use github.com/owner/repo.', 'usage');
    throw new InputFailure('could not read ' + line(ref) + ': ' + line(e.message), 'unreachable');
  }
  const parsed = Repo.parseRepoRef(ref) || {};
  const where = r.repo + (parsed.subdir ? '/' + parsed.subdir : '');
  const pick = (folder) => '--repo github.com/' + r.repo + '/tree/' + (parsed.ref || String(r.sha || 'HEAD')) + '/' + folder;
  const c = cliUsable(r, line(where), pick);
  const { provenance, left, cond } = repoProvenance(c);
  return { data: c.tools, source: { kind: 'repo', repo: r.repo, sha: r.sha, via: r.via, fidelity: c.fidelity, approximate: isApproximate(c), provenance, from: c.kind, files: c.files || [c.path], ...(left.length ? { left_out: left.map((x) => ({ name: line(x.name, 128), reasons: x.reasons.map((y) => line(y, 160)) })) } : {}), ...(cond.length ? { conditional: cond.map((x) => line(x.name, 128)) } : {}), ...(via ? { registry: via } : {}) } };
}

/** The advice every "cannot grade this read" message ends with (the CLI's and the Action's names for the live inputs). */
export const LIVE_ADVICE = 'Grade the live list instead: start the server with --command "<start command>", or give a saved tools/list file '
  + '(in the GitHub Action: set command or tools-file).';

/** No tool definitions in a folder: the message names the live alternatives (the CLI's and the Action's). */
export function noToolsMessage(where, r) {
  return 'no tool definitions found in ' + where + ' (scanned ' + r.scanned.source + ' of ' + r.scanned.sourceTotal + ' source files, and the committed tool lists and MCPB manifests). ' + LIVE_ADVICE;
}

/** Snapshots of other servers that were found and not used (several, and no tool defined in the source). */
export function foreignNote(r) {
  const f = (r.hints && r.hints.foreignSnapshots) || [];
  return f.length ? ' Not used: ' + f.length + ' mcp-catalog-snap snapshots of other servers (' + f.map((x) => line(x.path, 200) + ': ' + line(x.server || 'unnamed', 100)).join(', ') + ').' : '';
}

/** A list read from source (literal or derived) is approximate; an exact committed list or snapshot is not. */
export const isApproximate = (c) => !!c && c.fidelity !== 'exact';
/** The words every surface uses for an approximate list. */
export const APPROXIMATE = 'approximate: read from source, not the server\'s live list';

/**
 * What a repository scan (RepoSource.fromGitHub / fromDirectory) gives to grade. Shared by the CLI and the Action, so
 * both decide the same way:
 *   { candidate }                       one list to grade
 *   { problem: 'none' }                 no tool definition found (or only in folders that are not the server)
 *   { problem: 'names', candidate }     only tool names (an MCPB manifest), which cannot be graded
 *   { problem: 'multiple' }             tools of more than one server (or several committed lists): nothing is merged or picked
 */
export function usableList(r) {
  const c = r.best;
  const multi = !!(r.hints && (r.hints.servers || r.hints.lists));
  if ((!c || c.fidelity === 'names') && multi) return { problem: 'multiple' };
  if (!c) return { problem: 'none' };
  if (c.fidelity === 'names') return { problem: 'names', candidate: c };
  return { candidate: c };
}

const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
/** The servers (or committed lists) a scan found, best first: "src/a (server constructor, 9 tools), src/b (3 tools)". */
export function serverChoices(r) {
  const h = r.hints || {};
  if (h.servers) return h.servers.map((x) => line(x.path || '.', 200) + ' (' + [x.constructor ? 'server constructor' : null, x.tools ? plural(x.tools, 'tool') : 'no tool read'].filter(Boolean).join(', ') + ')').join(', ');
  return (h.lists || []).map((x) => line(x.path, 200) + ' (' + plural(x.tools, 'tool') + ')').join(', ');
}
/** The folders to choose from, for the advice: package folders, or the folders of the committed lists. */
export function serverFolders(r) {
  const h = r.hints || {};
  if (h.servers) return h.servers.map((x) => x.path || '.');
  return Array.from(new Set((h.lists || []).map((x) => (x.path.includes('/') ? x.path.slice(0, x.path.lastIndexOf('/')) : '.'))));
}

/** Why nothing usable was found, beyond "no tool definitions": languages not read, folders set aside, lists not used. */
export function whyNothing(r) {
  const h = r.hints || {};
  let s = '';
  const lang = (h.otherLanguages || [])[0];
  if (lang && lang.files >= lang.readFiles) s += ' The source here is ' + lang.name + ' (' + plural(lang.files, '.' + ({ Go: 'go', Rust: 'rs', 'C#': 'cs', Java: 'java', Kotlin: 'kt', Ruby: 'rb', PHP: 'php', Swift: 'swift' }[lang.name] || lang.name) + ' file') + '): ' + lang.name + ' source is not read yet (the reader reads TypeScript, JavaScript and Python).';
  const ign = (h.ignoredFolders || []).filter((x) => x.tools);
  if (ign.length) s += ' Tool definitions were found only in folders that look like admin, console, docs, examples, evaluation or test code, which are not graded from a parent folder: ' + ign.map((x) => line(x.path, 200) + ' (' + plural(x.tools, 'tool') + ')').join(', ') + '; if one of them is the server, point the check at that folder.';
  if (h.serverWithoutTools) s += ' A server is constructed in ' + line(h.serverWithoutTools || '.', 200) + ', but none of its tools could be read.';
  if (h.lists) s += ' Not used: ' + plural(h.lists.length, 'committed tool list') + ' in different places (' + h.lists.map((x) => line(x.path, 200)).join(', ') + '); grade one by giving the file itself.';
  return s + foreignNote(r);
}

/** The CLI's reading of a scan: the candidate to grade, or an InputFailure (exit 3) with the same advice as the Action. */
function cliUsable(r, where, pick) {
  const u = usableList(r);
  if (u.problem === 'none') throw new InputFailure(noToolsMessage(where, r) + whyNothing(r), 'unreachable');
  if (u.problem === 'names') throw new InputFailure('only tool names were found in ' + where + ' (' + line(u.candidate.path, 200) + ' lists names and descriptions without schemas), which cannot be graded. ' + LIVE_ADVICE, 'unreachable');
  if (u.problem === 'multiple') {
    throw new InputFailure('found tool definitions of more than one server in ' + where + ': ' + serverChoices(r) + '. Nothing was merged or picked. '
      + 'Check one server at a time (' + serverFolders(r).slice(0, 3).map((f) => pick(f)).join(', ') + '), or ' + LIVE_ADVICE.charAt(0).toLowerCase() + LIVE_ADVICE.slice(1), 'unreachable');
  }
  return u.candidate;
}

/** A local checkout, read like --repo: no network, nothing run. */
async function fromRepoDir(dir, opt) {
  let r;
  try { r = await withDeadline(Repo.fromDirectory(dir), opt.timeout * 1000, 'Reading ' + dir); } catch (e) {
    if (e && e.code === 'not_found') throw new InputFailure(line(e.message), 'usage');
    throw new InputFailure('could not read ' + line(dir) + ': ' + line(e && e.message), 'unreachable');
  }
  const base = String(dir).replace(/\/+$/, '') || '.';
  const c = cliUsable(r, line(dir), (folder) => '--repo-dir ' + (folder === '.' ? base : base + '/' + folder));
  const { provenance, left, cond } = repoProvenance(c);
  return { data: c.tools, where: c.where || null, source: { kind: 'dir', dir: r.repo, fidelity: c.fidelity, approximate: isApproximate(c), provenance, from: c.kind, files: c.files || [c.path], ...(c.built ? { built: true } : {}), ...(r.truncated ? { truncated: true } : {}), ...(left.length ? { left_out: left.map((x) => ({ name: line(x.name, 128), reasons: x.reasons.map((y) => line(y, 160)) })) } : {}), ...(cond.length ? { conditional: cond.map((x) => line(x.name, 128)) } : {}) } };
}

async function fromRegistry(name, opt, note) {
  let s;
  try { s = await withDeadline(Repo.fromRegistry(name), opt.timeout * 1000, 'The registry lookup'); } catch (e) { throw new InputFailure('could not reach the MCP Registry: ' + line(e.message), 'unreachable'); }
  if (!s.found) throw new InputFailure('not in the MCP Registry: ' + line(name) + (s.similar.length ? '. Similar: ' + s.similar.map((x) => line(x, 100)).join(', ') : ''), 'unreachable');
  const via = { name: s.name, version: s.version || null };
  // Public streamable-http remotes first, plain URLs before "?login"-style variants; no user headers are sent.
  const remotes = Array.from(new Set(s.remotes.filter((x) => x.type === 'streamable-http' && !x.templated && !x.needsHeaders).map((x) => x.url)))
    .sort((a, b) => (a.includes('?') ? 1 : 0) - (b.includes('?') ? 1 : 0));
  let last = null;
  for (const u of remotes) {
    note('registry: ' + line(s.name) + ' ' + line(s.version || '') + ' -> remote ' + line(u));
    try {
      const got = await fromUrl(u, {}, opt, { requireHttps: true });
      got.source.registry = via;
      return got;
    } catch (e) { last = e; note(line(u) + ': ' + line(e.message)); }
  }
  const pkg = s.packages.find((p) => p.command && p.transport === 'stdio');
  if (s.repository && /^https:\/\/github\.com\//.test(s.repository.url)) {
    const repo = s.repository.url.replace(/\/$/, '') + (s.repository.subfolder ? '/tree/HEAD/' + s.repository.subfolder : '');
    note('registry: ' + line(s.name) + ' -> source ' + line(repo) + (pkg ? ' (to run it instead: mcp-check --command "' + line(pkg.command) + '")' : ''));
    return fromRepo(repo, opt, via);
  }
  if (last) throw last;
  if (pkg) throw new InputFailure('no public remote or GitHub source for ' + line(s.name) + '. Run it locally: mcp-check --command "' + line(pkg.command) + '"', 'unreachable');
  throw new InputFailure('no usable remote, package or repository in the registry entry for ' + line(s.name), 'unreachable');
}

function readConfigFile(path) {
  try { return readFileSync(path, 'utf8'); } catch (e) { throw new InputFailure('cannot read ' + path + ': ' + e.message, 'usage'); }
}

async function fromConfig(opt, note) {
  let files;
  if (opt.config === 'auto') {
    files = Config.knownConfigPaths(homedir(), process.platform, process.env.APPDATA, process.cwd()).filter((c) => existsSync(c.path));
    if (!files.length) throw new InputFailure('no MCP client config found in the usual places. Give the file: --config <path>.', 'usage');
  } else files = [{ client: 'config', path: opt.config }];
  const out = [];
  for (const f of files) {
    const cfg = Config.parseConfig(readConfigFile(f.path), { env: process.env });
    if (cfg.error) { if (opt.config !== 'auto') throw new InputFailure(f.path + ': ' + cfg.error, 'usage'); note(f.path + ': ' + cfg.error); continue; }
    for (const s of cfg.servers) {
      if (opt.server && s.name !== opt.server) continue;
      const label = f.client + ' / ' + line(s.name, 100);
      if (s.error) { out.push({ label, error: s.error, code: 'unreachable' }); continue; }
      if (s.disabled) { note(label + ': disabled in the config, skipped'); continue; }
      if (s.unresolved && s.unresolved.length) { out.push({ label, error: 'needs values this checker cannot fill: ' + s.unresolved.join(', '), code: 'unreachable' }); continue; }
      try {
        let got;
        if (s.transport === 'stdio') {
          note(label + ': starting ' + line([s.command].concat(s.args).join(' ')));
          got = await fromStdio([s.command].concat(s.args), opt, { env: s.env, cwd: s.cwd });
        } else if (s.transport === 'http') {
          const names = Object.keys(s.headers || {});
          note(label + ': ' + line(s.url) + (names.length ? ' (headers: ' + names.map((n) => line(n, 60)).join(', ') + ')' : ''));
          got = await fromUrl(s.url, s.headers || {}, opt);
        } else { out.push({ label, error: 'the deprecated HTTP+SSE transport is not supported', code: 'unreachable' }); continue; }
        got.source.config = f.path;
        got.source.server = s.name;
        out.push({ label, ...got });
      } catch (e) {
        if (!(e instanceof InputFailure)) throw e;
        out.push({ label, error: e.message + (e.auth ? ' Pass a token in the config headers.' : ''), code: e.code, stderr: e.stderr });
      }
    }
  }
  if (opt.server && !out.length) throw new InputFailure('no server named ' + opt.server + ' in ' + files.map((f) => f.path).join(', '), 'usage');
  return out;
}

/** Collects the items to grade for the parsed CLI options. Throws InputFailure for a single input that fails. */
export async function collect(opt, note = () => {}) {
  if (opt.file) {
    try { return [{ label: opt.file === '-' ? 'stdin' : opt.file, text: opt.file === '-' ? readFileSync(0, 'utf8') : readFileSync(opt.file, 'utf8') }]; } catch (e) { throw new InputFailure('cannot read ' + (opt.file === '-' ? 'stdin' : opt.file) + ': ' + e.message, 'usage'); }
  }
  if (opt.url) {
    const headers = {};
    for (const [k, v] of Object.entries(opt.headers)) headers[k] = expandEnv(v);
    return [{ label: opt.url, ...(await fromUrl(opt.url, headers, opt)) }];
  }
  if (opt.argv || opt.command) {
    let argv;
    try { argv = opt.argv || splitCommand(opt.command); } catch (e) { throw mapCapture(e); }
    if (!argv.length) throw new InputFailure('the command is empty', 'usage');
    note('starting ' + line(argv.join(' ')));
    return [{ label: argv.join(' '), ...(await fromStdio(argv, opt, { env: Object.keys(opt.env).length ? opt.env : null })) }];
  }
  if (opt.config) return fromConfig(opt, note);
  if (opt.repo) { const got = await fromRepo(opt.repo, opt); note('found ' + got.data.length + ' tools in ' + got.source.repo + '@' + String(got.source.sha).slice(0, 12) + ' (' + got.source.provenance + ')'); return [{ label: got.source.repo, ...got }]; }
  if (opt.repoDir) { const got = await fromRepoDir(opt.repoDir, opt); note('found ' + got.data.length + ' tools in ' + line(opt.repoDir) + ' (' + got.source.provenance + ')'); return [{ label: line(opt.repoDir), ...got }]; }
  if (opt.registry) { const got = await fromRegistry(opt.registry, opt, note); return [{ label: opt.registry, ...got }]; }
  return [];
}

/** The one-line provenance shown with every report of a fetched list. Server-supplied text is sanitised. */
export function sourceLine(s) {
  if (!s) return null;
  const si = s.serverInfo && typeof s.serverInfo === 'object' && typeof s.serverInfo.name === 'string' ? ', ' + line(s.serverInfo.name, 80) + (typeof s.serverInfo.version === 'string' ? ' ' + line(s.serverInfo.version, 40) : '') : '';
  const reg = s.registry ? ' via MCP Registry ' + line(s.registry.name, 120) + (s.registry.version ? ' ' + line(s.registry.version, 40) : '') : '';
  if (s.kind === 'http') return 'Source: live server ' + line(s.url) + ' (' + s.era + (s.protocolVersion ? ', protocol ' + line(s.protocolVersion, 20) : '') + si + ')' + reg;
  if (s.kind === 'stdio') return 'Source: local server ' + line(s.command || s.server) + ' (' + s.era + ', protocol ' + line(s.protocolVersion, 20) + si + ')';
  if (s.kind === 'dir') return 'Source: local folder ' + line(s.dir) + ' (read statically, nothing was run), ' + s.provenance + (s.built ? '; read from build output, since no source file defines a tool' : '') + (s.truncated ? '; the folder holds more files than the listing limit, so the deepest were not read' : '');
  if (s.kind === 'repo') return 'Source: ' + s.repo + '@' + String(s.sha).slice(0, 12) + ' (' + s.via + '), ' + s.provenance + reg;
  return null;
}

/** For a list read from source: the line every report of it carries, saying the grades are approximate and how to get exact ones. */
export function approximateLine(s) {
  if (!s || !s.approximate) return null;
  return 'Approximate: read from source, not the server\'s live list. For exact grades, run the server (--command "<start command>") or grade a saved tools/list file.';
}

/** What --save writes: the fetched list in a shape every input accepts (a JSON-RPC answer, pages, or {tools}). */
export function savedList(item) {
  const d = item.data;
  if (Array.isArray(d) && d.length && d[0] && d[0].jsonrpc) return d.length === 1 ? d[0] : d;
  return { tools: d };
}
