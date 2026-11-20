import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'tickets', version: '0.1.0' });
server.registerTool('ticket_get', { description: 'Reads one ticket.', inputSchema: { id: z.string() } }, async () => ({ content: [] }));
