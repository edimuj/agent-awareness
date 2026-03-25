import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from '../../core/registry.ts';
import { render } from '../../core/renderer.ts';
import {
  loadState, saveState, getPluginState, setPluginState,
  loadTickerCache, writeTickerPid, readTickerPid, clearTickerPid,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import { parseInterval } from '../../core/types.ts';
import type { GatherContext, GatherResult, Trigger } from '../../core/types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const TICKER_SCRIPT = join(PROJECT_ROOT, 'src', 'daemon', 'ticker.ts');

const CONTEXT: GatherContext = { provider: 'codex' };

/** Build a registry with all discovered plugins and loaded config. */
async function createRegistry(): Promise<Registry> {
  const registry = new Registry();
  const { plugins, errors } = await loadPlugins();

  for (const plugin of plugins) {
    registry.register(plugin);
  }

  // Log discovery errors to stderr — don't crash the pipeline
  for (const { source, error } of errors) {
    console.error(`[agent-awareness] ${source}: ${error}`);
  }

  await registry.loadConfig(DEFAULT_CONFIG);
  return registry;
}

/** Check if any enabled plugin uses interval:* triggers. */
function hasIntervalPlugins(registry: Registry): boolean {
  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    const triggers = config?.triggers ?? {};
    for (const trigger of Object.keys(triggers)) {
      if (triggers[trigger] && parseInterval(trigger)) return true;
    }
  }
  return false;
}

/** Kill any existing ticker, spawn a new one if needed. */
async function manageTicker(registry: Registry): Promise<void> {
  // Kill old ticker if running
  const oldPid = await readTickerPid();
  if (oldPid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* already dead */ }
    await clearTickerPid();
  }

  if (!hasIntervalPlugins(registry)) return;

  // Spawn detached ticker
  const child = spawn('node', [TICKER_SCRIPT, CONTEXT.provider], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  if (child.pid) {
    await writeTickerPid(child.pid);
  }
}

/**
 * Run the awareness pipeline for a given event.
 * Returns compact text for context injection, or '' if nothing triggered.
 *
 * On 'session-start': starts plugins, spawns background ticker.
 * On 'prompt': merges live gather results with ticker cache for interval plugins.
 */
export async function run(event: string): Promise<string> {
  const registry = await createRegistry();

  if (event === 'session-start') {
    await registry.startPlugins();
    await manageTicker(registry);
  }

  let state = await loadState();
  const triggered = registry.getTriggeredPlugins(event, state);

  // For prompt events, also include cached results from the ticker
  // for interval plugins that aren't in the triggered list
  const tickerResults: GatherResult[] = [];
  if (event === 'prompt') {
    const cache = await loadTickerCache();
    for (const [pluginName, cached] of Object.entries(cache)) {
      // Only use cache if this plugin wasn't already triggered by another rule
      const alreadyTriggered = triggered.some(t => t.plugin.name === pluginName);
      if (!alreadyTriggered && cached.text) {
        tickerResults.push({ text: cached.text });
      }
    }
  }

  const results: GatherResult[] = [];

  for (const { plugin, trigger } of triggered) {
    // Skip interval triggers on prompt — the ticker handles those
    if (event === 'prompt' && parseInterval(trigger)) continue;

    const config = registry.getPluginConfig(plugin.name)!;
    const prevState = getPluginState(state, plugin.name);
    const result = await plugin.gather(trigger as Trigger, config, prevState, CONTEXT);
    if (!result) continue; // plugin chose not to inject
    results.push(result);
    state = setPluginState(state, plugin.name, result.state);
  }

  await saveState(state);

  const allResults = [...results, ...tickerResults];
  if (allResults.length === 0) return '';

  return render(allResults);
}

/**
 * Graceful shutdown — kill ticker, call onStop() on all plugins.
 */
export async function stop(): Promise<void> {
  const oldPid = await readTickerPid();
  if (oldPid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* already dead */ }
    await clearTickerPid();
  }

  const registry = await createRegistry();
  await registry.stopPlugins();
}
