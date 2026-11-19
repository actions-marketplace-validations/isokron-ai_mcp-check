#!/usr/bin/env node
// Lists this server's own tools over an in-memory MCP connection and grades them with the engine.
//   node scripts/dogfood.mjs           print the grade table (Markdown)
//   node scripts/dogfood.mjs --json    print the tools/list answer
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { checkToolsList } from '../src/tools.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function ownToolsList() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'dogfood', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const list = await client.listTools();
  await client.close();
  return list;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = await ownToolsList();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(list, null, 2)); process.exit(0); }
  const { report } = checkToolsList({ tools_list: list });
  console.log('| Section | Grade | Score | Blocking | Attention | Advice | Note |\n|---|---|---|---|---|---|---|');
  for (const s of report.sections) {
    if (s.grade == null) console.log('| ' + s.name + ' | not graded | | | | | ' + (s.note || '') + ' |');
    else console.log('| ' + s.name + ' | ' + s.grade + ' | ' + s.score + ' | ' + s.counts.blocking + ' | ' + s.counts.attention + ' | ' + s.counts.advice + ' | |');
  }
  console.log('\nRubric ' + report.rubric_version + ', ' + report.input.tools + ' tools, catalog hash `' + report.input.catalog_hash + '`.');
  if (report.findings.length) { console.log(''); report.findings.forEach((f) => console.log('- ' + f.severity + ' ' + (f.tool || '(list)') + ' ' + f.id + ': ' + f.message)); }
}
