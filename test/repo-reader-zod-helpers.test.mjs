// Zod helpers in TypeScript servers (R-RD-25 onwards): .regex(), bounds from constants, schema factory functions and
// the other zod constructs three real servers needed. Each fixture is trimmed from the server it names, at the commit
// named, with the handlers and unrelated tools removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const tool = (an, n) => { const x = an.tools.find((y) => y.tool.name === n); assert.ok(x, 'no tool ' + n + ' in ' + an.tools.map((y) => y.tool.name).join(', ')); return x.tool; };
const ZOD3 = '{"dependencies": {"@modelcontextprotocol/sdk": "1.29.0", "zod": "3.25.76"}}';
const ZOD4 = '{"dependencies": {"@modelcontextprotocol/sdk": "1.32.2", "zod": "4.6.7"}}';
const SAFE = 9007199254740991;

// ---------------------------------------------------------------- R-RD-25: .regex() -> pattern
// Trimmed from isokron-ai/mcp-check d4a373a5f785db4631c18aad97df658836bbc2d1 src/server.js (explain_check) and
// barzoj/somtoday-mcp 51b0d5f334d6971a9c800fdf14dde84508fdb8ef src/server.ts (school_info, download_attachment).
test('R-RD-25: .regex(/…/) is written as the JSON Schema pattern (in a chain, in a union branch, with a message or flags); two regexes leave it out', () => {
  const an = read({ 'package.json': ZOD4, 'src/server.ts': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { z } from 'zod';",
    "const server = new McpServer({ name: 'somtoday', version: '1.0.0' });",
    "server.registerTool('explain_check', {",
    "  description: 'Returns the documentation for one check by its id.',",
    "  inputSchema: { check_id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).describe('Check id from a check_tools_list finding.') },",
    "}, async () => ({ content: [] }));",
    "server.registerTool('school_info', {",
    "  description: 'School contact data per child.',",
    "  inputSchema: {",
    "    paginaId: z.union([z.number().int().min(-2), z.string().regex(/^(-[12]|\\d+)$/)]).transform(String).optional().describe('Information page id.'),",
    "    bestanddataId: z.string().regex(/^[A-Za-z0-9._~-]{1,200}$/, 'bad id').optional(),",
    "    folded: z.string().regex(/^[a-z]+$/i),",
    "    twice: z.string().regex(/^a/).regex(/b$/),",
    "    thrice: z.string().regex(/^a/).regex(/b/).regex(/c$/),",
    "  },",
    "}, async () => ({ content: [] }));",
  ].join('\n') });
  assert.deepEqual(tool(an, 'explain_check').inputSchema.properties.check_id, { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9-]+$', description: 'Check id from a check_tools_list finding.' });
  const p = tool(an, 'school_info').inputSchema.properties;
  assert.deepEqual(p.paginaId, { anyOf: [{ type: 'integer', minimum: -2, maximum: SAFE }, { type: 'string', pattern: '^(-[12]|\\d+)$' }], description: 'Information page id.' });
  assert.deepEqual(p.bestanddataId, { type: 'string', pattern: '^[A-Za-z0-9._~-]{1,200}$' });
  assert.deepEqual(p.folded, { type: 'string', pattern: '^[a-z]+$' }, 'flags are not carried into the pattern');
  assert.deepEqual(p.twice, { type: 'string' }, 'two patterns go to allOf in the SDK; the reader leaves them out rather than guess');
  assert.deepEqual(p.thrice, { type: 'string' });
});

// ---------------------------------------------------------------- R-RD-26: bounds and numbers from constants
// Trimmed from isokron-ai/mcp-check d4a373a5f785db4631c18aad97df658836bbc2d1 src/server.js, src/tools.js and
// src/limits.js (check_tools_list), with two section names masked. The `unknown` bound is added: a value only known
// at run time.
test('R-RD-26: .min/.max/.length take a literal constant, .length of a constant array and arithmetic of literals; a bound that cannot be read is left out', () => {
  const an = read({ 'package.json': ZOD4,
    'src/tools.js': [
      "export const SECTIONS = ['spec', 'dir-a', 'dir-b', 'security', 'quality', 'surface'];",
      'export const MAX_FINDINGS = 500;',
      'export const DEFAULT_LIMIT = 100;',
    ].join('\n'),
    'src/limits.js': 'export const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB of JSON per list\nexport const MAX_TOOLS = 2000;\n',
    'src/server.js': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import * as z from 'zod/v4';",
      "import { SECTIONS, DEFAULT_LIMIT, MAX_FINDINGS } from './tools.js';",
      "import { MAX_BYTES, MAX_TOOLS } from './limits.js';",
      "const server = new McpServer({ name: 'mcp-check', version: '1.0.0' });",
      "server.registerTool('check_tools_list', {",
      "  description: 'Grades a tools/list answer. Limit ' + MAX_BYTES / 1048576 + ' MiB of JSON and ' + MAX_TOOLS + ' tools.',",
      '  inputSchema: z.strictObject({',
      "    sections: z.array(z.enum(SECTIONS)).min(1).max(SECTIONS.length).optional().describe('Sections to report.'),",
      "    limit: z.number().int().min(1).max(MAX_FINDINGS).default(DEFAULT_LIMIT).describe('Most findings to return.'),",
      '    pair: z.array(z.string()).length(SECTIONS.length - 4),',
      '    bytes: z.string().max(MAX_BYTES - 1),',
      '    unknown: z.string().max(Number(process.env.MAX_LEN)),',
      '  }),',
      '}, async () => ({ content: [] }));',
    ].join('\n') });
  const t = tool(an, 'check_tools_list');
  assert.equal(t.description, 'Grades a tools/list answer. Limit 2 MiB of JSON and 2000 tools.');
  const p = t.inputSchema.properties;
  assert.deepEqual(p.sections, { type: 'array', items: { type: 'string', enum: ['spec', 'dir-a', 'dir-b', 'security', 'quality', 'surface'] }, minItems: 1, maxItems: 6, description: 'Sections to report.' });
  assert.deepEqual(p.limit, { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Most findings to return.' });
  assert.deepEqual(p.pair, { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 });
  assert.deepEqual(p.bytes, { type: 'string', maxLength: 2097151 });
  assert.deepEqual(p.unknown, { type: 'string' }, 'a bound known only at run time is left out, not guessed');
});

// A constant array with an element the reader could not read has no known length.
// Trimmed from the same file; the spread element is added.
test('R-RD-26: .length of a constant array with a spread or an unreadable element is not a bound', () => {
  const an = read({ 'package.json': ZOD4, 'src/server.js': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import * as z from 'zod/v4';",
    "import { EXTRA } from 'somewhere-else';",
    "const SECTIONS = ['spec', 'quality', ...EXTRA];",
    "const server = new McpServer({ name: 'mcp-check', version: '1.0.0' });",
    "server.registerTool('check_tools_list', { description: 'Grades a list.', inputSchema: { sections: z.array(z.string()).max(SECTIONS.length) } }, async () => ({ content: [] }));",
  ].join('\n') });
  assert.deepEqual(tool(an, 'check_tools_list').inputSchema.properties.sections, { type: 'array', items: { type: 'string' } });
});
