import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'repo-tools', version: '1.0.0' });
server.registerTool('list_pull_requests', {
  description: 'Lists open pull requests of a repository.',
  inputSchema: { repo: z.string().describe('owner/name') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));
export default server;
