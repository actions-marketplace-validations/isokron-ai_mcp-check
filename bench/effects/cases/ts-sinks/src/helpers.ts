import fs from 'node:fs';

// Not used by any tool below: a function of the same name as a tool, in another file.
export function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true });
}

export const ops: Record<string, (p: string) => void> = {
  wipe: (p) => fs.unlinkSync(p),
  stamp: (p) => fs.writeFileSync(p, 'x'),
};

export function level1(p: string) { level2(p); }
function level2(p: string) { level3(p); }
function level3(p: string) { level4(p); }
function level4(p: string) { fs.writeFileSync(p, 'deep'); }
