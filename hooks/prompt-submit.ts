import { ensureServer, gatherFromDaemon } from '../src/daemon/client.ts';
import { run } from '../src/providers/claude-code/adapter.ts';

// Drain stdin — Claude Code pipes data here. Not reading it causes EPIPE.
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

// Try daemon first. Fall back to direct adapter (Tier 1).
let output = '';
try {
  const daemon = await ensureServer();
  if (daemon) {
    output = await gatherFromDaemon(daemon, 'prompt');
  }
} catch {
  // Daemon failed — fall through to Tier 1
}

if (!output) {
  output = await run('prompt');
}

if (output) process.stdout.write(output);
