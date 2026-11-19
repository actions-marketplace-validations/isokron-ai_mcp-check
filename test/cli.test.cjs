'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const cli = path.join(__dirname, '..', 'bin', 'mcp-check.js');
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
const ex = path.join(__dirname, 'fixtures', 'example.json');

test('cli: text report, exit 0 without a threshold', () => { const r = run([ex]); assert.equal(r.status, 0); assert.match(r.stdout, /Anthropic directory\s+C/); });
test('cli: --min-grade fails below the threshold', () => { const r = run([ex, '--min-grade', 'B']); assert.equal(r.status, 1); assert.match(r.stdout, /Below --min-grade B: anthropic C, openai C/); });
test('cli: --min-grade passes a well-designed list on every section', () => { assert.equal(run([path.join(__dirname, 'catalogs/well-designed.json'), '--min-grade', 'A', '--sections', 'spec,anthropic,openai,security,quality,surface']).status, 0); });
test('cli: stdin, JSON and SARIF formats', () => {
  const j = JSON.parse(run(['-', '--format', 'json'], fs.readFileSync(ex, 'utf8')).stdout);
  assert.equal(j.rubric_version, '2.1.0');
  assert.equal(JSON.parse(run([ex, '--format', 'sarif']).stdout).version, '2.1.0');
  assert.match(run([ex, '--format', 'md']).stdout, /^# MCP tool list check/);
});
test('cli: --fix writes the fixed list; --compare fails on a high-risk change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcheck-'));
  const out = path.join(dir, 'fixed.json');
  assert.equal(run([ex, '--fix', out]).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).tools.length === 8);
  const flipped = JSON.parse(fs.readFileSync(ex, 'utf8'));
  flipped.tools.find((t) => t.name === 'close_issue').annotations.readOnlyHint = true;
  const f2 = path.join(dir, 'new.json'); fs.writeFileSync(f2, JSON.stringify(flipped));
  const r = run([f2, '--compare', ex]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HIGH RISK: close_issue/);
});
test('cli: bad input and usage exit 2', () => {
  assert.equal(run(['-'], 'not json').status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run([ex, '--format', 'xml']).status, 2);
});

const bin = path.join(__dirname, '..', 'bin');
const read = (f) => fs.readFileSync(f, 'utf8');
test('cli: --stdin, --version, --help, -o', () => {
  const r = run(['--stdin', '--format', 'json'], read(ex));
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.engine_version, require('../package.json').version);
  assert.equal(run(['--version']).stdout.trim(), require('../package.json').version);
  assert.match(run(['--help']).stdout, /mcp-check capture/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcheck-'));
  const out = path.join(dir, 'r.md');
  const w = run([ex, '--format', 'md', '-o', out]);
  assert.equal(w.status, 0);
  assert.match(read(out), /^# MCP tool list check/);
  assert.match(w.stderr, /Anthropic directory\s+C/, 'the text summary goes to stderr when the report goes to a file');
  assert.equal(run([ex, '--stdin'], '').status, 2, 'a file and --stdin together is a usage error');
});
test('cli: --sarif-uri gives every result a file location at the tool\'s line', () => {
  const s = JSON.parse(run([ex, '--format', 'sarif', '--sarif-uri', 'tools.json']).stdout);
  const lines = read(ex).split('\n');
  assert.ok(s.runs[0].results.length > 0);
  for (const res of s.runs[0].results) {
    const loc = res.locations[0].physicalLocation;
    assert.equal(loc.artifactLocation.uri, 'tools.json');
    const tool = res.locations[0].logicalLocations[0].name;
    if (tool !== 'tools/list') assert.ok(lines[loc.region.startLine - 1].includes('"' + tool + '"'), tool + ' at line ' + loc.region.startLine);
  }
  assert.equal(s.runs[0].tool.driver.semanticVersion, require('../package.json').version);
});
test('cli: capture lists a stdio server\'s tools (initialize and tools/list only), and the list grades', () => {
  const r = spawnSync(process.execPath, [path.join(bin, 'mcp-check.js'), 'capture', '--timeout', '30', '--', process.execPath, path.join(bin, 'mcp-check-server.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.tools.map((t) => t.name), ['check_tools_list', 'explain_check', 'compare_tools_lists']);
  assert.equal(run(['-', '--min-grade', 'A'], r.stdout).status, 0);
});
test('cli: capture reports a server that exits or is not found, with exit 3 (unreachable)', () => {
  const r = spawnSync(process.execPath, [path.join(bin, 'mcp-check.js'), 'capture', '--timeout', '10', '--', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /exited before answering \(exit 3/);
  const n = spawnSync(process.execPath, [path.join(bin, 'mcp-check.js'), 'capture', '--', 'no-such-command-mcp-check'], { encoding: 'utf8' });
  assert.equal(n.status, 3);
  assert.match(n.stderr, /did not start|exited before answering/);
  assert.equal(run(['capture']).status, 2);
});
test('cli: size, depth and tool-count limits; tool names cannot start a new output line', () => {
  const many = JSON.stringify({ tools: Array.from({ length: 2001 }, (_, i) => ({ name: 't' + i, inputSchema: { type: 'object' } })) });
  const r = run(['-'], many);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /stdin has 2001 tools; the limit is 2000/);
  assert.match(run(['-'], '['.repeat(100)).stderr, /nests deeper than 64 levels/);
  const t = run(['-'], JSON.stringify({ tools: [{ name: 'x\n::error::injected', inputSchema: { type: 'object' } }] }));
  assert.ok(!/^::error::/m.test(t.stdout), t.stdout);
});
