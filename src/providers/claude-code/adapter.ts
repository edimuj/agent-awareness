import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from '../../core/registry.ts';
import { PluginDispatcher } from '../../core/dispatcher.ts';
import { render } from '../../core/renderer.ts';
import { applyInjectionPolicy } from '../../core/policy.ts';
import {
  loadState, getPluginState, setPluginState, withState,
  loadTickerCache, saveTickerCache, writeTickerPid, readTickerPid, clearTickerPid,
  readTickerOwner, loadChannelSeen,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import { parseInterval } from '../../core/types.ts';
import type { GatherContext, GatherResult, PluginState, Trigger } from '../../core/types.ts';
import type { PolicyInput } from '../../core/policy.ts';
import { createClaimContext, pruneExpiredClaims } from '../../core/claims.ts';
import { closeSync, existsSync } from 'node:fs';
import { openLogFd, rotateLogIfNeeded } from '../../core/log.ts';
import { resolveGatherContext } from '../../core/session-context.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const COMPILED_TICKER = join(PROJECT_ROOT, 'dist', 'daemon', 'ticker.js');
const SOURCE_TICKER = join(PROJECT_ROOT, 'src', 'daemon', 'ticker.ts');
const TICKER_SCRIPT = existsSync(COMPILED_TICKER) ? COMPILED_TICKER : SOURCE_TICKER;
const PROMPT_META_KEY = '__agent_awareness_prompt_meta_claude_code';

const dispatcher = new PluginDispatcher();

interface PromptMetaState {
  tickerSeen?: Record<string, string>;
  seenFingerprints?: Record<string, string>;
  sessionStartedAt?: string;
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
  const oldPid = await readTickerPid();
  const owner = await readTickerOwner();

  // If the MCP server owns the ticker and its process is alive, let it be.
  // The MCP server runs the tick loop internally — no standalone daemon needed.
  if (oldPid && owner === 'mcp') {
    try {
      process.kill(oldPid, 0); // test if alive (signal 0 = no-op)
      return; // MCP server is handling ticks
    } catch { /* MCP server died — fall through to spawn standalone */ }
  }

  // Kill old standalone ticker if running
  if (oldPid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* already dead */ }
    await clearTickerPid();
  }

  if (!hasIntervalPlugins(registry)) return;

  // Spawn detached standalone ticker — stderr goes to log file
  await rotateLogIfNeeded();
  const logFd = openLogFd();
  const child = spawn('node', [TICKER_SCRIPT, 'claude-code'], {
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
  const context: GatherContext = await resolveGatherContext('claude-code');

  if (event === 'session-start') {
    await registry.startPlugins();
    // Drop stale interval cache from previous sessions before the new ticker starts.
    await saveTickerCache({});
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
  const tickerInputs: PolicyInput[] = [];
  const tickerSeenUpdates: Record<string, string> = {};
  if (event === 'prompt') {
    const cache = await loadTickerCache();
    const meta = getPromptMeta(preState);
    const seen = meta.tickerSeen ?? {};
    const sessionStartedAtMs = meta.sessionStartedAt ? Date.parse(meta.sessionStartedAt) : NaN;
    for (const [pluginName, cached] of Object.entries(cache)) {
      const alreadyTriggered = triggered.some(t => t.plugin.name === pluginName);
      if (alreadyTriggered || !cached.text) continue;

      const gatheredAt = typeof cached.gatheredAt === 'string' ? cached.gatheredAt : '';
      const gatheredAtMs = gatheredAt ? Date.parse(gatheredAt) : NaN;
      if (!Number.isFinite(gatheredAtMs)) continue;
      if (Number.isFinite(sessionStartedAtMs) && gatheredAtMs <= sessionStartedAtMs) continue;
      if (seen[pluginName] === gatheredAt) continue;

      if (gatheredAt) tickerSeenUpdates[pluginName] = gatheredAt;
      if (cached.text) {
        tickerInputs.push({
          pluginName,
          result: {
            text: cached.text,
            updatedAt: gatheredAt || undefined,
          },
        });
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
        return Promise.resolve(plugin.gather(trigger as Trigger, config, prevState, { ...context, signal, claims }));
      },
    }));

  // Dispatch all plugins in parallel, each with its own timeout
  const dispatched = await dispatcher.dispatchAll(dispatchEntries);

  const gatheredResults = dispatched
    .filter((entry): entry is { pluginName: string; result: GatherResult } => !!entry.result)
    .map(({ pluginName, result }) => ({ pluginName, result }));
  const gatheredInputs: PolicyInput[] = gatheredResults.map(({ pluginName, result }) => ({
    pluginName,
    result,
  }));
  const policyInputs = [...gatheredInputs, ...tickerInputs];

  // Merge channel-seen fingerprints so hooks skip data already pushed via channel
  const channelSeenFps = event === 'prompt' ? await loadChannelSeen() : {};
  const previousPolicyMeta = event === 'session-start'
    ? {}
    : { seenFingerprints: { ...getPromptMeta(preState).seenFingerprints, ...channelSeenFps } };
  const policyConfig = registry.getPolicyConfig();
  const maxChars = event === 'session-start'
    ? policyConfig.maxCharsSessionStart
    : policyConfig.maxCharsPrompt;
  const policy = applyInjectionPolicy(policyInputs, {
    event,
    previousMeta: previousPolicyMeta,
    maxChars,
    debugReasons: process.env.AGENT_AWARENESS_POLICY_DEBUG === '1',
  });

  // Atomic state update — lock protects against ticker/MCP races
  const hasPromptTickerUpdates = Object.keys(tickerSeenUpdates).length > 0;
  const hasGatherResults = gatheredResults.length > 0;
  const hasPolicyResults = policy.results.length > 0;
  const shouldStampSessionStart = event === 'session-start';
  if (hasGatherResults || hasPromptTickerUpdates || hasPolicyResults || shouldStampSessionStart) {
    await withState((state: PluginState) => {
      for (const { pluginName, result } of gatheredResults) {
        state = setPluginState(state, pluginName, result.state);
      }

      if (event === 'session-start') {
        const nowIso = new Date().toISOString();
        state = {
          ...state,
          [PROMPT_META_KEY]: {
            tickerSeen: {},
            seenFingerprints: policy.meta.seenFingerprints ?? {},
            sessionStartedAt: nowIso,
            _updatedAt: nowIso,
          },
        };
      }

      if (event === 'prompt' && (hasPromptTickerUpdates || hasGatherResults || hasPolicyResults)) {
        const currentMeta = getPromptMeta(state);
        const nowIso = new Date().toISOString();
        state = {
          ...state,
          [PROMPT_META_KEY]: {
            ...currentMeta,
            tickerSeen: {
              ...(currentMeta.tickerSeen ?? {}),
              ...tickerSeenUpdates,
            },
            seenFingerprints: policy.meta.seenFingerprints ?? (currentMeta.seenFingerprints ?? {}),
            sessionStartedAt: currentMeta.sessionStartedAt,
            _updatedAt: nowIso,
          },
        };
      }

      return state;
    });
  }

  if (policy.results.length === 0) return '';

  return render(policy.results);
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
