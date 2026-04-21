/**
 * Unified plugin execution dispatcher.
 *
 * ALL plugin calls — hook triggers, MCP events, interval ticks — go through
 * this dispatcher. It provides:
 *
 *   - Per-plugin bounded event queue (drop oldest on overflow)
 *   - Serial execution per plugin (prevents state races)
 *   - Parallel execution across plugins
 *   - AbortSignal timeout on every call (actually cancels fetch/IO)
 *   - Clean error handling: failures → null result + stderr log, never crash
 *
 * The dispatcher is plugin-agnostic. Callers provide an executor function
 * that receives an AbortSignal and returns a result. The dispatcher manages
 * queuing, scheduling, and timeout — nothing else.
 */
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_QUEUE = 3;
export class PluginDispatcher {
    #queues = new Map();
    #processing = new Set();
    #limits = new Map();
    #defaultTimeout;
    #defaultMaxQueue;
    constructor(options) {
        this.#defaultTimeout = options?.defaultTimeout ?? DEFAULT_TIMEOUT;
        this.#defaultMaxQueue = options?.defaultMaxQueue ?? DEFAULT_MAX_QUEUE;
    }
    /** Set per-plugin timeout and queue limits. */
    configure(pluginName, limits) {
        this.#limits.set(pluginName, limits);
    }
    /**
     * Dispatch a single plugin execution.
     *
     * Queues the executor, processes serially per plugin, applies timeout.
     * Resolves with the result or null on error/timeout — never rejects.
     */
    dispatch(pluginName, executor) {
        return new Promise(resolve => {
            const queue = this.#queues.get(pluginName) ?? [];
            const maxQueue = this.#limits.get(pluginName)?.maxQueue ?? this.#defaultMaxQueue;
            // Drop oldest entries if queue is full
            while (queue.length >= maxQueue) {
                const dropped = queue.shift();
                console.error(`[agent-awareness] ${pluginName}: event dropped (queue full)`);
                dropped.resolve(null);
            }
            queue.push({
                executor,
                resolve,
                reject: () => resolve(null), // never expose rejections to caller
            });
            this.#queues.set(pluginName, queue);
            this.#processNext(pluginName);
        });
    }
    /**
     * Dispatch multiple plugins in parallel, collect results.
     * Each plugin runs independently — one failure doesn't affect others.
     */
    async dispatchAll(entries) {
        return Promise.all(entries.map(({ pluginName, executor }) => this.dispatch(pluginName, executor).then(result => ({ pluginName, result }))));
    }
    /** Number of queued (not yet processing) entries for a plugin. */
    queueDepth(pluginName) {
        return this.#queues.get(pluginName)?.length ?? 0;
    }
    /** Whether a plugin is currently executing. */
    isProcessing(pluginName) {
        return this.#processing.has(pluginName);
    }
    async #processNext(pluginName) {
        if (this.#processing.has(pluginName))
            return;
        const queue = this.#queues.get(pluginName);
        if (!queue?.length)
            return;
        this.#processing.add(pluginName);
        const entry = queue.shift();
        const timeout = this.#limits.get(pluginName)?.timeout ?? this.#defaultTimeout;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout);
        try {
            const result = await Promise.race([
                entry.executor(ac.signal),
                abortPromise(ac.signal, pluginName, timeout),
            ]);
            entry.resolve(result);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[agent-awareness] ${pluginName}: ${msg}`);
            entry.resolve(null);
        }
        finally {
            clearTimeout(timer);
            this.#processing.delete(pluginName);
            // Process next queued event for this plugin
            if (this.#queues.get(pluginName)?.length) {
                this.#processNext(pluginName);
            }
        }
    }
}
/**
 * Returns a promise that rejects when the signal aborts.
 * Used in Promise.race to enforce timeout on executors that ignore the signal.
 */
function abortPromise(signal, pluginName, timeout) {
    return new Promise((_, reject) => {
        if (signal.aborted) {
            reject(new Error(`${pluginName}: timed out after ${timeout}ms`));
            return;
        }
        signal.addEventListener('abort', () => {
            reject(new Error(`${pluginName}: timed out after ${timeout}ms`));
        }, { once: true });
    });
}
