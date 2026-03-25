import { run } from '../src/providers/claude-code/adapter.mjs';

const output = await run('session-start');
if (output) process.stdout.write(output);
