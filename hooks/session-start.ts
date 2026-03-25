import { run } from '../src/providers/claude-code/adapter.ts';

// Drain stdin — Claude Code pipes data here. Not reading it causes EPIPE.
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('session-start');
if (output) process.stdout.write(output);
