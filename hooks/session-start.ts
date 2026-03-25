import { run } from '../src/providers/claude-code/adapter.ts';

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.unref();

const output = await run('session-start');
if (output) process.stdout.write(output);
