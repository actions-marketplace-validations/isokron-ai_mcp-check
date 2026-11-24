import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUserTools } from './tools.js';

const server = new McpServer({ name: 'users', version: '1.0.0' });
registerUserTools(server);
export default server;
