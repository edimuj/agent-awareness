import { appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './state.ts';

export const LOG_FILE = join(STATE_DIR, 'agent-awareness.log');
const MAX_LOG_SIZE = 256 * 1024; // 256 KB — rotate when exceeded

/** Append a timestamped line to the log file. */
export async function logToFile(message: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19);
  await appendFile(LOG_FILE, `${ts} ${message}\n`);
}

/** Rotate log if over size limit. Keeps one previous (.1) file. */
export async function rotateLogIfNeeded(): Promise<void> {
  try {
    const s = await stat(LOG_FILE);
    if (s.size > MAX_LOG_SIZE) {
      await rename(LOG_FILE, LOG_FILE + '.1');
    }
  } catch { /* file doesn't exist yet — nothing to rotate */ }
}

/** Open a file descriptor for the log (for spawn stdio redirect). Caller must closeSync(fd). */
export function openLogFd(): number {
  mkdirSync(STATE_DIR, { recursive: true });
  return openSync(LOG_FILE, 'a');
}
