import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { initStateDir, STATE_DIR } from './state.ts';
import { withStateLock } from './lock.ts';

let lockDir: string;

before(async () => {
  await initStateDir('test');
  lockDir = join(STATE_DIR, 'state.lock');
});

afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

describe('withStateLock', () => {
  it('executes function and returns result', async () => {
    const result = await withStateLock(async () => 42);
    assert.equal(result, 42);
  });

  it('releases lock after successful execution', async () => {
    await withStateLock(async () => 'done');
    const exists = await stat(lockDir).then(() => true).catch(() => false);
    assert.equal(exists, false, 'lock dir should be removed after execution');
  });

  it('releases lock after error', async () => {
    await assert.rejects(
      () => withStateLock(async () => { throw new Error('boom'); }),
      { message: 'boom' },
    );
    const exists = await stat(lockDir).then(() => true).catch(() => false);
    assert.equal(exists, false, 'lock dir should be removed after error');
  });

  it('serializes concurrent access', async () => {
    const order: number[] = [];

    const a = withStateLock(async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 100));
      order.push(2);
    });

    await new Promise(r => setTimeout(r, 50));

    const b = withStateLock(async () => {
      order.push(3);
    });

    await Promise.all([a, b]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('breaks stale lock from dead PID', async () => {
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'meta.json'), JSON.stringify({
      pid: 999999999,
      createdAt: new Date().toISOString(),
    }));

    const result = await withStateLock(async () => 'recovered');
    assert.equal(result, 'recovered');
  });
});
