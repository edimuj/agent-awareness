import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadPlugins } from "../core/loader.js";
import { Registry } from "../core/registry.js";
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
export async function list() {
    const { plugins, errors } = await loadPlugins();
    const registry = new Registry();
    for (const plugin of plugins) {
        registry.register(plugin);
    }
    await registry.loadConfig(DEFAULT_CONFIG);
    if (plugins.length === 0 && errors.length === 0) {
        console.log('No plugins found.');
        return;
    }
    console.log('Discovered plugins:\n');
    const nameWidth = Math.max(12, ...plugins.map(p => p.name.length)) + 2;
    for (const plugin of plugins) {
        const enabled = registry.isEnabled(plugin.name);
        const status = enabled ? '✓ enabled ' : '✗ disabled';
        const hooks = ['onInstall', 'onUninstall', 'onStart', 'onStop'];
        const activeHooks = hooks.filter(h => plugin[h] !== undefined);
        const hookStr = activeHooks.length > 0 ? ` [${activeHooks.join(', ')}]` : '';
        const triggers = (registry.getPluginConfig(plugin.name)?.triggers ?? {});
        const triggerList = Object.keys(triggers).filter(t => triggers[t]).join(', ');
        console.log(`  ${status}  ${plugin.name.padEnd(nameWidth)} ${plugin.description}`);
        console.log(`${''.padEnd(14)}${''.padEnd(nameWidth)} triggers: ${triggerList || 'none'}${hookStr}`);
    }
    if (errors.length > 0) {
        console.log('\nLoad errors:');
        for (const { source, error } of errors) {
            console.log(`  ⚠ ${source}: ${error}`);
        }
    }
    console.log(`\n${plugins.length} plugin(s) loaded, ${errors.length} error(s)`);
}
