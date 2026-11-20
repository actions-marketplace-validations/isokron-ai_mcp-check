// The MCP server: three read-only tools over the vendored check engine. No network, no file access, no state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { checkToolsList, explainCheck, compareToolsLists, SECTIONS, GRADES, DEFAULT_LIMIT, MAX_FINDINGS } from './tools.js';
import { InputError, MAX_BYTES, MAX_DEPTH, MAX_TOOLS } from './limits.js';
import M from './engine.js';

export { VERSION } from './version.js';
import { VERSION } from './version.js';
import { tagged } from './links.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const toolsListArg = (what) => z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe(what + ': the answer to tools/list, as JSON text or as a value. Accepts a JSON-RPC answer, {"tools": [...]}, a bare array of tools, or an array of pages. Limit ' + MAX_BYTES / 1048576 + ' MiB of JSON, ' + MAX_DEPTH + ' levels of nesting and ' + MAX_TOOLS + ' tools.');

const counts = z.object({ blocking: z.number().int(), attention: z.number().int(), advice: z.number().int() });
const nstr = z.string().nullable();

const checkOutput = z.object({
  rubric_version: z.string().describe('Version of the grading rubric.'),
  report_schema: z.string(),
  spec_version: z.string().describe('MCP specification revision the spec section checks against.'),
  sources_read: z.string().describe('Date the Anthropic and OpenAI directory rules were last read.'),
  input: z.object({ tools: z.number().int(), skipped: z.number().int(), era: z.string(), catalog_hash: z.string() }),
  sections: z.array(z.object({
    id: z.enum(SECTIONS), name: z.string(), grade: z.enum(GRADES).nullable(), score: z.number().nullable(),
    ready: z.boolean().nullable(), counts: counts.nullable(), caps: z.array(z.string()), note: nstr,
  })),
  min_grade: z.enum(GRADES).nullable(),
  passed: z.boolean().describe('False when a reported section is below min_grade.'),
  below_min_grade: z.array(z.string()),
  counts,
  findings: z.array(z.object({
    id: z.string().describe('Check id; pass it to explain_check.'), severity: z.enum(['blocking', 'attention', 'advice']),
    section: z.string(), tool: nstr, message: z.string(), path: nstr, title: z.string(),
    docs: z.string().describe('https://isokron.ai/mcp-check/checks/<id>'), fix: z.string(), fix_snippet: nstr,
  })),
  findings_truncated: z.boolean(),
  suggested_fixes: z.object({
    changes: z.array(z.object({ tool: z.string(), change: z.string(), review: z.boolean() })),
    tools_list: z.unknown().describe('The list with the safe fixes applied, in the shape it was given; null when include_fixed_list is false.'),
  }),
  tool_hashes: z.array(z.object({ name: z.string(), sha256: z.string() })),
});

const explainOutput = z.object({
  id: z.string(), title: z.string(), section: z.string(), affects: z.array(z.string()),
  severity: z.enum(['blocking', 'attention', 'advice']),
  source_quote: z.string().describe('The rule, quoted verbatim from its source.'), source: z.string(), source_title: z.string(),
  explanation: z.string(), fix: z.string(),
  example: z.object({ bad: z.string(), good: z.string() }).nullable(), docs: z.string(), rubric_version: z.string(),
});

const change = z.object({ field: z.string(), risk: z.enum(['high', 'medium', 'low']), from: z.unknown(), to: z.unknown(), note: nstr });
const compareOutput = z.object({
  before: z.object({ tools: z.number().int(), catalog_hash: z.string() }),
  after: z.object({ tools: z.number().int(), catalog_hash: z.string() }),
  identical: z.boolean(),
  added: z.array(z.object({ name: z.string(), readOnlyHint: z.boolean().nullable(), destructiveHint: z.boolean().nullable() })),
  removed: z.array(z.string()),
  changed: z.array(z.object({ name: z.string(), old_hash: z.string(), new_hash: z.string(), changes: z.array(change) })),
  unchanged: z.number().int(),
  high_risk: z.array(z.string()).describe('Tools whose annotation change lets a client run them with less confirmation.'),
});

function wrap(fn) {
  return async (args) => {
    try {
      const { report, text } = fn(args);
      return { structuredContent: report, content: [{ type: 'text', text }] };
    } catch (e) {
      if (e instanceof InputError) return { isError: true, content: [{ type: 'text', text: e.message }] };
      throw e;
    }
  };
}

// tools/list is served from these definitions as JSON Schema 2020-12 (the MCP default dialect, so no $schema),
// instead of the SDK's draft-07 output, and without the legacy "execution" field.
const DEFS = [];
function register(server, name, config, fn) {
  DEFS.push({ name, config });
  server.registerTool(name, config, wrap(fn));
}
const jsonSchema = (schema, io) => {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' });
  delete out.$schema;
  return out;
};
export function toolDefinitions() {
  return DEFS.map(({ name, config }) => ({
    name, title: config.title, description: config.description,
    inputSchema: jsonSchema(config.inputSchema, 'input'),
    outputSchema: jsonSchema(config.outputSchema, 'output'),
    annotations: config.annotations,
  }));
}

export function createServer() {
  DEFS.length = 0;
  const server = new McpServer(
    { name: 'mcp-check', title: 'IsoKron MCP check', version: VERSION, websiteUrl: tagged('https://isokron.ai/mcp-check', 'server') },
    { instructions: 'Grades an MCP server\'s tools/list answer against the MCP specification ' + M.SPEC_VERSION + ', the Anthropic and OpenAI directory rules, hidden-instruction patterns, schema quality and write-surface design. Everything runs locally on the JSON you pass; nothing is sent anywhere.' },
  );

  register(server, 'check_tools_list', {
    title: 'Check an MCP tool list',
    description: 'Grades an MCP server\'s tools/list answer and returns a report: a letter grade per section (MCP specification, Anthropic directory, OpenAI directory, hidden-instruction scan, schema quality) and the write-surface guard coverage (advice, no grade), each finding with its check id and docs link, and the list with safe fixes applied. Use this before submitting a server to the Claude or ChatGPT directories, or in review of a tool list change. Do not use it to compare two versions of a list; use compare_tools_lists for that. It reads only the JSON passed in; it does not connect to the server.',
    inputSchema: z.strictObject({
      tools_list: toolsListArg('The tool list to grade'),
      sections: z.array(z.enum(SECTIONS)).min(1).max(SECTIONS.length).optional().describe('Sections to report and to test against min_grade (surface has no grade and is never below it). Default: all six.'),
      min_grade: z.enum(GRADES).optional().describe('Lowest acceptable grade. When set, passed is false if any reported section grades below it.'),
      limit: z.number().int().min(1).max(MAX_FINDINGS).default(DEFAULT_LIMIT).describe('Most findings to return, blocking first. Grades and counts always cover every finding.'),
      include_fixed_list: z.boolean().default(true).describe('Include the whole list with safe fixes applied. Set false for large lists to keep the answer short; the change list is always included.'),
    }),
    outputSchema: checkOutput,
    annotations: READ_ONLY,
  }, checkToolsList);

  register(server, 'explain_check', {
    title: 'Explain a check',
    description: 'Returns the documentation for one check by its id: severity, the source rule quoted verbatim, what the finding means and how to fix it, with an example where one exists. Use this when a check_tools_list finding needs more detail. Do not use it to grade a list.',
    inputSchema: z.strictObject({
      check_id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).describe('Check id from a check_tools_list finding, for example "anthropic-title".'),
    }),
    outputSchema: explainOutput,
    annotations: READ_ONLY,
  }, explainCheck);

  register(server, 'compare_tools_lists', {
    title: 'Compare two MCP tool lists',
    description: 'Compares two tools/list answers from the same server by SHA-256 definition hashes and reports tools added, removed and changed, field by field. Flags as high risk any annotation change that lets a client run a tool with less confirmation, the pattern of a rug-pull. Use this when a server updates, before trusting the new list. Do not use it to grade a single list.',
    inputSchema: z.strictObject({
      before: toolsListArg('The earlier tool list'),
      after: toolsListArg('The newer tool list'),
    }),
    outputSchema: compareOutput,
    annotations: READ_ONLY,
  }, compareToolsLists);

  const defs = toolDefinitions();
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: defs }));
  return server;
}
