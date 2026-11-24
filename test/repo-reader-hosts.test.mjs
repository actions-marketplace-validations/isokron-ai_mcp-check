// Tools of another agent host's plugin API (OpenCode, OpenClaw, the Vercel AI SDK, OpenAI Agents, LangChain, Mastra,
// LlamaIndex) are not MCP tools: never listed, never a server's tool library, named in hints.hostPlugins (R-RD-05).
// Synthetic sources written for these tests from each host's documented plugin form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');
const BIN = fileURLToPath(new URL('../bin/mcp-check.js', import.meta.url));

const names = (r) => r.tools.map((x) => x.tool.name).sort();
const repo = (files) => R.analyseRepo(new Map(Object.entries(files)));
function tree(files) {
  const d = mkdtempSync(join(tmpdir(), 'mcpcheck-hosts-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), t); }
  return d;
}

const OPENCODE = 'import type { Plugin } from "@opencode-ai/plugin";\nimport { tool } from "@opencode-ai/plugin";\n'
  + 'export const Notes: Plugin = async () => ({ tool: {\n  notes_recall: tool({ description: "Recall notes.", args: { q: tool.schema.string() }, async execute() { return ""; } }),\n'
  + '  notes_status: tool({ description: "Notes status.", args: {}, async execute() { return ""; } }),\n} });\n';
const OPENCLAW = 'let definePluginEntry;\ntry { ({ definePluginEntry } = require("openclaw/plugin-sdk/core")); } catch { definePluginEntry = (d) => d; }\n'
  + 'export default definePluginEntry({ id: "notes", register(api) {\n  api.registerTool({ name: "memory_recall", description: "Recall notes.", parameters: { type: "object", properties: {} }, async execute() {} });\n} });\n';
const AI_SDK = 'import { tool } from "ai";\nimport { z } from "zod";\nexport const agentTools = { lookup: tool({ description: "Look something up for the embedded agent.", inputSchema: z.object({ q: z.string() }), execute: async () => "" }) };\n';
const MCP_SERVER = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\n'
  + 'const server = new McpServer({ name: "notes", version: "1.0.0" });\n'
  + 'server.registerTool("notes_search", { description: "Search the notes.", inputSchema: { q: z.string() } }, async () => ({ content: [] }));\n';

test('R-RD-05: OpenCode tool({…}) and OpenClaw api.registerTool({…}) plugins are not MCP tools, and are named in hints.hostPlugins', async () => {
  const r = repo({ 'plugins/opencode/src/index.ts': OPENCODE, 'plugins/openclaw/src/index.ts': OPENCLAW });
  assert.deepEqual(names(r), []);
  assert.deepEqual(r.hostPlugins.map((x) => [x.path, x.module]).sort(), [['plugins/openclaw/src/index.ts', 'openclaw'], ['plugins/opencode/src/index.ts', '@opencode-ai/plugin']]);
  const d = tree({ 'package.json': '{"name":"notes-plugins"}', 'plugins/opencode/package.json': '{"name":"a","dependencies":{"@opencode-ai/plugin":"^1"}}', 'plugins/opencode/src/index.ts': OPENCODE, 'plugins/openclaw/package.json': '{"name":"b","peerDependencies":{"openclaw":"*"}}', 'plugins/openclaw/src/index.ts': OPENCLAW });
  const out = spawnSync(process.execPath, [BIN, '--repo-dir', d, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(out.status, 3);
  assert.match(out.stderr, /another agent host's plugin API were found \(not MCP tools, so not graded\): .*@opencode-ai\/plugin/);
});

test('R-RD-05: a repository of one MCP server and host plugins is one server, not several (the plugins do not join it or split it)', async () => {
  const d = tree({
    'package.json': '{"name":"notes","private":true}',
    'server/package.json': '{"name":"notes-mcp","dependencies":{"@modelcontextprotocol/sdk":"^1.20.0","zod":"^3.24.0"}}',
    'server/src/index.ts': MCP_SERVER,
    'integrations/opencode/package.json': '{"name":"notes-opencode","dependencies":{"@opencode-ai/plugin":"^1"}}',
    'integrations/opencode/src/index.ts': OPENCODE,
    'integrations/openclaw/package.json': '{"name":"notes-openclaw","peerDependencies":{"openclaw":"*"}}',
    'integrations/openclaw/src/index.ts': OPENCLAW,
  });
  const r = await R.fromDirectory(d);
  assert.equal(r.hints.servers, undefined);
  assert.deepEqual(r.best.tools.map((t) => t.name), ['notes_search']);
  assert.equal(r.hints.hostPlugins.length, 2);
});

test('R-RD-05: a host-plugin tool with the name of a Rust MCP tool no longer hides the Rust tool', async () => {
  const d = tree({
    'Cargo.toml': '[package]\nname = "notes"\n',
    'src/main.rs': '#[derive(Clone)] pub struct Notes;\n#[tool_router]\nimpl Notes {\n    #[tool(name = "notes_recall", description = "Recall notes.")]\n    fn recall(&self) -> String { todo!() }\n    #[tool(name = "notes_forget", description = "Forget notes.")]\n    fn forget(&self) -> String { todo!() }\n}\n#[tool_handler]\nimpl ServerHandler for Notes {}\n',
    'integrations/opencode/package.json': '{"name":"notes-opencode","dependencies":{"@opencode-ai/plugin":"^1"}}',
    'integrations/opencode/src/index.ts': OPENCODE,
  });
  const r = await R.fromDirectory(d);
  assert.equal(r.hints.servers, undefined);
  assert.deepEqual(r.best.tools.map((t) => t.name).sort(), ['notes_forget', 'notes_recall']);
});

test('R-RD-05: an MCP module in the same file keeps its tools (the Vercel AI SDK beside the MCP SDK, the Claude Agent SDK, mcp-handler)', () => {
  const both = 'import { tool } from "ai";\nimport { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst server = new McpServer({ name: "x", version: "1" });\nserver.registerTool("kept_tool", { description: "Kept.", inputSchema: {} }, h);\n';
  const agentSdk = 'import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";\nimport { z } from "zod";\nexport const s = createSdkMcpServer({ name: "x", tools: [tool("sdk_tool", "An in-process MCP tool.", { a: z.string() }, async () => ({ content: [] }))] });\n';
  const handler = 'import { createMcpHandler } from "mcp-handler";\nimport { tool } from "ai";\nexport default createMcpHandler((server) => { server.tool("handler_tool", "A tool.", {}, async () => ({ content: [] })); });\n';
  assert.deepEqual(names(repo({ 'src/a.ts': both })), ['kept_tool']);
  assert.ok(!repo({ 'src/b.ts': agentSdk }).hostPlugins.length);
  assert.deepEqual(names(repo({ 'src/c.ts': handler })), ['handler_tool']);
  // and an embedded agent's AI SDK tools, with no MCP module, are not listed
  const r = repo({ 'src/agent/tools.ts': AI_SDK, 'src/server.ts': MCP_SERVER });
  assert.deepEqual(names(r), ['notes_search']);
  assert.deepEqual(r.hostPlugins.map((x) => x.module), ['ai']);
});

test('R-RD-05: an MCP tool that calls an LLM through a host library keeps its SDK-shaped registrations', () => {
  const src = 'import { generateText } from "ai";\nimport { z } from "zod";\n'
    + 'export function registerSummarize(server) {\n  server.registerTool("summarize", { description: "Summarizes a text.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: (await generateText({ prompt: text })).text }] }));\n}\n'
    + 'export function registerTranslate(server) {\n  server.tool("translate", "Translates a text.", { text: z.string() }, async () => ({ content: [] }));\n}\n';
  const lc = 'import { ChatOpenAI } from "@langchain/openai";\nexport const reg = (server) => server.registerTool("ask", { description: "Asks the model." }, async () => ({ content: [] }));\n';
  const r = repo({ 'package.json': '{"name":"s","dependencies":{"@modelcontextprotocol/sdk":"1.32.2","ai":"5"}}', 'src/summarize.ts': src, 'src/ask.ts': lc, 'src/index.ts': MCP_SERVER });
  assert.deepEqual(names(r), ['ask', 'notes_search', 'summarize', 'translate']);
  assert.deepEqual(r.hostPlugins, []);
});

test('R-RD-05: in a file with both, only the host-shaped tool({…}) is dropped', () => {
  const both = 'import { tool } from "ai";\nimport { z } from "zod";\nexport const agentTools = { lookup: tool({ description: "Agent lookup.", inputSchema: z.object({ q: z.string() }), execute: async () => "" }) };\n'
    + 'export const reg = (server) => server.registerTool("search", { description: "Searches." }, async () => ({ content: [] }));\n';
  const r = repo({ 'package.json': '{"name":"s"}', 'src/tools.ts': both, 'src/index.ts': MCP_SERVER });
  assert.deepEqual(names(r), ['notes_search', 'search']);
  assert.deepEqual(r.hostPlugins.map((x) => [x.path, x.tools]), [['src/tools.ts', 1]]);
});
