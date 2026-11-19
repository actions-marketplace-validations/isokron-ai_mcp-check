#!/usr/bin/env node
// The engine (engine/core.js and the Ajv bundle it loads) is the same file as the web checker at
// isokron.ai/mcp-check. This copies it from the web checker's source tree into engine/ and records the
// SHA-256 of every file in engine/VENDORED.json, so an edit to one copy and not the other is caught.
//   node scripts/vendor.mjs <path/to/web-checker>   copy and record (or set $CHECK_V2)
//   node scripts/vendor.mjs --verify [path]         exit 1 if a file no longer matches its recorded hash,
//                                                   or (when the source is given and present) differs from it
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const verify = args.includes('--verify');
const given = args.find((a) => !a.startsWith('--')) || process.env.CHECK_V2 || '';
const src = given ? resolve(given) : '';
if (!verify && !src) { console.error('usage: node scripts/vendor.mjs <path/to/web-checker> (or set CHECK_V2)'); process.exit(2); }
const FILES = [
  ['core.js', 'core.js'],
  ['vendor/ajv2020.min.js', 'vendor/ajv2020.min.js'],
  ['vendor/AJV-LICENSE.txt', 'vendor/AJV-LICENSE.txt'],
];
// Files kept only in this repository (no web-checker source): recorded by hash, never copied.
const LOCAL = ['vendor/THIRD-PARTY-LICENSES.txt'];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifestPath = join(root, 'engine', 'VENDORED.json');

if (verify) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];
  for (const f of m.files) {
    const local = join(root, 'engine', f.path);
    if (!existsSync(local)) { problems.push(f.path + ': missing'); continue; }
    if (sha(local) !== f.sha256) problems.push(f.path + ': edited after vendoring (hash differs from VENDORED.json)');
    const upstream = src && f.source ? join(src, f.source) : '';
    if (upstream && existsSync(upstream) && sha(upstream) !== f.sha256) problems.push(f.path + ': upstream ' + upstream + ' has changed; re-run npm run vendor');
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('engine matches VENDORED.json (' + m.files.length + ' files, rubric ' + m.rubric_version + ')');
  process.exit(0);
}

const files = [];
for (const [from, to] of FILES) {
  const a = join(src, from);
  const b = join(root, 'engine', to);
  mkdirSync(dirname(b), { recursive: true });
  copyFileSync(a, b);
  files.push({ path: to, source: from, sha256: sha(b) });
}
for (const to of LOCAL) files.push({ path: to, source: null, sha256: sha(join(root, 'engine', to)) });
const rubric = /const RUBRIC_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'engine', 'core.js'), 'utf8'))[1];
writeFileSync(manifestPath, JSON.stringify({ from: 'the isokron.ai/mcp-check web checker', rubric_version: rubric, files }, null, 2) + '\n');
console.log('vendored ' + files.length + ' files, rubric ' + rubric);
