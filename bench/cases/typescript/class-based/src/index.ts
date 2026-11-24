import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WeatherTools } from './weather-tools.js';

const server = new McpServer({ name: 'weather-class', version: '1.0.0' });
new WeatherTools('https://weather.invalid').register(server);
export default server;
