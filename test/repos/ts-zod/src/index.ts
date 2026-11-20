import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerNoteTools } from './tools/notes.js';

const server = new McpServer({ name: 'notes', version: '0.1.0' });
registerNoteTools(server);
await server.connect(new StdioServerTransport());
