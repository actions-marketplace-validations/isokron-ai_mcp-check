"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const zod_1 = require("zod");
const server = new mcp_js_1.McpServer({ name: "colors", version: "1.0.0" });
server.registerTool("hex_to_rgb", {
    description: "Converts a hex colour to red, green and blue values.",
    inputSchema: { hex: zod_1.z.string().describe("Colour such as #ff8800") },
    annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));
server.registerTool("rgb_to_hex", {
    description: "Converts red, green and blue values to a hex colour.",
    inputSchema: { r: zod_1.z.number().int(), g: zod_1.z.number().int(), b: zod_1.z.number().int() },
    annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));
exports.default = server;
