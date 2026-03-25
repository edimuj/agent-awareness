import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AwarenessPlugin, PluginConfig, PluginState } from './types.ts';
import { parseInterval } from './types.ts';

const USER_CONFIG = join(homedir(), '.config', 'agent-awareness', 'config.json');

interface Config {
  plugins?: Record<string, PluginConfig>;
  [key: string]: unknown;
}

interface TriggeredPlugin {
  plugin: AwarenessPlugin;
  trigger: string;
}

export class Registry {
  #plugins = new Map<string, AwarenessPlugin>();
  #config: Config = {};

  register(plugin: AwarenessPlugin): void {
    this.#plugins.set(plugin.name, plugin);
  }

  async loadConfig(defaultConfigPath: string): Promise<Config> {
    const defaults: Config = JSON.parse(await readFile(defaultConfigPath, 'utf8'));

    let userConfig: Config = {};
    try {
      userConfig = JSON.parse(await readFile(USER_CONFIG, 'utf8'));
    } catch { /* no user config — use defaults */ }

    this.#config = deepMerge(defaults, userConfig);
    return this.#config;
  }

  getPluginConfig(name: string): PluginConfig | null {
    const plugin = this.#plugins.get(name);
    if (!plugin) return null;
    const userConf = this.#config.plugins?.[name] ?? {};
    return { ...plugin.defaults, ...userConf };
  }

  isEnabled(name: string): boolean {
    const conf = this.#config.plugins?.[name];
    return conf?.enabled !== false;
  }

  getEnabledPlugins(): AwarenessPlugin[] {
    return [...this.#plugins.values()].filter(p => this.isEnabled(p.name));
  }

  /**
   * Determine which plugins should fire for a given event.
   * Returns [{ plugin, trigger }] — the matched trigger so plugins
   * can vary their output (e.g. 'full' vs 'compact').
   */
  getTriggeredPlugins(event: string, state: PluginState): TriggeredPlugin[] {
    const now = new Date();
    const results: TriggeredPlugin[] = [];

    for (const plugin of this.getEnabledPlugins()) {
      const config = this.getPluginConfig(plugin.name);
      const triggers = config?.triggers ?? {};

      for (const trigger of Object.keys(triggers)) {
        if (!triggers[trigger]) continue;

        let matched = false;

        // Direct event match (e.g. trigger='session-start', event='session-start')
        if (trigger === event) {
          matched = true;
        } else if (event === 'prompt') {
          // Change-detection and interval triggers only fire during prompt events
          if (trigger === 'change:hour') {
            const prev = state[plugin.name]?.lastHour as number | undefined;
            if (prev !== undefined && prev !== now.getHours()) matched = true;
          }
          if (trigger === 'change:day') {
            const prev = state[plugin.name]?.lastDay as string | undefined;
            const today = now.toISOString().slice(0, 10);
            if (prev && prev !== today) matched = true;
          }

          const interval = parseInterval(trigger);
          if (interval) {
            const lastUpdate = state[plugin.name]?._updatedAt;
            if (!lastUpdate || (now.getTime() - new Date(lastUpdate as string).getTime()) >= interval) matched = true;
          }
        }

        if (matched) {
          results.push({ plugin, trigger });
          break; // one match per plugin is enough
        }
      }
    }

    return results;
  }

  getPlugin(name: string): AwarenessPlugin | undefined {
    return this.#plugins.get(name);
  }

  /** Call onStart() on all enabled plugins. Errors are logged, not thrown. */
  async startPlugins(): Promise<void> {
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.onStart) {
        try {
          await plugin.onStart();
        } catch (err) {
          console.error(`[agent-awareness] ${plugin.name} onStart failed:`, err);
        }
      }
    }
  }

  /** Call onStop() on all enabled plugins. Errors are logged, not thrown. */
  async stopPlugins(): Promise<void> {
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.onStop) {
        try {
          await plugin.onStop();
        } catch (err) {
          console.error(`[agent-awareness] ${plugin.name} onStop failed:`, err);
        }
      }
    }
  }

  /** Call onInstall() on a specific plugin. */
  async installPlugin(name: string): Promise<void> {
    const plugin = this.#plugins.get(name);
    if (plugin?.onInstall) await plugin.onInstall();
  }

  /** Call onUninstall() on a specific plugin. */
  async uninstallPlugin(name: string): Promise<void> {
    const plugin = this.#plugins.get(name);
    if (plugin?.onUninstall) await plugin.onUninstall();
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) ?? {},
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
