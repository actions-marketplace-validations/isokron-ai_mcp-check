import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// A stand-in server used only by the tests: its tool is not one of the real server's tools.
const fake = new McpServer({ name: 'fake', version: '0.0.0' });
fake.registerTool('reset_clock_for_tests', { description: 'Test helper.', inputSchema: {} }, async () => ({ content: [] }));
export default fake;
