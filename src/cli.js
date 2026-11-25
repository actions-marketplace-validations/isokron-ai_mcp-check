// The mcp-check command line. Same engine as the web checker, the MCP server and the GitHub Action.
import { writeFileSync } from 'node:fs';
import M from './engine.js';
import { VERSION } from './version.js';
import { capture, CaptureError } from './capture.js';
import { parseList } from './tools.js';
import { InputError, MAX_BYTES, MAX_DEPTH, MAX_TOOLS } from './limits.js';
import { ALL_SECTIONS, DEFAULT_SECTIONS, GRADED_SECTIONS, GRADES, belowMinGrade, sarifWithLocations, surfaceLine } from './report.js';
import { approximateLine, collect, InputFailure, line, sourceLine, savedList } from './inputs/collect.js';
import { tagged } from './links.js';
import { analyseList, skippedLine } from './unreadable.js';
import { codeEffectsReport, codeEffectsText, codeEffectsMarkdown } from './code-effects.js';

const USAGE = `mcp-check ${VERSION}: grade an MCP server's tools/list (rubric ${M.RUBRIC_VERSION})

Usage:
  mcp-check <tools.json | - | --stdin> [options]   grade a saved tools/list answer
  mcp-check --url <https://host/mcp> [--header "Name: value"]... [--protocol auto|modern|legacy]
                                                   list a remote server's tools (Streamable HTTP, 2026-07-28
                                                   stateless or initialize handshake; JSON or SSE)
  mcp-check -- <server command...>                 start a local stdio server and list its tools
  mcp-check --command "<server command>" [--env KEY=VALUE]...
  mcp-check --config auto|<file> [--server name]   every server in an MCP client config: Claude Desktop,
                                                   Claude Code, Cursor, Windsurf, VS Code, Zed
  mcp-check --repo github.com/owner/repo [--github-token-env NAME]
                                                   read the tool definitions from the source, run nothing
  mcp-check --repo-dir <path>                      the same, from a local checkout (no network)
  mcp-check --registry <server name>               an MCP Registry entry: its remote, else its source
  mcp-check capture [--timeout S] -- <server command...>
                                                   print a stdio server's tools/list answer
  mcp-check serve                                  run the MCP server (stdio): check_tools_list,
                                                   explain_check, compare_tools_lists

A server is sent initialize and tools/list only; no tool is ever called.

Options:
  --format text|md|json|sarif   output format (default text)
  --min-grade A-F               exit 1 when a selected section grades below this
  --sections a,b,...            sections to report and gate: ${ALL_SECTIONS.join(', ')}
                                (default ${DEFAULT_SECTIONS.join(',')}); surface has no grade and is
                                never gated: selecting it adds its guard-coverage line
  --fix <out.json>              write the list with safe fixes applied
  --compare <old.json>          diff against an earlier list; exit 1 on a high-risk annotation change
  --code-effects                experimental, with --repo or --repo-dir: follow each tool's handler through the source and
                                compare what it writes, deletes or sends with the declared hints (own block of the report,
                                never graded, never changes the exit code)
  --code-effects-depth <0-6>    how many levels of calls --code-effects follows inside the repository (default 3)
  --save <file>                 write the tool list that was fetched (for --compare or the web checker)
  --timeout <seconds>           one overall limit for reaching a server and listing its tools (default 60)
  --sarif-uri <path>            with --format sarif: the repository path of the list, for file locations
  -o, --output <file>           write the report to a file instead of stdout
  -v, --version                 print the version
  -h, --help                    print this help

--header values may name environment variables ("Authorization: Bearer $TOKEN"); header values are never
printed. Limits: ${MAX_BYTES / 1048576} MiB of JSON, ${MAX_DEPTH} levels of nesting and ${MAX_TOOLS} tools per list.
Exit codes: 0 pass, 1 below --min-grade or a high-risk change, 2 bad input or usage, 3 a server could not be
reached or listed, or the source gave no list to grade (no tool definitions, names only, or more than one server).
Grades of a list read from source (--repo, --repo-dir) are approximate; --command or a saved list gives exact ones.
Docs: ${tagged('https://isokron.ai/mcp-check', 'cli')}
`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opt = {
    cmd: 'check', format: 'text', minGrade: null, sections: DEFAULT_SECTIONS.slice(), fix: null, compare: null, file: null, sarifUri: null, output: null, timeout: 60, server: null,
    url: null, headers: {}, protocol: 'auto', command: null, argv: null, env: {}, config: null, repo: null, repoDir: null, registry: null, save: null, githubTokenEnv: null, codeEffects: false, codeEffectsDepth: undefined,
  };
  const timeout = (v) => { const n = Number(v); if (!(n > 0 && n <= 600)) throw new UsageError('--timeout must be 1 to 600 seconds'); return n; };
  if (argv[0] === 'serve') { opt.cmd = 'serve'; if (argv.length > 1) throw new UsageError('serve takes no arguments'); return opt; }
  if (argv[0] === 'capture') {
    opt.cmd = 'capture';
    const dd = argv.indexOf('--');
    const before = dd < 0 ? argv.slice(1) : argv.slice(1, dd);
    opt.argv = dd < 0 ? [] : argv.slice(dd + 1);
    for (let i = 0; i < before.length; i++) {
      const a = before[i];
      if (a === '--timeout') opt.timeout = timeout(before[++i]);
      else if (a === '-o' || a === '--output') { opt.output = before[++i]; if (!opt.output) throw new UsageError(a + ' needs a value'); }
      else throw new UsageError('unexpected argument ' + a + ' (put the server command after --)');
    }
    if (!opt.argv.length) throw new UsageError('capture needs the server command after --');
    return opt;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new UsageError(a + ' needs a value'); return argv[++i]; };
    if (a === '--') { opt.argv = argv.slice(i + 1); if (!opt.argv.length) throw new UsageError('-- needs a server command'); break; }
    else if (a === '--format') opt.format = next();
    else if (a === '--min-grade') opt.minGrade = next().toUpperCase();
    else if (a === '--sections') opt.sections = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--fix') opt.fix = next();
    else if (a === '--compare') opt.compare = next();
    else if (a === '--sarif-uri') opt.sarifUri = next();
    else if (a === '-o' || a === '--output') opt.output = next();
    else if (a === '--stdin') { if (opt.file) throw new UsageError('give a file or --stdin, not both'); opt.file = '-'; }
    else if (a === '--url') opt.url = next();
    else if (a === '--header') {
      const h = next(); const k = h.indexOf(':');
      if (k < 1) throw new UsageError('--header must be "Name: value"');
      const name = h.slice(0, k).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new UsageError('--header name is not a valid HTTP header name');
      opt.headers[name] = h.slice(k + 1).trim();
    }
    else if (a === '--protocol') opt.protocol = next();
    else if (a === '--command') opt.command = next();
    else if (a === '--env') { const e = next(); const k = e.indexOf('='); if (k < 1) throw new UsageError('--env must be KEY=VALUE'); opt.env[e.slice(0, k)] = e.slice(k + 1); }
    else if (a === '--config') opt.config = next();
    else if (a === '--server') opt.server = next();
    else if (a === '--repo') opt.repo = next();
    else if (a === '--repo-dir') opt.repoDir = next();
    else if (a === '--code-effects') opt.codeEffects = true;
    else if (a === '--code-effects-depth') { const n = Number(next()); if (!Number.isInteger(n) || n < 0 || n > 6) throw new UsageError('--code-effects-depth must be a whole number from 0 to 6'); opt.codeEffectsDepth = n; opt.codeEffects = true; }
    else if (a === '--registry') opt.registry = next();
    else if (a === '--github-token-env') opt.githubTokenEnv = next();
    else if (a === '--save') opt.save = next();
    else if (a === '--timeout') opt.timeout = timeout(next());
    else if (a === '-h' || a === '--help') { opt.cmd = 'help'; return opt; }
    else if (a === '-v' || a === '--version') { opt.cmd = 'version'; return opt; }
    else if (a.startsWith('-') && a !== '-') throw new UsageError('unknown option ' + a);
    else if (!opt.file) opt.file = a;
    else throw new UsageError('unexpected argument ' + a);
  }
  const inputs = [opt.file, opt.url, opt.command || opt.argv, opt.config, opt.repo, opt.repoDir, opt.registry].filter(Boolean).length;
  if (inputs > 1) throw new UsageError('give one input: a file, --url, --command or --, --config, --repo, --repo-dir or --registry');
  if (!inputs) throw new UsageError('no input: give a tools.json file, -, --stdin, --url, -- <command>, --config, --repo, --repo-dir or --registry');
  if (Object.keys(opt.headers).length && !opt.url) throw new UsageError('--header goes with --url only (config files carry their own headers)');
  if (Object.keys(opt.env).length && !(opt.command || opt.argv)) throw new UsageError('--env goes with --command or -- only');
  if (opt.server && !opt.config) throw new UsageError('--server goes with --config');
  if (opt.githubTokenEnv && !(opt.repo || opt.registry)) throw new UsageError('--github-token-env goes with --repo or --registry');
  if (opt.codeEffects && !(opt.repo || opt.repoDir)) throw new UsageError('--code-effects goes with --repo or --repo-dir (it reads handlers from source)');
  if (opt.save && opt.file) throw new UsageError('--save is for fetched lists; the input is already a file');
  if (!['text', 'md', 'json', 'sarif'].includes(opt.format)) throw new UsageError('unknown format ' + opt.format + ' (use text, md, json or sarif)');
  if (!['auto', 'modern', 'legacy'].includes(opt.protocol)) throw new UsageError('--protocol must be auto, modern or legacy');
  if (opt.minGrade && !GRADES.includes(opt.minGrade)) throw new UsageError('--min-grade must be A to F');
  if (!opt.sections.length) throw new UsageError('--sections is empty');
  opt.sections.forEach((s) => { if (!ALL_SECTIONS.includes(s)) throw new UsageError('unknown section ' + s + ' (use ' + ALL_SECTIONS.join(', ') + ')'); });
  return opt;
}

function textReport(r, opt, below, diff, source) {
  const out = [];
  out.push('MCP check ' + VERSION + ', rubric ' + r.rubric_version + ' (' + r.input.tools + ' tools, era ' + r.input.era + ')');
  const sl = sourceLine(source);
  if (sl) out.push(sl);
  const al = approximateLine(source);
  if (al) out.push(al);
  const sk = skippedLine(r);
  if (sk) out.push(sk);
  GRADED_SECTIONS.forEach((k) => {
    const s = r.sections[k];
    out.push('  ' + s.name.padEnd(32) + (s.grade || 'n/a').padEnd(3) + (s.score == null ? '' : String(s.score).padStart(3) + '/100') + (s.ready === false ? '  not ready' : '') + (s.caps && s.caps.length ? '  ' + s.caps.join(' ') : '') + (opt.sections.includes(k) ? '' : '  (not gated)'));
  });
  // The write surface has no letter (rubric 2.2.0); its coverage line shows only when the section is selected.
  if (opt.sections.includes('surface')) out.push('  ' + line(surfaceLine(r), 2000));
  const fs = M.allFindings(r).filter((f) => f.severity !== 'advice' && f.section !== 'surface');
  if (fs.length) out.push('', 'Blocking and attention items:');
  fs.forEach((f) => out.push('  [' + f.severity + '] ' + (f.tool ? line(f.tool, 200) : '(list)') + ': ' + f.id + ': ' + line(f.message, 2000)));
  if (r.code_effects) out.push(...codeEffectsText(r.code_effects, line));
  if (diff) out.push('', 'Compared with ' + opt.compare + ': ' + diff.added.length + ' added, ' + diff.removed.length + ' removed, ' + diff.changed.length + ' changed' + (diff.highRisk.length ? '; HIGH RISK: ' + diff.highRisk.map((t) => line(t, 200)).join(', ') : ''));
  if (below.length) out.push('', 'Below --min-grade ' + opt.minGrade + ': ' + below.join(', '));
  out.push('', 'Docs for each check: ' + tagged(M.DOCS_BASE + '<id>', 'cli'));
  return out.join('\n');
}

/** Grades one collected item. Returns { r, below, diff, failed, parsed } or { error }. */
function grade(item, opt, prevTools) {
  let parsed;
  try { parsed = parseList(item.text !== undefined ? item.text : item.data, item.text !== undefined ? item.label : 'the tool list from ' + line(item.label, 200)); } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
  const r = analyseList(parsed, item.reader || null); // a source read: checks of parts the reader could not read are skipped
  if (opt.codeEffects && item.effects !== undefined) r.code_effects = codeEffectsReport(parsed.tools, item.effects); // its own block: never in the grades
  const below = belowMinGrade(r, opt.sections, opt.minGrade);
  const diff = prevTools ? M.diffCatalogs(prevTools, parsed.tools) : null;
  return { r, below, diff, parsed, failed: below.length > 0 || !!(diff && diff.highRisk.length) };
}

const mdEscape = (s) => s.replace(/&/g, '&amp;').replace(/([\\`*_[\]<>|!~#])/g, '\\$1');

function render(item, x, opt, multi) {
  const src = item.source || null;
  if (opt.format === 'json') {
    const j = JSON.parse(M.toJSON(Object.assign({}, x.r, { engine_version: VERSION }, x.diff ? { compare: x.diff } : {})));
    if (src) j.source = src;
    return multi ? Object.assign({ label: item.label }, j) : j;
  }
  if (opt.format === 'sarif') {
    const s = sarifWithLocations(x.r, item.text || '', opt.sarifUri);
    s.runs[0].tool.driver.semanticVersion = VERSION;
    if (src) s.runs[0].properties = { source: src, label: item.label };
    return s;
  }
  if (opt.format === 'md') {
    const md = M.toMarkdown(x.r) + (x.r.code_effects ? '\n' + codeEffectsMarkdown(x.r.code_effects, mdEscape) : '');
    const sl = [sourceLine(src), approximateLine(src), skippedLine(x.r)].filter(Boolean).map(mdEscape).join('\n\n');
    return (multi ? '<!-- ' + line(item.label).replace(/--/g, '- -') + ' -->\n' : '') + (sl ? md.replace(/^(# [^\n]*\n)/, (m) => m + '\n' + sl + '\n') : md);
  }
  return (multi ? '== ' + item.label + '\n' : '') + textReport(x.r, opt, x.below, x.diff, src);
}

/** Runs the CLI. Returns the exit code; writes to the given streams. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opt;
  try { opt = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { stderr.write('mcp-check: ' + e.message + '\n\n' + USAGE); return 2; }
    throw e;
  }
  if (opt.cmd === 'help') { stdout.write(USAGE); return 0; }
  if (opt.cmd === 'version') { stdout.write(VERSION + '\n'); return 0; }
  if (opt.cmd === 'serve') {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { createServer } = await import('./server.js');
    await createServer().connect(new StdioServerTransport());
    return null; // keeps running until stdin closes
  }
  if (opt.cmd === 'capture') {
    try {
      const { result } = await capture(opt.argv, { timeoutMs: opt.timeout * 1000, stderr });
      const text = JSON.stringify(result, null, 2) + '\n';
      if (opt.output) writeFileSync(opt.output, text); else stdout.write(text);
      return 0;
    } catch (e) {
      if (e instanceof CaptureError) { stderr.write('mcp-check capture: ' + line(e.message, 2000) + '\n'); return e.code === 'usage' ? 2 : 3; }
      throw e;
    }
  }

  const note = (s) => stderr.write('mcp-check: ' + s + '\n');
  if (opt.minGrade && opt.sections.includes('surface')) note('surface has no grade since rubric 2.2.0 (it reports guard coverage), so --min-grade does not gate it.');
  let items;
  try { items = await collect(opt, note); } catch (e) {
    if (e instanceof InputFailure) {
      stderr.write('mcp-check: ' + line(e.message, 2000) + (e.stderr ? '\n--- server stderr (last lines) ---\n' + e.stderr.trim().split('\n').slice(-15).map((l) => line(l, 500)).join('\n') : '') + '\n');
      return e.code === 'usage' ? 2 : 3;
    }
    throw e;
  }
  const multi = items.length > 1 || !!opt.config;
  // --config with --server picks one server; the report keeps the config shape (labelled) either way.
  const single = items.length === 1 && (!opt.config || !!opt.server);
  if (!single && (opt.fix || opt.compare || opt.save || opt.sarifUri)) { stderr.write('mcp-check: --fix, --compare, --save and --sarif-uri need a single server (use --server name)\n'); return 2; }

  let prevTools = null;
  if (opt.compare) {
    let prev;
    try { prev = (await collect({ ...opt, url: null, argv: null, command: null, config: null, repo: null, repoDir: null, registry: null, file: opt.compare }, note))[0]; } catch (e) {
      stderr.write('mcp-check: ' + e.message + '\n'); return 2;
    }
    try { prevTools = parseList(prev.text, '--compare file ' + opt.compare).tools; } catch (e) {
      if (e instanceof InputError) { stderr.write('mcp-check: ' + e.message + '\n'); return 2; }
      throw e;
    }
  }

  let failed = false, unreachable = 0, graded = 0;
  const outs = [];
  for (const item of items) {
    if (item.error) {
      unreachable++;
      outs.push(opt.format === 'json' ? { label: item.label, error: line(item.error, 2000) } : (multi ? '== ' + item.label + '\n' : '') + 'Could not list tools: ' + line(item.error, 2000));
      continue;
    }
    const x = grade(item, opt, prevTools);
    if (x.error) {
      if (!multi) { stderr.write('mcp-check: ' + line(x.error, 2000) + '\n'); return 2; }
      unreachable++;
      outs.push(opt.format === 'json' ? { label: item.label, error: line(x.error, 2000) } : '== ' + item.label + '\nCould not check: ' + line(x.error, 2000));
      continue;
    }
    graded++;
    if (x.failed) failed = true;
    if (opt.fix) writeFileSync(opt.fix, M.fixCatalog(x.parsed).json + '\n');
    if (opt.save && item.data) writeFileSync(opt.save, JSON.stringify(savedList(item), null, 2) + '\n');
    outs.push(render(item, x, opt, multi));
    if (opt.output && opt.format !== 'text') stderr.write(textReport(x.r, opt, x.below, x.diff, item.source) + '\n');
  }

  let out;
  if (opt.format === 'json') out = JSON.stringify(multi ? outs : outs[0], null, 2);
  else if (opt.format === 'sarif') {
    const first = outs.find((o) => o && o.runs) || { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0' };
    out = JSON.stringify(Object.assign({}, first, { runs: outs.filter((o) => o && o.runs).flatMap((o) => o.runs) }), null, 2);
  } else out = outs.join('\n\n');
  if (opt.output) writeFileSync(opt.output, out + '\n'); else stdout.write(out + '\n');
  if (failed) return 1;
  return unreachable && !graded ? 3 : 0;
}
