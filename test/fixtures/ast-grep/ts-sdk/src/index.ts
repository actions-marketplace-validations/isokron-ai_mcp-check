import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });
const PREFIX = "dyn";

server.tool("add_numbers", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

server.tool("no_description", { x: z.string() }, async () => ({ content: [] }));

server.registerTool(
  "get_weather",
  {
    title: "Weather",
    description: "Get the weather for a city",
    inputSchema: { city: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => ({ content: [] }),
);

server.registerTool(`tpl_tool`, { description: "template literal" }, async () => ({ content: [] }));
server.tool(PREFIX + "_computed", "computed name", async () => ({ content: [] }));
for (const n of ["a", "b"]) {
  server.tool(n, "looped", async () => ({ content: [] }));
}
