const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const TOOLS = [
  {
    name: 'get_forecast',
    title: 'Get forecast',
    description: 'Returns the forecast for a city for the next days.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        days: { type: 'integer', minimum: 1, maximum: 7, description: 'Days ahead' },
      },
      required: ['city'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const server = new Server({ name: 'weather', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
module.exports = { server };
