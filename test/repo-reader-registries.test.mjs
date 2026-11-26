// Source reader: tools registered through a register helper imported from another file (R-RD-32), registries of tool
// definitions iterated to register them, typed or imported from another module (R-RD-33), and Python lists of
// functions iterated to add_tool (R-RD-34). Fixtures are trimmed from real servers, credited at each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const names = (an) => an.tools.map((x) => x.tool.name).sort();
const tool = (an, n) => { const x = an.tools.find((y) => y.tool.name === n); assert.ok(x, 'no tool ' + n + ' in ' + names(an).join(', ')); return x.tool; };
const PKG = (sdk) => `{"dependencies": {"@modelcontextprotocol/sdk": "${sdk || '1.10.1'}", "zod": "3.24.3"}}`;
const SERVER = "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nconst server = new McpServer({ name: 'x', version: '1.0.0' });\n";
const D7 = 'http://json-schema.org/draft-07/schema#';

// ---------------------------------------------------------------- R-RD-32: imported register helpers
// Trimmed from clssck/dataiku_mcp @ 1d20e26b95a38d06ca67df49168940f984bd446e (src/tools/register-tool.ts:121,
// src/tools/datasets.ts:448): a generic helper named like the SDK method, the config forwarded with a cast.
const DATAIKU_HELPER = [
  "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  'type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };',
  'export function registerTool<TArgs extends unknown[]>(',
  '  server: McpServer,',
  '  name: string,',
  '  config: Record<string, unknown>,',
  '  handler: (...args: TArgs) => ToolResult | Promise<ToolResult>,',
  ') {',
  '  return server.registerTool(',
  '    name,',
  '    config as never,',
  '    (async (...args: TArgs) => handler(...args)) as never,',
  '  );',
  '}',
].join('\n');

test('R-RD-32: a registerTool(server, name, config, cb) helper imported from another file (generic, config cast as never) is read at each call', () => {
  const an = read({
    'package.json': PKG('1.26.0'),
    'src/tools/register-tool.ts': DATAIKU_HELPER,
    'src/tools/datasets.ts': [
      "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { z } from 'zod';",
      "import { registerTool } from './register-tool.js';",
      'export function register(server: McpServer) {',
      '  registerTool(',
      '    server,',
      '    "dataset",',
      '    {',
      '      description:',
      '        "Dataset ops: list/get/schema/preview/metadata/download/create/update/delete.",',
      '      inputSchema: z.object({ datasetName: z.string(), limit: z.number().optional() }),',
      '    },',
      '    async (args: Record<string, unknown>) => ({ content: [{ type: "text", text: String(args) }] }),',
      '  );',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['dataset']);
  const t = tool(an, 'dataset');
  assert.equal(t.description, 'Dataset ops: list/get/schema/preview/metadata/download/create/update/delete.');
  assert.deepEqual(t.inputSchema.properties, { datasetName: { type: 'string' }, limit: { type: 'number' } });
  assert.deepEqual(t.inputSchema.required, ['datasetName']);
  assert.equal(an.unresolved, 0);
});

// Trimmed from anoopt/outlook-meetings-scheduler-mcp-server @ d77d3ed54269f4538706c36db625d82775edeec2
// (src/utils/tool-registration.ts:8, src/tools/people.ts:10): positional arguments forwarded to server.tool.
test('R-RD-32: a helper imported from another file that forwards to server.tool(name, description, shape, cb) is read with its schema', () => {
  const an = read({
    'package.json': PKG(),
    'src/utils/tool-registration.ts': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      'export function registerTool(',
      '  server: McpServer,',
      '  name: string,',
      '  description: string,',
      '  params: any,',
      '  handler: (args: any) => Promise<any>',
      '): void {',
      '  server.tool(',
      '    name,',
      '    description,',
      '    params,',
      '    async (args: any) => {',
      '      try { return await handler(args); } catch (error) { return { content: [{ type: "text", text: "Error" }] }; }',
      '    }',
      '  );',
      '}',
    ].join('\n'),
    'src/tools/people.ts': [
      "import { z } from 'zod';",
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { registerTool } from '../utils/tool-registration.js';",
      'export function registerPeopleTools(server: McpServer): void {',
      '  registerTool(',
      '    server,',
      '    "find-person",',
      '    "Find a person\'s email address by their name",',
      '    {',
      '      name: z.string().describe("Name or partial name of the person to find"),',
      '      maxResults: z.number().optional().describe("Maximum number of people to return"),',
      '    },',
      '    async ({ name }) => ({ content: [{ type: "text", text: name }] })',
      '  );',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['find-person']);
  assert.deepEqual(tool(an, 'find-person'), {
    name: 'find-person',
    description: "Find a person's email address by their name",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name or partial name of the person to find' }, maxResults: { type: 'number', description: 'Maximum number of people to return' } },
      required: ['name'],
      additionalProperties: false,
      $schema: D7,
    },
  });
});

// Shape of mauricio-cantu/brasil-api-mcp-server @ 433f4756342d5c5e5a459f179e47d212f35c4088 (src/utils/index.ts:8,
// src/index.ts:30-41), with the tool objects kept in the calling file (the typed, imported form is R-RD-33).
test('R-RD-32: registerTool(server, tool) forwarding tool.name, tool.description and tool.params, called in a loop over a known list, is read once per element', () => {
  const an = read({
    'package.json': PKG('1.7.0'),
    'src/utils/index.ts': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      'export const registerTool = (server: McpServer, tool: any) => {',
      '  server.tool(tool.name, tool.description, tool.params, tool.handler);',
      '};',
    ].join('\n'),
    'src/index.ts': [
      "import { z } from 'zod';",
      SERVER,
      "import { registerTool } from './utils/index.js';",
      'const getCepTool = { name: "get_postal_code_v1", description: "Get a location data given a CEP (postal code).", params: { cep: z.string().describe("The CEP to query") }, handler: async () => ({ content: [] }) };',
      'const getAllBanksTool = { name: "get_all_banks", description: "Get information of all banks from Brazil.", params: {}, handler: async () => ({ content: [] }) };',
      'const tools = [getCepTool, getAllBanksTool];',
      'tools.forEach((tool) => {',
      '  registerTool(server, tool);',
      '});',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['get_all_banks', 'get_postal_code_v1']);
  assert.deepEqual(tool(an, 'get_postal_code_v1').inputSchema, { type: 'object', properties: { cep: { type: 'string', description: 'The CEP to query' } }, required: ['cep'], additionalProperties: false, $schema: D7 });
  assert.deepEqual(tool(an, 'get_all_banks').inputSchema, { type: 'object', properties: {}, additionalProperties: false, $schema: D7 });
  assert.equal(an.unresolved, 0);
});

test('R-RD-32: an imported helper called with a name the reader cannot work out is counted as unresolved and not listed; a helper from a package is not followed', () => {
  const an = read({
    'package.json': PKG(),
    'src/reg.ts': "export function registerTool(server: any, name: string, description: string, shape: any, cb: any) { server.tool(name, description, shape, cb); }\n",
    'src/index.ts': [
      "import { z } from 'zod';",
      SERVER,
      "import { registerTool } from './reg.js';",
      "import { registerTool as fromPkg } from 'some-helper-package';",
      'const prefix = process.env.PREFIX;',
      'registerTool(server, prefix + "_search", "Search the index.", { q: z.string() }, async () => ({ content: [] }));',
      'fromPkg(server, "elsewhere", "Not followed.", { q: z.string() }, async () => ({ content: [] }));',
      'registerTool(server, "lookup", "Look up one record.", { id: z.string() }, async () => ({ content: [] }));',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['lookup']);
  assert.equal(an.unresolved, 1);
  assert.equal(an.unresolvedList[0].description, 'Search the index.');
});
