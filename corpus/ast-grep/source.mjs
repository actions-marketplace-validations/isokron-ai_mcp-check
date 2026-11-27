// The subject's source at one commit, on disk, for ast-grep. scan-static reads a subject through the GitHub API and keeps
// no checkout, so this fetches the same commit (the sha the reader read) with git: a fresh, empty repository, a shallow
// partial fetch of that one commit, and a checkout of source files only. Nothing of the subject is run or built: no hook
// exists in a fresh repository, symlinks are written as plain files, LFS filters and submodules are off.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXCLUDED_PATH } from './paths.mjs';

export const SHA_RE = /^[0-9a-f]{40}$/;
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

/** Runs git with the fixed -c flags; `input` goes to its stdin, and the promise resolves with its stdout. */
const git = (cwd, args, { timeoutMs, input = null, env = {} }) => new Promise((resolve, reject) => {
  const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never',
    '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'advice.detachedHead=false', ...args],
  { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } },
  (err, stdout) => (err ? reject(Object.assign(new Error('git ' + args[0] + ' failed'), { killed: err.killed === true })) : resolve(String(stdout))));
  if (input !== null) child.stdin.end(input); else child.stdin.end();
});

/** The source paths to check out: source files outside tests, docs and vendored code, at most `max`, those that look like a server first. */
export function chooseFiles(listing, { prefix = '', max = MAX_FILES, exclude = EXCLUDED_PATH } = {}) {
  const ext = /\.(?:[cm]?[jt]sx?|py|go|rs|cs)$/;
  const files = String(listing).split('\n').filter((p) => p && ext.test(p) && p.startsWith(prefix) && !exclude.test(p) && !/[*?\[\]\\\n]|^[#!]/.test(p));
  if (files.length <= max) return files;
  const score = (p) => (/mcp|tool|server/i.test(p) ? 0 : 1);
  return files.sort((x, y) => score(x) - score(y) || x.length - y.length || (x < y ? -1 : 1)).slice(0, max);
}
export const MAX_FILES = 6000;

/**
 * Fetches `repo` (owner/name) at `sha` into a new folder under `tmp` and returns { dir, cleanup }. Throws an Error whose
 * `code` is 'timeout' or 'fetch_failed' (the commit is gone, the repository is private, GitHub refused).
 */
export async function fetchSource(repo, sha, { tmp = tmpdir(), timeoutMs = 45_000, host = 'https://github.com/', run = git, prefix = '' } = {}) {
  if (!REPO_RE.test(repo) || !SHA_RE.test(sha)) throw Object.assign(new Error('bad subject'), { code: 'bad_subject' });
  const root = mkdtempSync(join(tmp, 'ast-grep-src-'));
  const dir = join(root, 'src');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    // one budget for all the steps: each gets what is left of it
    const t0 = Date.now();
    const opts = () => ({ timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)) });
    await run(root, ['init', '-q', 'src'], opts());
    await run(dir, ['remote', 'add', 'origin', host + repo + '.git'], opts());
    // the commit's tree without blobs, then only the source files worth reading are checked out (their blobs fetched in one batch)
    await run(dir, ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin', sha], opts());
    const listing = await run(dir, ['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], opts());
    const files = chooseFiles(listing, { prefix });
    if (files.length) {
      await run(dir, ['sparse-checkout', 'set', '--no-cone', '--stdin'], { ...opts(), input: files.map((f) => '/' + f).join('\n') + '\n' });
      await run(dir, ['checkout', '-q', '--detach', 'FETCH_HEAD'], opts());
    }
    return { dir, cleanup };
  } catch (e) {
    cleanup();
    throw Object.assign(new Error('source not fetched'), { code: e && e.killed ? 'timeout' : e && e.code === 'bad_subject' ? 'bad_subject' : 'fetch_failed' });
  }
}
