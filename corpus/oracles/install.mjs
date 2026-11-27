#!/usr/bin/env node
/**
 * Installs the live-probe lane's oracles (corpus/LIVE-PROBE.md, "Oracles") into a folder of the runner's temp space,
 * before the sandbox guard and before any target runs:
 *
 *   node corpus/oracles/install.mjs <dest> <mcp-surface-corpus checkout>
 *
 * - npm: the conformance suite and the TypeScript SDK clients, `npm ci --ignore-scripts` from package-lock.json;
 * - PyPI: the Python SDK, `pip install --require-hashes --only-binary=:all: --no-deps` from requirements.txt;
 * - Go: the Go SDK client, `go build -mod=readonly` from go.mod and go.sum (a newer Go toolchain, when go.mod asks
 *   for one, comes the same way, from the Go module proxy, checked against the checksum database).
 *
 * Every download goes through the sandbox's own allowlist proxy (mcp-surface-corpus sandbox/egress-proxy.mjs,
 * listening on 127.0.0.1 at a port the system picks), which tunnels only to the package registries' hosts on port 443
 * and logs every request; the lockfiles' hashes decide what is accepted. Writes <dest>/clients.json: for each client
 * the command that runs it, or why it is unavailable. A client that fails to install is recorded, never fatal: the
 * lane then reports that oracle as unavailable (our fault, never the server's). Exits 0 unless <dest> cannot be
 * written.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FORMAT = 'isokron-live-probe-oracle-install/1';
/**
 * The hosts the proxy tunnels to. proxy.golang.org answers a module zip with a redirect to storage.googleapis.com, so
 * that host is on the list too; what comes from it is accepted only when it matches go.sum.
 */
export const ALLOW_HOSTS = Object.freeze(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com']);

function run(cmd, args, { env, cwd, timeoutMs }) {
  return new Promise((done) => {
    const t0 = Date.now();
    let child;
    try { child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { done({ exit: 127, out: String(e.message), ms: 0 }); return; }
    let out = '';
    const add = (c) => { out = (out + c.toString('utf8')).slice(-8000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => add(Buffer.from(String(e.message))));
    child.on('close', (code) => { clearTimeout(timer); done({ exit: code, out, ms: Date.now() - t0 }); });
  });
}

const lastLine = (s) => String(s || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);

export async function install(dest, msc, { log = () => {} } = {}) {
  dest = resolve(dest);
  mkdirSync(dest, { recursive: true });
  const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
  const { makeProxy } = await import(pathToFileURL(join(resolve(msc), 'sandbox', 'egress-proxy.mjs')).href);
  const proxyLog = [];
  const server = makeProxy(new Set(ALLOW_HOSTS), (o) => { if (proxyLog.length < 5000) proxyLog.push({ t: new Date().toISOString(), ...o }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const home = join(dest, 'home'); mkdirSync(home, { recursive: true });
  const base = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', CI: '1',
    HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '',
  };
  const result = { format: FORMAT, started_at: new Date().toISOString(), finished_at: null, proxy: { allow: [...ALLOW_HOSTS], requests: 0, refused: 0, hosts: [] }, conformance: null, clients: {} };

  const npm = async () => {
    const dir = join(dest, 'npm'); mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json', 'ts-client.mjs', 'inspector-client.mjs']) cpSync(join(here, f), join(dir, f));
    const r = await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: dir, timeoutMs: 6 * 60_000, env: { ...base, npm_config_cache: join(dest, 'npm-cache'), npm_config_https_proxy: proxy, npm_config_proxy: proxy, npm_config_update_notifier: 'false' } });
    log(`npm ci: exit ${r.exit} in ${r.ms} ms`);
    const ver = (p) => { try { return JSON.parse(readFileSync(join(dir, 'node_modules', ...p.split('/'), 'package.json'), 'utf8')).version; } catch { return null; } };
    const conf = join(dir, 'node_modules', '@modelcontextprotocol', 'conformance');
    const cv = r.exit === 0 ? ver('@modelcontextprotocol/conformance') : null;
    result.conformance = cv === pins.conformance.version && existsSync(join(conf, 'dist', 'index.js'))
      ? { ok: true, version: cv, dir: conf, bin: join(conf, 'dist', 'index.js') }
      : { ok: false, version: cv, error: r.exit === 0 ? 'not the pinned version' : `npm ci failed: ${lastLine(r.out)}` };
    for (const [id, line, pkg] of [['typescript-v1', 'v1', '@modelcontextprotocol/sdk'], ['typescript-v2', 'v2', '@modelcontextprotocol/client']]) {
      const want = pins.clients.find((c) => c.id === id).version;
      const v = r.exit === 0 ? ver(pkg) : null;
      result.clients[id] = v === want ? { ok: true, version: v, command: [process.execPath, join(dir, 'ts-client.mjs'), line] } : { ok: false, version: v, error: r.exit === 0 ? 'not the pinned version' : `npm ci failed: ${lastLine(r.out)}` };
    }
    // R-ORC-13: the MCP Inspector's CLI, from the same lockfile, behind our wrapper (inspector-client.mjs).
    const iw = pins.clients.find((c) => c.id === 'inspector');
    if (iw) {
      const v = r.exit === 0 ? ver('@modelcontextprotocol/inspector') : null;
      const launcher = join(dir, 'node_modules', '@modelcontextprotocol', 'inspector', 'clients', 'launcher', 'build', 'index.js');
      result.clients.inspector = v === iw.version && existsSync(launcher) ? { ok: true, version: v, command: [process.execPath, join(dir, 'inspector-client.mjs')] } : { ok: false, version: v, error: r.exit === 0 ? (v === iw.version ? 'no CLI launcher in the package' : 'not the pinned version') : `npm ci failed: ${lastLine(r.out)}` };
    }
  };

  const pypi = async () => {
    const id = 'python';
    const want = pins.clients.find((c) => c.id === id).version;
    const venv = join(dest, 'py');
    let r = await run('python3', ['-m', 'venv', venv], { env: base, timeoutMs: 120_000 });
    if (r.exit !== 0) { result.clients[id] = { ok: false, version: null, error: `venv failed: ${lastLine(r.out)}` }; return; }
    r = await run(join(venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', '--no-input', '--require-hashes', '--only-binary=:all:', '--no-deps', '--index-url', 'https://pypi.org/simple', '-r', join(here, 'requirements.txt')], { env: { ...base, PIP_CACHE_DIR: join(dest, 'pip-cache') }, timeoutMs: 6 * 60_000 });
    log(`pip install: exit ${r.exit} in ${r.ms} ms`);
    if (r.exit !== 0) { result.clients[id] = { ok: false, version: null, error: `pip install failed: ${lastLine(r.out)}` }; return; }
    cpSync(join(here, 'py-client.py'), join(dest, 'py-client.py'));
    const v = await run(join(venv, 'bin', 'python'), ['-I', '-c', 'from importlib.metadata import version; print(version("mcp"))'], { env: base, timeoutMs: 60_000 });
    const got = v.exit === 0 ? v.out.trim().split('\n').pop() : null;
    result.clients[id] = got === want ? { ok: true, version: got, command: [join(venv, 'bin', 'python'), '-I', join(dest, 'py-client.py')] } : { ok: false, version: got, error: 'not the pinned version' };
  };

  const go = async () => {
    const id = 'go';
    const want = pins.clients.find((c) => c.id === id).version;
    const src = join(dest, 'go-src');
    cpSync(join(here, 'go'), src, { recursive: true });
    const bin = join(dest, 'oracle-go');
    const genv = { ...base, GOPATH: join(dest, 'gopath'), GOMODCACHE: join(dest, 'gopath', 'pkg', 'mod'), GOCACHE: join(dest, 'gocache'), GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOFLAGS: '-mod=readonly -modcacherw', GOTOOLCHAIN: 'auto', GOTELEMETRY: 'off', CGO_ENABLED: '0' };
    const r = await run('go', ['build', '-trimpath', '-o', bin, '.'], { cwd: src, env: genv, timeoutMs: 8 * 60_000 });
    log(`go build: exit ${r.exit} in ${r.ms} ms`);
    if (r.exit !== 0) { result.clients[id] = { ok: false, version: null, error: `go build failed: ${lastLine(r.out)}` }; return; }
    const v = await run('go', ['version', '-m', bin], { cwd: src, env: genv, timeoutMs: 60_000 });
    const m = /\bgithub\.com\/modelcontextprotocol\/go-sdk\s+(v[0-9A-Za-z.+-]+)/.exec(v.out);
    const got = m ? m[1] : null;
    result.clients[id] = got === want ? { ok: true, version: got, command: [bin] } : { ok: false, version: got, error: 'not the pinned version' };
  };

  await Promise.all([npm(), pypi(), go()]);
  await new Promise((r) => server.close(() => r()));
  result.proxy.requests = proxyLog.filter((e) => e.host).length;
  result.proxy.refused = proxyLog.filter((e) => e.allowed === false).length;
  result.proxy.hosts = [...new Set(proxyLog.filter((e) => e.allowed === true && e.host).map((e) => e.host))].sort();
  result.finished_at = new Date().toISOString();
  writeFileSync(join(dest, 'proxy.jsonl'), proxyLog.map((e) => JSON.stringify(e)).join('\n') + (proxyLog.length ? '\n' : ''));
  writeFileSync(join(dest, 'clients.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [dest, msc] = process.argv.slice(2);
  if (!dest || !msc) { process.stderr.write('usage: install.mjs <dest> <mcp-surface-corpus checkout>\n'); process.exit(2); }
  install(dest, msc, { log: (l) => process.stdout.write(`${l}\n`) }).then((r) => {
    const ok = Object.entries(r.clients).map(([k, v]) => `${k}=${v.ok ? v.version : 'unavailable'}`).join(', ');
    process.stdout.write(`oracles: conformance=${r.conformance && r.conformance.ok ? r.conformance.version : 'unavailable'}, ${ok}; proxy ${r.proxy.requests} requests, ${r.proxy.refused} refused (${r.proxy.hosts.join(' ')})\n`);
  }, (e) => { process.stderr.write(`${e && e.stack}\n`); process.exit(1); });
}
