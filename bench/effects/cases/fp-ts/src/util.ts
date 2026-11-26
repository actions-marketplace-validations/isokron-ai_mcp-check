import fs from "node:fs";
export function helper(mode: string, x: string) {
  if (mode === "write") { fs.writeFileSync(x, "d"); return 1; }
  return fs.readFileSync(x, "utf8");
}
export function other(x: string) { return x; }
