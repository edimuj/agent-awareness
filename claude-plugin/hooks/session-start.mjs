import { ensureServer, gatherFromDaemon } from '../dist/daemon/client.js';
import { run } from '../dist/providers/claude-code/adapter.js';

// Drain stdin — Claude Code pipes data here. Not reading it causes EPIPE.
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

// Try daemon first (shared process, single ticker). Fall back to direct adapter.
let output = '';
try {
  const daemon = await ensureServer();
  if (daemon) {
    output = await gatherFromDaemon(daemon, 'session-start');
  }
} catch {
  // Daemon failed — fall through to Tier 1
}

if (!output) {
  output = await run('session-start');
}

if (output) process.stdout.write(output);
