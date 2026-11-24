import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { echoTool } from './tools/echo.js';
import { upperTool } from './tools/upper.js';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool(echoTool.name, echoTool.config, echoTool.handler);
server.registerTool(upperTool.name, upperTool.config, upperTool.handler);
export default server;
