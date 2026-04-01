import { run } from '../providers/codex/adapter.ts';

if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('prompt');
if (output) process.stdout.write(output);
