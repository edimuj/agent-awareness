import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  initStateDir,
  loadState, saveState, getPluginState, setPluginState,
  withState, loadTickerCache, saveTickerCache,
  writeTickerPid, readTickerPid, clearTickerPid,
  STATE_DIR,
} from './state.ts';

let stateFile: string;
let tickerCache: string;
let pidFile: string;
let lockDir: string;

before(async () => {
  await initStateDir('test');
  stateFile = join(STATE_DIR, 'state.json');
  tickerCache = join(STATE_DIR, 'ticker-cache.json');
  pidFile = join(STATE_DIR, 'ticker.pid');
  lockDir = join(STATE_DIR, 'state.lock');
});

async function readOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

// Back up and restore state files around each test
let origState: string | null = null;
let origCache: string | null = null;
let origPid: string | null = null;

afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

describe('loadState / saveState', () => {
  it('returns empty object when no state file exists', async () => {
    origState = await readOrNull(stateFile);
    try {
      await rm(stateFile, { force: true });
      const state = await loadState();
      assert.deepEqual(state, {});
    } finally {
      if (origState !== null) {
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(stateFile, origState);
      }
    }
  });

  it('round-trips state through save/load', async () => {
    origState = await readOrNull(stateFile);
    try {
      const data = { 'test-plugin': { value: 42, _updatedAt: '2025-01-01T00:00:00Z' } };
      await saveState(data);
      const loaded = await loadState();
      assert.deepEqual(loaded, data);
    } finally {
      if (origState !== null) {
        await writeFile(stateFile, origState);
      } else {
        await rm(stateFile, { force: true });
      }
    }
  });

  it('creates state directory if missing', async () => {
    origState = await readOrNull(stateFile);
    try {
      await saveState({ probe: { ok: true } });
      const exists = await stat(STATE_DIR).then(() => true).catch(() => false);
      assert.ok(exists);
    } finally {
      if (origState !== null) {
        await writeFile(stateFile, origState);
      } else {
        await rm(stateFile, { force: true });
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
    origState = await readOrNull(stateFile);
    try {
      await saveState({ counter: { n: 1 } });
      const result = await withState(state => {
        const n = (state.counter as Record<string, unknown>)?.n as number ?? 0;
        return setPluginState(state, 'counter', { n: n + 1 });
      });
      assert.equal((result.counter as Record<string, unknown>).n, 2);

      const loaded = await loadState();
      assert.equal((loaded.counter as Record<string, unknown>).n, 2);
    } finally {
      if (origState !== null) {
        await writeFile(stateFile, origState);
      } else {
        await rm(stateFile, { force: true });
      }
    }
  });
});

describe('ticker cache', () => {
  it('returns empty object when no cache file exists', async () => {
    origCache = await readOrNull(tickerCache);
    try {
      await rm(tickerCache, { force: true });
      const cache = await loadTickerCache();
      assert.deepEqual(cache, {});
    } finally {
      if (origCache !== null) {
        await writeFile(tickerCache, origCache);
      }
    }
  });

  it('round-trips ticker cache', async () => {
    origCache = await readOrNull(tickerCache);
    try {
      const data = { myPlugin: { text: 'hello', gatheredAt: '2025-01-01T00:00:00Z' } };
      await saveTickerCache(data);
      const loaded = await loadTickerCache();
      assert.deepEqual(loaded, data);
    } finally {
      if (origCache !== null) {
        await writeFile(tickerCache, origCache);
      } else {
        await rm(tickerCache, { force: true });
      }
    }
  });
});

describe('ticker PID', () => {
  it('returns null when no PID file exists', async () => {
    origPid = await readOrNull(pidFile);
    try {
      await rm(pidFile, { force: true });
      const pid = await readTickerPid();
      assert.equal(pid, null);
    } finally {
      if (origPid !== null) {
        await writeFile(pidFile, origPid);
      }
    }
  });

  it('round-trips PID value', async () => {
    origPid = await readOrNull(pidFile);
    try {
      await writeTickerPid(12345);
      const pid = await readTickerPid();
      assert.equal(pid, 12345);
    } finally {
      if (origPid !== null) {
        await writeFile(pidFile, origPid);
      } else {
        await rm(pidFile, { force: true });
      }
    }
  });

  it('clears PID file', async () => {
    origPid = await readOrNull(pidFile);
    try {
      await writeTickerPid(99999);
      await clearTickerPid();
      const pid = await readTickerPid();
      assert.equal(pid, null);
    } finally {
      if (origPid !== null) {
        await writeFile(pidFile, origPid);
      }
    }
  });
});
