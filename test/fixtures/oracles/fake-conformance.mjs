// A stand-in for the conformance suite's command line in test/oracles.test.mjs: `server --url U --scenario S
// --spec-version R --timeout T -o DIR`. It initializes a session through the URL (the bridge), sends one request
// for the scenario, ends the session, and writes DIR/server-S-<time>/checks.json as the suite does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const a = process.argv.slice(2);
const opt = (f) => a[a.indexOf(f) + 1];
const url = opt('--url'); const scenario = opt('--scenario'); const dir = opt('-o');
const post = async (body, sid) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, sid: r.headers.get('mcp-session-id'), text: await r.text() };
};
const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: opt('--spec-version'), capabilities: {}, clientInfo: { name: 'fake-conformance', version: '1' } } });
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
const method = scenario === 'ping' ? 'ping' : scenario === 'tools-list' ? 'tools/list' : scenario === 'prompts-list' ? 'prompts/list' : scenario === 'resources-list' ? 'resources/list' : 'ping';
const r = await post({ jsonrpc: '2.0', id: 2, method }, init.sid);
await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': init.sid } });
const ok = r.status === 200 && !JSON.parse(r.text).error;
const checks = [
  { id: scenario, name: scenario, description: 'fake', status: ok ? 'SUCCESS' : 'FAILURE', timestamp: '2026-11-24T00:00:00.000Z', ...(ok ? {} : { errorMessage: `Failed: ${JSON.parse(r.text).error.message}` }) },
  { id: 'server-session-id-visible-ascii', name: 's', description: 'fake', status: init.sid ? 'SUCCESS' : 'INFO', timestamp: '2026-11-24T00:00:00.000Z' },
];
const d = join(dir, `server-${scenario}-2026`);
mkdirSync(d, { recursive: true });
writeFileSync(join(d, 'checks.json'), JSON.stringify(checks));
process.exit(ok ? 0 : 1);
