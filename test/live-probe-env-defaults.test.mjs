// R-LP-80: declared defaults of optional env names (a registry package's environmentVariables).
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

const WYRE = [
  { name: 'MCP_TRANSPORT', isRequired: false, default: 'stdio', description: 'the image defaults to http for gateway hosting' },
  { name: 'LOG_LEVEL', isRequired: false },
  { name: 'API_TOKEN', isRequired: false, isSecret: true, default: 'sk-example' },
  { name: 'DATA_DIR', isRequired: false, default: '{home}/data' },
  { name: 'ALERTOPS_KEY', isRequired: true, isSecret: true },
  { name: 'REGION', isRequired: true, default: 'eu' },
  { name: 'PATH', isRequired: false, default: '/evil' },
];

test('R-LP-80: an optional env name gets its declared default (MCP_TRANSPORT=stdio), and nothing we invent: no default, a secret\'s default or a placeholder leaves it out', async () => {
  assert.deepEqual(LP.packageEnv(WYRE), { env: { MCP_TRANSPORT: 'stdio', ALERTOPS_KEY: null, REGION: 'eu' }, names: ['MCP_TRANSPORT', 'LOG_LEVEL', 'API_TOKEN', 'DATA_DIR', 'ALERTOPS_KEY', 'REGION'] });
  // Through the launch the sandbox gets: the image's own HTTP default is overridden as a client would.
  const r = await LP.launchFor({ registryType: 'npm', identifier: '@wyre-ai/alertops-mcp', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: WYRE });
  assert.deepEqual(r.launch.env, { MCP_TRANSPORT: 'stdio', ALERTOPS_KEY: null, REGION: 'eu' });
  assert.deepEqual(r.choice.env_names, ['MCP_TRANSPORT', 'LOG_LEVEL', 'API_TOKEN', 'DATA_DIR', 'ALERTOPS_KEY', 'REGION']);
  // A default with a newline or over 500 characters is never passed.
  assert.deepEqual(LP.packageEnv([{ name: 'A', default: 'x\ny' }, { name: 'B', default: 'x'.repeat(501) }]).env, {});
  // Mutation check: without the rule an optional name's declared default is dropped (the image starts HTTP).
  const M = await mutant("    if (!e.isRequired && (d === null || PLACEHOLDER.test(d))) continue;", '    if (!e.isRequired) continue;');
  assert.deepEqual(M.packageEnv(WYRE).env, { ALERTOPS_KEY: null, REGION: 'eu' });
  // ...and without the placeholder check a templated default is passed as if it were a value.
  const P = await mutant("    if (!e.isRequired && (d === null || PLACEHOLDER.test(d))) continue;", '    if (!e.isRequired && d === null) continue;');
  assert.equal(P.packageEnv(WYRE).env.DATA_DIR, '{home}/data');
});

test('R-LP-80: a placeholder in an optional default ({data-dir}, $HOME, ${HOME}, <your-key>) is never passed; config_state says defaults when the probe set only declared defaults', async () => {
  for (const d of ['{data-dir}', '{home.dir}/x', '$HOME/data', '${HOME}/data', '<your-key>', 'Bearer <token>']) assert.deepEqual(LP.packageEnv([{ name: 'OPT', default: d }]).env, {}, d);
  for (const d of ['stdio', 'https://api.example.com', '8080', 'costs 5$', 'x < y']) assert.deepEqual(LP.packageEnv([{ name: 'OPT', default: d }]).env, { OPT: d }, d);
  // config_state: none (the bare probe), defaults (only declared defaults we passed), dummy (any dummy value).
  const bare = { tag: 'bare' }; const envp = { tag: 'env' };
  const rec = (used) => ({ env: { names: { registry: [], readme: [], used } } });
  const launch = { kind: 'npm', package: 'x', env: { MCP_TRANSPORT: 'stdio', API_KEY: null } };
  assert.equal(LP.configStateOf(bare, bare, rec(['MCP_TRANSPORT']), launch), 'none');
  assert.equal(LP.configStateOf(envp, bare, rec(['MCP_TRANSPORT']), launch), 'defaults');
  assert.equal(LP.configStateOf(envp, bare, rec(['MCP_TRANSPORT', 'API_KEY']), launch), 'dummy', 'a required name with no default is a dummy');
  assert.equal(LP.configStateOf(envp, bare, rec(['MCP_TRANSPORT', 'README_TOKEN']), launch), 'dummy', 'a README name is a dummy');
  assert.equal(LP.configStateOf(envp, bare, rec([]), launch), 'dummy');
  // Mutation checks: the old pattern lets {data-dir} through; without configStateOf every env probe is "dummy".
  const M = await mutant("    if (!e.isRequired && (d === null || PLACEHOLDER.test(d))) continue;", "    if (!e.isRequired && (d === null || /\\{[A-Za-z0-9_]+\\}/.test(d))) continue;");
  assert.deepEqual(M.packageEnv([{ name: 'OPT', default: '{data-dir}' }]).env, { OPT: '{data-dir}' });
  const C = await mutant("  return used && used.length && used.every((n) => typeof given[n] === 'string') ? 'defaults' : 'dummy';", "  return 'dummy';");
  assert.equal(C.configStateOf(envp, bare, rec(['MCP_TRANSPORT']), launch), 'dummy');
});
