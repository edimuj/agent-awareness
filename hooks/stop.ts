import { readFileSync } from 'node:fs';
import { ensureServer, registerSessionStatus } from '../src/daemon/client.ts';

interface HookInput {
  session_id?: string;
  sessionId?: string;
}

function readInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) as HookInput : {};
  } catch {
    return {};
  }
}

function pickSessionId(input: HookInput): string | null {
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
