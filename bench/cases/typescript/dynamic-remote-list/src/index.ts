import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Every tool comes from a catalogue fetched at start-up: no tool exists in the source.
type Remote = { name: string; description: string };

const server = new McpServer({ name: 'proxy', version: '0.1.0' });
const catalogue: Remote[] = await fetch(process.env.CATALOGUE_URL ?? 'https://catalogue.invalid/tools.json').then((r) => r.json());

for (const entry of catalogue) {
  server.registerTool(entry.name, { description: entry.description, inputSchema: {} }, async () => ({ content: [] }));
}

export default server;
