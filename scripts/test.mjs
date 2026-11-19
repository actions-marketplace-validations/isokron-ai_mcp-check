#!/usr/bin/env node
// Runs every test/*.test.{cjs,mjs} with node --test, one file at a time (the stdio and Action tests start
// processes). Lists the files itself, so it works on Node versions with and without --test globs.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(dir).filter((f) => /\.test\.(c|m)?js$/.test(f)).sort().map((f) => join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
