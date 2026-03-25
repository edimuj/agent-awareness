import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Registry } from '../../core/registry.ts';
import { render } from '../../core/renderer.ts';
import { loadState, saveState, getPluginState, setPluginState } from '../../core/state.ts';
import type { Trigger } from '../../core/types.ts';

// Awareness plugins
import timeDate from '../../plugins/time-date.ts';
import quota from '../../plugins/quota.ts';
import system from '../../plugins/system.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

/**
 * Run the awareness pipeline for a given event.
 * Returns compact text for context injection, or '' if nothing triggered.
 *
 * On 'session-start', calls onStart() on all enabled plugins before gathering.
 */
export async function run(event: string): Promise<string> {
  const registry = new Registry();

  registry.register(timeDate);
  registry.register(quota);
  registry.register(system);

  await registry.loadConfig(DEFAULT_CONFIG);

  // Lifecycle: call onStart for all enabled plugins at session start
  if (event === 'session-start') {
    await registry.startPlugins();
  }

  let state = await loadState();
  const triggered = registry.getTriggeredPlugins(event, state);

  if (triggered.length === 0) return '';

  const results = [];
  for (const { plugin, trigger } of triggered) {
    const config = registry.getPluginConfig(plugin.name)!;
    const prevState = getPluginState(state, plugin.name);
    const result = await plugin.gather(trigger as Trigger, config, prevState);
    results.push(result);
    state = setPluginState(state, plugin.name, result.state);
  }

  await saveState(state);

  return render(results);
}

/**
 * Graceful shutdown — call onStop() on all enabled plugins.
 * Wire this to SessionEnd or process signals as needed.
 */
export async function stop(): Promise<void> {
  const registry = new Registry();

  registry.register(timeDate);
  registry.register(quota);
  registry.register(system);

  await registry.loadConfig(DEFAULT_CONFIG);
  await registry.stopPlugins();
}
