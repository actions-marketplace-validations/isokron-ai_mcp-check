import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
];

const server = new Server({ name: "fs", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [] }));
