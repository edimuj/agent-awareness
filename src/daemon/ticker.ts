/**
 * Background ticker daemon.
 *
 * Spawned at session start when any plugin uses interval:* triggers.
 * Runs gather() on schedule, caches text results for the prompt hook
 * to read. Exits cleanly on SIGTERM.
 *
 * Usage: node src/daemon/ticker.ts <provider>
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Registry } from '../core/registry.ts';
import { PluginDispatcher } from '../core/dispatcher.ts';
import { loadPlugins } from '../core/loader.ts';
import { loadState, saveState, getPluginState, setPluginState, loadTickerCache, saveTickerCache } from '../core/state.ts';
import { parseInterval } from '../core/types.ts';
import type { GatherContext, Trigger } from '../core/types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

const provider = process.argv[2] ?? 'claude-code';
const context: GatherContext = { provider };

// Collect interval plugins and their schedules
interface Schedule {
  pluginName: string;
  intervalMs: number;
  lastFired: number;
}

const dispatcher = new PluginDispatcher();

async function setup(): Promise<{ registry: Registry; schedules: Schedule[] }> {
  const registry = new Registry();
  const { plugins } = await loadPlugins();
  for (const plugin of plugins) registry.register(plugin);
  await registry.loadConfig(DEFAULT_CONFIG);

  const schedules: Schedule[] = [];

  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    const triggers = config?.triggers ?? {};

    // Configure per-plugin dispatcher limits
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

  return { registry, schedules };
}

async function tick(registry: Registry, schedules: Schedule[]): Promise<void> {
  await registry.refreshConfigIfStale();

  const now = Date.now();
  const due = schedules.filter(s => (now - s.lastFired) >= s.intervalMs);
  if (due.length === 0) return;

  let state = await loadState();
  const cache = await loadTickerCache();

  // Build dispatch entries for all due plugins
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
      executor: (_signal: AbortSignal) => {
        const prevState = getPluginState(state, plugin.name);
        return Promise.resolve(plugin.gather(triggerKey as Trigger, config, prevState, context));
      },
    }];
  });

  // Dispatch all due plugins in parallel
  const results = await dispatcher.dispatchAll(entries);

  for (const { pluginName, result } of results) {
    if (result?.text) {
      cache[pluginName] = { text: result.text, gatheredAt: new Date().toISOString() };
    }
    if (result?.state) {
      state = setPluginState(state, pluginName, result.state);
    }
    // Mark schedule as fired
    const schedule = due.find(s => s.pluginName === pluginName);
    if (schedule) schedule.lastFired = now;
  }

  await saveState(state);
  await saveTickerCache(cache);
}

async function main(): Promise<void> {
  const { registry, schedules } = await setup();

  if (schedules.length === 0) {
    process.exit(0); // nothing to tick
  }

  // Tick interval = GCD of all intervals, clamped to min 10s
  const gcd = schedules.reduce((a, b) => gcdOf(a, b.intervalMs), schedules[0].intervalMs);
  const tickMs = Math.max(10_000, gcd);

  // Initial gather
  await tick(registry, schedules);

  const timer = setInterval(() => tick(registry, schedules), tickMs);

  // Clean shutdown
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

function gcdOf(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

main();
