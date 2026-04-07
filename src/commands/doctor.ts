import { readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../core/loader.ts';
import { Registry } from '../core/registry.ts';
import { initStateDir, STATE_DIR } from '../core/state.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const LOCAL_PLUGIN_DIR = join(homedir(), '.config', 'agent-awareness', 'plugins');

export async function doctor(): Promise<void> {
  await initStateDir('claude-code');

  const logFile = join(STATE_DIR, 'agent-awareness.log');

  console.log('agent-awareness doctor\n');

  // --- Plugin sources ---
  console.log('Plugin sources:');
  const builtinDir = join(PROJECT_ROOT, 'src', 'plugins');
  const localNodeModules = join(PROJECT_ROOT, 'node_modules');

  let globalRoot: string | null = null;
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* npm not available */ }

  const envConfig = process.env.AGENT_AWARENESS_CONFIG;

  console.log(`  builtin:  ${builtinDir}`);
  console.log(`  npm:      ${localNodeModules}`);
  console.log(`  global:   ${globalRoot ?? '(npm root -g failed)'}`);
  console.log(`  local:    ${LOCAL_PLUGIN_DIR}`);

  // --- Config paths ---
  console.log('\nConfig resolution (later overrides earlier):');
  const userPluginsD = join(homedir(), '.config', 'agent-awareness', 'plugins.d');
  console.log(`  defaults: plugin built-in defaults`);
  console.log(`  package:  ${DEFAULT_CONFIG}`);
  console.log(`  user:     ${userPluginsD}`);
  if (envConfig) {
    console.log(`  rig:      ${join(envConfig, 'plugins.d')} (AGENT_AWARENESS_CONFIG)`);
  }

  // --- State & logs ---
  console.log('\nPaths:');
  console.log(`  state:    ${STATE_DIR}`);
  console.log(`  log:      ${logFile}`);

  const logExists = await stat(logFile).catch(() => null);
  if (logExists) {
    const sizeKb = (logExists.size / 1024).toFixed(1);
    console.log(`            (${sizeKb} KB, last modified: ${logExists.mtime.toISOString().slice(0, 19)})`);
  } else {
    console.log(`            (not yet created)`);
  }

  // --- Load plugins ---
  console.log('\nLoading plugins...\n');

  const { plugins, errors } = await loadPlugins();
  const registry = new Registry();
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  await registry.loadConfig(DEFAULT_CONFIG);

  const realErrors = errors.filter(e => !e.source.includes('.test.'));

  if (plugins.length > 0) {
    const nameWidth = Math.max(12, ...plugins.map(p => p.name.length)) + 2;
    console.log(`  Loaded (${plugins.length}):`);
    for (const plugin of plugins) {
      const enabled = registry.isEnabled(plugin.name);
      const status = enabled ? '  OK' : 'SKIP';
      const mcpCount = plugin.mcp?.tools?.length ?? 0;
      const mcpStr = mcpCount > 0 ? ` [${mcpCount} MCP tool${mcpCount > 1 ? 's' : ''}]` : '';
      console.log(`    ${status}  ${plugin.name.padEnd(nameWidth)} ${plugin.description}${mcpStr}`);
    }
  }

  if (realErrors.length > 0) {
    console.log(`\n  Errors (${realErrors.length}):`);
    for (const { source, error } of realErrors) {
      const shortError = error.length > 100 ? error.slice(0, 97) + '...' : error;
      console.log(`    FAIL ${source}`);
      console.log(`         ${shortError}`);
    }
  }

  if (globalRoot) {
    let globalPlugins: string[] = [];
    try {
      const entries = await readdir(globalRoot);
      globalPlugins = entries.filter(e => e.startsWith('agent-awareness-plugin-'));
    } catch { /* no access */ }

    if (failingGlobalPlugins(globalPlugins, realErrors)) {
      console.log(`\n  Hint: Some global plugin(s) failed to load.`);
      console.log(`        If they were installed before the JS build pipeline was added,`);
      console.log(`        reinstall with: npm install -g <package-name>`);
    }
  }

  const total = plugins.length + realErrors.length;
  const ok = plugins.length;
  const fail = realErrors.length;
  const statusLabel = fail === 0 ? 'healthy' : fail > ok ? 'unhealthy' : 'degraded';

  console.log(`\nStatus: ${statusLabel} — ${ok} loaded, ${fail} failed (${total} discovered)`);
}

function failingGlobalPlugins(globalPlugins: string[], errors: Array<{ source: string; error: string }>): boolean {
  return globalPlugins.length > 0 && errors.some(e => e.source.startsWith('global:'));
}
