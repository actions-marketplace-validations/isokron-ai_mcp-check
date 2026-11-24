// For test/oracles.test.mjs (R-ORC-04): starts a grandchild that keeps this program's stdout open and never exits,
// writes the grandchild's pid, then hangs, as an SDK client whose server command outlives it would.
import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write(`${JSON.stringify({ grandchild: g.pid })}\n`);
setInterval(() => {}, 1000);
