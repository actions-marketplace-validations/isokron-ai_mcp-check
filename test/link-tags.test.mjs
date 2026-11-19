// Every link to isokron.ai that this repository shows to a person carries the channel tag of the place
// it appears in: utm_source and utm_medium, a fixed pair per surface. The table of all surfaces across
// the IsoKron repositories is docs/LINK-TAGS.md in the site's repository; the rows for this repository
// are repeated here, and this test fails when a link lacks its tag, carries another surface's tag or an
// unknown source, or when a file gains an isokron.ai link without being listed below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import M from '../src/engine.js';
import { LINK_TAGS, tagged, tagDocsLinks } from '../src/links.js';
import { sarifWithLocations, summaryMarkdown, webLink } from '../src/report.js';
import { createServer } from '../src/server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(join(root, f), 'utf8');

/** Files whose links are written by hand, and the one tag each file's links carry. */
const FILE_TAGS = {
  'README.md': { source: 'mcp-check-readme', medium: 'readme' },
  'CHANGELOG.md': { source: 'mcp-check-readme', medium: 'readme' },
  'CONTRIBUTING.md': { source: 'mcp-check-readme', medium: 'readme' },
  'RUBRIC.md': { source: 'mcp-check-readme', medium: 'readme' },
  'SECURITY.md': { source: 'mcp-check-readme', medium: 'readme' },
  'docs/github-action.md': { source: 'mcp-check-readme', medium: 'readme' },
  'corpus/README.md': { source: 'mcp-check-readme', medium: 'readme' },
  'package.json': { source: 'mcp-check-npm', medium: 'npm' },
  'server.json': { source: 'mcp-check-registry', medium: 'registry' },
};

/** Links in those files that stay untagged, each with the reason. */
const UNTAGGED = {
  // A URL pattern in a code span, not a link: the reader replaces <id>.
  'README.md': ['https://isokron.ai/mcp-check/checks/<id>'],
  // The author field's URL: package tooling reads it; npm's package page links the homepage, which is tagged.
  'package.json': ['https://isokron.ai'],
};

/**
 * Files that hold an isokron.ai URL and are not checked as text: the vendored engine (hash-locked, the
 * same file as the web checker), code whose printed links are checked below by running it, and tests.
 */
const NOT_SCANNED = [
  /^engine\//, /^test\//, /^node_modules\//, /^\.git\//,
  /^src\/(cli|report|server|links)\.js$/,
  /^scripts\/vendor\.mjs$/, /^src\/engine\.js$/, /^src\/inputs\/mcp-client\.cjs$/, // comments that name the page, no URL scheme
];

const KNOWN = new Map([...Object.values(FILE_TAGS), ...Object.values(LINK_TAGS)].map((t) => [t.source, t.medium]));
const URL_RE = /https:\/\/isokron\.ai(?![\w.-])[^\s"'`)\]}<>]*(?:<id>[^\s"'`)\]}<>]*)?/g;

function tagOf(url) {
  const q = url.split('#')[0].split('?')[1] || '';
  const p = new URLSearchParams(q);
  return { source: p.get('utm_source'), medium: p.get('utm_medium'), keys: [...p.keys()] };
}
function assertTag(url, want, where) {
  const t = tagOf(url);
  assert.equal(t.source, want.source, where + ': ' + url + ' should carry utm_source=' + want.source);
  assert.equal(t.medium, want.medium, where + ': ' + url + ' should carry utm_medium=' + want.medium);
  assert.deepEqual(t.keys, ['utm_source', 'utm_medium'], where + ': ' + url + ' carries only the two tag parameters, in this order');
  assert.ok(!/#.*[?&]utm_/.test(url), where + ': the tag goes before the fragment in ' + url);
}

function files() {
  const git = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim().split('\n');
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { if (n === 'node_modules' || n === '.git') continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(relative(root, p)); } };
  walk(root);
  return out;
}

test('link tags: sources are lower-case words, one medium each, unique per surface', () => {
  const all = [...Object.values(FILE_TAGS), ...Object.values(LINK_TAGS)];
  for (const t of all) { assert.match(t.source, /^[a-z][a-z0-9-]{2,39}$/); assert.match(t.medium, /^[a-z]{2,12}$/); assert.equal(KNOWN.get(t.source), t.medium, t.source + ' has one medium'); }
  const runtime = Object.values(LINK_TAGS).map((t) => t.source);
  assert.equal(new Set(runtime).size, runtime.length, 'each printed surface has its own utm_source');
});

test('link tags: every isokron.ai link in the listed files carries that file\'s tag', () => {
  for (const [file, want] of Object.entries(FILE_TAGS)) {
    const urls = read(file).match(URL_RE) || [];
    const skip = new Set(UNTAGGED[file] || []);
    for (const url of urls) { if (skip.has(url)) continue; assertTag(url, want, file); }
    for (const u of skip) assert.ok(urls.includes(u), file + ': the untagged exception ' + u + ' is still in the file (remove it from UNTAGGED otherwise)');
  }
});

test('link tags: no other tracked file holds an isokron.ai link, and no link uses an unknown source', () => {
  for (const f of files()) {
    if (NOT_SCANNED.some((re) => re.test(f))) continue;
    let text;
    try { text = read(f); } catch { continue; }
    const urls = text.match(URL_RE) || [];
    if (urls.length) assert.ok(FILE_TAGS[f], f + ' has a link to isokron.ai (' + urls[0] + '): add the file to FILE_TAGS here and to docs/LINK-TAGS.md in the site repository');
    for (const m of text.matchAll(/isokron\.ai[^\s"'`)\]}<>]*[?&]utm_source=([^&#\s"'`)\]}<>]*)/g)) assert.ok(KNOWN.has(m[1]), f + ': unknown utm_source ' + m[1]);
  }
});

test('link tags: tagged() puts the tag before the fragment and leaves other URLs alone', () => {
  assert.equal(tagged('https://isokron.ai/mcp-check', 'cli'), 'https://isokron.ai/mcp-check?utm_source=mcp-check-cli&utm_medium=cli');
  assert.equal(tagged('https://isokron.ai', 'cli'), 'https://isokron.ai?utm_source=mcp-check-cli&utm_medium=cli');
  assert.equal(tagged('https://isokron.ai/mws#mws-conc-2', 'action'), 'https://isokron.ai/mws?utm_source=mcp-check-action&utm_medium=action#mws-conc-2');
  assert.equal(tagged('https://isokron.ai/x?a=1#f', 'sarif'), 'https://isokron.ai/x?a=1&utm_source=mcp-check-sarif&utm_medium=sarif#f');
  const once = tagged('https://isokron.ai/mcp-check', 'badge');
  assert.equal(tagged(once, 'cli'), once, 'a URL that already has a tag keeps it');
  for (const other of ['https://example.com/a', 'https://isokron.ai.example.com/a', 'https://github.com/isokron-ai/mcp-check', 'http://isokron.ai/a']) assert.equal(tagged(other, 'cli'), other);
  assert.throws(() => tagged('https://isokron.ai', 'nope'), /unknown link surface/);
});

test('link tags: the CLI prints its docs links with the cli tag', () => {
  const run = (args) => spawnSync(process.execPath, [join(root, 'bin', 'mcp-check.js'), ...args], { encoding: 'utf8' });
  for (const out of [run(['--help']).stdout, run([join(root, 'test', 'fixtures', 'example.json')]).stdout]) {
    const urls = out.match(URL_RE) || [];
    assert.ok(urls.length >= 1, out);
    for (const u of urls) assertTag(u, LINK_TAGS.cli, 'cli output');
  }
  assert.match(run([join(root, 'test', 'fixtures', 'example.json')]).stdout, /checks\/<id>\?utm_source=mcp-check-cli&utm_medium=cli\n/);
});

test('link tags: job summary, SARIF, badge report and serverInfo carry their own tags; data stays untagged', async () => {
  const text = read('test/fixtures/example.json');
  const r = M.analyse(M.parseInput(text));
  const link = await webLink(text);

  const summary = summaryMarkdown(r, { minGrade: 'B', webLink: link });
  const inSummary = (summary.match(URL_RE) || []).filter((u) => u !== link);
  assert.ok(inSummary.length > 0);
  for (const u of inSummary) assertTag(u, LINK_TAGS.action, 'job summary');
  assert.ok(summary.includes('](' + link + ')'), 'the web-checker link is written as it is');
  assert.ok(!/utm_/.test(link), 'the link that carries the tool list in its fragment has no tag');

  for (const s of [sarifWithLocations(r, text, 'tools.json'), sarifWithLocations(r, text, null)]) {
    const d = s.runs[0].tool.driver;
    assertTag(d.informationUri, LINK_TAGS.sarif, 'SARIF informationUri');
    assert.ok(d.rules.length > 0);
    for (const rule of d.rules) { assertTag(rule.helpUri, LINK_TAGS.sarif, 'SARIF helpUri'); assert.ok(rule.helpUri.startsWith(M.DOCS_BASE + rule.id + '?')); }
  }

  const md = M.toMarkdown(r);
  const report = tagDocsLinks(md, 'badge', { docsBase: M.DOCS_BASE, ids: Object.keys(M.CHECK) });
  const inReport = report.match(URL_RE) || [];
  assert.equal(inReport.length, (md.match(URL_RE) || []).length);
  for (const u of inReport) assertTag(u, LINK_TAGS.badge, 'badge report');
  assert.equal(report.replaceAll('?utm_source=mcp-check-badge&utm_medium=badge', ''), md, 'only the docs links change');
  const hostile = '| `[x](https://isokron.ai/mcp-check/checks/x)` | [not-a-check](https://isokron.ai/mcp-check/checks/not-a-check) | https://isokron.ai/mcp-check/checks/anthropic-title |';
  assert.equal(tagDocsLinks(hostile, 'badge', { docsBase: M.DOCS_BASE, ids: Object.keys(M.CHECK) }), hostile, 'text that is not one of the engine\'s own docs links is left alone');

  // Data that programs read: the engine's JSON report and SARIF export, and the docs values of findings.
  for (const f of M.allFindings(r)) assert.equal(M.CHECK[f.id].docs, M.DOCS_BASE + f.id);
  assert.ok(!/utm_/.test(M.toJSON(r)) && !/utm_/.test(M.toMarkdown(r)));

  const info = createServer().server._serverInfo;
  assertTag(info.websiteUrl, LINK_TAGS.server, 'serverInfo.websiteUrl');
});
