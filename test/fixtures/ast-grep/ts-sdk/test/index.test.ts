import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const s = new McpServer({ name: "t", version: "1" });
s.tool("only_in_tests", "x", async () => ({ content: [] }));
