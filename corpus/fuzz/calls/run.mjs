/**
 * Fuzz one fixture's tools/call: for every listed tool, cases from its inputSchema (gen.mjs), each judged against the
 * invariants (invariants.mjs). Only fixtures of fixtures.json, never a command from the caller.
 */
import { generate } from './gen.mjs';
import { judgeCall } from './invariants.mjs';
import { getFixture, launch } from './fixtures.mjs';
import { FixtureSession } from './session.mjs';

export const MAX_RESTARTS = 8;
export const MAX_FINDINGS = 200;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

async function open(spec, requestMs) {
  const s = new FixtureSession(spec.command, { env: spec.env, cwd: spec.cwd, requestMs }).start();
  const ok = await s.handshake();
  return ok ? s : (await s.stop(), null);
}

async function listTools(s) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await s.request('tools/list', cursor ? { cursor } : {});
    const res = r.response?.result;
    if (!isObj(res) || !Array.isArray(res.tools)) return tools.length ? tools : null;
    tools.push(...res.tools.filter((t) => isObj(t) && typeof t.name === 'string'));
    cursor = typeof res.nextCursor === 'string' ? res.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

/**
 * @returns {Promise<{id: string, status: 'ran'|'unavailable', reason?: string, tools: number, calls: number, restarts: number,
 *   findings: object[], inconclusive: object[], found: string[]}>}
 */
export async function fuzzFixture(id, { tinyDir, requestMs = 5000 } = {}) {
  getFixture(id);
  const spec = launch(id, { tinyDir });
  const base = { id, tools: 0, calls: 0, restarts: 0, findings: [], inconclusive: [], found: [] };
  if (spec.unavailable) return { ...base, status: 'unavailable', reason: spec.unavailable };
  let s = await open(spec, requestMs);
  if (!s) return { ...base, status: 'unavailable', reason: 'handshake_failed' };
  const tools = await listTools(s);
  if (!tools || tools.length === 0) { await s.stop(); return { ...base, status: 'unavailable', reason: 'no_tools_listed' }; }
  const out = { ...base, status: 'ran', tools: tools.length };
  const cases = [];
  tools.forEach((tool, i) => {
    for (const k of generate(tool.inputSchema)) cases.push({ tool, kase: k });
    if (i === 0) cases.push({ tool: null, name: '__isokron_no_such_tool__', kase: { id: 'unknown-tool:call', class: 'unknown-tool', expect: 'any', arguments: {} } });
  });
  for (const { tool, name, kase } of cases) {
    if (!s) { out.inconclusive.push({ id: 'LIFE-1', why: 'the server could not be restarted' }); break; }
    const before = s.stray.length;
    const outcome = await s.request('tools/call', { name: name ?? tool.name, arguments: kase.arguments });
    out.calls += 1;
    const j = judgeCall({ tool, kase, outcome, strays: s.stray.slice(before) });
    for (const f of j.findings) if (out.findings.length < MAX_FINDINGS) out.findings.push({ ...f, tool: name ?? tool.name });
    out.inconclusive.push(...j.inconclusive.map((x) => ({ ...x, tool: name ?? tool.name })));
    if (outcome.exited || outcome.timedOut || outcome.lineCap || s.closed) {
      await s.stop();
      out.restarts += 1;
      s = out.restarts > MAX_RESTARTS ? null : await open(spec, requestMs);
    }
  }
  if (s) await s.stop();
  out.found = [...new Set(out.findings.map((f) => f.id))].sort();
  return out;
}
