import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectSSE, ensureServer } from "../../daemon/client.js";
import { CodexAppClient } from "./app-client.js";
class CodexAwarenessSidecar {
    config;
    logPrefix = '[agent-awareness-codex-live]';
    app;
    threadId = '';
    activeTurnId = null;
    threadStatus = 'notLoaded';
    stopping = false;
    appConnected = false;
    daemonConnected = false;
    reconnecting = null;
    constructor(config) {
        this.config = config;
        this.app = this.createAppClient();
    }
    async run() {
        mkdirSync(dirname(this.config.statePath), { recursive: true });
        process.on('SIGINT', () => void this.stop('SIGINT'));
        process.on('SIGTERM', () => void this.stop('SIGTERM'));
        await this.ensureAppReady();
        await this.consumeDaemonEvents();
    }
    createAppClient() {
        const app = new CodexAppClient(this.config.appServerUrl, msg => this.log(msg));
        app.onEvent(event => this.handleAppEvent(event));
        app.onConnectionChange(connected => {
            this.appConnected = connected;
            if (!connected) {
                this.activeTurnId = null;
                this.threadStatus = 'notLoaded';
                if (!this.stopping)
                    void this.ensureAppReady();
            }
            this.writeState();
        });
        return app;
    }
    async ensureAppReady(force = false) {
        if (this.stopping)
            return;
        if (this.appConnected && !force)
            return;
        if (this.reconnecting)
            return this.reconnecting;
        this.reconnecting = this.connectWithRetry(force).finally(() => {
            this.reconnecting = null;
        });
        return this.reconnecting;
    }
    async connectWithRetry(force) {
        let waitMs = this.config.reconnectInitialDelayMs;
        while (!this.stopping) {
            try {
                if (force) {
                    try {
                        this.app.close();
                    }
                    catch { /* ignore */ }
                    this.appConnected = false;
                }
                if (!this.app.isConnected()) {
                    this.app = this.createAppClient();
                    await this.app.connect();
                    await this.app.initialize();
                }
                const thread = this.threadId
                    ? await this.resumeKnownThread(this.threadId)
                    : await this.resolveThread();
                this.threadId = thread.id;
                this.syncThreadState(thread);
                this.log(`attached to thread ${thread.id}`);
                return;
            }
            catch (error) {
                this.appConnected = false;
                this.log(`app connection failed: ${describeError(error)}; retrying in ${waitMs}ms`);
                await delay(waitMs);
                waitMs = Math.min(this.config.reconnectMaxDelayMs, waitMs * 2);
            }
        }
    }
    async consumeDaemonEvents() {
        while (!this.stopping) {
            try {
                const daemon = await ensureServer();
                if (!daemon)
                    throw new Error('agent-awareness daemon unavailable');
                const stream = await connectSSE(daemon, this.config.sessionId);
                if (!stream)
                    throw new Error('failed to connect daemon SSE');
                this.daemonConnected = true;
                this.writeState();
                this.log(`connected to daemon ${daemon.host}:${daemon.port}`);
                await this.readSse(stream);
            }
            catch (error) {
                this.daemonConnected = false;
                this.writeState();
                if (!this.stopping) {
                    this.log(`daemon stream error: ${describeError(error)}; retrying`);
                    await delay(1000);
                }
            }
        }
    }
    async readSse(stream) {
        let buffer = '';
        for await (const chunk of stream) {
            if (this.stopping)
                return;
            buffer += chunk.toString();
            let splitAt = buffer.indexOf('\n\n');
            while (splitAt !== -1) {
                const frame = buffer.slice(0, splitAt);
                buffer = buffer.slice(splitAt + 2);
                await this.handleSseFrame(frame);
                splitAt = buffer.indexOf('\n\n');
            }
        }
    }
    async handleSseFrame(frame) {
        const lines = frame.split(/\r?\n/);
        const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim() ?? 'message';
        if (event !== 'plugin-result')
            return;
        const data = lines
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trimStart())
            .join('\n');
        if (!data)
            return;
        const parsed = JSON.parse(data);
        if (!parsed.text?.trim())
            return;
        await this.deliverAwareness(parsed);
    }
    async deliverAwareness(event) {
        await this.ensureAppReady();
        const prompt = formatAwarenessPrompt(event);
        this.log(`delivering ${event.plugin} via ${this.activeTurnId ? 'steer' : 'start'}`);
        if (this.activeTurnId) {
            try {
                await this.app.turnSteer(this.threadId, this.activeTurnId, prompt);
                this.writeState();
                return;
            }
            catch (error) {
                this.log(`steer failed, falling back to new turn: ${describeError(error)}`);
            }
        }
        await this.app.turnStart(this.threadId, prompt);
        this.writeState();
    }
    async stop(signal) {
        if (this.stopping)
            return;
        this.stopping = true;
        this.log(`stopping on ${signal}`);
        this.writeState();
        this.app.close();
    }
    async resumeKnownThread(threadId) {
        try {
            const resumed = await this.app.threadResume({
                threadId,
                cwd: this.config.cwd,
                ...this.threadPermissions(),
                persistExtendedHistory: false,
            });
            return normalizeThread(resumed.thread);
        }
        catch (error) {
            this.log(`resume failed for thread ${threadId}: ${describeError(error)}; falling back to thread resolution`);
            this.threadId = '';
            return this.resolveThread();
        }
    }
    async resolveThread() {
        if (this.config.threadId && this.config.threadMode !== 'start') {
            const resumed = await this.app.threadResume({
                threadId: this.config.threadId,
                cwd: this.config.cwd,
                ...this.threadPermissions(),
                persistExtendedHistory: false,
            });
            return normalizeThread(resumed.thread);
        }
        if (this.config.threadMode !== 'start') {
            const loaded = await this.app.threadLoadedList(20);
            const loadedThreads = [];
            for (const loadedThreadId of loaded.data) {
                const thread = await this.readThreadWithFallback(loadedThreadId);
                if (thread.cwd === this.config.cwd)
                    loadedThreads.push(thread);
            }
            const latestLoaded = [...loadedThreads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (latestLoaded)
                return latestLoaded;
            const listed = await this.app.threadList({ cwd: this.config.cwd, limit: 10, archived: false });
            const latest = [...listed.data].sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (latest) {
                const resumed = await this.app.threadResume({
                    threadId: latest.id,
                    cwd: this.config.cwd,
                    ...this.threadPermissions(),
                    persistExtendedHistory: false,
                });
                return normalizeThread(resumed.thread);
            }
        }
        const started = await this.app.threadStart({
            cwd: this.config.cwd,
            ...this.threadPermissions(),
            ephemeral: false,
            sessionStartSource: 'startup',
            model: this.config.model ?? null,
        });
        return normalizeThread(started.thread);
    }
    threadPermissions() {
        const payload = {};
        if (this.config.approvalPolicy)
            payload.approvalPolicy = this.config.approvalPolicy;
        if (this.config.sandbox)
            payload.sandbox = this.config.sandbox;
        return payload;
    }
    async readThreadWithFallback(threadId) {
        try {
            const read = await this.app.threadRead(threadId, true);
            return normalizeThread(read.thread);
        }
        catch (error) {
            if (!describeError(error).includes('not materialized yet'))
                throw error;
            const read = await this.app.threadRead(threadId, false);
            return normalizeThread(read.thread);
        }
    }
    syncThreadState(thread) {
        this.threadStatus = thread.status.type;
        const turns = thread.turns ?? [];
        const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress');
        this.activeTurnId = activeTurn?.id ?? null;
        this.writeState();
    }
    handleAppEvent(event) {
        if (event.type !== 'notification')
            return;
        const { method, params } = event.message;
        if (method === 'thread/status/changed') {
            if (params?.threadId === this.threadId && params.status && typeof params.status === 'object' && 'type' in params.status) {
                this.threadStatus = String(params.status.type);
                this.writeState();
            }
            return;
        }
        if (method === 'turn/started') {
            if (params?.threadId === this.threadId && params.turn && typeof params.turn === 'object' && 'id' in params.turn) {
                this.activeTurnId = String(params.turn.id);
                this.threadStatus = 'active';
                this.writeState();
            }
            return;
        }
        if (method === 'turn/completed') {
            if (params?.threadId === this.threadId && params.turn && typeof params.turn === 'object') {
                const completedId = 'id' in params.turn ? String(params.turn.id) : null;
                if (completedId && this.activeTurnId === completedId)
                    this.activeTurnId = null;
                this.threadStatus = 'idle';
                this.writeState();
            }
        }
    }
    writeState() {
        if (!this.threadId)
            return;
        const state = {
            threadId: this.threadId,
            activeTurnId: this.activeTurnId,
            threadStatus: this.threadStatus,
            appConnected: this.appConnected,
            daemonConnected: this.daemonConnected,
            appServerUrl: this.config.appServerUrl,
            cwd: this.config.cwd,
            updatedAt: new Date().toISOString(),
        };
        writeFileSync(this.config.statePath, JSON.stringify(state, null, 2) + '\n');
    }
    log(message) {
        console.error(`${this.logPrefix} ${message}`);
    }
}
function formatAwarenessPrompt(event) {
    return [
        'Agent Awareness live context update.',
        '',
        `Plugin: ${event.plugin}`,
        `Observed: ${event.timestamp}`,
        '',
        'Context:',
        event.text,
        '',
        'Treat this as realtime context from agent-awareness. Do not summarize it back unless it changes what you should do.',
    ].join('\n');
}
function normalizeThread(thread) {
    return { ...thread, turns: thread.turns ?? [] };
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function loadConfig() {
    const cwd = process.env.AGENT_AWARENESS_CODEX_CWD || process.cwd();
    return {
        appServerUrl: process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:4501',
        cwd,
        statePath: process.env.AGENT_AWARENESS_CODEX_LIVE_STATE_PATH || `${cwd}/.agent-awareness-codex-live.json`,
        reconnectInitialDelayMs: envNumber('AGENT_AWARENESS_CODEX_RECONNECT_INITIAL_MS', 1000),
        reconnectMaxDelayMs: envNumber('AGENT_AWARENESS_CODEX_RECONNECT_MAX_MS', 10000),
        threadMode: process.env.CODEX_THREAD_MODE || 'auto',
        threadId: process.env.CODEX_THREAD_ID || undefined,
        model: process.env.CODEX_MODEL || undefined,
        approvalPolicy: process.env.CODEX_LIVE_APPROVAL_POLICY || undefined,
        sandbox: process.env.CODEX_LIVE_SANDBOX || undefined,
        sessionId: process.env.AGENT_AWARENESS_CODEX_SESSION_ID || `codex-live-${process.pid}`,
    };
}
async function main() {
    const sidecar = new CodexAwarenessSidecar(loadConfig());
    await sidecar.run();
}
main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
});
