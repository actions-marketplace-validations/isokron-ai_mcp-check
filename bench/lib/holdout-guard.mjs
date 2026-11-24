// The holdout guard: the private holdout's files are known here only by their sha256, so a public case or truth file
// that copies one (verbatim, or with only its whitespace changed) is refused by the test suite.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder } from './cases.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
/** Files smaller than this get only the hash of their bytes. A whitespace-free hash of a tiny boilerplate file (a
 *  two-line package.json or go.mod) could equal one written independently for a public case, and refuse it for no
 *  reason; a copied case is caught by its larger source and truth files anyway. */
export const MIN_NORMALISED_BYTES = 200;

/** The hashes of one file: its bytes, and (from 200 bytes) its text with all whitespace removed. */
export function fileHashes(buf) {
  return buf.length >= MIN_NORMALISED_BYTES ? [sha(buf), sha(String(buf).replace(/\s+/g, ''))] : [sha(buf)];
}

/** Every hash of every file under <base>/cases and <base>/truth, with the path it came from. */
export function caseSetHashes(base) {
  const out = [];
  for (const sub of ['cases', 'truth']) for (const f of filesUnder(join(base, sub))) for (const h of fileHashes(readFileSync(join(base, sub, f)))) out.push({ path: sub + '/' + f, hash: h });
  return out;
}
