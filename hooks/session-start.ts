import { run } from '../src/providers/claude-code/adapter.ts';

const output = await run('session-start');
if (output) process.stdout.write(output);
