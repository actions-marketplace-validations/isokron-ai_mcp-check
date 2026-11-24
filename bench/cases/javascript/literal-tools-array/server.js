import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'list_bookmarks',
    description: 'Lists saved bookmarks.',
    inputSchema: { type: 'object', properties: { tag: { type: 'string', description: 'Only bookmarks with this tag' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'remove_bookmark',
    description: 'Removes a bookmark.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Bookmark id' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const server = new Server({ name: 'bookmarks', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
export default server;
