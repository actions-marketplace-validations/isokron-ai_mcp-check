import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const server = new McpServer({ name: 'weather', version: '1.0.0' });

server.tool('get_weather', 'Current weather for a city.', { city: z.string().describe('City name') }, async ({ city }) => ({
  content: [{ type: 'text', text: 'Sunny in ' + city }],
}));

server.tool('get_forecast', 'Five-day forecast for a city.', { city: z.string().describe('City name'), days: z.number().int().min(1).max(5).describe('Days ahead') }, async ({ city }) => ({
  content: [{ type: 'text', text: 'Forecast for ' + city }],
}));
