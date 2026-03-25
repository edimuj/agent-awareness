import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginState } from './types.ts';

export const STATE_DIR = join(homedir(), '.cache', 'agent-awareness');
const STATE_FILE = join(STATE_DIR, 'state.json');
const TICKER_CACHE = join(STATE_DIR, 'ticker-cache.json');
const PID_FILE = join(STATE_DIR, 'ticker.pid');

export async function loadState(): Promise<PluginState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state: PluginState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function getPluginState(state: PluginState, pluginName: string): Record<string, unknown> | null {
  return state[pluginName] ?? null;
}

export function setPluginState(state: PluginState, pluginName: string, pluginState: Record<string, unknown> | undefined): PluginState {
  return { ...state, [pluginName]: { ...pluginState, _updatedAt: new Date().toISOString() } };
}

/** Cached text results from the background ticker, keyed by plugin name. */
export interface TickerCache {
  [pluginName: string]: { text: string; gatheredAt: string };
}

export async function loadTickerCache(): Promise<TickerCache> {
  try {
    return JSON.parse(await readFile(TICKER_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveTickerCache(cache: TickerCache): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(TICKER_CACHE, JSON.stringify(cache) + '\n');
}

export async function writeTickerPid(pid: number): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PID_FILE, String(pid) + '\n');
}

export async function readTickerPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_FILE, 'utf8');
    return parseInt(raw.trim()) || null;
  } catch {
    return null;
  }
}

export async function clearTickerPid(): Promise<void> {
  try { await (await import('node:fs/promises')).unlink(PID_FILE); }
  catch { /* already gone */ }
}
