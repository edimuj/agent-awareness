import { run } from '../src/providers/claude-code/adapter.mjs';

const output = await run('prompt');
if (output) process.stdout.write(output);
