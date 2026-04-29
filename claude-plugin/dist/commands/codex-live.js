import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { codexHooksInstall } from "./codex-hooks.js";
import { ensureServer } from "../daemon/client.js";
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const RUNTIME_ROOT = join(homedir(), '.cache', 'agent-awareness', 'codex-live');
const DEFAULT_HOOK_HANDSHAKE_TIMEOUT_MS = 5000;
export async function codexLive(options = {}) {
    await codexHooksInstall({
        scope: options.hooksScope ?? 'global',
        fallbackToProject: options.hooksFallbackToProject ?? true,
        quiet: true,
    });
    if (process.exitCode) {
        throw new Error('Failed to install required Codex hooks for live mode');
    }
    const daemon = await ensureServer();
    if (!daemon) {
        throw new Error('Failed to start agent-awareness daemon');
    }
    const listenUrl = options.listenUrl || `ws://127.0.0.1:${await getFreePort()}`;
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const runDir = join(RUNTIME_ROOT, runId);
    mkdirSync(runDir, { recursive: true });
    const env = {
        ...process.env,
        AGENT_AWARENESS_CODEX_LIVE: '1',
        AGENT_AWARENESS_CODEX_LIVE_RUN_ID: runId,
        AGENT_AWARENESS_CODEX_LIVE_RUNTIME_DIR: runDir,
        AGENT_AWARENESS_CODEX_PACKAGE_ROOT: PROJECT_ROOT,
        CODEX_APP_SERVER_URL: listenUrl,
        AGENT_AWARENESS_CODEX_CWD: process.cwd(),
    };
    const codexBinary = findCodexBinary();
    const appLog = join(runDir, 'app-server.log');
    const appServer = spawn(codexBinary, ['app-server', '--listen', listenUrl], {
        env,
        stdio: ['ignore', openAppendFd(appLog), openAppendFd(appLog)],
    });
    const shutdown = () => cleanupRun(runDir, appServer);
    process.once('SIGINT', () => { shutdown(); process.exit(130); });
    process.once('SIGTERM', () => { shutdown(); process.exit(143); });
    process.once('exit', shutdown);
    await waitForAppServer(listenUrl, appServer);
    console.log(`Agent Awareness Codex live session: ${listenUrl}`);
    console.log(`Runtime: ${runDir}`);
    const codex = spawn(codexBinary, ['--remote', listenUrl, ...(options.codexArgs ?? [])], {
        env,
        stdio: 'inherit',
    });
    const handshake = await waitForHookHandshake(runDir, DEFAULT_HOOK_HANDSHAKE_TIMEOUT_MS);
    if (handshake?.status === 'ok' && handshake.pid && isAlive(handshake.pid)) {
        appendLauncherLog(runDir, `HOOK_HANDSHAKE_OK code=${handshake.code} pid=${handshake.pid}`);
    }
    else if (codex.exitCode === null) {
        const pid = spawnFallbackSidecar(runDir, env);
        appendLauncherLog(runDir, `HOOK_FALLBACK_STARTED pid=${pid}${handshake ? ` code=${handshake.code}` : ' code=HOOK_HANDSHAKE_TIMEOUT'}`);
    }
    const exitCode = await new Promise(resolve => {
        codex.on('exit', code => resolve(code ?? 0));
    });
    shutdown();
    process.exit(exitCode);
}
async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Failed to allocate a TCP port for Codex app-server'));
                return;
            }
            const { port } = address;
            server.close(err => err ? reject(err) : resolve(port));
        });
    });
}
function findCodexBinary() {
    return process.env.AGENT_AWARENESS_CODEX_BINARY || 'codex';
}
function openAppendFd(path) {
    return openSync(path, 'a');
}
async function waitForAppServer(listenUrl, child) {
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error('codex app-server exited before accepting connections');
        try {
            const ws = new WebSocket(listenUrl);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebSocket connect timeout')), 250);
                ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(); };
                ws.onerror = event => { clearTimeout(timeout); reject(event); };
            });
            return;
        }
        catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Timed out waiting for codex app-server at ${listenUrl}: ${String(lastError)}`);
}
async function waitForHookHandshake(runDir, timeoutMs) {
    const path = join(runDir, 'session-start-handshake.json');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            try {
                return JSON.parse(readFileSync(path, 'utf8'));
            }
            catch {
                return null;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}
function spawnFallbackSidecar(runDir, env) {
    const autoDir = join(runDir, 'auto');
    mkdirSync(autoDir, { recursive: true });
    const sidecarEnv = {
        ...env,
        CODEX_THREAD_MODE: 'auto',
        AGENT_AWARENESS_CODEX_SESSION_ID: `codex-live-${process.pid}`,
        AGENT_AWARENESS_CODEX_LIVE_STATE_PATH: join(autoDir, 'live-state.json'),
    };
    delete sidecarEnv.CODEX_THREAD_ID;
    const logPath = join(autoDir, 'sidecar.log');
    const sidecar = spawn(process.execPath, [resolveSidecarScript()], {
        env: sidecarEnv,
        detached: true,
        stdio: ['ignore', openAppendFd(logPath), openAppendFd(logPath)],
    });
    sidecar.unref();
    writeFileSync(join(autoDir, 'sidecar.pid'), String(sidecar.pid));
    appendFileSync(join(runDir, 'sidecar-pids.txt'), `${sidecar.pid}\n`);
    return sidecar.pid ?? 0;
}
function resolveSidecarScript() {
    const dist = join(PROJECT_ROOT, 'dist', 'providers', 'codex', 'live-sidecar.js');
    if (existsSync(dist))
        return dist;
    return join(PROJECT_ROOT, 'src', 'providers', 'codex', 'live-sidecar.ts');
}
function cleanupRun(runDir, appServer) {
    const pidsPath = join(runDir, 'sidecar-pids.txt');
    if (existsSync(pidsPath)) {
        for (const line of readFileSync(pidsPath, 'utf8').split(/\r?\n/)) {
            const pid = Number(line.trim());
            if (Number.isFinite(pid) && pid > 0) {
                try {
                    process.kill(pid, 'SIGTERM');
                }
                catch { /* already gone */ }
            }
        }
    }
    try {
        appServer.kill('SIGTERM');
    }
    catch { /* already gone */ }
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function appendLauncherLog(runDir, message) {
    appendFileSync(join(runDir, 'launcher.log'), `${new Date().toISOString()} ${message}\n`);
}
