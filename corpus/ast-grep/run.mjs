// Runs the pinned ast-grep binary. The binary is the platform package of @ast-grep/cli, installed from this folder's
// lockfile with `npm ci --ignore-scripts` (the package's own install script is never run); the version is the one
// in package.json and the lockfile pins its integrity. Rules are copied from packs/ with the language filled in.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PINNED_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies['@ast-grep/cli'];

/** pack file -> the ast-grep languages its rules are written for (the pack says __LANG__ where it varies). */
export const PACKS = Object.freeze({
  'typescript.yml': ['TypeScript', 'Tsx', 'JavaScript'],
  'python.yml': [null], 'go.yml': [null], 'rust.yml': [null], 'csharp.yml': [null],
});
/** The language of a pack after its rule ids are made unique per language: `ts-server-tool.Tsx`. */
export const baseRuleId = (id) => String(id).split('.')[0];

function platformPackage() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'cli-darwin-arm64' : 'cli-darwin-x64';
  if (platform === 'linux') {
    const musl = (() => { try { return readdirSync('/lib').some((f) => f.startsWith('ld-musl')); } catch { return false; } })();
    return 'cli-linux-' + (arch === 'arm64' ? 'arm64' : 'x64') + (musl ? '-musl' : '-gnu');
  }
  if (platform === 'win32') return 'cli-win32-x64-msvc';
  return null;
}

/** Path of the ast-grep binary under `modules` (a node_modules folder), or null when it is not installed. */
export function binaryPath(modules = join(HERE, 'node_modules')) {
  const pkg = platformPackage();
  if (!pkg) return null;
  const file = join(modules, '@ast-grep', pkg, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  return existsSync(file) ? file : null;
}

/** Writes the rule folder and sgconfig.yml under `dir`; returns the config path. */
export function materializeRules(dir, { packs = PACKS, packsDir = join(HERE, 'packs') } = {}) {
  const rules = join(dir, 'rules');
  mkdirSync(rules, { recursive: true });
  for (const [file, langs] of Object.entries(packs)) {
    const text = readFileSync(join(packsDir, file), 'utf8');
    for (const lang of langs) {
      const body = lang === null ? text : text.replaceAll('__LANG__', lang).replace(/^id: (\S+)$/gm, 'id: $1.' + lang);
      writeFileSync(join(rules, file.replace(/\.yml$/, '') + (lang ? '.' + lang : '') + '.yml'), body);
    }
  }
  writeFileSync(join(dir, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');
  return join(dir, 'sgconfig.yml');
}

/**
 * Scans `target` with the rules; resolves { matches, error }. Matches are ast-grep's JSON records (one per line),
 * with ruleId reduced to its base. Never rejects: an exit that is not 0 or 1, a timeout or unreadable output is `error`.
 */
export function scan({ binary, target, timeoutMs = 60_000, rulesDir = null, maxBuffer = 256 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let dir = rulesDir;
    let own = null;
    try {
      if (!dir) { own = mkdtempSync(join(tmpdir(), 'ast-grep-rules-')); dir = own; materializeRules(dir); }
    } catch (e) { resolve({ matches: [], error: 'rules_not_written' }); return; }
    const done = (r) => { if (own) rmSync(own, { recursive: true, force: true }); resolve(r); };
    const args = ['scan', '--config', join(dir, 'sgconfig.yml'), '--json=stream', '--no-ignore', 'hidden', '--no-ignore', 'dot', '--no-ignore', 'vcs', '--no-ignore', 'exclude', '--no-ignore', 'global', '--no-ignore', 'parent', target];
    execFile(binary, args, { timeout: timeoutMs, maxBuffer, env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), LANG: 'C.UTF-8' } }, (err, stdout) => {
      if (err && !(err.code === 1 && !err.killed) ) { done({ matches: [], error: err.killed || err.signal ? 'timeout' : err.code === 'ENOBUFS' ? 'output_too_large' : 'ast_grep_failed' }); return; }
      const matches = [];
      for (const line of String(stdout).split('\n')) {
        if (!line) continue;
        try { const j = JSON.parse(line); matches.push({ ...j, ruleId: baseRuleId(j.ruleId) }); } catch { done({ matches: [], error: 'unreadable_output' }); return; }
      }
      done({ matches, error: null });
    });
  });
}

/** The version the binary reports, or null. */
export function binaryVersion(binary) {
  return new Promise((resolve) => execFile(binary, ['--version'], { timeout: 10_000 }, (err, out) => resolve(err ? null : (/(\d+\.\d+\.\d+)/.exec(String(out)) || [])[1] ?? null)));
}
