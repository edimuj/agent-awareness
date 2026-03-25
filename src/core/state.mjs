import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.cache', 'agent-awareness');
const STATE_FILE = join(STATE_DIR, 'state.json');

export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function getPluginState(state, pluginName) {
  return state[pluginName] ?? null;
}

export function setPluginState(state, pluginName, pluginState) {
  return { ...state, [pluginName]: { ...pluginState, _updatedAt: new Date().toISOString() } };
}
