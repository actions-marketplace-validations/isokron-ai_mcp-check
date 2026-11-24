import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ticket-tools', version: '1.0.0' });
server.registerTool('list_tickets', {
  description: 'Lists open tickets of a board.',
  inputSchema: { board: z.string().describe('Board key') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));
export default server;
