import { run } from '../src/providers/codex/adapter.ts';

// Drain stdin when piped (not TTY)
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

function formatForHookContext(text: string): string {
  return text
    .split(/\r?\n+/)
    .map(part => part.trim())
    .filter(Boolean)
    .join(' || ');
}

const output = await run('session-start');
if (output) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: formatForHookContext(output),
    },
  }));
}
