import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from "../providers/codex/adapter.js";
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
function readInput() {
    if (process.stdin.isTTY)
        return {};
    try {
        const raw = readFileSync(0, 'utf8');
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return {};
    }
}
function formatForHookContext(text) {
    return text
        .split(/\r?\n+/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(' || ');
}
function pickThreadId(input) {
    const candidates = [
        input.thread_id,
        input.threadId,
        input.thread?.id,
        input.session_id,
        input.sessionId,
        input.session?.id,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return '';
}
function sanitize(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'session';
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
function writeHandshake(runtimeDir, payload) {
    writeFileSync(join(runtimeDir, 'session-start-handshake.json'), `${JSON.stringify(payload, null, 2)}\n`);
}
function existingAlivePid(pidPath) {
    if (!existsSync(pidPath))
        return null;
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (!Number.isFinite(pid) || !isAlive(pid))
        return null;
    return pid;
}
function resolveSidecarScript() {
    const dist = join(PROJECT_ROOT, 'dist', 'providers', 'codex', 'live-sidecar.js');
    if (existsSync(dist))
        return dist;
    return join(PROJECT_ROOT, 'src', 'providers', 'codex', 'live-sidecar.ts');
}
function maybeStartLiveSidecar(input) {
    if (process.env.AGENT_AWARENESS_CODEX_LIVE !== '1')
        return '';
    const appServerUrl = process.env.CODEX_APP_SERVER_URL;
    const runId = process.env.AGENT_AWARENESS_CODEX_LIVE_RUN_ID;
    const runtimeDir = process.env.AGENT_AWARENESS_CODEX_LIVE_RUNTIME_DIR;
    if (!appServerUrl || !runId || !runtimeDir)
        return '';
    const cwd = input.cwd || process.env.AGENT_AWARENESS_CODEX_CWD || process.cwd();
    const threadId = pickThreadId(input);
    const sessionKey = sanitize(threadId || 'auto');
    const sessionDir = join(runtimeDir, sessionKey);
    const pidPath = join(sessionDir, 'sidecar.pid');
    const statePath = join(sessionDir, 'live-state.json');
    const logPath = join(sessionDir, 'sidecar.log');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    const autoPidPath = join(runtimeDir, 'auto', 'sidecar.pid');
    const activePid = existingAlivePid(pidPath) ?? (threadId ? existingAlivePid(autoPidPath) : null);
    if (activePid !== null) {
        writeHandshake(runtimeDir, {
            status: 'ok',
            code: 'HOOK_SIDECAR_REUSED',
            message: `using existing sidecar pid ${activePid}`,
            pid: activePid,
            threadId: threadId || undefined,
            timestamp: new Date().toISOString(),
        });
        return `Agent Awareness live sidecar already running (pid ${activePid}).`;
    }
    try {
        const sidecarEnv = {
            ...process.env,
            CODEX_APP_SERVER_URL: appServerUrl,
            CODEX_THREAD_MODE: threadId ? 'resume' : 'auto',
            CODEX_THREAD_ID: threadId || undefined,
            CODEX_MODEL: input.model || process.env.CODEX_MODEL || '',
            AGENT_AWARENESS_CODEX_CWD: cwd,
            AGENT_AWARENESS_CODEX_SESSION_ID: threadId || `codex-live-${runId}`,
            AGENT_AWARENESS_CODEX_LIVE_STATE_PATH: statePath,
        };
        if (!threadId)
            delete sidecarEnv.CODEX_THREAD_ID;
        const out = openSync(logPath, 'a');
        const err = openSync(logPath, 'a');
        const sidecar = spawn(process.execPath, [resolveSidecarScript()], {
            env: sidecarEnv,
            detached: true,
            stdio: ['ignore', out, err],
        });
        sidecar.unref();
        writeFileSync(pidPath, String(sidecar.pid));
        appendFileSync(join(runtimeDir, 'sidecar-pids.txt'), `${sidecar.pid}\n`);
        writeHandshake(runtimeDir, {
            status: 'ok',
            code: 'HOOK_SIDECAR_STARTED',
            message: `spawned sidecar pid ${sidecar.pid}`,
            pid: sidecar.pid,
            threadId: threadId || undefined,
            timestamp: new Date().toISOString(),
        });
        return `Agent Awareness live sidecar started (pid ${sidecar.pid}). Realtime context updates will arrive as live Codex turns.`;
    }
    catch (error) {
        writeHandshake(runtimeDir, {
            status: 'error',
            code: 'HOOK_SIDECAR_SPAWN_FAILED',
            message: error instanceof Error ? error.message : String(error),
            threadId: threadId || undefined,
            timestamp: new Date().toISOString(),
        });
        return `Agent Awareness live sidecar failed to start: ${error instanceof Error ? error.message : String(error)}`;
    }
}
const input = readInput();
const output = await run('session-start');
const liveOutput = maybeStartLiveSidecar(input);
const parts = [output, liveOutput].filter(Boolean).map(formatForHookContext);
if (parts.length > 0) {
    process.stdout.write(JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: parts.join(' || '),
        },
    }));
}
