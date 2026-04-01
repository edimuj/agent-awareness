/**
 * File-based locking for state.json.
 *
 * Uses atomic mkdir() as the lock primitive (works across platforms).
 * Includes stale-lock detection: if the lock is older than STALE_MS
 * and the holding PID is dead, it's forcibly removed.
 */

import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const LOCK_DIR = join(homedir(), '.cache', 'agent-awareness', 'state.lock');
const LOCK_META = join(LOCK_DIR, 'meta.json');

/** Lock is considered stale after 30 seconds. */
const STALE_MS = 30_000;
/** Retry interval when waiting for lock. */
const RETRY_MS = 50;
/** Maximum time to wait for a lock before giving up. */
const MAX_WAIT_MS = 10_000;

interface LockMeta {
  pid: number;
  createdAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readMeta(): Promise<LockMeta | null> {
  try {
    return JSON.parse(await readFile(LOCK_META, 'utf8'));
  } catch {
    return null;
  }
}

async function isStale(): Promise<boolean> {
  const meta = await readMeta();
  if (!meta) {
    // Lock dir exists but no meta — treat as stale
    const info = await stat(LOCK_DIR).catch(() => null);
    if (!info) return true;
    return Date.now() - info.mtimeMs > STALE_MS;
  }

  // PID dead → stale
  if (!isPidAlive(meta.pid)) return true;

  // Too old → stale
  return Date.now() - new Date(meta.createdAt).getTime() > STALE_MS;
}

async function tryAcquire(): Promise<boolean> {
  try {
    // Ensure lock parent exists before atomic lock-dir creation.
    await mkdir(dirname(LOCK_DIR), { recursive: true });
    await mkdir(LOCK_DIR);
    // Write meta with our PID
    const meta: LockMeta = { pid: process.pid, createdAt: new Date().toISOString() };
    await writeFile(LOCK_META, JSON.stringify(meta) + '\n');
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function release(): Promise<void> {
  await rm(LOCK_DIR, { recursive: true, force: true });
}

/**
 * Execute `fn` while holding the state lock.
 *
 * Acquires an atomic file lock, runs the function, releases the lock.
 * Handles stale lock cleanup and retries with backoff.
 */
export async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (await tryAcquire()) {
      try {
        return await fn();
      } finally {
        await release();
      }
    }

    // Lock exists — check if stale
    if (await isStale()) {
      await release(); // force-remove stale lock
      continue;        // retry immediately
    }

    // Wait and retry
    await new Promise(r => setTimeout(r, RETRY_MS));
  }

  // Timeout — force-break and proceed (better than deadlock)
  console.error('[agent-awareness] state lock timeout — force-breaking stale lock');
  await release();
  try {
    await tryAcquire();
    return await fn();
  } finally {
    await release();
  }
}
