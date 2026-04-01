import { run } from '../providers/codex/adapter.ts';

if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('session-start');
if (output) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: output,
    },
  }));
}
