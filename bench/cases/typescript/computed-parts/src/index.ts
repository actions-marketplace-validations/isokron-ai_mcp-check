import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeChart, chartArgs, chartHints } from './chart-config.js';

const server = new McpServer({ name: 'charts', version: '1.0.0' });

// The description, arguments and annotations are built at run time from a configuration module.
server.registerTool('render_chart', {
  title: 'Render a chart',
  description: describeChart('bar'),
  inputSchema: chartArgs(),
  annotations: chartHints(),
}, async () => ({ content: [] }));

server.registerTool('chart_types', {
  title: 'Chart types',
  description: 'Lists the chart types this server can render, with the arguments each one takes.',
  inputSchema: { verbose: z.boolean().optional().describe('Include the arguments of each type') },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => ({ content: [] }));

export default server;
