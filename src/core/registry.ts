import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AwarenessPlugin, PluginConfig, PluginState } from './types.ts';
import { parseInterval } from './types.ts';

const USER_CONFIG_DIR = join(homedir(), '.config', 'agent-awareness');
const USER_PLUGINS_D = join(USER_CONFIG_DIR, 'plugins.d');
const USER_LEGACY_CONFIG = join(USER_CONFIG_DIR, 'config.json');

/**
 * Config resolution order per plugin:
 *   1. Plugin built-in defaults
 *   2. Package defaults (config/default.json → plugins.<name>)
 *   3. User global (~/.config/agent-awareness/plugins.d/<name>.json)
 *   4. Rig/project override ($AGENT_AWARENESS_CONFIG/plugins.d/<name>.json)
 *   5. Legacy monolithic config.json (backward compat, lowest priority user layer)
 *
 * System config (non-plugin settings) comes from config.json files only.
 */

interface SystemConfig {
  plugins?: Record<string, PluginConfig>;
  [key: string]: unknown;
}

interface TriggeredPlugin {
  plugin: AwarenessPlugin;
  trigger: string;
}

export class Registry {
  #plugins = new Map<string, AwarenessPlugin>();
  #packageDefaults: Record<string, PluginConfig> = {};
  #userPluginConfigs: Record<string, PluginConfig> = {};
  #legacyConfig: Record<string, PluginConfig> = {};

  register(plugin: AwarenessPlugin): void {
    this.#plugins.set(plugin.name, plugin);
  }

  async loadConfig(defaultConfigPath: string): Promise<void> {
    // 1. Package defaults (config/default.json)
    try {
      const defaults: SystemConfig = JSON.parse(await readFile(defaultConfigPath, 'utf8'));
      this.#packageDefaults = defaults.plugins ?? {};
    } catch { /* no defaults file */ }

    // 2. Legacy monolithic config.json (backward compat)
    try {
      const legacy: SystemConfig = JSON.parse(await readFile(USER_LEGACY_CONFIG, 'utf8'));
      this.#legacyConfig = legacy.plugins ?? {};
    } catch { /* no legacy config */ }

    // 3. Per-plugin config files from user global + rig override
    this.#userPluginConfigs = await loadPluginConfigs();
  }

  getPluginConfig(name: string): PluginConfig | null {
    const plugin = this.#plugins.get(name);
    if (!plugin) return null;

    // Layer: defaults → package → legacy → per-plugin files
    return deepMerge(
      deepMerge(
        deepMerge(plugin.defaults, this.#packageDefaults[name] ?? {}),
        this.#legacyConfig[name] ?? {},
      ),
      this.#userPluginConfigs[name] ?? {},
    ) as PluginConfig;
  }

  isEnabled(name: string): boolean {
    // Check all config layers — per-plugin files win over package defaults
    const perPlugin = this.#userPluginConfigs[name];
    if (perPlugin?.enabled !== undefined) return perPlugin.enabled !== false;

    const legacy = this.#legacyConfig[name];
    if (legacy?.enabled !== undefined) return legacy.enabled !== false;

    const pkgDefault = this.#packageDefaults[name];
    if (pkgDefault?.enabled !== undefined) return pkgDefault.enabled !== false;

    return true; // enabled by default
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

/**
 * Load per-plugin config files from plugins.d directories.
 * Scans user global first, then rig/project override (via env var).
 * Later layers deep-merge over earlier ones.
 */
async function loadPluginConfigs(): Promise<Record<string, PluginConfig>> {
  const configs: Record<string, PluginConfig> = {};

  // User global: ~/.config/agent-awareness/plugins.d/
  await loadPluginDir(USER_PLUGINS_D, configs);

  // Rig/project override: $AGENT_AWARENESS_CONFIG/plugins.d/
  const envDir = process.env.AGENT_AWARENESS_CONFIG;
  if (envDir) {
    await loadPluginDir(join(envDir, 'plugins.d'), configs);
  }

  return configs;
}

async function loadPluginDir(dir: string, configs: Record<string, PluginConfig>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // directory doesn't exist — fine
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const pluginName = entry.replace(/\.json$/, '');

    try {
      const content = JSON.parse(await readFile(join(dir, entry), 'utf8'));
      configs[pluginName] = configs[pluginName]
        ? deepMerge(configs[pluginName], content) as PluginConfig
        : content;
    } catch { /* skip malformed files */ }
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
