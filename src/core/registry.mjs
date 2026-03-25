import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseInterval } from './types.mjs';

const USER_CONFIG = join(homedir(), '.config', 'agent-awareness', 'config.json');

export class Registry {
  #plugins = new Map();
  #config = {};

  register(plugin) {
    this.#plugins.set(plugin.name, plugin);
  }

  async loadConfig(defaultConfigPath) {
    const defaults = JSON.parse(await readFile(defaultConfigPath, 'utf8'));

    let userConfig = {};
    try {
      userConfig = JSON.parse(await readFile(USER_CONFIG, 'utf8'));
    } catch { /* no user config — use defaults */ }

    this.#config = deepMerge(defaults, userConfig);
    return this.#config;
  }

  getPluginConfig(name) {
    const plugin = this.#plugins.get(name);
    if (!plugin) return null;
    const userConf = this.#config.plugins?.[name] ?? {};
    return { ...plugin.defaults, ...userConf };
  }

  isEnabled(name) {
    const conf = this.#config.plugins?.[name];
    return conf?.enabled !== false;
  }

  getEnabledPlugins() {
    return [...this.#plugins.values()].filter(p => this.isEnabled(p.name));
  }

  /**
   * Determine which plugins should fire for a given event.
   * Returns [{ plugin, trigger }] — the matched trigger so plugins
   * can vary their output (e.g. 'full' vs 'compact').
   */
  getTriggeredPlugins(event, state) {
    const now = new Date();
    const results = [];

    for (const plugin of this.getEnabledPlugins()) {
      const config = this.getPluginConfig(plugin.name);
      const triggers = config.triggers ?? {};

      for (const trigger of Object.keys(triggers)) {
        if (!triggers[trigger]) continue;

        let matched = false;

        // Direct event match (e.g. trigger='session-start', event='session-start')
        if (trigger === event) {
          matched = true;
        } else if (event === 'prompt') {
          // Change-detection and interval triggers only fire during prompt events
          if (trigger === 'change:hour') {
            const prev = state[plugin.name]?.lastHour;
            if (prev !== undefined && prev !== now.getHours()) matched = true;
          }
          if (trigger === 'change:day') {
            const prev = state[plugin.name]?.lastDay;
            const today = now.toISOString().slice(0, 10);
            if (prev && prev !== today) matched = true;
          }

          const interval = parseInterval(trigger);
          if (interval) {
            const lastUpdate = state[plugin.name]?._updatedAt;
            if (!lastUpdate || (now - new Date(lastUpdate)) >= interval) matched = true;
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

  getPlugin(name) {
    return this.#plugins.get(name);
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
