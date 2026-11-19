import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToolsList, compareToolsLists } from '../src/tools.js';
import { MAX_BYTES, MAX_DEPTH, MAX_TOOLS } from '../src/limits.js';

const tool = (i) => ({ name: 't' + i, inputSchema: { type: 'object' } });
const nest = (n) => { let v = {}; for (let i = 0; i < n; i++) v = { a: v }; return v; };

test('limits: JSON text over 2 MiB is refused before parsing', () => {
  const big = JSON.stringify({ tools: [{ name: 'x', description: 'a'.repeat(MAX_BYTES), inputSchema: { type: 'object' } }] });
  assert.throws(() => checkToolsList({ tools_list: big }), (e) => e.code === 'too_large' && /limit is 2\.00 MiB/.test(e.message));
});

test('limits: an object over 2 MiB is refused', () => {
  const big = { tools: [{ name: 'x', description: 'a'.repeat(MAX_BYTES), inputSchema: { type: 'object' } }] };
  assert.throws(() => checkToolsList({ tools_list: big }), (e) => e.code === 'too_large');
});

test('limits: nesting deeper than the cap is refused, as text and as a value', () => {
  const deep = { tools: [{ name: 'x', inputSchema: { type: 'object', properties: nest(MAX_DEPTH + 5) } }] };
  assert.throws(() => checkToolsList({ tools_list: deep }), (e) => e.code === 'too_deep');
  assert.throws(() => checkToolsList({ tools_list: JSON.stringify(deep) }), (e) => e.code === 'too_deep');
  assert.throws(() => checkToolsList({ tools_list: '['.repeat(100000) }), (e) => e.code === 'too_deep');
  assert.ok(checkToolsList({ tools_list: { tools: [{ name: 'x', inputSchema: { type: 'object', properties: nest(20) } }] } }));
});

test('limits: too many tools, bad JSON and wrong types give clear errors', () => {
  const many = { tools: Array.from({ length: MAX_TOOLS + 1 }, (_, i) => tool(i)) };
  assert.throws(() => checkToolsList({ tools_list: many }), (e) => e.code === 'too_many_tools');
  assert.throws(() => checkToolsList({ tools_list: '{not json' }), (e) => e.code === 'not_json' && /^tools_list: /.test(e.message));
  assert.throws(() => checkToolsList({ tools_list: { foo: 1 } }), (e) => e.code === 'no_tools_key');
  assert.throws(() => checkToolsList({ tools_list: 42 }), (e) => e.code === 'bad_type');
  assert.throws(() => compareToolsLists({ before: '[]x', after: '[]' }), (e) => /^before: /.test(e.message));
});
