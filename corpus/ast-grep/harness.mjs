// Real-repo validation of the ast-grep oracle against ground truth (the mcp-check QA gate's targets: a repository at a
// pinned commit, optionally a subfolder, and the tools its server registers). Run by .github/workflows/ast-grep-validate.yml
// (workflow_dispatch, free public Actions) and usable locally. Precision and recall are counted per language over the
// targets with truth: precision against every tool the server has (a gated tool is a real tool), recall over the default
// tools (and over all). A target with no tool list read by ast-grep counts its truth as missed; `unreadable` is
// reported, never counted as a wrong tool.
//
//   node corpus/ast-grep/harness.mjs run <targets.json|-> [--json out.json]    scan and score
//   node corpus/ast-grep/harness.mjs shards <targets.json> <out-dir> [--max N]  split into dispatch inputs under the 65,535-character limit
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSource } from './source.mjs';
import { runOracle } from './index.mjs';

export const INPUT_LIMIT = 60_000;
const LANGS = ['ts', 'python', 'go', 'rust', 'csharp'];

/** One target as the dispatch carries it: what the scan and the scoring need, no more. */
export function slim(t) {
  const tools = ((t.expected && t.expected.tools) || []).map((x) => (x.default === false ? [x.name, 0] : [x.name]));
  return { id: t.id, repo: t.repo, sha: t.sha, language: t.language, ...(t.subdir ? { subdir: t.subdir } : {}), ...(t.holdout ? { holdout: true } : {}), ...(t.multi_server ? { multi: true } : {}), ...(t.usable === false ? { unusable: true } : {}), tools };
}

/** Splits slim targets into groups whose JSON stays under `limit` characters. */
export function shardTargets(targets, { limit = INPUT_LIMIT } = {}) {
  const shards = [];
  let cur = [];
  let size = 2;
  for (const t of targets.map(slim)) {
    const n = JSON.stringify(t).length + 1;
    if (cur.length && size + n > limit) { shards.push(cur); cur = []; size = 2; }
    cur.push(t); size += n;
  }
  if (cur.length) shards.push(cur);
  return shards;
}

/** Scores one oracle summary against a target's truth. */
export function scoreTarget(summary, target) {
  const found = new Set(summary.tools.map((t) => t.name));
  const all = new Set(target.tools.map((x) => x[0]));
  const dflt = new Set(target.tools.filter((x) => x[1] !== 0).map((x) => x[0]));
  const tp = [...found].filter((n) => all.has(n)).length;
  return {
    found: found.size, truth_all: all.size, truth_default: dflt.size,
    tp, fp: found.size - tp,
    tp_default: [...dflt].filter((n) => found.has(n)).length,
    tp_all: [...all].filter((n) => found.has(n)).length,
    missed: [...dflt].filter((n) => !found.has(n)), wrong: [...found].filter((n) => !all.has(n)),
  };
}

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** Per-language and overall counts over scored rows (row: { language, holdout, status, confidence, score }). */
export function aggregate(rows) {
  const sum = (rs) => {
    const s = { targets: rs.length, read: 0, unreadable: 0, none: 0, error: 0, found: 0, tp: 0, fp: 0, truth_default: 0, tp_default: 0, truth_all: 0, tp_all: 0 };
    for (const r of rs) { s[r.status] = (s[r.status] ?? 0) + 1; s.found += r.score.found; s.tp += r.score.tp; s.fp += r.score.fp; s.truth_default += r.score.truth_default; s.tp_default += r.score.tp_default; s.truth_all += r.score.truth_all; s.tp_all += r.score.tp_all; }
    return { ...s, precision: ratio(s.tp, s.found), recall_default: ratio(s.tp_default, s.truth_default), recall_all: ratio(s.tp_all, s.truth_all) };
  };
  const by = {};
  for (const lang of [...new Set(rows.map((r) => r.language))].sort()) {
    const rs = rows.filter((r) => r.language === lang);
    by[lang] = { all: sum(rs), high_confidence: sum(rs.filter((r) => r.confidence === 'high')), holdout: sum(rs.filter((r) => r.holdout)) };
  }
  return { by_language: by, overall: { all: sum(rows), high_confidence: sum(rows.filter((r) => r.confidence === 'high')) } };
}

const pct = (x) => (x === null ? 'n/a' : x.toFixed(3));
export function markdown(agg, rows, { showDetail = true } = {}) {
  const L = ['| language | targets | read | unreadable | none | error | precision | recall (default) | recall (all) | precision, high confidence | read at high confidence |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  const line = (name, a, h) => `| ${name} | ${a.targets} | ${a.read} | ${a.unreadable} | ${a.none} | ${a.error} | ${pct(a.precision)} (${a.tp}/${a.found}) | ${pct(a.recall_default)} (${a.tp_default}/${a.truth_default}) | ${pct(a.recall_all)} (${a.tp_all}/${a.truth_all}) | ${pct(h.precision)} (${h.tp}/${h.found}) | ${h.targets} |`;
  for (const [lang, v] of Object.entries(agg.by_language)) L.push(line(lang, v.all, v.high_confidence));
  L.push(line('**all**', agg.overall.all, agg.overall.high_confidence));
  if (showDetail) {
    L.push('', '| target | language | status | confidence | found | tp | fp | default truth | default found | unreadable |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows.filter((x) => !x.holdout)) L.push(`| ${r.id} | ${r.language} | ${r.status} | ${r.confidence ?? ''} | ${r.score.found} | ${r.score.tp} | ${r.score.fp} | ${r.score.truth_default} | ${r.score.tp_default} | ${r.unreadable_count} |`);
  }
  return L.join('\n') + '\n';
}

/** Scans and scores every scorable target (single server, with truth). Never throws for a target. */
export async function runTargets(targets, { fetch = fetchSource, log = () => {}, runOne = runOracle } = {}) {
  const rows = [];
  const skipped = [];
  for (const t of targets) {
    if (t.multi || t.unusable || !t.tools.length) { skipped.push({ id: t.id, why: t.multi ? 'multi_server' : t.unusable ? 'unusable_truth' : 'no_truth' }); continue; }
    const out = await runOne({ repo: t.repo, sha: t.sha, reader: null, fetchSource: async (r, s) => {
      const src = await fetch(r, s, t.subdir ? { prefix: t.subdir.replace(/\/?$/, '/') } : {});
      if (!t.subdir) return src;
      return { dir: join(src.dir, t.subdir), cleanup: src.cleanup };
    } });
    const s = out.summary;
    rows.push({ id: t.id, language: t.language, holdout: t.holdout === true, status: s.status, confidence: s.confidence, unreadable_count: s.unreadable_count, error: s.error, idioms: s.idioms, score: scoreTarget(s, t) });
    log(t.id + ': ' + s.status + (s.confidence ? ' ' + s.confidence : '') + ' found ' + s.tool_count);
  }
  return { rows, skipped };
}

async function main(argv) {
  const [cmd, a, b, ...rest] = argv;
  if (cmd === 'shards') {
    const raw = JSON.parse(readFileSync(a, 'utf8'));
    const targets = Array.isArray(raw) ? raw : raw.targets;
    const max = rest.includes('--max') ? Number(rest[rest.indexOf('--max') + 1]) : INPUT_LIMIT;
    const shards = shardTargets(targets, { limit: max });
    mkdirSync(b, { recursive: true });
    shards.forEach((s, i) => writeFileSync(join(b, 'shard-' + (i + 1) + '.json'), JSON.stringify(s)));
    process.stdout.write(shards.length + ' shards of ' + shards.map((s) => s.length).join(', ') + ' targets\n');
    return 0;
  }
  if (cmd === 'run') {
    const text = a === '-' ? process.env.TARGETS : readFileSync(a, 'utf8');
    const targets = JSON.parse(text);
    if (!Array.isArray(targets) || targets.length > 200) throw new Error('targets must be a list of at most 200');
    const { rows, skipped } = await runTargets(targets, { log: (l) => process.stdout.write(l + '\n') });
    const agg = aggregate(rows);
    const md = markdown(agg, rows);
    process.stdout.write(md + '\nskipped (no single-server truth): ' + skipped.map((s) => s.id + ':' + s.why).join(', ') + '\n');
    const flags = [b, ...rest];
    const out = flags.includes('--json') ? flags[flags.indexOf('--json') + 1] : null;
    if (out) writeFileSync(out, JSON.stringify({ aggregate: agg, rows, skipped }));
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
    return 0;
  }
  process.stdout.write('usage: harness.mjs run <targets.json|-> [--json out] | shards <targets.json> <out-dir> [--max N]\n');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
