import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'weather', version: '0.1.0' });

const TOOLS = {
  get_forecast: {
    description: 'Returns the forecast for a city for the next three days.',
    inputSchema: { city: z.string().describe('City name') },
    annotations: { readOnlyHint: true },
  },
  get_alerts: {
    description: 'Lists the weather alerts in force for a region.',
    inputSchema: { region: z.string().describe('Region code'), severe_only: z.boolean().optional().describe('Only severe alerts') },
    annotations: { readOnlyHint: true },
  },
};

for (const [name, config] of Object.entries(TOOLS)) {
  server.registerTool(name, config, async () => ({ content: [] }));
}

export default server;
