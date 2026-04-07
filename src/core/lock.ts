/**
 * File-based locking for state.json.
 *
 * Uses atomic mkdir() as the lock primitive (works across platforms).
 * Includes stale-lock detection: if the lock is older than STALE_MS
 * and the holding PID is dead, it's forcibly removed.
 *
 * Lock directory is passed in via setLockDir() from state.ts after initStateDir().
 */

import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Lock is considered stale after 30 seconds. */
const STALE_MS = 30_000;
/** Retry interval when waiting for lock. */
const RETRY_MS = 50;
/** Maximum time to wait for a lock before giving up. */
const MAX_WAIT_MS = 10_000;

let lockDir = '';

/** Called by state.ts after initStateDir() to set the lock directory. */
export function setLockDir(dir: string): void {
  lockDir = dir;
}

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
    return JSON.parse(await readFile(join(lockDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function isStale(): Promise<boolean> {
  const meta = await readMeta();
  if (!meta) {
    const info = await stat(lockDir).catch(() => null);
    if (!info) return true;
    return Date.now() - info.mtimeMs > STALE_MS;
  }
  if (!isPidAlive(meta.pid)) return true;
  return Date.now() - new Date(meta.createdAt).getTime() > STALE_MS;
}

async function tryAcquire(): Promise<boolean> {
  try {
    await mkdir(dirname(lockDir), { recursive: true });
    await mkdir(lockDir);
    const meta: LockMeta = { pid: process.pid, createdAt: new Date().toISOString() };
    await writeFile(join(lockDir, 'meta.json'), JSON.stringify(meta) + '\n');
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function release(): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

/**
 * Execute `fn` while holding the state lock.
 * Handles stale lock cleanup and retries with backoff.
 */
export async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!lockDir) throw new Error('Lock dir not initialized — call initStateDir() first');
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (await tryAcquire()) {
      try {
        return await fn();
      } finally {
        await release();
      }
    }

    if (await isStale()) {
      await release();
      continue;
    }

    await new Promise(r => setTimeout(r, RETRY_MS));
  }

  console.error('[agent-awareness] state lock timeout — force-breaking stale lock');
  await release();
  try {
    await tryAcquire();
    return await fn();
  } finally {
    await release();
  }
}
