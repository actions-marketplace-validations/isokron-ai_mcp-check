import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export class WeatherTools {
  constructor(private readonly apiBase: string) {}

  register(server: McpServer): void {
    server.registerTool('current_conditions', {
      description: 'Current temperature, wind and sky for a place.',
      inputSchema: { place: z.string().describe('Place name or postcode') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async () => ({ content: [] }));
    server.registerTool('weather_alerts', {
      description: 'Active weather alerts for a region.',
      inputSchema: { region: z.string().describe('Region code') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async () => ({ content: [] }));
  }
}
