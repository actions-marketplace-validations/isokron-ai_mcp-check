import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { TOOLS } from './tools.js';

const server = new Server({ name: 'items', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'get_item': {
      const text = fs.readFileSync('items/' + args.id, 'utf8');
      return { content: [{ type: 'text', text }] };
    }
    case 'touch_item':
      fs.writeFileSync('items/' + args.id + '.seen', String(Date.now()));
      return { content: [] };
    case 'delete_item': {
      fs.rmSync('items/' + args.id);
      return { content: [] };
    }
    case 'count_items':
      return { content: [{ type: 'text', text: String(fs.readdirSync('items').length) }] };
    default:
      throw new Error('unknown tool');
  }
});

export default server;
