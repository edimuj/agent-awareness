import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AwarenessPlugin } from './types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUILTIN_DIR = join(__dirname, '..', 'plugins');
const LOCAL_PLUGIN_DIR = join(homedir(), '.config', 'agent-awareness', 'plugins');
const PROJECT_ROOT = join(__dirname, '..', '..');
const NODE_MODULES = join(PROJECT_ROOT, 'node_modules');
const NPM_PREFIX = 'agent-awareness-plugin-';

export interface LoadResult {
  plugins: AwarenessPlugin[];
  errors: Array<{ source: string; error: string }>;
}

/**
 * Discover and load plugins from all three sources:
 *   1. Built-in plugins (src/plugins/)
 *   2. npm packages (node_modules/agent-awareness-plugin-*)
 *   3. Local plugins (~/.config/agent-awareness/plugins/)
 *
 * Invalid plugins are collected in errors, never thrown.
 */
export async function loadPlugins(): Promise<LoadResult> {
  const errors: LoadResult['errors'] = [];
  const plugins: AwarenessPlugin[] = [];

  const sources = await Promise.all([
    loadFromDirectory(BUILTIN_DIR, 'builtin', errors),
    loadNpmPlugins(errors),
    loadFromDirectory(LOCAL_PLUGIN_DIR, 'local', errors),
  ]);

  for (const batch of sources) {
    plugins.push(...batch);
  }

  // Deduplicate by name — later sources override earlier (local > npm > builtin)
  const seen = new Map<string, AwarenessPlugin>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      const prev = plugins.indexOf(seen.get(plugin.name)!);
      const curr = plugins.indexOf(plugin);
      // Keep the later one (higher index = higher priority source)
      if (curr > prev) seen.set(plugin.name, plugin);
    } else {
      seen.set(plugin.name, plugin);
    }
  }

  return { plugins: [...seen.values()], errors };
}

/** Load .ts files and directories (with index.ts) from a plugin directory. */
async function loadFromDirectory(
  dir: string,
  source: string,
  errors: LoadResult['errors'],
): Promise<AwarenessPlugin[]> {
  const plugins: AwarenessPlugin[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return plugins; // directory doesn't exist — that's fine
  }

  // Ensure a package.json with "type": "module" exists so Node doesn't warn
  // about ESM detection in user plugin directories
  if (source === 'local') {
    await ensureEsmPackageJson(dir);
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const label = `${source}:${entry}`;

    try {
      const info = await stat(fullPath);
      let modulePath: string;

      if (info.isFile() && entry.endsWith('.ts')) {
        modulePath = fullPath;
      } else if (info.isDirectory()) {
        modulePath = join(fullPath, 'index.ts');
        try {
          await stat(modulePath);
        } catch {
          // No index.ts — try index.mjs for JS-only plugin authors
          modulePath = join(fullPath, 'index.mjs');
          await stat(modulePath); // throws if neither exists
        }
      } else {
        continue; // skip non-plugin files
      }

      const loaded = await importPlugin(modulePath, label, errors);
      plugins.push(...loaded);
    } catch (err) {
      errors.push({ source: label, error: `Failed to load: ${(err as Error).message}` });
    }
  }

  return plugins;
}

/** Scan node_modules for agent-awareness-plugin-* packages. */
async function loadNpmPlugins(errors: LoadResult['errors']): Promise<AwarenessPlugin[]> {
  const plugins: AwarenessPlugin[] = [];

  let entries: string[];
  try {
    entries = await readdir(NODE_MODULES);
  } catch {
    return plugins; // no node_modules — that's fine
  }

  // Handle both flat packages and @scoped packages
  const candidates: string[] = [];

  for (const entry of entries) {
    if (entry.startsWith(NPM_PREFIX)) {
      candidates.push(entry);
    } else if (entry.startsWith('@')) {
      // Scan scoped packages: @scope/agent-awareness-plugin-*
      try {
        const scopedEntries = await readdir(join(NODE_MODULES, entry));
        for (const scoped of scopedEntries) {
          if (scoped.startsWith(NPM_PREFIX)) {
            candidates.push(join(entry, scoped));
          }
        }
      } catch { /* skip unreadable scopes */ }
    }
  }

  for (const pkg of candidates) {
    const label = `npm:${pkg}`;

    try {
      // Import by package specifier so Node resolves exports/main correctly.
      // This supports common object-shaped exports maps.
      const loaded = await importPlugin(pkg, label, errors);
      plugins.push(...loaded);
    } catch (err) {
      errors.push({ source: label, error: `Failed to load: ${(err as Error).message}` });
    }
  }

  return plugins;
}

/** Import a module and extract plugin(s) from default export. Handles single and array exports. */
async function importPlugin(
  modulePath: string,
  label: string,
  errors: LoadResult['errors'],
): Promise<AwarenessPlugin[]> {
  const mod = await import(modulePath);
  const exported = mod.default;

  if (!exported) {
    errors.push({ source: label, error: 'No default export' });
    return [];
  }

  // Plugin packs: default export is an array
  const candidates = Array.isArray(exported) ? exported : [exported];
  const valid: AwarenessPlugin[] = [];

  for (const candidate of candidates) {
    const validation = validatePlugin(candidate);
    if (validation) {
      errors.push({ source: label, error: validation });
    } else {
      valid.push(candidate as AwarenessPlugin);
    }
  }

  return valid;
}

/** Drop a minimal package.json so Node treats .ts files as ESM without warnings. */
async function ensureEsmPackageJson(dir: string): Promise<void> {
  const pkgPath = join(dir, 'package.json');
  try {
    await stat(pkgPath);
  } catch {
    await mkdir(dir, { recursive: true });
    await writeFile(pkgPath, '{ "type": "module" }\n');
  }
}

/** Validate that an object conforms to the AwarenessPlugin interface. Returns error string or null. */
function validatePlugin(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') {
    return 'Plugin must be an object';
  }

  const p = obj as Record<string, unknown>;

  if (typeof p.name !== 'string' || !p.name) {
    return 'Plugin must have a non-empty "name" string';
  }
  if (typeof p.description !== 'string') {
    return `Plugin "${p.name}": missing "description" string`;
  }
  if (!Array.isArray(p.triggers)) {
    return `Plugin "${p.name}": "triggers" must be an array`;
  }
  if (!p.defaults || typeof p.defaults !== 'object') {
    return `Plugin "${p.name}": "defaults" must be an object`;
  }
  if (typeof p.gather !== 'function') {
    return `Plugin "${p.name}": "gather" must be a function`;
  }

  // Lifecycle hooks — optional but must be functions if present
  for (const hook of ['onInstall', 'onUninstall', 'onStart', 'onStop'] as const) {
    if (p[hook] !== undefined && typeof p[hook] !== 'function') {
      return `Plugin "${p.name}": "${hook}" must be a function if provided`;
    }
  }

  return null;
}
