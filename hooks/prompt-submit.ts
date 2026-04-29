import { readFileSync } from 'node:fs';
import { ensureServer, gatherFromDaemon, registerSessionStatus } from '../src/daemon/client.ts';
import { run } from '../src/providers/claude-code/adapter.ts';

interface HookInput {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
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

// Try daemon first. Fall back to direct adapter (Tier 1).
let output = '';
const input = readInput();
const sessionId = pickSessionId(input);
const sessionMeta = sessionId ? {
  sessionId,
  provider: 'claude-code',
  status: 'busy' as const,
} : undefined;
try {
  const daemon = await ensureServer();
  if (daemon) {
    if (sessionMeta) {
      await registerSessionStatus(daemon, sessionMeta);
    }
    output = await gatherFromDaemon(daemon, 'prompt', input.cwd, sessionMeta);
  }
} catch {
  // Daemon failed — fall through to Tier 1
}

if (!output) {
  output = await run('prompt');
}

if (output) process.stdout.write(output);
