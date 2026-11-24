import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'billing', version: '0.2.0' });

for (const entity of ['invoice', 'customer']) {
  server.registerTool(`list_${entity}s`, {
    description: `Lists ${entity}s, newest first.`,
    inputSchema: { limit: z.number().int().optional().describe('Most rows to return') },
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [] }));
}

export default server;
