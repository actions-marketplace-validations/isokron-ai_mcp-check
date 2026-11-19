// The public docs say what the code does: the Action's inputs and outputs in docs/github-action.md are
// those of action.yml, with the same defaults; every option the README and the docs name is one the
// command line accepts, and every option it accepts is in --help and in the README; the exit codes and
// the limits in the README are the ones the CLI prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { MAX_BYTES, MAX_DEPTH, MAX_TOOLS } from '../src/limits.js';
import { ALL_SECTIONS, DEFAULT_SECTIONS } from '../src/report.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(join(root, f), 'utf8');
const help = spawnSync(process.execPath, [join(root, 'bin', 'mcp-check.js'), '--help'], { encoding: 'utf8' }).stdout;

/** The inputs or outputs block of action.yml: name -> default (inputs) or true (outputs). No YAML library: the file's own layout. */
function actionBlock(name) {
  const lines = read('action.yml').split('\n');
  const start = lines.indexOf(name + ':');
  assert.ok(start >= 0, name);
  const out = {};
  let cur = null;
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const key = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(lines[i]);
    if (key) { cur = key[1]; out[cur] = name === 'inputs' ? undefined : true; continue; }
    const def = /^ {4}default:\s*(.*)$/.exec(lines[i]);
    if (def && cur && name === 'inputs') out[cur] = def[1].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** Rows of the first Markdown table after `heading`: arrays of cell text. */
function tableAfter(md, heading) {
  const at = md.indexOf('\n' + heading + '\n');
  assert.ok(at >= 0, heading);
  const rows = [];
  for (const l of md.slice(at + heading.length + 2).split('\n')) {
    if (l.startsWith('|')) rows.push(l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()));
    else if (rows.length) break;
  }
  return rows.slice(2);
}
const unTick = (s) => s.replace(/^`|`$/g, '');

test('docs: the inputs table in docs/github-action.md is action.yml\'s inputs, in order, with the same defaults', () => {
  const inputs = actionBlock('inputs');
  const rows = tableAfter(read('docs/github-action.md'), '## Inputs');
  assert.deepEqual(rows.map((r) => unTick(r[0])), Object.keys(inputs));
  for (const [name, def] of rows.map((r) => [unTick(r[0]), unTick(r[1])])) assert.equal(def, inputs[name], 'default of ' + name);
});

test('docs: the outputs listed in docs/github-action.md are action.yml\'s outputs', () => {
  const md = read('docs/github-action.md');
  const para = md.slice(md.indexOf('\n## Outputs\n')).split('\n').find((l) => l.startsWith('`'));
  assert.deepEqual([...para.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]).filter((n) => n !== 'true' && n !== 'false'), Object.keys(actionBlock('outputs')));
});

test('docs: Action inputs used in the README and the docs examples exist', () => {
  const inputs = new Set(Object.keys(actionBlock('inputs')));
  for (const f of ['README.md', 'docs/github-action.md']) {
    for (const block of read(f).matchAll(/```yaml\n([\s\S]*?)```/g)) {
      const withAt = block[1].split('\n');
      for (let i = 0; i < withAt.length; i++) {
        if (!/uses: isokron-ai\/mcp-check@/.test(withAt[i])) continue;
        const indent = withAt[i].search(/\S/) - (withAt[i].trimStart().startsWith('- ') ? 0 : 2);
        for (let j = i + 2; j < withAt.length && /^\s*$/.test(withAt[j]) === false && withAt[j].search(/\S/) > indent + 2; j++) {
          const k = /^\s+([a-z][a-z-]*):/.exec(withAt[j]);
          if (k) assert.ok(inputs.has(k[1]), f + ': ' + k[1] + ' is not an input of action.yml');
        }
      }
    }
  }
});

/** Long options the parser accepts, found by trying each candidate named anywhere in the source or the docs. */
function accepted(flag) {
  for (const argv of [[flag, 'x', 'f.json'], [flag, 'f.json'], [flag], [flag, 'x'], [flag, 'A', 'f.json'], [flag, 'a:b', '--url', 'https://h/mcp'], [flag, 'A=b', '--command', 'x'], [flag, '5', 'f.json']]) {
    try { parseArgs(argv); return true; } catch (e) { if (!/^unknown option /.test(e.message) && !/^unexpected argument /.test(e.message)) return true; if (/^unknown option /.test(e.message)) return false; }
  }
  return false;
}

test('docs: every option the README, the docs and the changelog name is accepted, and every accepted option is in --help and the README', () => {
  const named = (text) => new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((m) => m[0]));
  // Options of other programs that the docs show inside commands (npm, npx, the MCP inspector, claude).
  const foreign = new Set(['--cli', '--method', '--ignore-scripts', '--no-audit', '--no-fund', '--dry-run', '--access', '--tag', '--verify', '--memory', '--skill', '--agent', '--yes']);
  const readme = named(read('README.md'));
  for (const f of ['README.md', 'docs/github-action.md', 'CHANGELOG.md']) {
    for (const flag of named(read(f))) { if (foreign.has(flag)) continue; assert.ok(accepted(flag), f + ' names ' + flag + ', which the command line does not accept'); }
  }
  const inHelp = named(help);
  for (const flag of inHelp) assert.ok(accepted(flag), '--help names ' + flag + ', which the command line does not accept');
  const inSource = named(read('src/cli.js'));
  for (const flag of inSource) {
    if (!accepted(flag)) continue;
    assert.ok(inHelp.has(flag), flag + ' is accepted and missing from --help');
    assert.ok(readme.has(flag), flag + ' is accepted and missing from README.md');
  }
});

test('docs: exit codes, sections, default sections and limits in the README are the ones the CLI prints', () => {
  const readme = read('README.md');
  const codes = /Exit codes: ([\s\S]*?)\.\n/.exec(help)[1].replace(/\s+/g, ' ');
  const inReadme = /Exit codes: (.*?)\.\n/.exec(readme)[1].replace(/`/g, '');
  assert.equal(inReadme, codes);
  assert.ok(readme.includes(ALL_SECTIONS.map((s) => '`' + s + '`').join(', ')), 'the six sections');
  assert.ok(readme.includes('(default `' + DEFAULT_SECTIONS.join(',') + '`)'), 'the default sections');
  assert.ok(readme.includes(MAX_BYTES / 1048576 + ' MiB of JSON, ' + MAX_DEPTH + ' levels of nesting and ' + MAX_TOOLS.toLocaleString('en-US') + ' tools'), 'the input limits');
  assert.match(readme, /`--timeout seconds` \| One overall limit .* \(default 60\)/);
  assert.equal(parseArgs(['f.json']).timeout, 60);
  assert.equal(parseArgs(['f.json']).format, 'text');
});
