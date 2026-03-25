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

async function setup(): Promise<{ registry: Registry; schedules: Schedule[] }> {
  const registry = new Registry();
  const { plugins } = await loadPlugins();
  for (const plugin of plugins) registry.register(plugin);
  await registry.loadConfig(DEFAULT_CONFIG);

  const schedules: Schedule[] = [];

  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    const triggers = config?.triggers ?? {};

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
  const now = Date.now();
  const due = schedules.filter(s => (now - s.lastFired) >= s.intervalMs);
  if (due.length === 0) return;

  let state = await loadState();
  const cache = await loadTickerCache();

  for (const schedule of due) {
    const plugin = registry.getPlugin(schedule.pluginName);
    if (!plugin) continue;

    const config = registry.getPluginConfig(plugin.name);
    if (!config) continue;

    const prevState = getPluginState(state, plugin.name);

    try {
      // Find the matching interval trigger string for this schedule
      const triggerKey = Object.keys(config.triggers ?? {}).find(t => {
        const ms = parseInterval(t);
        return ms === schedule.intervalMs;
      }) ?? 'prompt';

      const result = await plugin.gather(triggerKey as Trigger, config, prevState, context);

      if (result?.text) {
        cache[plugin.name] = { text: result.text, gatheredAt: new Date().toISOString() };
      }
      if (result?.state) {
        state = setPluginState(state, plugin.name, result.state);
      }
      schedule.lastFired = now;
    } catch (err) {
      process.stderr.write(`[ticker] ${plugin.name} gather failed: ${err}\n`);
    }
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
