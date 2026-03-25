import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Registry } from '../../core/registry.mjs';
import { render } from '../../core/renderer.mjs';
import { loadState, saveState, getPluginState, setPluginState } from '../../core/state.mjs';

// Awareness plugins
import timeDate from '../../plugins/time-date.mjs';
import quota from '../../plugins/quota.mjs';
import system from '../../plugins/system.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

/**
 * Run the awareness pipeline for a given event.
 * Returns compact text for context injection, or '' if nothing triggered.
 */
export async function run(event) {
  const registry = new Registry();

  registry.register(timeDate);
  registry.register(quota);
  registry.register(system);

  await registry.loadConfig(DEFAULT_CONFIG);

  let state = await loadState();
  const triggered = registry.getTriggeredPlugins(event, state);

  if (triggered.length === 0) return '';

  const results = [];
  for (const { plugin, trigger } of triggered) {
    const config = registry.getPluginConfig(plugin.name);
    const prevState = getPluginState(state, plugin.name);
    const result = await plugin.gather(trigger, config, prevState);
    results.push(result);
    state = setPluginState(state, plugin.name, result.state);
  }

  await saveState(state);

  return render(results);
}
