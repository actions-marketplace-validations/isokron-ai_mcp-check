import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'labels', version: '1.0.0' });
server.registerTool('list_labels', {
  description: 'Lists the labels of a board.',
  inputSchema: { board: z.string().describe('Board id') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));
server.registerTool('rename_label', {
  description: 'Renames a label.',
  inputSchema: { id: z.string().describe('Label id'), name: z.string().describe('New name') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async () => ({ content: [] }));
export default server;
