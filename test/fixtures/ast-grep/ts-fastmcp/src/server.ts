import { FastMCP } from "fastmcp";
import { z } from "zod";
const server = new FastMCP({ name: "fm", version: "1.0.0" });
server.addTool({
  name: "fm_add",
  description: "Add",
  parameters: z.object({ a: z.number(), name: z.string() }),
  annotations: { readOnlyHint: true, title: "Add" },
  execute: async () => "1",
});
server.addTool({ name: "fm_sub", description: "Subtract", execute: async () => "1" });
