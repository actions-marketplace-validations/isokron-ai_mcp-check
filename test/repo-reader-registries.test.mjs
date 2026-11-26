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
    'src/reg.ts': "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport function registerTool(server: McpServer, name: string, description: string, shape: any, cb: any) { server.tool(name, description, shape, cb); }\n",
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

// Synthetic, in the shape of the outlook helper above. A .tool() method of another library (a CLI builder) is not the
// SDK's: a helper forwarding to it is a helper only in a file that imports the MCP SDK, or when its receiver is a
// parameter typed McpServer (imported here through a module of the repository).
test('R-RD-32: a helper forwarding to X.tool(…) is a register helper only in a file importing the MCP SDK or on a parameter typed McpServer', () => {
  const an = read({
    'package.json': PKG(),
    'src/types.ts': "export type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n",
    'src/cli.ts': "import { program } from 'commander';\nexport function addCommand(cli: any, name: string, description: string, opts: any, cb: any) { cli.tool(name, description, opts, cb); }\n",
    'src/typed.ts': "import type { McpServer } from './types.js';\nexport function addTool(server: McpServer, name: string, description: string, shape: any, cb: any) { server.tool(name, description, shape, cb); }\n",
    'src/index.ts': [
      "import { z } from 'zod';",
      SERVER,
      "import { addCommand } from './cli.js';",
      "import { addTool } from './typed.js';",
      'addCommand(program, "build", "Build the project.", { watch: true }, () => {});',
      'addTool(server, "lookup", "Look up one record.", { id: z.string() }, async () => ({ content: [] }));',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['lookup']);
  assert.equal(an.unresolved, 0);
});

// Synthetic, in the shape of the outlook helper above: a description the reader cannot read (getDesc()) is marked
// unread, and the shape is still the shape argument, not the description's place.
test('R-RD-32: a helper called with a description the reader cannot read marks the description unread and reads the shape from its own argument', () => {
  const HELPER = "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport function registerTool(server: McpServer, name: string, description: string, params: any, cb: any) { server.tool(name, description, params, cb); }\n";
  const an = read({
    'package.json': PKG(),
    'src/h.ts': HELPER,
    'src/s.ts': [
      "import { z } from 'zod';",
      SERVER,
      "import { registerTool } from './h.js';",
      'registerTool(server, "x", getDesc(), { q: z.string() }, async () => ({ content: [] }));',
      'registerTool(server, "y", getDesc(), async () => ({ content: [] }));',
      'registerTool(server, "z", { q: z.string() }, async () => ({ content: [] }));',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['x', 'y', 'z']);
  const x = an.tools.find((t) => t.tool.name === 'x').tool;
  assert.equal(x.description, undefined);
  assert.deepEqual(x._unreadable, ['description']);
  assert.deepEqual(x.inputSchema.properties, { q: { type: 'string' } });
  const y = an.tools.find((t) => t.tool.name === 'y').tool;
  assert.deepEqual(y._unreadable, ['description', 'inputSchema'], 'the callback in the shape\'s place is not a shape');
  const z = an.tools.find((t) => t.tool.name === 'z').tool;
  assert.deepEqual(z.inputSchema.properties, { q: { type: 'string' } }, 'a shape in the description\'s place is the shape, as the SDK reads it');
  assert.equal(z._unreadable, undefined);
});

// ---------------------------------------------------------------- R-RD-33: typed and imported registries
// Trimmed from mauricio-cantu/brasil-api-mcp-server @ 433f4756342d5c5e5a459f179e47d212f35c4088 (src/tools/cep-v1.ts:12,
// src/tools/banks.ts:6, src/index.ts:30-41, src/utils/index.ts:8).
test('R-RD-33: typed tool objects exported by other files (const t: ToolDefinition<P> = {…}), listed and registered with forEach through an imported helper, are read', () => {
  const an = read({
    'package.json': PKG('1.7.0'),
    'src/types/MCP.ts': "import { ZodRawShape } from 'zod';\nexport interface McpToolDefinition<Args extends ZodRawShape = any> { name: string; description: string; params: Args; handler: any; }\n",
    'src/utils/index.ts': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { McpToolDefinition } from '../types/MCP.js';",
      'export const registerTool = (server: McpServer, tool: McpToolDefinition) => {',
      '  server.tool(tool.name, tool.description, tool.params, tool.handler);',
      '};',
    ].join('\n'),
    'src/tools/cep-v1.ts': [
      "import { z } from 'zod';",
      "import { McpToolDefinition } from '../types/MCP.js';",
      'const getCepToolParams = {',
      '  cep: z.string().describe("The CEP to query"),',
      '};',
      'type GetCepToolParams = typeof getCepToolParams;',
      'export const getCepTool: McpToolDefinition<GetCepToolParams> = {',
      '  name: "get_postal_code_v1",',
      '  description: "Get a location data given a CEP (postal code).",',
      '  params: getCepToolParams,',
      '  handler: async ({ cep }) => {',
      '    return { content: [{ type: "text", text: cep }] };',
      '  },',
      '};',
    ].join('\n'),
    'src/tools/banks.ts': [
      "import { McpToolDefinition } from '../types/MCP.js';",
      'export const getAllBanksTool: McpToolDefinition = {',
      '  name: "get_all_banks",',
      '  description: "Get information of all banks from Brazil.",',
      '  params: {},',
      '  handler: async () => ({ content: [] }),',
      '};',
    ].join('\n'),
    'src/index.ts': [
      SERVER,
      "import { getCepTool } from './tools/cep-v1.js';",
      "import { getAllBanksTool } from './tools/banks.js';",
      "import { registerTool } from './utils/index.js';",
      'const tools = [',
      '  getCepTool,',
      '  getAllBanksTool,',
      '];',
      'tools.forEach((tool) => {',
      '  registerTool(server, tool);',
      '});',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['get_all_banks', 'get_postal_code_v1']);
  assert.deepEqual(tool(an, 'get_postal_code_v1'), {
    name: 'get_postal_code_v1',
    description: 'Get a location data given a CEP (postal code).',
    inputSchema: { type: 'object', properties: { cep: { type: 'string', description: 'The CEP to query' } }, required: ['cep'], additionalProperties: false, $schema: D7 },
  });
  assert.equal(an.unresolved, 0);
});

const REGISTRY = [
  "import { z } from 'zod';",
  'export const TOOLS = [',
  "  { id: 'alpha', summary: 'First tool.', args: { q: z.string() } },",
  "  { id: 'beta', summary: 'Second tool.', args: { n: z.number().optional() } },",
  '];',
].join('\n');
const LOOP = [
  SERVER,
  "import { TOOLS } from './registry.js';",
  'for (const def of TOOLS) {',
  '  server.registerTool(def.id, { description: def.summary, inputSchema: def.args }, async () => ({ content: [] }));',
  '}',
].join('\n');

test('R-RD-33: a registry array imported from another module and iterated with for…of to registerTool is read, its keys mapped as the call maps them', () => {
  const an = read({ 'package.json': PKG(), 'src/registry.ts': REGISTRY, 'src/index.ts': LOOP });
  assert.deepEqual(names(an), ['alpha', 'beta']);
  assert.equal(tool(an, 'alpha').description, 'First tool.');
  assert.deepEqual(tool(an, 'alpha').inputSchema.required, ['q']);
  assert.equal(tool(an, 'beta').inputSchema.required, undefined);
  assert.equal(an.unresolved, 0);
});

test('R-RD-33: an object map imported from another module and iterated with Object.entries is read, the key as the name', () => {
  const an = read({
    'package.json': PKG(),
    'src/map.ts': "import { z } from 'zod';\nexport const TOOL_MAP = {\n  get_item: { summary: 'Get one item.', args: { id: z.string() } },\n  list_items: { summary: 'List items.', args: {} },\n};\n",
    'src/index.ts': SERVER + "import { TOOL_MAP } from './map.js';\nObject.entries(TOOL_MAP).forEach(([name, def]) => {\n  server.registerTool(name, { description: def.summary, inputSchema: def.args }, async () => ({ content: [] }));\n});\n",
  });
  assert.deepEqual(names(an), ['get_item', 'list_items']);
  assert.equal(tool(an, 'list_items').description, 'List items.');
  assert.equal(an.unresolved, 0);
});

test('R-RD-33: an imported registry that its own module changes (push) is not unrolled: the registration is counted as unresolved', () => {
  const an = read({ 'package.json': PKG(), 'src/registry.ts': REGISTRY + '\nexport function addTool(t: any) { TOOLS.push(t); }\n', 'src/index.ts': LOOP });
  assert.deepEqual(names(an), []);
  assert.equal(an.unresolved, 1);
});

// Synthetic, in the shape of the registry above: another module of the repository changes the exported registry, by
// any name it imports it under, directly or through a re-export, so the loop is counted as unresolved.
test('R-RD-33: an imported registry that another module changes (push, unshift, an alias, a namespace, a barrel, require, handed to a call) is not unrolled', () => {
  const cases = {
    'push': { 'src/plugin.ts': "import { TOOLS } from './registry.js';\nTOOLS.push({ id: 'gamma', summary: 'Third.', args: {} });\n" },
    'unshift in a function': { 'src/plugin.ts': "import { TOOLS } from './registry.js';\nexport function reg(t: any) { TOOLS.unshift(t); }\n" },
    'alias': { 'src/plugin.ts': "import { TOOLS as T } from './registry.js';\nT.splice(0, 1);\n" },
    'namespace': { 'src/plugin.ts': "import * as reg from './registry.js';\nreg.TOOLS.push({});\n" },
    'namespace handed on': { 'src/plugin.ts': "import * as reg from './registry.js';\nextend(reg);\n" },
    'barrel export *': { 'src/all.ts': "export * from './registry.js';\n", 'src/plugin.ts': "import { TOOLS } from './all.js';\nTOOLS.push({});\n" },
    'barrel renamed': { 'src/all.ts': "export { TOOLS as LIST } from './registry.js';\n", 'src/plugin.ts': "import { LIST } from './all.js';\nLIST.pop();\n" },
    'import re-exported': { 'src/mid.ts': "import { TOOLS } from './registry.js';\nexport { TOOLS };\n", 'src/plugin.ts': "import { TOOLS } from './mid.js';\nTOOLS.push({});\n" },
    'require': { 'src/plugin.js': "const r = require('./registry');\nr.TOOLS.push({});\n" },
    'handed to a call': { 'src/plugin.ts': "import { TOOLS } from './registry.js';\naddMore(TOOLS);\n" },
    'copied to a variable': { 'src/plugin.ts': "import { TOOLS } from './registry.js';\nconst list = TOOLS;\nlist.push({});\n" },
    'an item assigned': { 'src/plugin.ts': "import { TOOLS } from './registry.js';\nTOOLS[2] = { id: 'gamma', summary: 'Third.', args: {} };\n" },
  };
  for (const [label, files] of Object.entries(cases)) {
    const an = read(Object.assign({ 'package.json': PKG(), 'src/registry.ts': REGISTRY, 'src/index.ts': LOOP + "\nimport './plugin.js';\n" }, files));
    assert.deepEqual(names(an), [], label);
    assert.equal(an.unresolved, 1, label);
  }
});

test('R-RD-33: a registry that other modules only read (length, for…of, Object.keys, ns.TOOLS.length) is still unrolled', () => {
  const an = read({
    'package.json': PKG(), 'src/registry.ts': REGISTRY, 'src/index.ts': LOOP,
    'src/stats.ts': "import { TOOLS } from './registry.js';\nimport * as reg from './registry.js';\nexport const count = TOOLS.length + reg.TOOLS.length;\nfor (const t of TOOLS) console.log(t.id);\nconsole.log(Object.keys(TOOLS));\n",
  });
  assert.deepEqual(names(an), ['alpha', 'beta']);
  assert.equal(an.unresolved, 0);
});

// ---------------------------------------------------------------- R-RD-34: Python lists of functions
// Trimmed from stefanoamorelli/sec-edgar-mcp @ 86646eb0e23f84eb2b2d1a793c888ad63a8a82bc (sec_edgar_mcp/server.py:41-526).
const PYPROJECT = '[project]\nname = "x"\ndependencies = ["mcp>=1.20"]\n';
const SEC = (loop) => [
  'from mcp.server.fastmcp import FastMCP',
  'mcp = FastMCP("SEC EDGAR MCP")',
  '',
  'def get_cik_by_ticker(ticker: str):',
  '    """Convert a stock ticker symbol to its SEC CIK (Central Index Key)."""',
  '    return {"ticker": ticker}',
  '',
  'def get_company_info(identifier: str, include_former_names: bool = False):',
  '    """Retrieve company information from SEC records."""',
  '    return {"identifier": identifier}',
  '',
  'def register_tools():',
  ...loop,
  '',
  'register_tools()',
].join('\n');

test('R-RD-34: for tool in tools: mcp.add_tool(tool) over a list of functions of the same file reads each function as a tool', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'server.py': SEC([
    '    tools = [',
    '        get_cik_by_ticker,',
    '        get_company_info,',
    '    ]',
    '    for tool in tools:',
    '        mcp.add_tool(tool)',
  ]) });
  assert.deepEqual(names(an), ['get_cik_by_ticker', 'get_company_info']);
  const t = tool(an, 'get_company_info');
  assert.equal(t.description, 'Retrieve company information from SEC records.');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['identifier', 'include_former_names']);
  assert.deepEqual(t.inputSchema.required, ['identifier']);
  assert.equal(an.unresolved, 0);
});

test('R-RD-34: a tuple written in the loop itself is read the same way', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'server.py': SEC(['    for fn in (get_cik_by_ticker, get_company_info):', '        mcp.add_tool(fn)']) });
  assert.deepEqual(names(an), ['get_cik_by_ticker', 'get_company_info']);
});

test('R-RD-34: a list with a function from elsewhere, a list changed after it is built, or a registration under an if is counted as unresolved, never guessed', () => {
  const cases = [
    ['    from .extra import other_tool', '    tools = [get_cik_by_ticker, other_tool]', '    for tool in tools:', '        mcp.add_tool(tool)'],
    ['    tools = [get_cik_by_ticker]', '    tools.append(get_company_info)', '    for tool in tools:', '        mcp.add_tool(tool)'],
    ['    tools = [get_cik_by_ticker, get_company_info]', '    for tool in tools:', '        if tool.__name__ != "get_company_info":', '            mcp.add_tool(tool)'],
    ['    for tool in load_plugins():', '        mcp.add_tool(tool)'],
  ];
  cases.forEach((loop) => {
    const an = read({ 'pyproject.toml': PYPROJECT, 'server.py': SEC(loop) });
    assert.deepEqual(names(an), [], loop.join(' / '));
    assert.equal(an.unresolved, 1, loop.join(' / '));
  });
});

// Synthetic, in the shape of the sec-edgar fixture above with the list at module level: another module that imports
// it (by name, under another name, with *, or the module itself) and changes it makes the loop unresolved; one that
// only reads it, and a module of another package with a list of the same name, do not.
test('R-RD-34: a module-level list of functions another module changes (append, extend, insert, rebind, handed to a call) is counted as unresolved', () => {
  const SRV = (inFn) => [
    'from mcp.server.fastmcp import FastMCP',
    'mcp = FastMCP("SEC EDGAR MCP")',
    '',
    'def get_cik_by_ticker(ticker: str):',
    '    """Convert a stock ticker symbol to its SEC CIK (Central Index Key)."""',
    '    return {"ticker": ticker}',
    '',
    'def get_company_info(identifier: str):',
    '    """Retrieve company information from SEC records."""',
    '    return {"identifier": identifier}',
    '',
    'TOOLS = [get_cik_by_ticker, get_company_info]',
    '',
  ].concat(inFn ? ['def register_tools():', '    for tool in TOOLS:', '        mcp.add_tool(tool)', '', 'register_tools()'] : ['for tool in TOOLS:', '    mcp.add_tool(tool)']).join('\n');
  const changed = {
    'from-import append': 'from sec_edgar_mcp.server import TOOLS\nfrom sec_edgar_mcp.extra import other\nTOOLS.append(other)\n',
    'relative alias extend': 'from .server import TOOLS as T\nT.extend([print])\n',
    'star insert': 'from .server import *\nTOOLS.insert(0, print)\n',
    'module attribute append': 'from sec_edgar_mcp import server\nserver.TOOLS.append(print)\n',
    'module rebind': 'import sec_edgar_mcp.server as srv\nsrv.TOOLS = []\n',
    'handed to a call': 'from .server import TOOLS\nadd_more(TOOLS)\n',
  };
  for (const inFn of [false, true]) {
    for (const [label, plugin] of Object.entries(changed)) {
      const an = read({ 'pyproject.toml': PYPROJECT, 'sec_edgar_mcp/server.py': SRV(inFn), 'sec_edgar_mcp/plugins.py': plugin });
      assert.deepEqual(names(an), [], label + (inFn ? ' (loop in a function)' : ''));
      assert.equal(an.unresolved, 1, label);
    }
    const kept = {
      'read only': 'from .server import TOOLS\nfor t in TOOLS:\n    print(t.__name__)\n',
      'another module of that name': 'from other_pkg.registry import TOOLS\nTOOLS.append(print)\n',
    };
    for (const [label, plugin] of Object.entries(kept)) {
      const an = read({ 'pyproject.toml': PYPROJECT, 'sec_edgar_mcp/server.py': SRV(inFn), 'sec_edgar_mcp/plugins.py': plugin });
      assert.deepEqual(names(an), ['get_cik_by_ticker', 'get_company_info'], label);
      assert.equal(an.unresolved, 0, label);
    }
  }
});

// A function of the same file that appends to the module-level list, with the loop inside another function.
test('R-RD-34: a module-level list a function of the same file appends to is counted as unresolved', () => {
  const an = read({ 'pyproject.toml': PYPROJECT, 'server.py': [
    'from mcp.server.fastmcp import FastMCP',
    'mcp = FastMCP("x")',
    'def a(q: str):',
    '    """A."""',
    '    return q',
    'def b(q: str):',
    '    """B."""',
    '    return q',
    'TOOLS = [a]',
    'def more():',
    '    TOOLS.append(b)',
    'def register_tools():',
    '    for tool in TOOLS:',
    '        mcp.add_tool(tool)',
    'more()',
    'register_tools()',
  ].join('\n') });
  assert.deepEqual(names(an), []);
  assert.equal(an.unresolved, 1);
});

// ---------------------------------------------------------------- R-RD-35: .shape read back through a registry entry
// Trimmed from thuupx/memory-mcp-lite @ 9786819f6b4d53595510038d48b0299cc6034cc1 (apps/server/src/server.ts:21-64,
// apps/server/src/mcp/tools/get-project-summary.ts:13-50), found by the re-scan of the prevalence sample.
test('R-RD-35: an input shape written as Schema.shape keeps its optional keys when it is read back through a registry entry (tool.inputShape)', () => {
  const an = read({
    'package.json': PKG('1.20.0'),
    'src/tools/get-project-summary.ts': [
      "import { z } from 'zod';",
      'export const getProjectSummaryInput = z.object({',
      '  workspace_path: z.string().optional().describe("Absolute path to the workspace root"),',
      '  project_id: z.string().describe("Project id"),',
      '});',
      'export const getProjectSummaryTool = {',
      '  name: "get_project_summary" as const,',
      '  title: "Get project memory summary",',
      '  description: "Return the concise summary for the current project.",',
      '  inputShape: getProjectSummaryInput.shape,',
      '  handler: async () => ({ content: [] }),',
      '};',
    ].join('\n'),
    'src/server.ts': [
      SERVER,
      "import type { ZodRawShape } from 'zod';",
      "import { getProjectSummaryTool } from './tools/get-project-summary.js';",
      'interface RegisterableTool { name: string; title: string; description: string; inputShape: ZodRawShape; handler: any }',
      'const TOOLS: RegisterableTool[] = [',
      '  getProjectSummaryTool,',
      '];',
      'for (const tool of TOOLS) {',
      '  server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputShape }, tool.handler);',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(names(an), ['get_project_summary']);
  const t = tool(an, 'get_project_summary');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['workspace_path', 'project_id']);
  assert.deepEqual(t.inputSchema.required, ['project_id']);
});
