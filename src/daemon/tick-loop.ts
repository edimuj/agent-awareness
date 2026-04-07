/**
 * Shared ticker logic — used by both the standalone daemon and the MCP server.
 *
 * Extracts schedule setup and tick execution so either process can run
 * the gather loop without duplicating the core logic.
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Registry } from '../core/registry.ts';
import { PluginDispatcher } from '../core/dispatcher.ts';
import { loadPlugins } from '../core/loader.ts';
import { initStateDir, loadState, getPluginState, setPluginState, withState, loadTickerCache, saveTickerCache } from '../core/state.ts';
import { parseInterval } from '../core/types.ts';
import type { GatherContext, PluginState, Trigger } from '../core/types.ts';
import { createClaimContext } from '../core/claims.ts';
import { resolveGatherContext } from '../core/session-context.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

export interface Schedule {
  pluginName: string;
  intervalMs: number;
  lastFired: number;
}

export interface TickCallbacks {
  /** Called for each plugin that returns text on a tick. */
  onResult?: (pluginName: string, text: string) => void;
}

const dispatcher = new PluginDispatcher();

/**
 * Load plugins, build registry, and compute interval schedules.
 * Initializes provider-scoped state directory.
 * Returns null if no interval plugins are configured.
 */
export async function setupTicker(provider: string): Promise<{
  registry: Registry;
  schedules: Schedule[];
  tickMs: number;
  context: GatherContext;
} | null> {
  await initStateDir(provider);

  const registry = new Registry();
  const { plugins } = await loadPlugins();
  for (const plugin of plugins) registry.register(plugin);
  await registry.loadConfig(DEFAULT_CONFIG);

  const schedules: Schedule[] = [];

  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    const triggers = config?.triggers ?? {};

    if (config?.timeout || config?.maxQueue) {
      dispatcher.configure(plugin.name, {
        timeout: config.timeout as number | undefined,
        maxQueue: config.maxQueue as number | undefined,
      });
    }

    for (const trigger of Object.keys(triggers)) {
      if (!triggers[trigger]) continue;
      const ms = parseInterval(trigger);
      if (ms) {
        schedules.push({ pluginName: plugin.name, intervalMs: ms, lastFired: 0 });
      }
    }
  }

  if (schedules.length === 0) return null;

  const gcd = schedules.reduce((a, b) => gcdOf(a, b.intervalMs), schedules[0]!.intervalMs);
  const tickMs = Math.max(10_000, gcd);
  const context = await resolveGatherContext(provider);

  return { registry, schedules, tickMs, context };
}

/**
 * Run one tick: gather all due plugins, update state + cache, call onResult for each.
 */
export async function tick(
  registry: Registry,
  schedules: Schedule[],
  context: GatherContext,
  callbacks?: TickCallbacks,
): Promise<void> {
  await registry.refreshConfigIfStale();

  const now = Date.now();
  const due = schedules.filter(s => (now - s.lastFired) >= s.intervalMs);
  if (due.length === 0) return;

  const preState = await loadState();
  const cache = await loadTickerCache();

  const entries = due.flatMap(schedule => {
    const plugin = registry.getPlugin(schedule.pluginName);
    if (!plugin) return [];

    const config = registry.getPluginConfig(plugin.name);
    if (!config) return [];

    const triggerKey = Object.keys(config.triggers ?? {}).find(t => {
      const ms = parseInterval(t);
      return ms === schedule.intervalMs;
    }) ?? 'prompt';

    return [{
      pluginName: plugin.name,
      schedule,
      executor: (signal: AbortSignal) => {
        const prevState = getPluginState(preState, plugin.name);
        const claims = createClaimContext(plugin.name);
        return Promise.resolve(plugin.gather(triggerKey as Trigger, config, prevState, { ...context, signal, claims }));
      },
    }];
  });

  const results = await dispatcher.dispatchAll(entries);

  for (const { pluginName, result } of results) {
    if (result?.text) {
      cache[pluginName] = { text: result.text, gatheredAt: new Date().toISOString() };
      callbacks?.onResult?.(pluginName, result.text);
    }
    const schedule = due.find(s => s.pluginName === pluginName);
    if (schedule) schedule.lastFired = now;
  }

  await withState((state: PluginState) => {
    for (const { pluginName, result } of results) {
      if (result?.state) {
        state = setPluginState(state, pluginName, result.state);
      }
    }
    return state;
  });
  await saveTickerCache(cache);
}

function gcdOf(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}
