// R-LP-89: a bundle download's HTTP failure split as the registry's (R-LP-76): a 4xx that does not change is ours and final.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

/** corpus/<file> with `from` replaced by `to`, imported fresh (a mutation check). */
async function mutant(from, to, file = 'live-probe.mjs') {
  const src = readFileSync(join(root, 'corpus', file), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/' + file + ': ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}
import * as MB from '../corpus/mcpb.mjs';

const URL1 = 'https://github.com/acme/bundle/releases/download/v1.0.0/acme.mcpb';
const answer = (status, headers = {}) => async () => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, arrayBuffer: async () => Buffer.alloc(0) });
const detailOf = async (M, status, headers) => (await M.fetchBundle(URL1, { fetch: answer(status, headers) }).catch((e) => e)).detail;

test('R-LP-89: a bundle download\'s 4xx that does not change is bundle_fetch_refused (tool, not retried); 5xx, 403, 408, 425 stay upstream_error (retried), 429 rate_limited, github.com\'s 404 bundle_unavailable', async () => {
  for (const s of [400, 401, 410, 422, 451]) assert.equal(await detailOf(MB, s), 'bundle_fetch_refused', String(s));
  for (const s of [500, 502, 503, 504, 403, 408, 425]) assert.equal(await detailOf(MB, s), 'upstream_error', String(s));
  assert.equal(await detailOf(MB, 429), 'rate_limited');
  assert.equal(await detailOf(MB, 403, { 'x-ratelimit-remaining': '0' }), 'rate_limited');
  assert.equal(await detailOf(MB, 404), 'bundle_unavailable');
  // The detail: ours, never retried; the resolver's retryable two are unchanged.
  assert.deepEqual(LP.DETAILS.bundle_fetch_refused, ['tool_error', false, 'resolve', 'tool']);
  assert.equal(LP.DETAILS.upstream_error[1], true);
  // Through the resolver: a seed bundle answered 410 is a tool skip with no retry, not an outage.
  const seed = new Map([['acme/bundle', [{ registry: 'mcpb', identifier: URL1 }]]]);
  const reg = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'registry.modelcontextprotocol.io') { const b = Buffer.from(JSON.stringify({ servers: [] })); return { status: 200, ok: true, headers: { get: () => String(b.length) }, arrayBuffer: async () => b }; }
    return answer(410)();
  };
  const r = await LP.resolveSubject({ subject: 'acme/bundle', repo: 'acme/bundle' }, { seed, fetch: reg });
  assert.equal(r.detail, 'bundle_fetch_refused');
  // Mutation check: without the rule every 4xx is an outage, tried again every cycle.
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const from = "    if (Number.isInteger(res.status) && res.status >= 400 && res.status < 500 && ![403, 408, 425].includes(res.status)) throw fail('bundle_fetch_refused', { status: res.status });\n";
  assert.ok(src.includes(from));
  const mf = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '.mjs');
  writeFileSync(mf, src.replace(from, ''));
  try { const M = await import(pathToFileURL(mf).href); assert.equal(await detailOf(M, 410), 'upstream_error'); } finally { rmSync(mf, { force: true }); }
});
