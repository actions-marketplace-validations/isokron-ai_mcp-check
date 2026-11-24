import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const mcpServer = new McpServer({ name: 'services', version: '0.3.0' });
const s = mcpServer;
const register = s.registerTool.bind(s);

register('ping_service', {
  description: 'Checks whether a service answers on its health endpoint.',
  inputSchema: { service: z.string().describe('Service name') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

s.registerTool('restart_service', {
  description: 'Restarts a service. Requests in flight are dropped.',
  inputSchema: { service: z.string().describe('Service name') },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async () => ({ content: [{ type: 'text', text: 'restarted' }] }));

export default mcpServer;
