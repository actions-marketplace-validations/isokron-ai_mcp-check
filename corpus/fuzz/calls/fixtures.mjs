/**
 * The fixtures the tools/call fuzz stage may run, and how to start each. The stage runs tools/call, which can have side
 * effects, so it never takes a command from a caller: only an id from fixtures.json, and this module builds the argv.
 * Every fixture is ours: a seeded protocol-fault server in this repository, or a tiny-tracker build from
 * isokron-ai/mcp-write-safety at TINY_TRACKER_DIR (R-FC-01).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function fixtureIds() { return FIXTURES.fixtures.map((f) => f.id); }

export function getFixture(id) {
  const f = typeof id === 'string' && ID_RE.test(id) ? FIXTURES.fixtures.find((x) => x.id === id) : undefined;
  if (!f) throw new Error(`not a fixture of the tools/call fuzz stage: ${JSON.stringify(String(id).slice(0, 60))}`);
  return f;
}

/**
 * @returns {{command: string[], env: object, cwd?: string}|{unavailable: string}}
 */
export function launch(id, { tinyDir = process.env.TINY_TRACKER_DIR } = {}) {
  const f = getFixture(id);
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8' };
  if (f.kind === 'seeded') {
    if (f.fault !== null && !NAME_RE.test(f.fault)) throw new Error('fixtures.json: a fault name is not a plain word');
    return { command: [process.execPath, join(HERE, 'fixtures', 'seeded-server.mjs')], env: { ...env, FAULT: f.fault ?? 'clean' } };
  }
  if (f.kind === 'tiny-tracker') {
    if (!tinyDir || !isAbsolute(tinyDir)) return { unavailable: 'tiny_tracker_not_built' };
    const args = ['stdio'];
    for (const d of f.defects ?? []) { if (!NAME_RE.test(d)) throw new Error('fixtures.json: a defect name is not a plain word'); args.push('--defect', d); }
    for (const d of f.backend_defects ?? []) { if (!NAME_RE.test(d)) throw new Error('fixtures.json: a defect name is not a plain word'); args.push('--backend-defect', d); }
    return { command: [process.execPath, join(tinyDir, 'dist', 'src', 'cli.js'), ...args], env: { ...env, TRACKER_STATE_DIR: '' }, cwd: tinyDir };
  }
  throw new Error(`fixtures.json: unknown fixture kind ${JSON.stringify(f.kind)}`);
}
