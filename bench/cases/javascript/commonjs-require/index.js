const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');

const server = new McpServer({ name: 'timer', version: '1.0.0' });

server.tool('start_timer', 'Starts a named timer.', { label: z.string().describe('Timer label') }, async () => ({ content: [] }));
server.tool('stop_timer', 'Stops a named timer and returns the elapsed seconds.', { label: z.string().describe('Timer label') }, async () => ({ content: [] }));

module.exports = server;
