import { readFileSync } from 'node:fs';
import { ensureServer, registerSessionStatus } from '../dist/daemon/client.js';

function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function pickSessionId(input) {
  const id = input.session_id ?? input.sessionId;
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

const sessionId = pickSessionId(readInput());
if (sessionId) {
  try {
    const daemon = await ensureServer();
    if (daemon) {
      await registerSessionStatus(daemon, {
        sessionId,
        provider: 'claude-code',
        status: 'idle',
      });
    }
  } catch {
    // Non-blocking; stop hooks should not fail the session.
  }
}
