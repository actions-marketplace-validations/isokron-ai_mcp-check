import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function keyTool(name: string, description: string, readOnly: boolean) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key name' } }, required: ['key'] },
    annotations: { readOnlyHint: readOnly },
  };
}

const server = new Server({ name: 'kv', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    keyTool('get_key', 'Returns the value stored under a key.', true),
    keyTool('touch_key', 'Refreshes the expiry time of a key.', false),
  ],
}));
