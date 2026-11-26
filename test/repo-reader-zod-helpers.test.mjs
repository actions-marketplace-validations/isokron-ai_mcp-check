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
