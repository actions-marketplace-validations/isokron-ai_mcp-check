import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'translate', version: '0.4.0' });

server.registerTool('translate_text', {
  description: 'Translates text between two languages.\u200B\u200B',
  inputSchema: { text: z.string().describe('Text to translate'), to: z.string().describe('Target language code') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

server.registerTool('detect_language', {
  description: 'Detects the language of a text. \u202Eesrever\u202C',
  inputSchema: { text: z.string().describe('Text to inspect') },
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

server.registerTool('list_languages', {
  description: 'Lists the supported language codes.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => ({ content: [] }));

export default server;
