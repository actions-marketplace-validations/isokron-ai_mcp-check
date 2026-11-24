// --repo: an McpServer whose tools/list handler the server replaces with its own. The SDK's additions to a listed tool
// ($schema, execution) are then not known, so the reader writes neither (R-RD-04). Synthetic sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../engine/core.js');
const R = require('../src/inputs/repo-source.cjs');

const PKG = JSON.stringify({ name: 'demo-server', dependencies: { '@modelcontextprotocol/sdk': '1.32.2', zod: '^4.1.0' } });
const REGISTER = [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import * as z from 'zod/v4';",
  "export function register(server) {",
  "  server.registerTool('lookup', { title: 'Look up', description: 'Looks a word up.', inputSchema: z.strictObject({ word: z.string().describe('The word') }), outputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } }, async () => ({}));",
  "}",
].join('\n');
const OVERRIDE = [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
  "import { register } from './tools.js';",
  "const server = new McpServer({ name: 'demo', version: '1.0.0' });",
  "register(server);",
  "server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: myDefinitions() }));",
].join('\n');
const PLAIN = [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { register } from './tools.js';",
  "const server = new McpServer({ name: 'demo', version: '1.0.0' });",
  "register(server);",
].join('\n');
const read = (files) => R.analyseRepo(new Map(Object.entries(files))).tools.map((x) => x.tool);
const grade = (tools) => M.allFindings(M.analyse(M.parseInput(JSON.stringify({ tools }))));

test('R-RD-04: an McpServer with its own tools/list handler: no $schema and no execution are written for its tools', () => {
  const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': OVERRIDE });
  assert.deepEqual(got.map((t) => t.name), ['lookup']);
  const t = got[0];
  assert.equal(t.inputSchema.$schema, undefined);
  assert.ok(!('$schema' in t.inputSchema), 'not even an undefined $schema key');
  assert.equal(t.outputSchema && t.outputSchema.$schema, undefined);
  assert.equal(t.execution, undefined);
  // the rest of the derived list is unchanged: the schema body, the title, the annotations
  assert.equal(t.inputSchema.type, 'object');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['word']);
  assert.deepEqual(t.annotations, { readOnlyHint: true });
  const ids = grade(got).map((f) => f.id);
  assert.ok(!ids.includes('spec-schema-dialect'), ids.join(','));
  assert.ok(!ids.includes('spec-execution-legacy'), ids.join(','));
});

test('R-RD-04: without the override the SDK 1.x listing is still reproduced ($schema draft-07, execution) and graded', () => {
  const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': PLAIN });
  assert.equal(got[0].inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(got[0].execution, { taskSupport: 'forbidden' });
  const ids = grade(got).map((f) => f.id);
  assert.ok(ids.includes('spec-schema-dialect'));
  assert.ok(ids.includes('spec-execution-legacy'));
});

test('R-RD-04: a low-level Server with a tools/list handler elsewhere in the repository does not count as an override', () => {
  const lowLevel = [
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "const s = new Server({ name: 'other', version: '1' }, { capabilities: { tools: {} } });",
    "s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));",
  ].join('\n');
  const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': PLAIN, 'src/proxy.ts': lowLevel });
  assert.equal(got[0].inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(got[0].execution, { taskSupport: 'forbidden' });
});

test("R-RD-04: SDK 2's string form setRequestHandler('tools/list', …) on an McpServer counts as an override", () => {
  const v2pkg = JSON.stringify({ name: 'demo-server', dependencies: { '@modelcontextprotocol/server': '2.4.0', zod: '^4.1.0' } });
  const reg = REGISTER.replace("'@modelcontextprotocol/sdk/server/mcp.js'", "'@modelcontextprotocol/server'");
  const over = "import { McpServer } from '@modelcontextprotocol/server';\nconst server = new McpServer({ name: 'd', version: '1' });\nserver.server.setRequestHandler('tools/list', () => ({ tools: defs }));\n";
  const got = read({ 'package.json': v2pkg, 'src/tools.ts': reg, 'src/index.ts': over });
  assert.equal(got[0].inputSchema.$schema, undefined);
  const plain = read({ 'package.json': v2pkg, 'src/tools.ts': reg, 'src/index.ts': "import { McpServer } from '@modelcontextprotocol/server';\nconst server = new McpServer({ name: 'd', version: '1' });\n" });
  assert.equal(plain[0].inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('R-RD-04: this.server.setRequestHandler (a class holding a low-level Server) is not an McpServer override', () => {
  const cls = [
    "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "export class Host { constructor() { this.server = new Server({ name: 'h', version: '1' }); this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] })); } }",
  ].join('\n');
  const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': PLAIN, 'src/host.ts': cls });
  assert.equal(got[0].inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(got[0].execution, { taskSupport: 'forbidden' });
});

test("R-RD-04: a handler that wraps the SDK's own keeps execution, and still writes no $schema", () => {
  const wrap = [
    "import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "export default function retarget(mcpServer: McpServer) {",
    "  const listTools = (mcpServer.server as any)._requestHandlers.get('tools/list');",
    "  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (r, e) => { const out = await listTools(r, e); return out; });",
    "}",
  ].join('\n');
  const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': PLAIN, 'src/dialect.ts': wrap });
  assert.equal(got[0].inputSchema.$schema, undefined);
  assert.deepEqual(got[0].execution, { taskSupport: 'forbidden' });
});

test('R-RD-04: a class that holds the McpServer (this.mcp.server / this.server.server) counts as an override', () => {
  for (const holder of ['this.mcp.server', 'this.server.server']) {
    const cls = [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      "import { register } from './tools.js';",
      "export class App { constructor() { const m = new McpServer({ name: 'a', version: '1' }); register(m); " + holder.replace(/\.server$/, '') + " = m; " + holder + ".setRequestHandler(ListToolsRequestSchema, () => ({ tools: defs })); } }",
    ].join('\n');
    const got = read({ 'package.json': PKG, 'src/tools.ts': REGISTER, 'src/index.ts': cls });
    assert.equal(got[0].inputSchema.$schema, undefined, holder);
    assert.equal(got[0].execution, undefined, holder);
  }
});

test('R-RD-04: in a monorepo the override applies to its own package only', () => {
  const got = R.analyseRepo(new Map(Object.entries({
    'packages/a/package.json': PKG, 'packages/a/src/tools.ts': REGISTER, 'packages/a/src/index.ts': OVERRIDE,
    'packages/b/package.json': PKG, 'packages/b/src/tools.ts': REGISTER.replace("'lookup'", "'other'"), 'packages/b/src/index.ts': PLAIN,
  }))).found.map((x) => x.tool);
  const by = Object.fromEntries(got.map((t) => [t.name, t]));
  assert.equal(by.lookup.inputSchema.$schema, undefined);
  assert.equal(by.other.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(by.other.execution, { taskSupport: 'forbidden' });
});

test('R-RD-04: the override check is linear in the text (400 KB of semicolon-free imports, McpServer and setRequestHandler)', () => {
  const unit = 'import a from "b"\nconst McpServer = x\nimport c from "d"\nfoo.server.setRequestHandler(Other, f)\nimport McpServer\nthis.mcp.server .setRequestHandler(X)\n';
  const big = unit.repeat(Math.ceil(400000 / unit.length));
  const time = (text) => { const t0 = performance.now(); const r = R.customListHandler('src/big.ts', text); return [performance.now() - t0, r]; };
  const [small] = time(big.slice(0, 48000));
  const [large, r1] = time(big);
  assert.equal(r1, null);
  assert.ok(large < 500, 'took ' + Math.round(large) + ' ms for 400 KB');
  assert.ok(large < small * 30 + 50, 'not linear: ' + Math.round(small) + ' ms for 48 KB, ' + Math.round(large) + ' ms for 400 KB');
  const [, r2] = time(big + "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'\nm.server.setRequestHandler(ListToolsRequestSchema, f)\n");
  assert.equal(r2, 'replace');
});
