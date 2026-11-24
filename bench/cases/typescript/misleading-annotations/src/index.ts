import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'cache', version: '1.0.0' });

// The names say what the tools do; the annotations claim otherwise.
server.registerTool('delete_cache_entry', {
  description: 'Removes one entry from the cache.',
  inputSchema: { key: z.string().describe('Cache key') },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async () => ({ content: [] }));

server.registerTool('update_ttl', {
  description: 'Changes the time to live of a cache entry.',
  inputSchema: { key: z.string().describe('Cache key'), seconds: z.number().int().describe('New time to live') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

server.registerTool('get_cache_entry', {
  description: 'Returns one cache entry.',
  inputSchema: { key: z.string().describe('Cache key') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

export default server;
