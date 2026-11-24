// A stand-in oracle client for test/oracles.test.mjs: speaks raw JSON-RPC to the command after `--` and prints the
// result line the real clients print (corpus/oracles/ts-client.mjs). FAKE_OUTCOME=timeout makes it hang.
import { spawn } from 'node:child_process';

const [id, ms, sep, ...cmd] = process.argv.slice(2);
if (sep !== '--') process.exit(2);
if (process.env.FAKE_OUTCOME === 'timeout') setInterval(() => {}, 1000);
else {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = { format: 'isokron-oracle-client/1', client: id, sdk_version: '9.9.9', outcome: null, stage: 'connect', error: null, protocol: null, pages: 0, tools: null, ms: 1, limit_ms: Number(ms), env_keys: Object.keys(process.env).sort() };
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id === 1) { out.protocol = m.result.protocolVersion; out.stage = 'list'; child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`); }
      if (m.id === 2) { out.tools = m.result.tools; out.pages = 1; out.outcome = 'listed'; process.stdout.write(`${JSON.stringify(out)}\n`); child.kill(); process.exit(0); }
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })}\n`);
  setTimeout(() => { out.outcome = 'timeout'; process.stdout.write(`${JSON.stringify(out)}\n`); process.exit(0); }, Number(ms)).unref();
}
