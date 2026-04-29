import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectSSE, ensureServer } from '../../daemon/client.ts';
import { CodexAppClient, type ClientEvent, type Thread, type ThreadStatus } from './app-client.ts';

interface Config {
  appServerUrl: string;
  cwd: string;
  statePath: string;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  threadMode: 'auto' | 'resume' | 'start';
  threadId?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  sessionId: string;
}

interface RuntimeState {
  threadId: string;
  activeTurnId: string | null;
  threadStatus: ThreadStatus['type'];
  appConnected: boolean;
  daemonConnected: boolean;
  appServerUrl: string;
  cwd: string;
  updatedAt: string;
}

interface AwarenessEvent {
  plugin: string;
  text: string;
  timestamp: string;
}

class CodexAwarenessSidecar {
  private readonly config: Config;
  private readonly logPrefix = '[agent-awareness-codex-live]';
  private app: CodexAppClient;
  private threadId = '';
  private activeTurnId: string | null = null;
  private threadStatus: ThreadStatus['type'] = 'notLoaded';
  private stopping = false;
  private appConnected = false;
  private daemonConnected = false;
  private reconnecting: Promise<void> | null = null;

  constructor(config: Config) {
    this.config = config;
    this.app = this.createAppClient();
  }

  async run(): Promise<void> {
    mkdirSync(dirname(this.config.statePath), { recursive: true });
    process.on('SIGINT', () => void this.stop('SIGINT'));
    process.on('SIGTERM', () => void this.stop('SIGTERM'));

    await this.ensureAppReady();
    await this.consumeDaemonEvents();
  }

  private createAppClient(): CodexAppClient {
    const app = new CodexAppClient(this.config.appServerUrl, msg => this.log(msg));
    app.onEvent(event => this.handleAppEvent(event));
    app.onConnectionChange(connected => {
      this.appConnected = connected;
      if (!connected) {
        this.activeTurnId = null;
        this.threadStatus = 'notLoaded';
        if (!this.stopping) void this.ensureAppReady();
      }
      this.writeState();
    });
    return app;
  }

  private async ensureAppReady(force = false): Promise<void> {
    if (this.stopping) return;
    if (this.appConnected && !force) return;
    if (this.reconnecting) return this.reconnecting;

    this.reconnecting = this.connectWithRetry(force).finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  private async connectWithRetry(force: boolean): Promise<void> {
    let waitMs = this.config.reconnectInitialDelayMs;

    while (!this.stopping) {
      try {
        if (force) {
          try { this.app.close(); } catch { /* ignore */ }
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
      } catch (error) {
        this.appConnected = false;
        this.log(`app connection failed: ${describeError(error)}; retrying in ${waitMs}ms`);
        await delay(waitMs);
        waitMs = Math.min(this.config.reconnectMaxDelayMs, waitMs * 2);
      }
    }
  }

  private async consumeDaemonEvents(): Promise<void> {
    while (!this.stopping) {
      try {
        const daemon = await ensureServer();
        if (!daemon) throw new Error('agent-awareness daemon unavailable');
        const stream = await connectSSE(daemon, this.config.sessionId);
        if (!stream) throw new Error('failed to connect daemon SSE');

        this.daemonConnected = true;
        this.writeState();
        this.log(`connected to daemon ${daemon.host}:${daemon.port}`);
        await this.readSse(stream);
      } catch (error) {
        this.daemonConnected = false;
        this.writeState();
        if (!this.stopping) {
          this.log(`daemon stream error: ${describeError(error)}; retrying`);
          await delay(1000);
        }
      }
    }
  }

  private async readSse(stream: AsyncIterable<Buffer | string>): Promise<void> {
    let buffer = '';
    for await (const chunk of stream) {
      if (this.stopping) return;
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

  private async handleSseFrame(frame: string): Promise<void> {
    const lines = frame.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim() ?? 'message';
    if (event !== 'plugin-result') return;

    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) return;

    const parsed = JSON.parse(data) as AwarenessEvent;
    if (!parsed.text?.trim()) return;
    await this.deliverAwareness(parsed);
  }

  private async deliverAwareness(event: AwarenessEvent): Promise<void> {
    await this.ensureAppReady();
    const prompt = formatAwarenessPrompt(event);
    this.log(`delivering ${event.plugin} via ${this.activeTurnId ? 'steer' : 'start'}`);

    if (this.activeTurnId) {
      try {
        await this.app.turnSteer(this.threadId, this.activeTurnId, prompt);
        this.writeState();
        return;
      } catch (error) {
        this.log(`steer failed, falling back to new turn: ${describeError(error)}`);
      }
    }

    await this.app.turnStart(this.threadId, prompt);
    this.writeState();
  }

  private async stop(signal: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`stopping on ${signal}`);
    this.writeState();
    this.app.close();
  }

  private async resumeKnownThread(threadId: string): Promise<Thread> {
    try {
      const resumed = await this.app.threadResume({
        threadId,
        cwd: this.config.cwd,
        ...this.threadPermissions(),
        persistExtendedHistory: false,
      });
      return normalizeThread(resumed.thread);
    } catch (error) {
      this.log(`resume failed for thread ${threadId}: ${describeError(error)}; falling back to thread resolution`);
      this.threadId = '';
      return this.resolveThread();
    }
  }

  private async resolveThread(): Promise<Thread> {
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
      const loadedThreads: Thread[] = [];
      for (const loadedThreadId of loaded.data) {
        const thread = await this.readThreadWithFallback(loadedThreadId);
        if (thread.cwd === this.config.cwd) loadedThreads.push(thread);
      }
      const latestLoaded = [...loadedThreads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latestLoaded) return latestLoaded;

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

  private threadPermissions(): Record<string, string> {
    const payload: Record<string, string> = {};
    if (this.config.approvalPolicy) payload.approvalPolicy = this.config.approvalPolicy;
    if (this.config.sandbox) payload.sandbox = this.config.sandbox;
    return payload;
  }

  private async readThreadWithFallback(threadId: string): Promise<Thread> {
    try {
      const read = await this.app.threadRead(threadId, true);
      return normalizeThread(read.thread);
    } catch (error) {
      if (!describeError(error).includes('not materialized yet')) throw error;
      const read = await this.app.threadRead(threadId, false);
      return normalizeThread(read.thread);
    }
  }

  private syncThreadState(thread: Thread): void {
    this.threadStatus = thread.status.type;
    const turns = thread.turns ?? [];
    const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress');
    this.activeTurnId = activeTurn?.id ?? null;
    this.writeState();
  }

  private handleAppEvent(event: ClientEvent): void {
    if (event.type !== 'notification') return;
    const { method, params } = event.message;

    if (method === 'thread/status/changed') {
      if (params?.threadId === this.threadId && params.status && typeof params.status === 'object' && 'type' in params.status) {
        this.threadStatus = String(params.status.type) as ThreadStatus['type'];
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
        if (completedId && this.activeTurnId === completedId) this.activeTurnId = null;
        this.threadStatus = 'idle';
        this.writeState();
      }
    }
  }

  private writeState(): void {
    if (!this.threadId) return;
    const state: RuntimeState = {
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

  private log(message: string): void {
    console.error(`${this.logPrefix} ${message}`);
  }
}

function formatAwarenessPrompt(event: AwarenessEvent): string {
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

function normalizeThread(thread: Thread): Thread {
  return { ...thread, turns: thread.turns ?? [] };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(): Config {
  const cwd = process.env.AGENT_AWARENESS_CODEX_CWD || process.cwd();
  return {
    appServerUrl: process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:4501',
    cwd,
    statePath: process.env.AGENT_AWARENESS_CODEX_LIVE_STATE_PATH || `${cwd}/.agent-awareness-codex-live.json`,
    reconnectInitialDelayMs: envNumber('AGENT_AWARENESS_CODEX_RECONNECT_INITIAL_MS', 1000),
    reconnectMaxDelayMs: envNumber('AGENT_AWARENESS_CODEX_RECONNECT_MAX_MS', 10000),
    threadMode: (process.env.CODEX_THREAD_MODE as Config['threadMode']) || 'auto',
    threadId: process.env.CODEX_THREAD_ID || undefined,
    model: process.env.CODEX_MODEL || undefined,
    approvalPolicy: process.env.CODEX_LIVE_APPROVAL_POLICY || undefined,
    sandbox: process.env.CODEX_LIVE_SANDBOX || undefined,
    sessionId: process.env.AGENT_AWARENESS_CODEX_SESSION_ID || `codex-live-${process.pid}`,
  };
}

async function main(): Promise<void> {
  const sidecar = new CodexAwarenessSidecar(loadConfig());
  await sidecar.run();
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
