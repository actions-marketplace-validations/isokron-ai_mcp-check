#!/usr/bin/env node
/**
 * The byte cap between a target and an oracle client (corpus/LIVE-PROBE.md, "Oracles"). The SDK clients run on the
 * runner, outside the container's memory limit, so what a server may send them is bounded here: the client starts
 *
 *   node relay.mjs <total bytes> <line bytes> -- <command...>
 *
 * as its server, and this passes stdin through unchanged and the command's stdout through until the server has sent
 * more than <total bytes>, or one line longer than <line bytes>; then it stops the command and exits 3. The
 * command's stderr is dropped. It holds no more than one chunk at a time.
 */
import { spawn } from 'node:child_process';

export function relay(total, lineCap, command, { stdin = process.stdin, stdout = process.stdout, exit = (c) => process.exit(c) } = {}) {
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
  let sent = 0; let line = 0; let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { child.kill('SIGKILL'); } catch { /* gone */ } exit(3); };
  stdin.on('data', (c) => { try { child.stdin.write(c); } catch { /* closed */ } });
  stdin.on('end', () => { try { child.stdin.end(); } catch { /* closed */ } });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (c) => {
    if (stopped) return;
    sent += c.length;
    const nl = c.lastIndexOf(10);
    line = nl < 0 ? line + c.length : c.length - nl - 1;
    if (sent > total || line > lineCap) { stop(); return; }
    stdout.write(c);
  });
  child.on('error', () => exit(127));
  child.on('close', (code) => { if (!stopped) exit(code ?? 1); });
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
  return child;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [total, lineCap, sep, ...command] = process.argv.slice(2);
  if (!(Number(total) > 0) || !(Number(lineCap) > 0) || sep !== '--' || !command.length) { process.stderr.write('usage: relay.mjs <total bytes> <line bytes> -- <command...>\n'); process.exit(2); }
  relay(Number(total), Number(lineCap), command);
}
