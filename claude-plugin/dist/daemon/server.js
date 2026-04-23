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
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFile, unlink, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setupTicker, tick } from "./tick-loop.js";
import { Registry } from "../core/registry.js";
import { loadPlugins } from "../core/loader.js";
import { PluginDispatcher } from "../core/dispatcher.js";
import { initStateDir, STATE_DIR, loadState, getPluginState, setPluginState, withState } from "../core/state.js";
import { resolveGatherContext } from "../core/session-context.js";
import { createClaimContext } from "../core/claims.js";
import { pruneExpiredClaims } from "../core/claims.js";
import { applyInjectionPolicy } from "../core/policy.js";
import { render } from "../core/renderer.js";
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const DAEMON_DIR = join(homedir(), '.cache', 'agent-awareness');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
function getPackageVersion() {
    try {
        const pkgPath = join(PROJECT_ROOT, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return pkg.version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
const sseClients = new Set();
const sessions = new Set();
let lastActivity = Date.now();
function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.res.write(payload);
        }
        catch {
            sseClients.delete(client);
        }
    }
}
// --- Request handling ---
async function handleRequest(req, res) {
    lastActivity = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
        if (req.method === 'GET' && url.pathname === '/health') {
            const plugins = registry?.pluginNames() ?? [];
            json(res, { status: 'ok', version: getPackageVersion(), plugins, sessions: sessions.size, sseClients: sseClients.size, uptime: process.uptime() });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/events') {
            const sessionId = url.searchParams.get('sessionId') ?? 'unknown';
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            // Keep SSE socket alive indefinitely
            req.socket?.setKeepAlive(true, 30_000);
            req.socket?.setTimeout(0);
            res.socket?.setTimeout(0);
            res.write(': connected\n\n');
            // Send periodic heartbeat to prevent connection reaping
            const heartbeat = setInterval(() => {
                try {
                    res.write(': heartbeat\n\n');
                }
                catch {
                    clearInterval(heartbeat);
                }
            }, 30_000);
            const client = { res, sessionId };
            sseClients.add(client);
            sessions.add(sessionId);
            req.on('close', () => {
                clearInterval(heartbeat);
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
        if (req.method === 'POST' && url.pathname === '/reload') {
            const result = await reloadPlugins();
            json(res, { ok: true, ...result });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/session/register') {
            const body = await readBody(req);
            if (body.sessionId)
                sessions.add(body.sessionId);
            json(res, { ok: true, sessions: sessions.size });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/session/unregister') {
            const body = await readBody(req);
            if (body.sessionId)
                sessions.delete(body.sessionId);
            json(res, { ok: true, sessions: sessions.size });
            return;
        }
        res.writeHead(404);
        res.end('not found');
    }
    catch (err) {
        console.error('[daemon] request error:', err);
        res.writeHead(500);
        res.end('internal error');
    }
}
// --- Gather (used by hooks via POST /gather) ---
let registry = null;
const dispatcher = new PluginDispatcher();
async function ensureRegistry() {
    if (registry)
        return registry;
    registry = new Registry();
    const { plugins, errors } = await loadPlugins();
    for (const plugin of plugins)
        registry.register(plugin);
    for (const { source, error } of errors) {
        console.error(`[daemon] plugin load error: ${source}: ${error}`);
    }
    await registry.loadConfig(DEFAULT_CONFIG);
    return registry;
}
async function reloadPlugins() {
    const reg = await ensureRegistry();
    await reg.stopPlugins();
    reg.clear();
    const { plugins, errors } = await loadPlugins({ bustCache: true });
    for (const plugin of plugins)
        reg.register(plugin);
    for (const { source, error } of errors) {
        console.error(`[daemon] reload error: ${source}: ${error}`);
    }
    await reg.loadConfig(DEFAULT_CONFIG);
    await reg.startPlugins();
    console.error(`[daemon] reloaded ${plugins.length} plugins`);
    return {
        loaded: reg.pluginNames(),
        errors: errors.map(e => `${e.source}: ${e.error}`),
    };
}
async function gatherForTrigger(trigger, cwd) {
    const reg = await ensureRegistry();
    const context = await resolveGatherContext('claude-code', cwd);
    if (trigger === 'session-start') {
        await reg.startPlugins();
        await pruneExpiredClaims();
    }
    const preState = await loadState();
    const triggered = reg.getTriggeredPlugins(trigger, preState);
    if (triggered.length === 0)
        return '';
    const entries = triggered.map(({ plugin, trigger: trig }) => ({
        pluginName: plugin.name,
        executor: (signal) => {
            const config = reg.getPluginConfig(plugin.name);
            const prevState = getPluginState(preState, plugin.name);
            const claims = createClaimContext(plugin.name);
            return Promise.resolve(plugin.gather(trig, config, prevState, { ...context, signal, claims }));
        },
    }));
    const dispatched = await dispatcher.dispatchAll(entries);
    const gatheredResults = dispatched
        .filter((entry) => !!entry.result)
        .map(({ pluginName, result }) => ({ pluginName, result }));
    const policyInputs = gatheredResults.map(({ pluginName, result }) => ({
        pluginName,
        result,
    }));
    const policyConfig = reg.getPolicyConfig();
    const maxChars = trigger === 'session-start'
        ? policyConfig.maxCharsSessionStart
        : policyConfig.maxCharsPrompt;
    const policy = applyInjectionPolicy(policyInputs, { event: trigger, maxChars });
    // Save state
    await withState((state) => {
        for (const { pluginName, result } of gatheredResults) {
            state = setPluginState(state, pluginName, result.state);
        }
        return state;
    });
    if (policy.results.length === 0)
        return '';
    return render(policy.results, { showPluginNames: policyConfig.showPluginNames });
}
// --- Ticker (background interval polling) ---
let tickerTimer = null;
async function startTicker() {
    const setup = await setupTicker('claude-code');
    if (!setup) {
        console.error('[daemon] no interval plugins configured, ticker not started');
        return;
    }
    const { registry: tickerRegistry, schedules, tickMs, context } = setup;
    const onResult = (pluginName, text) => {
        broadcast('plugin-result', {
            plugin: pluginName,
            text,
            timestamp: new Date().toISOString(),
        });
    };
    // No initial tick — sessions get initial data from session-start hook.
    // First tick fires after tickMs, when SSE clients are connected.
    // Periodic ticks
    tickerTimer = setInterval(async () => {
        await tick(tickerRegistry, schedules, context, { onResult });
    }, tickMs);
    console.error(`[daemon] ticker started (${schedules.length} schedules, tick every ${tickMs}ms)`);
}
// --- Inactivity shutdown ---
function pruneDeadConnections() {
    for (const client of sseClients) {
        if (client.res.destroyed || client.res.writableEnded) {
            sseClients.delete(client);
            sessions.delete(client.sessionId);
        }
    }
}
function startInactivityMonitor() {
    const check = setInterval(() => {
        pruneDeadConnections();
        const idle = Date.now() - lastActivity;
        if (sessions.size === 0 && sseClients.size === 0 && idle > INACTIVITY_TIMEOUT) {
            console.error(`[daemon] no sessions for ${Math.round(idle / 1000)}s, shutting down`);
            shutdown();
        }
    }, 60_000);
    check.unref();
}
// --- Doctor ---
async function runDoctor() {
    const reg = await ensureRegistry();
    const lines = ['agent-awareness doctor (daemon)', ''];
    let globalRoot = null;
    try {
        globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
    }
    catch { /* npm not available */ }
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
function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
// --- Lifecycle ---
async function writePidFile(port) {
    await mkdir(DAEMON_DIR, { recursive: true });
    const data = {
        pid: process.pid,
        port,
        host: '127.0.0.1',
        startedAt: new Date().toISOString(),
        serverScript: fileURLToPath(import.meta.url),
        version: getPackageVersion(),
    };
    await writeFile(PID_FILE, JSON.stringify(data, null, 2) + '\n');
}
async function removePidFile() {
    try {
        await unlink(PID_FILE);
    }
    catch { /* already gone */ }
}
let server = null;
async function shutdown() {
    if (tickerTimer)
        clearInterval(tickerTimer);
    for (const client of sseClients) {
        try {
            client.res.end();
        }
        catch { /* ignore */ }
    }
    sseClients.clear();
    await removePidFile();
    server?.close();
    process.exit(0);
}
async function main() {
    await initStateDir('claude-code');
    // Check for stale PID file
    if (existsSync(PID_FILE)) {
        try {
            const existing = JSON.parse(await readFile(PID_FILE, 'utf8'));
            process.kill(existing.pid, 0); // throws if dead
            console.error(`[daemon] already running (pid ${existing.pid}, port ${existing.port})`);
            process.exit(0);
        }
        catch (err) {
            if (err.code === 'ESRCH') {
                // Stale PID, clean up and continue
                await removePidFile();
            }
            else if (err.code !== 'ERR_INVALID_ARG_TYPE') {
                // Process exists, bail
                process.exit(0);
            }
        }
    }
    server = createServer(handleRequest);
    server.keepAliveTimeout = 0; // SSE connections must not be reaped
    server.headersTimeout = 0;
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
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
