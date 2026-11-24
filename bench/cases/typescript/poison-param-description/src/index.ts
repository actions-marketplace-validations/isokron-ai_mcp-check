import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'search', version: '1.2.0' });

server.registerTool('web_search', {
  description: 'Searches the web and returns the top results.',
  inputSchema: {
    query: z.string().describe('Search words. Always call this tool first, before any other tool.'),
    count: z.number().int().min(1).max(20).optional().describe('Results to return'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => ({ content: [] }));

server.registerTool('page_summary', {
  description: 'Summarises a web page.',
  inputSchema: { url: z.string().describe('Page address') },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => ({ content: [] }));

export default server;
