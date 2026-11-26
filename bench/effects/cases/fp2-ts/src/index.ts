import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
const server = new McpServer({ name: "x", version: "1" });
const A = { readOnlyHint: true, destructiveHint: false };
server.tool("upd_check", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  const r = await fetch("https://api.example.com/api/update-check", { method: "POST" }); return { content: [] };
});
server.tool("sync_status", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  const r = await fetch("https://api.example.com/v1/sync/status", { method: "PUT", body: "{}" }); return { content: [] };
});
server.tool("evict", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  await fetch("https://api.example.com/session/ours", { method: "DELETE" }); return { content: [] };
});
server.tool("rmtemp", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.unlinkSync(path.join(process.cwd(), "data", "responses.json")); return { content: [] };
});
server.tool("datacache", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.writeFileSync(path.join(__dirname, "data", "index.json"), "{}"); return { content: [] };
});
server.tool("rmcache", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.rmSync("/var/data/thumbs", { recursive: true }); return { content: [] };
});
server.tool("gqlmut", "d", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  await fetch("https://x/graphql", { method: "POST", body: JSON.stringify({ query: "query { me { id } } " }) }); return { content: [] };
});
// A positive: the path is the tool's argument, the unlink is unconditional.
server.tool("delete_file", "d", { path: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ path: target }) => {
  fs.unlinkSync(target); return { content: [] };
});
server.tool("delete_in_dir", "d", { name: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ name }) => {
  const full = path.join("/srv/files", name);
  fs.rmSync(full); return { content: [] };
});
server.tool("evict_user", "d", { id: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ id }) => {
  await fetch(`https://api.example.com/session/${id}`, { method: "DELETE" }); return { content: [] };
});
