import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const pair = { a: z.number().describe('First number'), b: z.number().describe('Second number') };

const TOOLS = [
  { name: 'add_numbers', description: 'Adds two numbers.', schema: pair, run: (a: number, b: number) => a + b },
  { name: 'multiply_numbers', description: 'Multiplies two numbers.', schema: pair, run: (a: number, b: number) => a * b },
];

const server = new McpServer({ name: 'calc', version: '0.0.1' });

for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(t.run(a, b)) }] }));
}

export default server;
