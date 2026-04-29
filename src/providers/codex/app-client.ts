import { setTimeout as delay } from 'node:timers/promises';

type JsonRpcId = number | string;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface Turn {
  id: string;
  status: TurnStatus;
  startedAt: number | null;
  completedAt: number | null;
}

export interface Thread {
  id: string;
  cwd: string;
  status: ThreadStatus;
  updatedAt: number;
  preview: string;
  turns?: Turn[];
}

export type ClientEvent =
  | { type: 'notification'; message: JsonRpcNotification }
  | { type: 'server-request'; message: JsonRpcRequest }
  | { type: 'response'; message: JsonRpcResponse };

export interface TurnStartResponse {
  turn: Turn;
}

export interface ThreadStartResponse {
  thread: Thread;
}

export interface ThreadResumeResponse {
  thread: Thread;
}

export interface ThreadReadResponse {
  thread: Thread;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

export interface ThreadLoadedListResponse {
  data: string[];
  nextCursor: string | null;
}

export class CodexAppClient {
  private readonly url: string;
  private readonly log: (msg: string) => void;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (err: unknown) => void }>();
  private listeners = new Set<(event: ClientEvent) => void>();
  private connected = false;
  private connectionListeners = new Set<(connected: boolean) => void>();

  constructor(url: string, log: (msg: string) => void = () => {}) {
    this.url = url;
    this.log = log;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.emitConnection(true);
        resolve();
      };
      ws.onerror = event => reject(new Error(`websocket error: ${String((event as ErrorEvent).message || 'unknown')}`));
      ws.onclose = event => {
        this.connected = false;
        this.emitConnection(false);
        const err = new Error(`websocket closed code=${event.code} reason=${event.reason || '(none)'}`);
        for (const pending of this.pending.values()) pending.reject(err);
        this.pending.clear();
      };
      ws.onmessage = event => this.handleMessage(String(event.data));
    });
  }

  close(): void {
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async initialize(): Promise<unknown> {
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

  onEvent(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  async settle(ms = 150): Promise<void> {
    await delay(ms);
  }

  async threadStart(params: Record<string, unknown>): Promise<ThreadStartResponse> {
    return this.request<ThreadStartResponse>('thread/start', params);
  }

  async threadResume(params: Record<string, unknown>): Promise<ThreadResumeResponse> {
    return this.request<ThreadResumeResponse>('thread/resume', params);
  }

  async threadRead(threadId: string, includeTurns = false): Promise<ThreadReadResponse> {
    return this.request<ThreadReadResponse>('thread/read', { threadId, includeTurns });
  }

  async threadList(params: Record<string, unknown>): Promise<ThreadListResponse> {
    return this.request<ThreadListResponse>('thread/list', params);
  }

  async threadLoadedList(limit = 20): Promise<ThreadLoadedListResponse> {
    return this.request<ThreadLoadedListResponse>('thread/loaded/list', { limit });
  }

  async turnStart(threadId: string, text: string): Promise<TurnStartResponse> {
    return this.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
    });
  }

  async turnSteer(threadId: string, turnId: string, text: string): Promise<{ turnId: string }> {
    return this.request<{ turnId: string }>('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text }],
    });
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>('turn/interrupt', { threadId, turnId });
  }

  private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error('websocket not connected');
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  private handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        this.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new Error(`${parsed.error.message} (${parsed.error.code})`));
        } else {
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

  private record(event: ClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }
}
