import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export enum UserTool {
  List = 'list_users',
  Get = 'get_user',
}

export function registerUserTools(server: McpServer): void {
  server.registerTool(UserTool.List, {
    description: 'Lists users of the workspace.',
    inputSchema: { cursor: z.string().optional().describe('Cursor from the previous page') },
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [] }));
  server.registerTool(UserTool.Get, {
    description: 'Returns one user by id.',
    inputSchema: { id: z.string().describe('User id') },
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [] }));
}
