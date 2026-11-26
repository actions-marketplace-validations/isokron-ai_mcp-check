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
