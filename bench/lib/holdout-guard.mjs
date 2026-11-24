// The holdout guard: the private holdout's files are known here only by their sha256, so a public case or truth file
// that copies one (verbatim, or with only its whitespace changed) is refused by the test suite.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder } from './cases.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
/** The hashes of one file: its bytes, and its text with all whitespace removed. */
export function fileHashes(buf) {
  return [sha(buf), sha(String(buf).replace(/\s+/g, ''))];
}

/** Every hash of every file under <base>/cases and <base>/truth, with the path it came from. */
export function caseSetHashes(base) {
  const out = [];
  for (const sub of ['cases', 'truth']) for (const f of filesUnder(join(base, sub))) for (const h of fileHashes(readFileSync(join(base, sub, f)))) out.push({ path: sub + '/' + f, hash: h });
  return out;
}
