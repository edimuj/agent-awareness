import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginState } from './types.ts';

const STATE_DIR = join(homedir(), '.cache', 'agent-awareness');
const STATE_FILE = join(STATE_DIR, 'state.json');

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
