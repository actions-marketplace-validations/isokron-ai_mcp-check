#!/usr/bin/env node
// Real-repo QA of the static source reader: scorer and gate. See qa/README.md.
//
//   node qa/score.mjs --label head [--out qa/out] [--gate] [--min-recall 0.8] [--gate-langs ts,python,go,rust]
//                     [--base base] [--md file] [--json file]
//
// Reads <out>/<label>/remote/<id>.* (run.mjs), scores each target against qa/truth/<id>.json and prints one markdown
// report. With --base <label> it also compares every target with that build's outputs (regressions, byte-identical
// counts). --gate exits 1 when any gate rule is breached:
//   1. micro recall of default tools >= --min-recall for each gated language (targets with usable truth);
//   2. zero silent monorepo merges;
//   3. no names-only list graded on schema or annotation checks;
//   4. no run ends in an error or is missing (a crash, a timeout, an unreadable answer);
//   5. with --base: no target loses a default tool the base build found, gains a phantom or wrong-server tool, drops
//      from graded to anything else, or becomes a silent merge or pick.
// Status per target: graded (exit 0/1 with a report) | no-tools (exit 3, nothing found) | refused (the CLI declined on
// purpose: several servers, names only, language not read yet) | error (anything else).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];
const REFUSE_RE = /(several|multiple|more than one) (mcp )?servers?\b|choose (a|one) (sub)?folder|pick (a|one) (sub)?folder|working-directory|names[- ]only|only (the )?names|is not read yet|not read yet/i;
const NO_TOOLS_RE = /no tool definitions found/i;
const SCHEMA_FINDING_RE = /schema|hint|annotation/i;
const LANG_NAME = { ts: 'TypeScript', python: 'Python', go: 'Go', rust: 'Rust' };

function parseArgs(argv) {
  const o = { label: null, out: path.join(HERE, 'out'), gate: false, minRecall: 0.8, base: null, md: null, json: null, gateLangs: ['ts', 'python', 'go', 'rust'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--label') o.label = next();
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--gate') o.gate = true;
    else if (a === '--min-recall') o.minRecall = Number(next());
    else if (a === '--base') o.base = next();
    else if (a === '--md') o.md = next();
    else if (a === '--json') o.json = next();
    else if (a === '--gate-langs') o.gateLangs = next().split(',').map((x) => x.trim()).filter(Boolean);
    else throw new Error('unknown argument ' + a);
  }
  if (!o.label) throw new Error('--label is required');
  if (!(o.minRecall > 0 && o.minRecall <= 1)) throw new Error('--min-recall is a number in (0, 1]');
  return o;
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const r3 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
const fmt = (x) => (x == null ? 'n/a' : x.toFixed(2));

function status(meta, report, err) {
  if (!meta) return 'missing';
  if ((meta.exit === 0 || meta.exit === 1) && report && report.sections) return 'graded';
  if (report && report.refused) return 'refused';
  if ((meta.exit === 2 || meta.exit === 3) && REFUSE_RE.test(err)) return 'refused';
  if (meta.exit === 3 && NO_TOOLS_RE.test(err)) return 'no-tools';
  return 'error';
}

function repoGroups(servers, repo) {
  const g = servers.servers[repo];
  if (!g) return null;
  const sets = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, new Set(v)]));
  const owner = new Map();
  for (const [k, s] of Object.entries(sets)) for (const n of s) owner.set(n, owner.has(n) ? null : k);
  return { sets, unique: owner };
}

function scoreTarget(t, servers, dir) {
  const base = path.join(dir, t.id);
  const meta = readJson(base + '.meta.json');
  const report = readJson(base + '.json');
  const err = readText(base + '.err');
  const st = status(meta, report, err);
  const row = { id: t.id, repo: t.repo, subdir: t.subdir || '', language: t.language, patterns: t.patterns, status: st, exit: meta ? meta.exit : null, ms: meta ? meta.ms : null, attempts: meta ? meta.attempts : null };
  const found = st === 'graded' ? (report.tools || []).map((x) => x.name) : [];
  row.found = found.length;
  if (st === 'graded') {
    row.fidelity = report.source?.fidelity ?? null;
    row.from = report.source?.from ?? null;
    row.grades = Object.fromEntries(SECTIONS.map((s) => [s, report.sections?.[s]?.grade ?? null]));
    if (row.fidelity === 'names') {
      const bad = (report.tools || []).flatMap((x) => x.findings || []).filter((f) => SCHEMA_FINDING_RE.test(f.id || ''));
      row.names_only_graded = bad.length > 0;
    }
  } else if (st !== 'missing') row.message = err.trim().split('\n').pop().slice(0, 240);

  const truth = t.truth ? readJson(path.join(HERE, 'truth', t.id + '.json')) : null;
  const groups = repoGroups(servers, t.repo);
  const aliases = (servers.server_aliases || {})[t.repo] || {};
  let own = truth?.server_root ?? (t.subdir || null);
  if (own != null && aliases[own]) own = aliases[own];
  if (groups && found.length) {
    const hit = new Set();
    for (const n of found) { const g = groups.unique.get(n); if (g) hit.add(g); }
    // Cross-check with the files the list was read from: files all under one server folder make a second
    // "server" hit by name a name collision, not a merge.
    const roots = Object.keys(groups.sets).filter((k) => k).sort((a, b) => b.length - a.length);
    const fileRoots = new Set();
    for (const f of (st === 'graded' ? (report.source?.files || []) : [])) { let r = roots.find((k) => f === k || f.startsWith(k + '/')); if (r && aliases[r]) r = aliases[r]; if (r) fileRoots.add(r); }
    row.servers_hit = [...hit].sort();
    row.merged = hit.size >= 2 && fileRoots.size !== 1;
    if (hit.size >= 2 && fileRoots.size === 1) row.servers_hit = [...fileRoots];
  }
  row.silent_merge = st === 'graded' && !!row.merged;

  if (t.multi_server) {
    const ok = t.multi_server.acceptable || [];
    row.multi_server = true;
    if (st === 'refused') row.multi_outcome = 'refused (ok)';
    else if (st === 'graded') {
      if (row.merged) row.multi_outcome = 'silent merge';
      else if (row.servers_hit?.length === 1 && ok.includes(row.servers_hit[0])) row.multi_outcome = 'acceptable pick';
      else if (row.servers_hit?.length === 1) row.multi_outcome = 'silent wrong pick';
      else row.multi_outcome = 'silent unattributed pick';
    } else row.multi_outcome = st;
    return row;
  }
  if (!truth || truth.usable === false) { row.truth = truth ? 'unusable' : 'none'; return row; }
  row.truth = t.truth_source;
  const all = new Set(truth.tools.map((x) => x.name));
  const dflt = new Set(truth.tools.filter((x) => x.default !== false).map((x) => x.name));
  const foundSet = new Set(found);
  const correct = found.filter((n) => all.has(n));
  const tpDefault = [...dflt].filter((n) => foundSet.has(n));
  const notTruth = found.filter((n) => !all.has(n));
  const wrong = groups ? notTruth.filter((n) => Object.entries(groups.sets).some(([k, s]) => k !== own && s.has(n))) : [];
  const phantom = notTruth.filter((n) => !wrong.includes(n));
  Object.assign(row, {
    truth_default: dflt.size, truth_all: all.size, correct: correct.length, tp_default: tpDefault.length,
    gated_found: correct.length - found.filter((n) => dflt.has(n)).length, phantom: phantom.length, wrong_server: wrong.length,
    precision: found.length ? r3(correct.length / found.length) : null,
    recall: dflt.size ? r3(tpDefault.length / dflt.size) : null,
    phantom_names: phantom.slice(0, 20), wrong_server_names: wrong.slice(0, 20),
    missed_names: [...dflt].filter((n) => !foundSet.has(n)).slice(0, 40),
  });
  if (all.size === 0 && st === 'graded') row.false_list = true;
  return row;
}

function aggRow(k, rs) {
  const scored = rs.filter((r) => r.truth_default != null && r.truth_default > 0);
  const sum = (f, xs = scored) => xs.reduce((a, r) => a + (r[f] || 0), 0);
  const truthD = sum('truth_default'), tpD = sum('tp_default');
  const withFound = rs.filter((r) => r.truth_all != null && r.found > 0);
  const found = sum('found', withFound), correct = sum('correct', withFound);
  const st = (s) => rs.filter((r) => r.status === s).length;
  return {
    key: k, targets: rs.length, with_truth: scored.length, truth_tools: truthD, found_right: tpD,
    phantom: sum('phantom', withFound), wrong_server: sum('wrong_server', withFound),
    precision: found ? r3(correct / found) : null, recall: truthD ? r3(tpD / truthD) : null,
    zero_recall: scored.filter((r) => r.recall === 0).length,
    graded: st('graded'), no_tools: st('no-tools'), refused: st('refused'), error: st('error') + st('missing'),
  };
}

function aggregate(rows, key) {
  const groups = new Map();
  for (const r of rows) { const keys = key === 'pattern' ? r.patterns : [r[key]]; for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); } }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, rs]) => aggRow(k, rs));
}

function mdTable(rows, cols) {
  const h = '| ' + cols.map((c) => c[0]).join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n';
  return h + rows.map((r) => '| ' + cols.map((c) => { const v = c[1](r); return v == null ? '' : String(v); }).join(' | ') + ' |').join('\n') + '\n';
}

export function scoreLabel(outRoot, label) {
  const doc = readJson(path.join(HERE, 'targets.json'));
  const servers = readJson(path.join(HERE, 'servers.json'));
  const dir = path.join(outRoot, label, 'remote');
  if (!fs.existsSync(dir)) throw new Error(`no outputs at ${dir}: run qa/run.mjs --label ${label} first`);
  return { doc, rows: doc.targets.map((t) => scoreTarget(t, servers, dir)), dir };
}

/** Per-target changes from a base build to this one: regressions (gate) and improvements (reported). */
export function diffRows(baseRows, rows) {
  const regressions = [], improvements = [];
  for (const r of rows) {
    const b = baseRows.find((x) => x.id === r.id);
    if (!b) continue;
    const bad = [], good = [];
    if (b.status === 'graded' && r.status !== 'graded' && !(r.multi_server && r.status === 'refused')) bad.push(`graded -> ${r.status}`);
    if (b.status !== 'graded' && r.status === 'graded' && !r.multi_server) good.push(`${b.status} -> graded`);
    if (b.tp_default != null && r.tp_default != null) {
      if (r.tp_default < b.tp_default) bad.push(`default tools found ${b.tp_default} -> ${r.tp_default}`);
      if (r.tp_default > b.tp_default) good.push(`default tools found ${b.tp_default} -> ${r.tp_default}`);
      if ((r.phantom || 0) > (b.phantom || 0)) bad.push(`phantom ${b.phantom || 0} -> ${r.phantom}`);
      if ((r.phantom || 0) < (b.phantom || 0)) good.push(`phantom ${b.phantom || 0} -> ${r.phantom}`);
      if ((r.wrong_server || 0) > (b.wrong_server || 0)) bad.push(`wrong-server ${b.wrong_server || 0} -> ${r.wrong_server}`);
    }
    if (r.silent_merge && !b.silent_merge) bad.push('new silent merge');
    if (r.multi_server && /^silent/.test(r.multi_outcome || '') && b.multi_outcome !== r.multi_outcome) bad.push(`${b.multi_outcome} -> ${r.multi_outcome}`);
    if (bad.length) regressions.push({ id: r.id, what: bad });
    if (good.length) improvements.push({ id: r.id, what: good });
  }
  return { regressions, improvements };
}

/** Byte comparison of two builds' raw outputs: the saved tool list and the JSON report, target by target. */
export function byteCompare(outRoot, baseLabel, label, targets) {
  const same = [], differ = [], missing = [];
  const rd = (l, id, ext) => { try { return fs.readFileSync(path.join(outRoot, l, 'remote', id + ext), 'utf8'); } catch { return null; } };
  for (const t of targets) {
    const a = [rd(baseLabel, t.id, '.tools.json'), rd(baseLabel, t.id, '.json')], b = [rd(label, t.id, '.tools.json'), rd(label, t.id, '.json')];
    if (a[1] == null || b[1] == null) { missing.push(t.id); continue; }
    (a[0] === b[0] && a[1] === b[1] ? same : differ).push(t.id);
  }
  return { same: same.length, differ, missing };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const { doc, rows } = scoreLabel(opt.out, opt.label);
  const runs = fs.readdirSync(path.join(opt.out, opt.label)).filter((f) => /^run(-\d+)?\.json$/.test(f)).map((f) => readJson(path.join(opt.out, opt.label, f)));
  const single = rows.filter((r) => !r.multi_server);
  const byLang = aggregate(single, 'language');
  const overall = aggRow('all', single);
  const srcOnly = aggRow('source reader only', single.filter((r) => !(r.status === 'graded' && r.from && r.from !== 'source') && !r.patterns.includes('snapshot')));
  const statuses = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const silentMerges = rows.filter((r) => r.silent_merge).map((r) => r.id);
  const silentPicks = rows.filter((r) => r.multi_server && /silent (wrong|unattributed) pick/.test(r.multi_outcome || '')).map((r) => r.id);
  const wrongServer = single.filter((r) => r.wrong_server > 0).map((r) => r.id);
  const namesOnlyGraded = rows.filter((r) => r.names_only_graded).map((r) => r.id);
  const errors = rows.filter((r) => r.status === 'error' || r.status === 'missing').map((r) => `${r.id} (${r.status}${r.message ? ': ' + r.message : ''})`);
  const falseLists = rows.filter((r) => r.false_list).map((r) => r.id);
  const slow = rows.filter((r) => r.ms != null).sort((a, b) => b.ms - a.ms)[0];
  const ms = rows.map((r) => r.ms).filter((x) => x != null).sort((a, b) => a - b);
  const langRec = (l) => byLang.find((x) => x.key === l)?.recall ?? null;
  const gate = {
    min_recall: opt.minRecall, langs: opt.gateLangs,
    recall_by_lang: Object.fromEntries(['ts', 'python', 'go', 'rust'].map((l) => [l, langRec(l)])),
    silent_merges: silentMerges.length, silent_picks: silentPicks.length, names_only_graded: namesOnlyGraded.length, errors: errors.length,
  };
  gate.failures = [
    ...opt.gateLangs.filter((l) => langRec(l) == null || langRec(l) < opt.minRecall).map((l) => `${LANG_NAME[l] || l} recall ${fmt(langRec(l))} < ${opt.minRecall}`),
    ...(silentMerges.length ? [`${silentMerges.length} silent monorepo merge(s): ${silentMerges.join(', ')}`] : []),
    ...(silentPicks.length ? [`${silentPicks.length} silent pick(s) on multi-server roots: ${silentPicks.join(', ')}`] : []),
    ...(namesOnlyGraded.length ? [`${namesOnlyGraded.length} names-only list(s) graded on schema/annotation checks: ${namesOnlyGraded.join(', ')}`] : []),
    ...(errors.length ? [`${errors.length} run(s) ended in error or are missing: ${errors.join('; ')}`] : []),
  ];

  let cmp = null;
  if (opt.base) {
    const b = scoreLabel(opt.out, opt.base);
    cmp = { ...diffRows(b.rows, rows), bytes: byteCompare(opt.out, opt.base, opt.label, doc.targets), base: opt.base };
    if (cmp.regressions.length) gate.failures.push(`${cmp.regressions.length} regression(s) against ${opt.base}: ${cmp.regressions.map((c) => c.id).join(', ')}`);
  }
  gate.pass = gate.failures.length === 0;

  const ref = readJson(path.join(HERE, 'reference.json'));
  const aggCols = [['', (r) => r.key], ['targets', (r) => r.targets], ['with truth', (r) => r.with_truth], ['truth tools', (r) => r.truth_tools], ['found right', (r) => r.found_right],
    ['phantom', (r) => r.phantom], ['wrong server', (r) => r.wrong_server], ['precision', (r) => fmt(r.precision)], ['recall', (r) => fmt(r.recall)],
    ['recall 0', (r) => r.zero_recall], ['graded', (r) => r.graded], ['no-tools', (r) => r.no_tools], ['refused', (r) => r.refused], ['error', (r) => r.error]];
  let md = `# Reader QA: ${opt.label}\n\n${rows.length} targets (${single.length} single-server, ${rows.length - single.length} multi-server roots); ${single.filter((r) => r.truth_default > 0).length} with default-tool truth. Statuses: ${Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(', ')}.\n`;
  md += `Runtime per target: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, max ${slow ? (slow.ms / 1000).toFixed(1) + ' s (' + slow.id + ')' : 'n/a'}; retried runs: ${rows.filter((r) => r.attempts > 1).length}.\n\n`;
  md += `## Gate: ${gate.pass ? 'PASS' : 'FAIL'}\n\n`;
  md += mdTable([{ k: 'Recall, TypeScript', v: langRec('ts'), r: ref?.recall?.ts }, { k: 'Recall, Python', v: langRec('python'), r: ref?.recall?.python }, { k: 'Recall, Go', v: langRec('go'), r: ref?.recall?.go }, { k: 'Recall, Rust', v: langRec('rust'), r: ref?.recall?.rust },
    { k: 'Recall, all', v: overall.recall, r: ref?.recall?.all }, { k: 'Precision, all', v: overall.precision, r: ref?.precision?.all }], [['', (r) => r.k], ['this run', (r) => fmt(r.v)], [`last local QA${ref ? ' (' + ref.build + ')' : ''}`, (r) => fmt(r.r)], ['gate', (r) => (/^Recall, (TypeScript|Python|Go|Rust)/.test(r.k) ? `>= ${opt.minRecall}` : '')]]);
  md += `\nSilent merges ${gate.silent_merges}, silent picks ${gate.silent_picks}, names-only lists graded ${gate.names_only_graded}, errors or missing ${gate.errors}.\n`;
  if (!gate.pass) md += '\n' + gate.failures.map((f) => '- ' + f).join('\n') + '\n';
  if (cmp) {
    const nb = cmp.bytes.same + cmp.bytes.differ.length;
    md += `\n## Against ${cmp.base} (the base build)\n\nByte-identical output (saved tool list and JSON report) on **${cmp.bytes.same} of ${nb}** targets${cmp.bytes.missing.length ? `; no output from one side for ${cmp.bytes.missing.join(', ')}` : ''}. Regressions: ${cmp.regressions.length}. Improvements: ${cmp.improvements.length}.\n`;
    if (cmp.bytes.differ.length) md += `\nDiffer in bytes: ${cmp.bytes.differ.join(', ')}.\n`;
    if (cmp.regressions.length) md += '\nRegressions:\n' + cmp.regressions.map((c) => `- ${c.id}: ${c.what.join('; ')}`).join('\n') + '\n';
    if (cmp.improvements.length) md += '\nImprovements:\n' + cmp.improvements.map((c) => `- ${c.id}: ${c.what.join('; ')}`).join('\n') + '\n';
  }
  md += '\n## Overall\n\n' + mdTable([overall, srcOnly], aggCols);
  md += '\n## By language\n\n' + mdTable(byLang, aggCols);
  md += '\n## Multi-server roots\n\n' + mdTable(rows.filter((r) => r.multi_server), [['target', (r) => r.id], ['status', (r) => r.status], ['outcome', (r) => r.multi_outcome], ['tools', (r) => r.found]]);
  md += `\nWrong-server tools in single-server targets: ${wrongServer.join(', ') || 'none'}. True negatives graded with a list: ${falseLists.join(', ') || 'none'}.\n`;
  md += '\n## Per target\n\n' + mdTable(rows, [['target', (r) => r.id], ['lang', (r) => r.language], ['status', (r) => r.status], ['from', (r) => r.from], ['fidelity', (r) => r.fidelity], ['found', (r) => r.found],
    ['truth (default/all)', (r) => (r.truth_default != null ? `${r.truth_default}/${r.truth_all}` : r.multi_server ? 'multi' : r.truth || '')], ['right', (r) => r.tp_default], ['phantom', (r) => r.phantom],
    ['P', (r) => (r.precision != null ? fmt(r.precision) : null)], ['R', (r) => (r.recall != null ? fmt(r.recall) : null)], ['s', (r) => (r.ms != null ? (r.ms / 1000).toFixed(1) : null)],
    ['grades', (r) => (r.grades ? SECTIONS.map((s) => r.grades[s] || '-').join(' ') : r.multi_outcome || null)]]);
  if (opt.md) fs.writeFileSync(opt.md, md);
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ label: opt.label, runs, statuses, overall, source_reader_only: srcOnly, by_language: byLang, gate, compare: cmp, per_target: rows }, null, 1) + '\n');
  process.stdout.write(md);
  if (opt.gate) { console.error(gate.pass ? 'GATE PASS' : 'GATE FAIL:\n  ' + gate.failures.join('\n  ')); process.exit(gate.pass ? 0 : 1); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error('qa/score.mjs: ' + (e && e.message)); process.exit(2); }
}
