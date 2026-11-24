// A stand-in server the eval suite talks to: canned answers, not the product.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const mock = new McpServer({ name: 'docs-mock', version: '0.0.0' });

mock.registerTool('mock_search_docs', {
  description: 'Returns canned search results for the evals.',
  inputSchema: { query: z.string() },
}, async () => ({ content: [] }));

export default mock;
