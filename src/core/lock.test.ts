import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { withStateLock } from './lock.ts';

const LOCK_DIR = join(homedir(), '.cache', 'agent-awareness', 'state.lock');

afterEach(async () => {
  // Clean up any leftover locks
  await rm(LOCK_DIR, { recursive: true, force: true });
});

describe('withStateLock', () => {
  it('executes function and returns result', async () => {
    const result = await withStateLock(async () => 42);
    assert.equal(result, 42);
  });

  it('releases lock after successful execution', async () => {
    await withStateLock(async () => 'done');
    const exists = await stat(LOCK_DIR).then(() => true).catch(() => false);
    assert.equal(exists, false, 'lock dir should be removed after execution');
  });

  it('releases lock after error', async () => {
    await assert.rejects(
      () => withStateLock(async () => { throw new Error('boom'); }),
      { message: 'boom' },
    );
    const exists = await stat(LOCK_DIR).then(() => true).catch(() => false);
    assert.equal(exists, false, 'lock dir should be removed after error');
  });

  it('serializes concurrent access', async () => {
    const order: number[] = [];

    const a = withStateLock(async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 100));
      order.push(2);
    });

    // Small delay so B arrives while A holds the lock
    await new Promise(r => setTimeout(r, 10));

    const b = withStateLock(async () => {
      order.push(3);
    });

    await Promise.all([a, b]);
    // A should complete (1,2) before B starts (3)
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('breaks stale lock from dead PID', async () => {
    // Create a fake lock with a dead PID
    await mkdir(LOCK_DIR, { recursive: true });
    await writeFile(join(LOCK_DIR, 'meta.json'), JSON.stringify({
      pid: 999999999,  // almost certainly dead
      createdAt: new Date().toISOString(),
    }));

    const result = await withStateLock(async () => 'recovered');
    assert.equal(result, 'recovered');
  });
});
