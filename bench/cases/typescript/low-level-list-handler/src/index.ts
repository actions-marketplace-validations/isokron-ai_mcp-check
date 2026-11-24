import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'files', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_text_range',
      description: 'Returns lines start..end of a text file in the workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path inside the workspace' }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'stat_path',
      description: 'Returns the size and modification time of a path in the workspace.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path inside the workspace' } }, required: ['path'] },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
