#!/usr/bin/env node
// The MCP server over stdio (same as `mcp-check serve`).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';

await createServer().connect(new StdioServerTransport());
