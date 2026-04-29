import { readFileSync } from 'node:fs';
import { ensureServer, unregisterSessionStatus } from '../src/daemon/client.ts';

interface HookInput {
  session_id?: string;
  sessionId?: string;
  reason?: string;
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

const input = readInput();
const sessionId = pickSessionId(input);

if (sessionId) {
  try {
    const daemon = await ensureServer();
    if (daemon) {
      await unregisterSessionStatus(daemon, {
        sessionId,
        provider: 'claude-code',
        status: 'offline',
        reason: input.reason,
      });
    }
  } catch {
    // Non-blocking; session shutdown should continue.
  }
}
