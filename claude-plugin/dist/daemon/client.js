/**
 * Daemon client — used by hooks and MCP server to connect to the central daemon.
 *
 * ensureServer() — check PID, ping /health, spawn daemon if not running
 * gatherFromDaemon() — POST /gather for hooks
 * connectSSE() — GET /events for MCP server channel forwarding
 */
import { request } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DAEMON_DIR = join(homedir(), '.cache', 'agent-awareness');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const SERVER_SCRIPT = join(__dirname, 'server.ts');
function getInstalledVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
        return pkg.version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
// Also check for compiled version (when running from dist/)
function getServerScript() {
    // Prefer .js (compiled) if it exists, fallback to .ts (dev)
    const jsPath = SERVER_SCRIPT.replace(/\.ts$/, '.js');
    if (existsSync(jsPath))
        return jsPath;
    return SERVER_SCRIPT;
}
/**
 * Read PID file and return daemon info, or null if not found/invalid.
 */
function readPidFile() {
    if (!existsSync(PID_FILE))
        return null;
    try {
        return JSON.parse(readFileSync(PID_FILE, 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * Ping daemon /health endpoint. Returns true if responsive.
 */
async function ping(host, port) {
    return new Promise(resolve => {
        const req = request({ host, port, path: '/health', method: 'GET', timeout: 2000 }, res => {
            resolve(res.statusCode === 200);
            res.resume(); // drain
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
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
async function killProcess(pid, timeoutMs = 2000) {
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch {
        return;
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isAlive(pid))
            return;
        await new Promise(r => setTimeout(r, 100));
    }
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch { /* already dead */ }
    await new Promise(r => setTimeout(r, 100));
}
/**
 * Spawn the daemon process in the background.
 */
function spawnDaemon() {
    const script = getServerScript();
    const child = spawn('node', [script], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
    });
    child.unref();
}
/**
 * Wait for daemon to become responsive (PID file + health check).
 */
async function waitForReady(maxWaitMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const info = readPidFile();
        if (info && await ping(info.host, info.port)) {
            return info;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    return null;
}
/**
 * Ensure the daemon is running. Starts it if needed.
 * Returns connection info { host, port } or null on failure.
 */
export async function ensureServer() {
    const info = readPidFile();
    if (info) {
        if (!isAlive(info.pid)) {
            try {
                unlinkSync(PID_FILE);
            }
            catch { /* ignore */ }
            return ensureServer();
        }
        // Check version or script mismatch (plugin was updated)
        const currentScript = getServerScript();
        const currentVersion = getInstalledVersion();
        const stale = info.serverScript !== currentScript
            || (currentVersion !== '0.0.0' && info.version !== currentVersion);
        if (stale) {
            await killProcess(info.pid);
            try {
                unlinkSync(PID_FILE);
            }
            catch { /* ignore */ }
            return ensureServer();
        }
        // Verify responsive
        if (await ping(info.host, info.port)) {
            return info;
        }
        // Not responsive — kill and restart
        await killProcess(info.pid);
        try {
            unlinkSync(PID_FILE);
        }
        catch { /* ignore */ }
    }
    // Spawn new daemon
    spawnDaemon();
    return waitForReady();
}
/**
 * POST /gather — request plugin output for a trigger. Used by hooks.
 */
export async function gatherFromDaemon(info, trigger, cwd) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ trigger, cwd: cwd ?? process.cwd() });
        const req = request({
            host: info.host,
            port: info.port,
            path: '/gather',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 15_000,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve(data.text ?? '');
                }
                catch {
                    resolve('');
                }
            });
        });
        req.on('error', err => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('daemon gather timeout')); });
        req.write(body);
        req.end();
    });
}
/**
 * GET /events — connect to daemon SSE stream. Used by MCP server.
 * Returns the HTTP response for streaming, or null on failure.
 *
 * Events arrive as:
 *   event: plugin-result
 *   data: {"plugin":"name","text":"...","timestamp":"..."}
 */
export async function connectSSE(info, sessionId) {
    return new Promise(resolve => {
        const req = request({
            host: info.host,
            port: info.port,
            path: `/events?sessionId=${encodeURIComponent(sessionId)}`,
            method: 'GET',
            timeout: 0, // no timeout for SSE
            headers: { Accept: 'text/event-stream', Connection: 'keep-alive' },
        }, res => {
            // Prevent Node from closing the socket due to inactivity
            res.socket?.setKeepAlive(true, 30_000);
            res.socket?.setTimeout(0);
            if (res.statusCode === 200) {
                resolve(res);
            }
            else {
                res.resume();
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}
/**
 * GET /doctor — get diagnostic output from daemon.
 */
export async function getDoctorFromDaemon(info) {
    return new Promise((resolve, reject) => {
        const req = request({
            host: info.host,
            port: info.port,
            path: '/doctor',
            method: 'GET',
            timeout: 10_000,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve(data.text ?? 'no output');
                }
                catch {
                    resolve('failed to parse daemon response');
                }
            });
        });
        req.on('error', err => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('daemon doctor timeout')); });
        req.end();
    });
}
