import { run } from '../src/providers/codex/adapter.ts';

// Drain stdin when piped (not TTY)
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('session-start');
if (output) process.stdout.write(output);
