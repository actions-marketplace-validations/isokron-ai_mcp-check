import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'records', version: '0.9.0' });

server.registerTool('read_record', {
  description: 'Returns one record by id.',
  inputSchema: { id: z.string().describe('Record id') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

if (process.env.RECORDS_ALLOW_WRITES === 'true') {
  server.registerTool('update_record', {
    description: 'Replaces the fields of one record.',
    inputSchema: { id: z.string().describe('Record id'), fields: z.record(z.string(), z.string()).describe('Fields to set') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async () => ({ content: [] }));
}

export default server;
