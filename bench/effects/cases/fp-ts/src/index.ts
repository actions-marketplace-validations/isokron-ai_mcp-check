import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { helper, other } from "./util.js";
const server = new McpServer({ name: "x", version: "1" });
const RO = { readOnlyHint: true, destructiveHint: false };

// 1 graphql POST, url from var, no readish word
const API = "https://api.example.com/v2";
server.tool("gql_query", "q", { q: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ q }) => {
  const r = await fetch(API, { method: "POST", headers: {}, body: JSON.stringify({ query: q }) });
  return { content: [{ type: "text", text: await r.text() }] };
});
// 2 elasticsearch via POST to _msearch-like opaque host
server.tool("es", "q", { q: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ q }) => {
  const r = await fetch(`${process.env.ES_URL}/idx/_doc/_count`, { method: "POST", body: q });
  return { content: [{ type: "text", text: await r.text() }] };
});
// 3 write to a log/state file with innocuous name
server.tool("with_log", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.appendFileSync(path.join(process.cwd(), "audit.log"), "called\n");
  return { content: [] };
});
// 4 mkdir recursive to ensure dir
server.tool("ensure", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.mkdirSync("out", { recursive: true });
  return { content: [] };
});
// 5 dead branch / error path
server.tool("deadbranch", "q", { x: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ x }) => {
  if (false) { fs.unlinkSync("/x"); }
  return { content: [] };
});
// 6 shared helper
server.tool("shared_read", "q", { x: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ x }) => helper("read", x));
// 7 name collision
server.tool("collide", "q", { x: z.string() }, { readOnlyHint: true, destructiveHint: false }, async ({ x }) => { return other(x); });
// 8 SQL FOR UPDATE / comments
import db from "./db.js";
server.tool("sel_update", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  // DELETE FROM users is not run here
  const r = await db.query("SELECT * FROM jobs WHERE id = 1 FOR UPDATE SKIP LOCKED");
  const s = await db.query("WITH x AS (SELECT 1) SELECT * FROM x");
  return { content: [] };
});
// 9 string in const never executed (docs for the model)
const HELP = "To remove data use DELETE FROM table WHERE ...";
server.tool("helpish", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => ({ content: [{ type: "text", text: HELP }] }));
// 10 POST to read RPC
server.tool("rpc", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  const r = await fetch("https://rpc.example.com/", { method: "POST", body: JSON.stringify({ method: "eth_blockNumber" }) });
  return { content: [] };
});
// 11 cache dir without cache name; writeFile to downloaded path
server.tool("dl", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  fs.writeFileSync(path.join(os_dir(), "thumb.png"), "x");
  return { content: [] };
});
function os_dir() { return "/var/data"; }
// 12 map.set / Set / local object .update / .delete on Map
server.tool("mapdel", "q", {}, { readOnlyHint: true, destructiveHint: false }, async () => {
  const m = new Map(); m.set("a", 1); m.delete("a"); const s = new Set(); s.delete(1);
  const o = { update() {} }; o.update();
  const url = new URLSearchParams(); url.delete("a");
  return { content: [] };
});
