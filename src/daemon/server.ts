#!/usr/bin/env node

/**
 * agent-awareness central daemon.
 *
 * Single process per machine — owns the ticker loop and plugin gathering.
 * Per-session MCP servers connect via SSE to receive results.
 *
 * HTTP endpoints:
 *   GET  /health           — liveness check
 *   GET  /events           — SSE stream of plugin results (one per session)
 *   POST /gather           — run plugins for a trigger, return text (used by hooks)
 *   GET  /doctor           — diagnostic output
 *   POST /session/register — register a session (resets inactivity timer)
 *   POST /session/unregister — unregister a session
 *
 * Auto-shuts down after INACTIVITY_TIMEOUT with no registered sessions.
 *
 * Usage: node src/daemon/server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { writeFile, unlink, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setupTicker, tick } from './tick-loop.ts';
import { Registry } from '../core/registry.ts';
import { loadPlugins } from '../core/loader.ts';
import { PluginDispatcher } from '../core/dispatcher.ts';
import { initStateDir, STATE_DIR, loadState, getPluginState, setPluginState, withState } from '../core/state.ts';
import { resolveGatherContext } from '../core/session-context.ts';
import { createClaimContext } from '../core/claims.ts';
import { pruneExpiredClaims } from '../core/claims.ts';
import type { GatherContext, GatherResult, PluginState, Trigger } from '../core/types.ts';
import { applyInjectionPolicy, type PolicyInput } from '../core/policy.ts';
import { render } from '../core/renderer.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

const DAEMON_DIR = join(homedir(), '.cache', 'agent-awareness');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

// --- SSE client tracking ---

interface SSEClient {
  res: ServerResponse;
  sessionId: string;
}

const sseClients = new Set<SSEClient>();
const sessions = new Set<string>();
let lastActivity = Date.now();

function broadcast(event: string, data: Record<string, unknown>): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Request handling ---

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  lastActivity = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, { status: 'ok', sessions: sessions.size, uptime: process.uptime() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const sessionId = url.searchParams.get('sessionId') ?? 'unknown';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');

      const client: SSEClient = { res, sessionId };
      sseClients.add(client);
      sessions.add(sessionId);

      req.on('close', () => {
        sseClients.delete(client);
        sessions.delete(sessionId);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/gather') {
      const body = await readBody(req);
      const trigger = body.trigger ?? 'session-start';
      const cwd = body.cwd ?? process.cwd();
      const text = await gatherForTrigger(trigger, cwd);
      json(res, { text });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/doctor') {
      const text = await runDoctor();
      json(res, { text });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/session/register') {
      const body = await readBody(req);
      if (body.sessionId) sessions.add(body.sessionId);
      json(res, { ok: true, sessions: sessions.size });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/session/unregister') {
      const body = await readBody(req);
      if (body.sessionId) sessions.delete(body.sessionId);
      json(res, { ok: true, sessions: sessions.size });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[daemon] request error:', err);
    res.writeHead(500);
    res.end('internal error');
  }
}

// --- Gather (used by hooks via POST /gather) ---

let registry: Registry | null = null;
const dispatcher = new PluginDispatcher();

async function ensureRegistry(): Promise<Registry> {
  if (registry) return registry;
  registry = new Registry();
  const { plugins, errors } = await loadPlugins();
  for (const plugin of plugins) registry.register(plugin);
  for (const { source, error } of errors) {
    console.error(`[daemon] plugin load error: ${source}: ${error}`);
  }
  await registry.loadConfig(DEFAULT_CONFIG);
  return registry;
}

async function gatherForTrigger(trigger: string, cwd: string): Promise<string> {
  const reg = await ensureRegistry();
  const context = await resolveGatherContext('claude-code', cwd);

  if (trigger === 'session-start') {
    await reg.startPlugins();
    await pruneExpiredClaims();
  }

  const preState = await loadState();
  const triggered = reg.getTriggeredPlugins(trigger, preState);
  if (triggered.length === 0) return '';

  const entries = triggered.map(({ plugin, trigger: trig }) => ({
    pluginName: plugin.name,
    executor: (signal: AbortSignal) => {
      const config = reg.getPluginConfig(plugin.name)!;
      const prevState = getPluginState(preState, plugin.name);
      const claims = createClaimContext(plugin.name);
      return Promise.resolve(plugin.gather(trig as Trigger, config, prevState, { ...context, signal, claims }));
    },
  }));

  const dispatched = await dispatcher.dispatchAll(entries);

  const gatheredResults = dispatched
    .filter((entry): entry is { pluginName: string; result: GatherResult } => !!entry.result)
    .map(({ pluginName, result }) => ({ pluginName, result }));

  const policyInputs: PolicyInput[] = gatheredResults.map(({ pluginName, result }) => ({
    pluginName,
    result,
  }));

  const policyConfig = reg.getPolicyConfig();
  const maxChars = trigger === 'session-start'
    ? policyConfig.maxCharsSessionStart
    : policyConfig.maxCharsPrompt;
  const policy = applyInjectionPolicy(policyInputs, { event: trigger, maxChars });

  // Save state
  await withState((state: PluginState) => {
    for (const { pluginName, result } of gatheredResults) {
      state = setPluginState(state, pluginName, result.state);
    }
    return state;
  });

  if (policy.results.length === 0) return '';
  return render(policy.results);
}

// --- Ticker (background interval polling) ---

let tickerTimer: ReturnType<typeof setInterval> | null = null;

async function startTicker(): Promise<void> {
  const setup = await setupTicker('claude-code');
  if (!setup) {
    console.error('[daemon] no interval plugins configured, ticker not started');
    return;
  }

  const { registry: tickerRegistry, schedules, tickMs, context } = setup;

  const onResult = (pluginName: string, text: string) => {
    broadcast('plugin-result', {
      plugin: pluginName,
      text,
      timestamp: new Date().toISOString(),
    });
  };

  // Initial tick
  await tick(tickerRegistry, schedules, context, { onResult });

  // Periodic ticks
  tickerTimer = setInterval(async () => {
    await tick(tickerRegistry, schedules, context, { onResult });
  }, tickMs);

  console.error(`[daemon] ticker started (${schedules.length} schedules, tick every ${tickMs}ms)`);
}

// --- Inactivity shutdown ---

function startInactivityMonitor(): void {
  const check = setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (sessions.size === 0 && idle > INACTIVITY_TIMEOUT) {
      console.error(`[daemon] no sessions for ${Math.round(idle / 1000)}s, shutting down`);
      shutdown();
    }
  }, 60_000);
  check.unref();
}

// --- Doctor ---

async function runDoctor(): Promise<string> {
  const reg = await ensureRegistry();
  const lines: string[] = ['agent-awareness doctor (daemon)', ''];

  let globalRoot: string | null = null;
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* npm not available */ }

  lines.push('Plugin sources:');
  lines.push(`  builtin:  ${join(PROJECT_ROOT, 'src', 'plugins')}`);
  lines.push(`  npm:      ${join(PROJECT_ROOT, 'node_modules')}`);
  lines.push(`  global:   ${globalRoot ?? '(npm root -g failed)'}`);
  lines.push(`  local:    ${join(homedir(), '.config', 'agent-awareness', 'plugins')}`);

  lines.push('', 'Paths:');
  lines.push(`  state:  ${STATE_DIR}`);
  const logFile = join(STATE_DIR, 'agent-awareness.log');
  lines.push(`  log:    ${logFile}`);
  const logStat = await stat(logFile).catch(() => null);
  if (logStat) {
    lines.push(`          (${(logStat.size / 1024).toFixed(1)} KB)`);
  }

  const enabled = reg.getEnabledPlugins();
  lines.push('', `Loaded (${enabled.length}):`);
  for (const plugin of enabled) {
    lines.push(`  OK  ${plugin.name}`);
  }

  lines.push('', `Daemon: running (pid ${process.pid})`);
  lines.push(`  Sessions: ${sessions.size}`);
  lines.push(`  SSE clients: ${sseClients.size}`);
  lines.push(`  Ticker: ${tickerTimer ? 'running' : 'not started'}`);

  const total = enabled.length;
  lines.push('', `Status: healthy — ${total} loaded, ${sessions.size} sessions`);

  return lines.join('\n');
}

// --- Utilities ---

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// --- Lifecycle ---

async function writePidFile(port: number): Promise<void> {
  await mkdir(DAEMON_DIR, { recursive: true });
  const data = {
    pid: process.pid,
    port,
    host: '127.0.0.1',
    startedAt: new Date().toISOString(),
    serverScript: fileURLToPath(import.meta.url),
    version: '0.6.1',
  };
  await writeFile(PID_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function removePidFile(): Promise<void> {
  try { await unlink(PID_FILE); } catch { /* already gone */ }
}

let server: ReturnType<typeof createServer> | null = null;

async function shutdown(): Promise<void> {
  if (tickerTimer) clearInterval(tickerTimer);
  for (const client of sseClients) {
    try { client.res.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  await removePidFile();
  server?.close();
  process.exit(0);
}

async function main(): Promise<void> {
  await initStateDir('claude-code');

  // Check for stale PID file
  if (existsSync(PID_FILE)) {
    try {
      const existing = JSON.parse(await readFile(PID_FILE, 'utf8'));
      process.kill(existing.pid, 0); // throws if dead
      console.error(`[daemon] already running (pid ${existing.pid}, port ${existing.port})`);
      process.exit(0);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        // Stale PID, clean up and continue
        await removePidFile();
      } else if (err.code !== 'ERR_INVALID_ARG_TYPE') {
        // Process exists, bail
        process.exit(0);
      }
    }
  }

  server = createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => resolve());
    server!.on('error', reject);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  await writePidFile(port);
  console.error(`[daemon] listening on 127.0.0.1:${port} (pid ${process.pid})`);

  // Start ticker and inactivity monitor
  await startTicker();
  startInactivityMonitor();

  // Clean shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[daemon] fatal:', err);
  process.exit(1);
});
