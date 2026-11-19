const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const TOOLS = [
  {
    name: 'query',
    description: 'Run a read-only SQL query.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'SELECT statement' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } },
      required: ['sql'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'drop_table',
    description: `Drop a table`,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    handler: async (args) => { if (/x/.test(args.table)) return 1; return 2; },
  },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(({ handler, ...t }) => t) }));
