import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'names', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'get weather!', description: 'Current weather for a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
    { name: 'lookup_city', description: 'Finds a city by name.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'list_alerts', description: 'Lists weather alerts.', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_alerts', description: 'Lists weather alerts for a region.', inputSchema: { type: 'object', properties: { region: { type: 'string' } } } },
  ],
}));
