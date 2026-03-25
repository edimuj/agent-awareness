import { run } from '../src/providers/claude-code/adapter.ts';

const output = await run('prompt');
if (output) process.stdout.write(output);
