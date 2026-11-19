import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = fileURLToPath(new URL('../bin/mcp-check-server.js', import.meta.url));
const ex = readFileSync(new URL('./fixtures/example.json', import.meta.url), 'utf8');

test('stdio: SDK client round trip over every tool', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: 'pipe' }));
  try {
    assert.equal(client.getServerVersion().name, 'mcp-check');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);

    // The client validates structuredContent against each tool's outputSchema.
    const c = await client.callTool({ name: 'check_tools_list', arguments: { tools_list: ex, min_grade: 'B', include_fixed_list: false } });
    assert.equal(c.isError, undefined);
    assert.equal(c.structuredContent.passed, false);
    assert.match(c.content[0].text, /anthropic C/);

    const e = await client.callTool({ name: 'explain_check', arguments: { check_id: 'openai-hints-explicit' } });
    assert.equal(e.structuredContent.id, 'openai-hints-explicit');

    const d = await client.callTool({ name: 'compare_tools_lists', arguments: { before: ex, after: JSON.parse(ex) } });
    assert.equal(d.structuredContent.identical, true);

    const bad = await client.callTool({ name: 'check_tools_list', arguments: { tools_list: '['.repeat(1000) } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /nests deeper than 64 levels/);

    const extra = await client.callTool({ name: 'check_tools_list', arguments: { tools_list: ex, extra: 1 } });
    assert.equal(extra.isError, true);
    assert.match(extra.content[0].text, /Unrecognized key: "extra"/);
  } finally {
    await client.close();
  }
});
