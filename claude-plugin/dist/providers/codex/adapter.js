import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from "../../core/registry.js";
import { PluginDispatcher } from "../../core/dispatcher.js";
import { render } from "../../core/renderer.js";
import { applyInjectionPolicy } from "../../core/policy.js";
import { loadState, getPluginState, setPluginState, withState, loadTickerCache, saveTickerCache, writeTickerPid, readTickerPid, clearTickerPid, loadChannelSeen, } from "../../core/state.js";
import { loadPlugins } from "../../core/loader.js";
import { parseInterval } from "../../core/types.js";
import { createClaimContext, pruneExpiredClaims } from "../../core/claims.js";
import { closeSync, existsSync } from 'node:fs';
import { openLogFd, rotateLogIfNeeded } from "../../core/log.js";
import { resolveGatherContext } from "../../core/session-context.js";
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const COMPILED_TICKER = join(PROJECT_ROOT, 'dist', 'daemon', 'ticker.js');
const SOURCE_TICKER = join(PROJECT_ROOT, 'src', 'daemon', 'ticker.ts');
const TICKER_SCRIPT = existsSync(COMPILED_TICKER) ? COMPILED_TICKER : SOURCE_TICKER;
const PROMPT_META_KEY = '__agent_awareness_prompt_meta_codex';
const dispatcher = new PluginDispatcher();
function getPromptMeta(preState) {
    const raw = preState[PROMPT_META_KEY];
    if (!raw || typeof raw !== 'object')
        return {};
    return raw;
}
/** Build a registry with all discovered plugins and loaded config. */
async function createRegistry() {
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
                timeout: config.timeout,
                maxQueue: config.maxQueue,
            });
        }
    }
    return registry;
}
/** Check if any enabled plugin uses interval:* triggers. */
function hasIntervalPlugins(registry) {
    for (const plugin of registry.getEnabledPlugins()) {
        const config = registry.getPluginConfig(plugin.name);
        const triggers = config?.triggers ?? {};
        for (const trigger of Object.keys(triggers)) {
            if (triggers[trigger] && parseInterval(trigger))
                return true;
        }
    }
    return false;
}
/** Kill any existing ticker, spawn a new one if needed. */
async function manageTicker(registry) {
    // Kill old ticker if running
    const oldPid = await readTickerPid();
    if (oldPid) {
        try {
            process.kill(oldPid, 'SIGTERM');
        }
        catch { /* already dead */ }
        await clearTickerPid();
    }
    if (!hasIntervalPlugins(registry))
        return;
    // Spawn detached ticker — stderr goes to log file
    await rotateLogIfNeeded();
    const logFd = openLogFd();
    const child = spawn('node', [TICKER_SCRIPT, 'codex'], {
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
export async function run(event) {
    const registry = await createRegistry();
    const context = await resolveGatherContext('codex');
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
    const tickerInputs = [];
    const tickerSeenUpdates = {};
    if (event === 'prompt') {
        const cache = await loadTickerCache();
        const meta = getPromptMeta(preState);
        const seen = meta.tickerSeen ?? {};
        const sessionStartedAtMs = meta.sessionStartedAt ? Date.parse(meta.sessionStartedAt) : NaN;
        for (const [pluginName, cached] of Object.entries(cache)) {
            // Only use cache if this plugin wasn't already triggered by another rule
            const alreadyTriggered = triggered.some(t => t.plugin.name === pluginName);
            if (alreadyTriggered || !cached.text)
                continue;
            const gatheredAt = typeof cached.gatheredAt === 'string' ? cached.gatheredAt : '';
            const gatheredAtMs = gatheredAt ? Date.parse(gatheredAt) : NaN;
            if (!Number.isFinite(gatheredAtMs))
                continue;
            if (Number.isFinite(sessionStartedAtMs) && gatheredAtMs <= sessionStartedAtMs)
                continue;
            if (seen[pluginName] === gatheredAt)
                continue;
            if (gatheredAt)
                tickerSeenUpdates[pluginName] = gatheredAt;
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
        executor: (signal) => {
            const config = registry.getPluginConfig(plugin.name);
            const prevState = getPluginState(preState, plugin.name);
            const claims = createClaimContext(plugin.name);
            return Promise.resolve(plugin.gather(trigger, config, prevState, { ...context, signal, claims }));
        },
    }));
    // Dispatch all plugins in parallel, each with its own timeout and fault isolation
    const dispatched = await dispatcher.dispatchAll(dispatchEntries);
    const gatheredResults = dispatched
        .filter((entry) => !!entry.result)
        .map(({ pluginName, result }) => ({ pluginName, result }));
    const gatheredInputs = gatheredResults.map(({ pluginName, result }) => ({
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
        await withState((state) => {
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
    if (policy.results.length === 0)
        return '';
    return render(policy.results);
}
/**
 * Graceful shutdown — kill ticker, call onStop() on all plugins.
 */
export async function stop() {
    const oldPid = await readTickerPid();
    if (oldPid) {
        try {
            process.kill(oldPid, 'SIGTERM');
        }
        catch { /* already dead */ }
        await clearTickerPid();
    }
    const registry = await createRegistry();
    await registry.stopPlugins();
}
