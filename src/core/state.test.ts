import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadState, saveState, getPluginState, setPluginState,
  withState, loadTickerCache, saveTickerCache,
  writeTickerPid, readTickerPid, clearTickerPid,
  STATE_DIR,
} from './state.ts';

const STATE_FILE = join(STATE_DIR, 'state.json');
const TICKER_CACHE = join(STATE_DIR, 'ticker-cache.json');
const PID_FILE = join(STATE_DIR, 'ticker.pid');
const LOCK_DIR = join(STATE_DIR, 'state.lock');

// Back up and restore state files around each test
let origState: string | null = null;
let origCache: string | null = null;
let origPid: string | null = null;

async function readOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

afterEach(async () => {
  // Clean up locks that withState may leave
  await rm(LOCK_DIR, { recursive: true, force: true });
});

describe('loadState / saveState', () => {
  it('returns empty object when no state file exists', async () => {
    // Temporarily move state file aside
    origState = await readOrNull(STATE_FILE);
    try {
      await rm(STATE_FILE, { force: true });
      const state = await loadState();
      assert.deepEqual(state, {});
    } finally {
      if (origState !== null) {
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(STATE_FILE, origState);
      }
    }
  });

  it('round-trips state through save/load', async () => {
    origState = await readOrNull(STATE_FILE);
    try {
      const data = { 'test-plugin': { value: 42, _updatedAt: '2025-01-01T00:00:00Z' } };
      await saveState(data);
      const loaded = await loadState();
      assert.deepEqual(loaded, data);
    } finally {
      if (origState !== null) {
        await writeFile(STATE_FILE, origState);
      } else {
        await rm(STATE_FILE, { force: true });
      }
    }
  });

  it('creates state directory if missing', async () => {
    // saveState calls mkdir recursive — just verify no throw
    origState = await readOrNull(STATE_FILE);
    try {
      await saveState({ probe: { ok: true } });
      const exists = await stat(STATE_DIR).then(() => true).catch(() => false);
      assert.ok(exists);
    } finally {
      if (origState !== null) {
        await writeFile(STATE_FILE, origState);
      } else {
        await rm(STATE_FILE, { force: true });
      }
    }
  });
});

describe('getPluginState / setPluginState', () => {
  it('returns null for unknown plugin', () => {
    const state = {};
    assert.equal(getPluginState(state, 'nonexistent'), null);
  });

  it('returns plugin state when present', () => {
    const state = { myPlugin: { count: 5 } };
    assert.deepEqual(getPluginState(state, 'myPlugin'), { count: 5 });
  });

  it('sets plugin state with _updatedAt timestamp', () => {
    const before = new Date().toISOString();
    const result = setPluginState({}, 'myPlugin', { count: 10 });

    assert.ok(result.myPlugin);
    assert.equal((result.myPlugin as Record<string, unknown>).count, 10);
    assert.ok(
      (result.myPlugin as Record<string, unknown>)._updatedAt,
      'should have _updatedAt',
    );
    const ts = (result.myPlugin as Record<string, unknown>)._updatedAt as string;
    assert.ok(ts >= before, '_updatedAt should be recent');
  });

  it('preserves other plugins when setting state', () => {
    const state = { existing: { val: 1 } };
    const result = setPluginState(state, 'newPlugin', { val: 2 });
    assert.deepEqual(getPluginState(result, 'existing'), { val: 1 });
    assert.ok(getPluginState(result, 'newPlugin'));
  });
});

describe('withState', () => {
  it('atomically reads, transforms, and saves state', async () => {
    origState = await readOrNull(STATE_FILE);
    try {
      await saveState({ counter: { n: 1 } });
      const result = await withState(state => {
        const n = (state.counter as Record<string, unknown>)?.n as number ?? 0;
        return setPluginState(state, 'counter', { n: n + 1 });
      });
      assert.equal((result.counter as Record<string, unknown>).n, 2);

      // Verify persisted
      const loaded = await loadState();
      assert.equal((loaded.counter as Record<string, unknown>).n, 2);
    } finally {
      if (origState !== null) {
        await writeFile(STATE_FILE, origState);
      } else {
        await rm(STATE_FILE, { force: true });
      }
    }
  });
});

describe('ticker cache', () => {
  it('returns empty object when no cache file exists', async () => {
    origCache = await readOrNull(TICKER_CACHE);
    try {
      await rm(TICKER_CACHE, { force: true });
      const cache = await loadTickerCache();
      assert.deepEqual(cache, {});
    } finally {
      if (origCache !== null) {
        await writeFile(TICKER_CACHE, origCache);
      }
    }
  });

  it('round-trips ticker cache', async () => {
    origCache = await readOrNull(TICKER_CACHE);
    try {
      const data = { myPlugin: { text: 'hello', gatheredAt: '2025-01-01T00:00:00Z' } };
      await saveTickerCache(data);
      const loaded = await loadTickerCache();
      assert.deepEqual(loaded, data);
    } finally {
      if (origCache !== null) {
        await writeFile(TICKER_CACHE, origCache);
      } else {
        await rm(TICKER_CACHE, { force: true });
      }
    }
  });
});

describe('ticker PID', () => {
  it('returns null when no PID file exists', async () => {
    origPid = await readOrNull(PID_FILE);
    try {
      await rm(PID_FILE, { force: true });
      const pid = await readTickerPid();
      assert.equal(pid, null);
    } finally {
      if (origPid !== null) {
        await writeFile(PID_FILE, origPid);
      }
    }
  });

  it('round-trips PID value', async () => {
    origPid = await readOrNull(PID_FILE);
    try {
      await writeTickerPid(12345);
      const pid = await readTickerPid();
      assert.equal(pid, 12345);
    } finally {
      if (origPid !== null) {
        await writeFile(PID_FILE, origPid);
      } else {
        await rm(PID_FILE, { force: true });
      }
    }
  });

  it('clears PID file', async () => {
    origPid = await readOrNull(PID_FILE);
    try {
      await writeTickerPid(99999);
      await clearTickerPid();
      const pid = await readTickerPid();
      assert.equal(pid, null);
    } finally {
      if (origPid !== null) {
        await writeFile(PID_FILE, origPid);
      }
    }
  });
});
