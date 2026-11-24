import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_NAMES } from './names.js';

const server = new McpServer({ name: 'docs', version: '2.0.0' });

server.registerTool(TOOL_NAMES.SEARCH, {
  description: 'Searches the documentation and returns matching page paths.',
  inputSchema: { query: z.string().describe('Words to search for') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

server.registerTool(TOOL_NAMES.FETCH, {
  description: 'Returns the text of one documentation page.',
  inputSchema: { path: z.string().describe('Page path from search_docs') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

export { server };
