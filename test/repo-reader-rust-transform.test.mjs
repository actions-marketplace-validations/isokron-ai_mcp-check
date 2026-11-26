// Rust reader: #[schemars(transform = f)] on an argument struct or one of its fields (R-RD-36). Fixtures under
// test/repos/rust-transform/ are trimmed from public repositories (README.md there names each repository and commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RR = require('../src/inputs/repo-rust.cjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'mcp-check.js');
const FIX = join(HERE, 'repos', 'rust-transform');

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const readFixture = (name) => {
  const root = join(FIX, name);
  const files = walk(root).filter((p) => p.endsWith('.rs')).map((p) => [relative(root, p), readFileSync(p, 'utf8')]);
  return RR.analyse(files, { cargo: [['Cargo.toml', readFileSync(join(root, 'Cargo.toml'), 'utf8')]] });
};
const read = (files) => RR.analyse(Object.entries(files), { cargo: [] });
const byName = (r) => Object.fromEntries(r.found.map((x) => [x.tool.name, x]));

test('R-RD-36: a field transform that drops "null" from the type (docling.rs drop_null) is followed: ["string","null"] -> "string"', () => {
  const t = byName(readFixture('docling')).convert;
  const p = t.tool.inputSchema.properties;
  assert.deepEqual(p.uri, { type: 'string', description: 'The document to read: a URL, a file: URI, a data: URI, or a file path.' });
  assert.equal(p.to.type, 'string');
  assert.equal(p.images.type, 'string');
  assert.equal(p.options.type, 'object');
  assert.equal(p.options.additionalProperties, true);
  assert.deepEqual(t.tool.inputSchema.required, ['uri']);
  assert.equal(t.tool._unreadable, undefined);
  assert.deepEqual(t.marks, []);
});

test('R-RD-36: a container transform that splits nullable properties into anyOf (org-mcp-server nullable_as_any_of) is followed; annotation keys stay on the property', () => {
  const t = byName(readFixture('org'))['org-search'];
  const p = t.tool.inputSchema.properties;
  assert.deepEqual(p.query, { type: 'string', description: 'Search query string to find in org file content' });
  assert.deepEqual(p.limit, { description: 'Maximum number of search results to return (optional)', anyOf: [{ type: 'integer', format: 'uint', minimum: 0 }, { type: 'null' }] });
  assert.deepEqual(p.tags, { description: 'Filter results by tags (optional, matches any of the provided tags)', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] });
  assert.equal(t.tool._unreadable, undefined);
  assert.deepEqual(t.marks, []);
});

test('R-RD-36: a transform that inserts a pattern built with format! from constants (weather-bridge city_query_schema) is followed', () => {
  const r = readFixture('weather');
  const src = readFileSync(join(FIX, 'weather', 'src', 'cities.rs'), 'utf8');
  const raw = (name) => new RegExp('const ' + name + ': &str =\\s*r"([^"]*)"').exec(src)[1];
  const WS = raw('WHITESPACE'); const SCALAR = raw('SCALAR');
  const nws = '(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\uD800-\\uDFFF' + WS + '])';
  const want = '^[' + WS + ']*' + nws + SCALAR + '{0,118}' + nws + '[' + WS + ']*(?![\\s\\S])';
  const t = byName(r);
  assert.equal(t.search_cities.tool.inputSchema.properties.query.pattern, want);
  assert.equal(t.search_cities.tool.inputSchema.properties.query.type, 'string');
  assert.equal(t.get_weather.tool.inputSchema.properties.city.pattern, want);
  assert.deepEqual(t.get_weather.tool.inputSchema.properties.city.type, ['string', 'null']);
  assert.equal(t.get_weather.tool.inputSchema.properties.cityId.minimum, 1);
  assert.equal(t.get_weather.tool._unreadable, undefined);
});

const ARGS = (attr, fnSrc) => ({ 'src/lib.rs': `
use rmcp::{tool, tool_router, handler::server::wrapper::Parameters, schemars};
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct Req {
    /// Where to look.
    pub path: String,
    ${attr}
    pub limit: Option<u32>,
}
${fnSrc}
#[derive(Clone)] pub struct S;
#[tool_router]
impl S {
    /// Lists files.
    #[tool(annotations(read_only_hint = true))]
    async fn list_files(&self, Parameters(r): Parameters<Req>) -> String { String::new() }
}
` });

test('R-RD-36: a known transform is matched with its own names renamed; a one-token change to it is not followed', () => {
  const renamed = `fn single_type(s: &mut schemars::Schema) {
    if let Some(serde_json::Value::Array(ts)) = s.get("type").cloned() {
        let rest: Vec<_> = ts.into_iter().filter(|x| x != "null").collect();
        if let [one] = rest.as_slice() { s.insert("type".into(), one.clone()); }
    }
    if s.get("default") == Some(&serde_json::Value::Null) { s.remove("default"); }
}`;
  const a = byName(read(ARGS('#[schemars(transform = single_type)]', renamed))).list_files;
  assert.equal(a.tool.inputSchema.properties.limit.type, 'integer');
  assert.equal(a.tool._unreadable, undefined);
  // keeps "integer" instead of dropping "null": not the known transform, and not guessed
  const changed = renamed.replace('x != "null"', 'x != "integer"');
  const b = byName(read(ARGS('#[schemars(transform = single_type)]', changed))).list_files;
  assert.deepEqual(b.tool._unreadable, ['inputSchema']);
  assert.deepEqual(b.marks.map((m) => m.reason), ['schema-transform (single_type)']);
  assert.equal(b.tool.description, 'Lists files.');
  assert.deepEqual(b.tool.annotations, { readOnlyHint: true });
});

test('R-RD-36: a transform the reader cannot follow keeps the tool, marks its input schema not readable and names the function; never the untransformed schema', () => {
  const cases = [
    // a body that is neither a known transform nor plain inserts
    ['#[schemars(transform = widen)]', 'fn widen(schema: &mut schemars::Schema) { for k in ["minimum", "maximum"] { schema.remove(k); } }', 'widen'],
    // an insert whose value is computed at run time
    ['#[schemars(transform = stamp)]', 'fn stamp(schema: &mut schemars::Schema) { schema.insert("default".into(), std::env::var("LIMIT").unwrap().into()); }', 'stamp'],
    // a function that is not in the repository
    ['#[schemars(transform = other_crate::tighten)]', '', 'tighten'],
    // an expression, not a function path
    ['#[schemars(transform = RecursiveTransform(drop_null))]', '', 'an expression'],
  ];
  for (const [attr, fnSrc, name] of cases) {
    const r = read(ARGS(attr, fnSrc));
    const x = byName(r).list_files;
    assert.ok(x, attr);
    assert.deepEqual(x.tool._unreadable, ['inputSchema'], attr);
    assert.deepEqual(x.marks.map((m) => m.reason), ['schema-transform (' + name + ')'], attr);
  }
  // container level as well
  const cont = ARGS('', 'fn shrink(schema: &mut schemars::Schema) { schema.remove("properties"); }');
  cont['src/lib.rs'] = cont['src/lib.rs'].replace('pub struct Req {', '#[schemars(transform = shrink)]\npub struct Req {');
  assert.deepEqual(byName(read(cont)).list_files.tool._unreadable, ['inputSchema']);
});

test('R-RD-36: --repo-dir says which tools have a transform it does not follow, and grades the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-rs-tf-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nrmcp = "3"\n');
  writeFileSync(join(dir, 'src', 'lib.rs'), ARGS('#[schemars(transform = widen)]', 'fn widen(schema: &mut schemars::Schema) { for k in ["minimum"] { schema.remove(k); } }')['src/lib.rs']);
  const r = spawnSync(process.execPath, [BIN, '--repo-dir', dir, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /1 tool with a schemars transform the reader does not follow \(widen\), input schema not read/);
  assert.match(r.stderr, /not readable from source, so their checks are skipped: 1 input schema/);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.source.unreadable, { inputSchema: ['list_files'] });
});
