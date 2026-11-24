import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'projects', version: '0.1.0' });

server.registerTool('list_projects', {
  title: 'List projects',
  description: 'Lists the projects you can see, newest first. Use this to find a project id.',
  inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Most projects to return') },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => ({ content: [{ type: 'text', text: '[]' }] }));

server.registerTool('create_project', {
  title: 'Create a project',
  description: 'Creates an empty project with the given name.',
  inputSchema: { name: z.string().min(1).describe('Project name') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ name }) => ({ content: [{ type: 'text', text: name }] }));

server.registerTool('archive_project', {
  title: 'Archive a project',
  description: 'Archives a project. Archived projects can be restored from the settings page.',
  inputSchema: { id: z.string().describe('Project id from list_projects') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ id }) => ({ content: [{ type: 'text', text: id }] }));

await server.connect(new StdioServerTransport());
