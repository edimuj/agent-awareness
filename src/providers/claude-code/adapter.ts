import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from '../../core/registry.ts';
import { PluginDispatcher } from '../../core/dispatcher.ts';
import { render } from '../../core/renderer.ts';
import {
  loadState, getPluginState, setPluginState, withState,
  loadTickerCache, writeTickerPid, readTickerPid, clearTickerPid,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import { parseInterval } from '../../core/types.ts';
import type { GatherContext, GatherResult, PluginState, Trigger } from '../../core/types.ts';
import { createClaimContext, pruneExpiredClaims } from '../../core/claims.ts';
import { closeSync } from 'node:fs';
import { openLogFd, rotateLogIfNeeded, logToFile } from '../../core/log.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const TICKER_SCRIPT = join(PROJECT_ROOT, 'src', 'daemon', 'ticker.ts');
const PROMPT_META_KEY = '__agent_awareness_prompt_meta_claude_code';

const CONTEXT: GatherContext = { provider: 'claude-code' };
const dispatcher = new PluginDispatcher();

interface PromptMetaState {
  tickerSeen?: Record<string, string>;
}

function getPromptMeta(preState: PluginState): PromptMetaState {
  const raw = preState[PROMPT_META_KEY];
  if (!raw || typeof raw !== 'object') return {};
  return raw as PromptMetaState;
}

/** Build a registry with all discovered plugins and loaded config. */
async function createRegistry(): Promise<Registry> {
  const registry = new Registry();
  const { plugins, errors } = await loadPlugins();

  for (const plugin of plugins) {
    registry.register(plugin);
  }

  // Log discovery errors to stderr — don't crash the pipeline
  for (const { source, error } of errors) {
    console.error(`[agent-awareness] ${source}: ${error}`);
  }

  await registry.loadConfig(DEFAULT_CONFIG);

  // Configure per-plugin dispatcher limits from config
  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    if (config?.timeout || config?.maxQueue) {
      dispatcher.configure(plugin.name, {
        timeout: config.timeout as number | undefined,
        maxQueue: config.maxQueue as number | undefined,
      });
    }
  }

  return registry;
}

/** Check if any enabled plugin uses interval:* triggers. */
function hasIntervalPlugins(registry: Registry): boolean {
  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    const triggers = config?.triggers ?? {};
    for (const trigger of Object.keys(triggers)) {
      if (triggers[trigger] && parseInterval(trigger)) return true;
    }
  }
  return false;
}

/** Kill any existing ticker, spawn a new one if needed. */
async function manageTicker(registry: Registry): Promise<void> {
  // Kill old ticker if running
  const oldPid = await readTickerPid();
  if (oldPid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* already dead */ }
    await clearTickerPid();
  }

  if (!hasIntervalPlugins(registry)) return;

  // Spawn detached ticker — stderr goes to log file
  await rotateLogIfNeeded();
  const logFd = openLogFd();
  const child = spawn('node', [TICKER_SCRIPT, CONTEXT.provider], {
    stdio: ['ignore', 'ignore', logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);

  if (child.pid) {
    await writeTickerPid(child.pid);
  }
}

/**
 * Run the awareness pipeline for a given event.
 * Returns compact text for context injection, or '' if nothing triggered.
 *
 * On 'session-start': starts plugins, spawns background ticker.
 * On 'prompt': merges live gather results with ticker cache for interval plugins.
 */
export async function run(event: string): Promise<string> {
  const registry = await createRegistry();

  if (event === 'session-start') {
    await registry.startPlugins();
    await manageTicker(registry);
  }

  // Prune expired claims at session start
  if (event === 'session-start') {
    await pruneExpiredClaims();
  }

  // Read state (non-locked) for trigger matching and dispatch planning
  const preState = await loadState();
  const triggered = registry.getTriggeredPlugins(event, preState);

  // For prompt events, also include cached results from the ticker
  // for interval plugins that have fresh (unseen) cache entries.
  const tickerResults: GatherResult[] = [];
  const tickerSeenUpdates: Record<string, string> = {};
  if (event === 'prompt') {
    const cache = await loadTickerCache();
    const seen = getPromptMeta(preState).tickerSeen ?? {};
    for (const [pluginName, cached] of Object.entries(cache)) {
      const alreadyTriggered = triggered.some(t => t.plugin.name === pluginName);
      if (alreadyTriggered || !cached.text) continue;

      const gatheredAt = typeof cached.gatheredAt === 'string' ? cached.gatheredAt : '';
      if (gatheredAt && seen[pluginName] === gatheredAt) continue;

      if (gatheredAt) tickerSeenUpdates[pluginName] = gatheredAt;
      if (cached.text) {
        tickerResults.push({ text: cached.text });
      }
    }
  }

  // Build executor list — skip interval triggers on prompt (ticker handles those)
  const dispatchEntries = triggered
    .filter(({ trigger }) => !(event === 'prompt' && parseInterval(trigger)))
    .map(({ plugin, trigger }) => ({
      pluginName: plugin.name,
      executor: (signal: AbortSignal) => {
        const config = registry.getPluginConfig(plugin.name)!;
        const prevState = getPluginState(preState, plugin.name);
        const claims = createClaimContext(plugin.name);
        return Promise.resolve(plugin.gather(trigger as Trigger, config, prevState, { ...CONTEXT, signal, claims }));
      },
    }));

  // Dispatch all plugins in parallel, each with its own timeout
  const dispatched = await dispatcher.dispatchAll(dispatchEntries);

  // Atomic state update — lock protects against ticker/MCP races
  const results: GatherResult[] = [];
  const hasPromptTickerUpdates = Object.keys(tickerSeenUpdates).length > 0;
  const hasGatherResults = dispatched.some(({ result }) => !!result);
  if (hasGatherResults || hasPromptTickerUpdates) {
    await withState((state: PluginState) => {
      for (const { pluginName, result } of dispatched) {
        if (!result) continue;
        results.push(result);
        state = setPluginState(state, pluginName, result.state);
      }

      if (event === 'prompt' && hasPromptTickerUpdates) {
        const currentMeta = getPromptMeta(state);
        state = {
          ...state,
          [PROMPT_META_KEY]: {
            ...currentMeta,
            tickerSeen: {
              ...(currentMeta.tickerSeen ?? {}),
              ...tickerSeenUpdates,
            },
            _updatedAt: new Date().toISOString(),
          },
        };
      }

      return state;
    });
  }

  const allResults = [...results, ...tickerResults];
  if (allResults.length === 0) return '';

  return render(allResults);
}

/**
 * Graceful shutdown — kill ticker, call onStop() on all plugins.
 */
export async function stop(): Promise<void> {
  const oldPid = await readTickerPid();
  if (oldPid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* already dead */ }
    await clearTickerPid();
  }

  const registry = await createRegistry();
  await registry.stopPlugins();
}
