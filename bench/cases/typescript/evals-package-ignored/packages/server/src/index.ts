import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'docs', version: '1.0.0' });

server.registerTool('search_docs', {
  description: 'Searches the product documentation and returns matching pages.',
  inputSchema: { query: z.string().describe('Search text') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

export default server;
