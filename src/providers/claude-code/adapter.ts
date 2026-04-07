import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Registry } from '../../core/registry.ts';
import { PluginDispatcher } from '../../core/dispatcher.ts';
import { render } from '../../core/renderer.ts';
import { applyInjectionPolicy } from '../../core/policy.ts';
import {
  initStateDir, loadState, getPluginState, setPluginState, withState,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import type { GatherContext, GatherResult, PluginState, Trigger } from '../../core/types.ts';
import type { PolicyInput } from '../../core/policy.ts';
import { createClaimContext, pruneExpiredClaims } from '../../core/claims.ts';
import { resolveGatherContext } from '../../core/session-context.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const META_KEY = '__agent_awareness_meta_claude_code';

const dispatcher = new PluginDispatcher();
let initialized = false;

interface SessionMeta {
  seenFingerprints?: Record<string, string>;
  sessionStartedAt?: string;
}

function getMeta(state: PluginState): SessionMeta {
  const raw = state[META_KEY];
  if (!raw || typeof raw !== 'object') return {};
  return raw as SessionMeta;
}

async function createRegistry(): Promise<Registry> {
  const registry = new Registry();
  const { plugins, errors } = await loadPlugins();

  for (const plugin of plugins) {
    registry.register(plugin);
  }
  for (const { source, error } of errors) {
    console.error(`[agent-awareness] ${source}: ${error}`);
  }

  await registry.loadConfig(DEFAULT_CONFIG);

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

/**
 * Run the awareness pipeline for a given event.
 * Returns compact text for context injection, or '' if nothing triggered.
 *
 * Tier 1 (hooks only): all triggers fire inline, including intervals.
 * No background processes, no ticker, no daemon.
 */
export async function run(event: string): Promise<string> {
  if (!initialized) {
    await initStateDir('claude-code');
    initialized = true;
  }

  const registry = await createRegistry();
  const context: GatherContext = await resolveGatherContext('claude-code');

  if (event === 'session-start') {
    await registry.startPlugins();
    await pruneExpiredClaims();
  }

  // Get all triggered plugins — including intervals checked inline on prompt
  const preState = await loadState();
  const triggered = registry.getTriggeredPlugins(event, preState);

  // Build executors for dispatch
  const dispatchEntries = triggered.map(({ plugin, trigger }) => ({
    pluginName: plugin.name,
    executor: (signal: AbortSignal) => {
      const config = registry.getPluginConfig(plugin.name)!;
      const prevState = getPluginState(preState, plugin.name);
      const claims = createClaimContext(plugin.name);
      return Promise.resolve(plugin.gather(trigger as Trigger, config, prevState, { ...context, signal, claims }));
    },
  }));

  // Dispatch all plugins in parallel
  const dispatched = await dispatcher.dispatchAll(dispatchEntries);

  const gatheredResults = dispatched
    .filter((entry): entry is { pluginName: string; result: GatherResult } => !!entry.result)
    .map(({ pluginName, result }) => ({ pluginName, result }));

  const policyInputs: PolicyInput[] = gatheredResults.map(({ pluginName, result }) => ({
    pluginName,
    result,
  }));

  // Apply injection policy with fingerprint dedup
  const previousMeta = event === 'session-start'
    ? {}
    : { seenFingerprints: getMeta(preState).seenFingerprints ?? {} };
  const policyConfig = registry.getPolicyConfig();
  const maxChars = event === 'session-start'
    ? policyConfig.maxCharsSessionStart
    : policyConfig.maxCharsPrompt;
  const policy = applyInjectionPolicy(policyInputs, {
    event,
    previousMeta,
    maxChars,
    debugReasons: process.env.AGENT_AWARENESS_POLICY_DEBUG === '1',
  });

  // Persist plugin state + session meta
  if (gatheredResults.length > 0 || policy.results.length > 0 || event === 'session-start') {
    await withState((state: PluginState) => {
      for (const { pluginName, result } of gatheredResults) {
        state = setPluginState(state, pluginName, result.state);
      }

      const nowIso = new Date().toISOString();
      if (event === 'session-start') {
        state = {
          ...state,
          [META_KEY]: {
            seenFingerprints: policy.meta.seenFingerprints ?? {},
            sessionStartedAt: nowIso,
            _updatedAt: nowIso,
          },
        };
      } else {
        const currentMeta = getMeta(state);
        state = {
          ...state,
          [META_KEY]: {
            ...currentMeta,
            seenFingerprints: policy.meta.seenFingerprints ?? (currentMeta.seenFingerprints ?? {}),
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
 * Graceful shutdown — call onStop() on all plugins.
 */
export async function stop(): Promise<void> {
  if (!initialized) {
    await initStateDir('claude-code');
    initialized = true;
  }
  const registry = await createRegistry();
  await registry.stopPlugins();
}
