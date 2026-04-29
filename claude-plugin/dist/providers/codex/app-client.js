import { setTimeout as delay } from 'node:timers/promises';
export class CodexAppClient {
    url;
    log;
    ws;
    nextId = 1;
    pending = new Map();
    listeners = new Set();
    connected = false;
    connectionListeners = new Set();
    constructor(url, log = () => { }) {
        this.url = url;
        this.log = log;
    }
    async connect() {
        if (this.connected)
            return;
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.onopen = () => {
                this.connected = true;
                this.emitConnection(true);
                resolve();
            };
            ws.onerror = event => reject(new Error(`websocket error: ${String(event.message || 'unknown')}`));
            ws.onclose = event => {
                this.connected = false;
                this.emitConnection(false);
                const err = new Error(`websocket closed code=${event.code} reason=${event.reason || '(none)'}`);
                for (const pending of this.pending.values())
                    pending.reject(err);
                this.pending.clear();
            };
            ws.onmessage = event => this.handleMessage(String(event.data));
        });
    }
    close() {
        this.ws?.close();
    }
    isConnected() {
        return this.connected;
    }
    async initialize() {
        return this.request('initialize', {
            clientInfo: {
                name: 'agent-awareness-codex-live',
                title: 'Agent Awareness Codex Live',
                version: '0.1.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
    }
    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onConnectionChange(listener) {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
    }
    async settle(ms = 150) {
        await delay(ms);
    }
    async threadStart(params) {
        return this.request('thread/start', params);
    }
    async threadResume(params) {
        return this.request('thread/resume', params);
    }
    async threadRead(threadId, includeTurns = false) {
        return this.request('thread/read', { threadId, includeTurns });
    }
    async threadList(params) {
        return this.request('thread/list', params);
    }
    async threadLoadedList(limit = 20) {
        return this.request('thread/loaded/list', { limit });
    }
    async turnStart(threadId, text) {
        return this.request('turn/start', {
            threadId,
            input: [{ type: 'text', text }],
        });
    }
    async turnSteer(threadId, turnId, text) {
        return this.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text }],
        });
    }
    async turnInterrupt(threadId, turnId) {
        return this.request('turn/interrupt', { threadId, turnId });
    }
    async request(method, params) {
        if (!this.connected || !this.ws) {
            throw new Error('websocket not connected');
        }
        const id = this.nextId++;
        const payload = { id, method, params };
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.ws.send(JSON.stringify(payload));
        return promise;
    }
    handleMessage(raw) {
        const parsed = JSON.parse(raw);
        if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
            const pending = this.pending.get(parsed.id);
            if (pending) {
                this.pending.delete(parsed.id);
                if (parsed.error) {
                    pending.reject(new Error(`${parsed.error.message} (${parsed.error.code})`));
                }
                else {
                    pending.resolve(parsed.result);
                }
            }
            this.record({ type: 'response', message: parsed });
            return;
        }
        if ('id' in parsed && 'method' in parsed) {
            this.log(`server-request ${parsed.method}`);
            this.record({ type: 'server-request', message: parsed });
            return;
        }
        if ('method' in parsed) {
            this.record({ type: 'notification', message: parsed });
        }
    }
    record(event) {
        for (const listener of this.listeners)
            listener(event);
    }
    emitConnection(connected) {
        for (const listener of this.connectionListeners)
            listener(connected);
    }
}
