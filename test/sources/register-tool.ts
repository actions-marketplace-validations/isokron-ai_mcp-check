import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });
const DELETE_DESC = "Delete an issue. This cannot be undone.";

server.registerTool(
  "create_issue",
  {
    title: "Create issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      repo: z.string().describe("owner/name"),
      title: z.string().min(1).max(256).describe("Issue title"),
      labels: z.array(z.string()).optional().describe("Labels to add"),
      priority: z.enum(["low", "high"]).default("low"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ repo, title }) => ({ content: [{ type: "text", text: `${repo} ${title}` }] })
);

server.tool("delete_issue", DELETE_DESC, { id: z.number().int().positive() }, { destructiveHint: true }, async ({ id }) => {
  return { content: [] };
});

server.tool("ping", async () => ({ content: [] }));

server.tool(
  "search_issues",
  "Search issues. " + "Returns at most 50.",
  { query: z.string(), state: z.enum(["open", "closed"]).optional() },
  async (args) => ({ content: [] })
);
