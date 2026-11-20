import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerNoteTools(server: McpServer) {
  server.registerTool('search_notes', {
    title: 'Search notes',
    description: 'Finds notes whose title or text contains the query. Use this to look up a note before reading or changing it.',
    inputSchema: { query: z.string().min(1).describe('Words to look for'), limit: z.number().int().min(1).max(50).optional().describe('Most notes to return') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query }) => ({ content: [{ type: 'text', text: query }] }));

  server.registerTool('delete_note', {
    title: 'Delete a note',
    description: 'Deletes one note by its id. The note cannot be restored.',
    inputSchema: { id: z.string().describe('Note id from search_notes') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => ({ content: [{ type: 'text', text: 'deleted ' + id }] }));
}
