import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const readOnly = { annotations: { readOnlyHint: true, openWorldHint: false } };
const server = new McpServer({ name: 'metrics', version: '3.1.0' });

server.registerTool('query_metric', {
  ...readOnly,
  description: 'Returns the values of one metric over a time range.',
  inputSchema: { metric: z.string().describe('Metric name'), from: z.string().describe('Start time, ISO 8601') },
}, async () => ({ content: [] }));

server.registerTool('list_metrics', {
  ...readOnly,
  description: 'Lists metric names.',
  inputSchema: {},
}, async () => ({ content: [] }));

export default server;
