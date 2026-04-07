import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseInterval } from "./types.js";
const USER_CONFIG_DIR = join(homedir(), '.config', 'agent-awareness');
const USER_PLUGINS_D = join(USER_CONFIG_DIR, 'plugins.d');
export class Registry {
    #plugins = new Map();
    #packageDefaults = {};
    #userPluginConfigs = {};
    #policyConfig = {};
    #defaultConfigPath = null;
    #lastConfigLoad = 0;
    #configTtl = 60_000; // reload config every 60s in long-running processes
    register(plugin) {
        this.#plugins.set(plugin.name, plugin);
    }
    async loadConfig(defaultConfigPath) {
        this.#defaultConfigPath = defaultConfigPath;
        // 1. Package defaults (config/default.json)
        let packagePolicy = {};
        try {
            const raw = JSON.parse(await readFile(defaultConfigPath, 'utf8'));
            this.#packageDefaults = raw.plugins ?? {};
            packagePolicy = raw.policy ?? {};
        }
        catch { /* no defaults file */ }
        // 2. Per-plugin config files from user global + rig override
        this.#userPluginConfigs = await loadPluginConfigs();
        // 3. Policy config: package defaults + user override
        const userPolicy = await loadPolicyConfig();
        this.#policyConfig = { ...packagePolicy, ...userPolicy };
        this.#lastConfigLoad = Date.now();
    }
    /**
     * Reload config if stale (older than configTtl).
     * Call this before accessing config in long-running processes (ticker, MCP).
     * No-op if config was loaded recently or loadConfig() was never called.
     */
    async refreshConfigIfStale() {
        if (!this.#defaultConfigPath)
            return;
        if (Date.now() - this.#lastConfigLoad < this.#configTtl)
            return;
        await this.loadConfig(this.#defaultConfigPath);
    }
    getPluginConfig(name) {
        const plugin = this.#plugins.get(name);
        if (!plugin)
            return null;
        return deepMerge(deepMerge(plugin.defaults, this.#packageDefaults[name] ?? {}), this.#userPluginConfigs[name] ?? {});
    }
    isEnabled(name) {
        const perPlugin = this.#userPluginConfigs[name];
        if (perPlugin?.enabled !== undefined)
            return perPlugin.enabled !== false;
        const pkgDefault = this.#packageDefaults[name];
        if (pkgDefault?.enabled !== undefined)
            return pkgDefault.enabled !== false;
        return true; // enabled by default
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
            const triggers = config?.triggers ?? {};
            for (const trigger of Object.keys(triggers)) {
                if (!triggers[trigger])
                    continue;
                let matched = false;
                // Direct event match (e.g. trigger='session-start', event='session-start')
                if (trigger === event) {
                    matched = true;
                }
                else if (event === 'prompt') {
                    // Change-detection and interval triggers only fire during prompt events
                    if (trigger === 'change:hour') {
                        const prev = state[plugin.name]?.lastHour;
                        if (prev !== undefined && prev !== now.getHours())
                            matched = true;
                    }
                    if (trigger === 'change:day') {
                        const prev = state[plugin.name]?.lastDay;
                        const today = localDayKey(now);
                        if (prev && prev !== today)
                            matched = true;
                    }
                    const interval = parseInterval(trigger);
                    if (interval) {
                        const lastUpdate = state[plugin.name]?._updatedAt;
                        if (!lastUpdate || (now.getTime() - new Date(lastUpdate).getTime()) >= interval)
                            matched = true;
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
    getPolicyConfig() {
        return this.#policyConfig;
    }
    getPlugin(name) {
        return this.#plugins.get(name);
    }
    /** Call onStart() on all enabled plugins. Errors are logged, not thrown. */
    async startPlugins() {
        for (const plugin of this.getEnabledPlugins()) {
            if (plugin.onStart) {
                try {
                    await plugin.onStart();
                }
                catch (err) {
                    console.error(`[agent-awareness] ${plugin.name} onStart failed:`, err);
                }
            }
        }
    }
    /** Call onStop() on all enabled plugins. Errors are logged, not thrown. */
    async stopPlugins() {
        for (const plugin of this.getEnabledPlugins()) {
            if (plugin.onStop) {
                try {
                    await plugin.onStop();
                }
                catch (err) {
                    console.error(`[agent-awareness] ${plugin.name} onStop failed:`, err);
                }
            }
        }
    }
    /** Call onInstall() on a specific plugin. */
    async installPlugin(name) {
        const plugin = this.#plugins.get(name);
        if (plugin?.onInstall)
            await plugin.onInstall();
    }
    /** Call onUninstall() on a specific plugin. */
    async uninstallPlugin(name) {
        const plugin = this.#plugins.get(name);
        if (plugin?.onUninstall)
            await plugin.onUninstall();
    }
}
/**
 * Load per-plugin config files from plugins.d directories.
 * Scans user global first, then rig/project override (via env var).
 * Later layers deep-merge over earlier ones.
 */
async function loadPluginConfigs() {
    const configs = {};
    // User global: ~/.config/agent-awareness/plugins.d/
    await loadPluginDir(USER_PLUGINS_D, configs);
    // Rig/project override: $AGENT_AWARENESS_CONFIG/plugins.d/
    const envDir = process.env.AGENT_AWARENESS_CONFIG;
    if (envDir) {
        await loadPluginDir(join(envDir, 'plugins.d'), configs);
    }
    return configs;
}
async function loadPolicyConfig() {
    // User: ~/.config/agent-awareness/policy.json
    const userPath = join(USER_CONFIG_DIR, 'policy.json');
    try {
        return JSON.parse(await readFile(userPath, 'utf8'));
    }
    catch {
        return {};
    }
}
async function loadPluginDir(dir, configs) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return; // directory doesn't exist — fine
    }
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        const pluginName = entry.replace(/\.json$/, '');
        try {
            const content = JSON.parse(await readFile(join(dir, entry), 'utf8'));
            configs[pluginName] = configs[pluginName]
                ? deepMerge(configs[pluginName], content)
                : content;
        }
        catch { /* skip malformed files */ }
    }
}
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key] ?? {}, source[key]);
        }
        else {
            result[key] = source[key];
        }
    }
    return result;
}
function localDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
