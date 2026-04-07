import { readFile, writeFile, mkdir, unlink, rename, cp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginState } from './types.ts';
import { withStateLock, setLockDir } from './lock.ts';

const BASE_DIR = join(homedir(), '.cache', 'agent-awareness');

/** Provider-scoped state directory. Must call initStateDir() before using state functions. */
export let STATE_DIR = '';

/**
 * Initialize the state directory for a specific provider.
 * Must be called once at startup before any state operations.
 * Runs one-time migration from old flat layout if needed.
 */
export async function initStateDir(provider: string): Promise<void> {
  STATE_DIR = join(BASE_DIR, provider);
  setLockDir(join(STATE_DIR, 'state.lock'));
  await mkdir(STATE_DIR, { recursive: true });
  await migrateFromFlatLayout(provider);
}

/**
 * Migrate old flat ~/.cache/agent-awareness/ files into provider subdir.
 * Only runs once — skips if provider dir already has state.json.
 */
async function migrateFromFlatLayout(provider: string): Promise<void> {
  const providerState = join(STATE_DIR, 'state.json');
  const oldState = join(BASE_DIR, 'state.json');

  // Skip if provider state already exists or old state doesn't
  const [hasNew, hasOld] = await Promise.all([
    access(providerState).then(() => true, () => false),
    access(oldState).then(() => true, () => false),
  ]);
  if (hasNew || !hasOld) return;

  // Move files from flat layout to provider subdir
  const filesToMove = ['state.json', 'ticker-cache.json', 'channel-seen.json', 'agent-awareness.log', 'agent-awareness.log.1'];
  for (const file of filesToMove) {
    const src = join(BASE_DIR, file);
    const dst = join(STATE_DIR, file);
    try {
      await rename(src, dst);
    } catch { /* file doesn't exist — skip */ }
  }

  // Copy claims directory
  const oldClaims = join(BASE_DIR, 'claims');
  const newClaims = join(STATE_DIR, 'claims');
  try {
    await cp(oldClaims, newClaims, { recursive: true });
    await rm(oldClaims, { recursive: true, force: true });
  } catch { /* no claims dir — skip */ }

  // Clean up old ticker files
  for (const file of ['ticker.pid', 'ticker-owner']) {
    try { await unlink(join(BASE_DIR, file)); } catch { /* skip */ }
  }
}

// --- Plugin state ---

export async function loadState(): Promise<PluginState> {
  try {
    return JSON.parse(await readFile(join(STATE_DIR, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state: PluginState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

export function getPluginState(state: PluginState, pluginName: string): Record<string, unknown> | null {
  return state[pluginName] ?? null;
}

export function setPluginState(state: PluginState, pluginName: string, pluginState: Record<string, unknown> | undefined): PluginState {
  return { ...state, [pluginName]: { ...pluginState, _updatedAt: new Date().toISOString() } };
}

/**
 * Atomic read-modify-write for plugin state.
 * Acquires file lock, loads state, calls transform, saves result, releases lock.
 */
export async function withState(fn: (state: PluginState) => Promise<PluginState> | PluginState): Promise<PluginState> {
  return withStateLock(async () => {
    const state = await loadState();
    const updated = await fn(state);
    await saveState(updated);
    return updated;
  });
}

// --- Ticker cache (Tier 2 / MCP only) ---

export interface TickerCache {
  [pluginName: string]: { text: string; gatheredAt: string };
}

export async function loadTickerCache(): Promise<TickerCache> {
  try {
    return JSON.parse(await readFile(join(STATE_DIR, 'ticker-cache.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveTickerCache(cache: TickerCache): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, 'ticker-cache.json'), JSON.stringify(cache) + '\n');
}

// --- Ticker PID (MCP server process tracking) ---

export async function writeTickerPid(pid: number): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, 'ticker.pid'), String(pid) + '\n');
}

export async function readTickerPid(): Promise<number | null> {
  try {
    const raw = await readFile(join(STATE_DIR, 'ticker.pid'), 'utf8');
    return parseInt(raw.trim()) || null;
  } catch {
    return null;
  }
}

export async function clearTickerPid(): Promise<void> {
  try { await unlink(join(STATE_DIR, 'ticker.pid')); }
  catch { /* already gone */ }
}

// --- Channel-seen fingerprints (Tier 2 / MCP dedup) ---

export async function loadChannelSeen(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(STATE_DIR, 'channel-seen.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveChannelSeen(seen: Record<string, string>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, 'channel-seen.json'), JSON.stringify(seen) + '\n');
}

export async function clearChannelSeen(): Promise<void> {
  try { await unlink(join(STATE_DIR, 'channel-seen.json')); }
  catch { /* already gone */ }
}
