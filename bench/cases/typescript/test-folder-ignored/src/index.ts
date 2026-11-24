import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'clock', version: '1.0.0' });
server.registerTool('current_time', {
  description: 'Returns the current time in UTC.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }));
export default server;
