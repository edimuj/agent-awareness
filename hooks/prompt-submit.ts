import { run } from '../src/providers/claude-code/adapter.ts';

// Drain stdin — Claude Code pipes the user prompt here.
// Not reading it causes EPIPE on the Claude Code side → hook error.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.unref();

const output = await run('prompt');
if (output) process.stdout.write(output);
