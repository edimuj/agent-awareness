/**
 * Daemon client — used by hooks and MCP server to connect to the central daemon.
 *
 * ensureServer() — check PID, ping /health, spawn daemon if not running
 * gatherFromDaemon() — POST /gather for hooks
 * connectSSE() — GET /events for MCP server channel forwarding
 */

import { request, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DAEMON_DIR = join(homedir(), '.cache', 'agent-awareness');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const SPAWN_LOCK = join(DAEMON_DIR, 'spawn.lock');
const SERVER_SCRIPT = join(__dirname, 'server.ts');

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Also check for compiled version (when running from dist/)
function getServerScript(): string {
  // Prefer .js (compiled) if it exists, fallback to .ts (dev)
  const jsPath = SERVER_SCRIPT.replace(/\.ts$/, '.js');
  if (existsSync(jsPath)) return jsPath;
  return SERVER_SCRIPT;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  serverScript: string;
  version: string;
}

export type SessionLifecycleStatus = 'online' | 'busy' | 'idle' | 'unknown' | 'offline';

export interface SessionStatusUpdate {
  sessionId: string;
  provider?: string;
  status?: SessionLifecycleStatus;
  reason?: string;
}

/**
 * Read PID file and return daemon info, or null if not found/invalid.
 */
function readPidFile(): DaemonInfo | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Ping daemon /health endpoint. Returns true if responsive.
 */
async function ping(host: string, port: number): Promise<boolean> {
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killProcess(pid: number, timeoutMs = 2000): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  await new Promise(r => setTimeout(r, 100));
}

/**
 * Spawn the daemon process in the background.
 */
function spawnDaemon(): void {
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
async function waitForReady(maxWaitMs = 5000): Promise<DaemonInfo | null> {
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
 * Acquire a spawn lock (mkdir-based). Returns true if acquired.
 */
async function acquireSpawnLock(): Promise<boolean> {
  try {
    await mkdir(DAEMON_DIR, { recursive: true });
    await mkdir(SPAWN_LOCK);
    await writeFile(join(SPAWN_LOCK, 'meta.json'),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if lock is stale (holder dead or lock older than 15s)
      try {
        const meta = JSON.parse(await readFile(join(SPAWN_LOCK, 'meta.json'), 'utf8'));
        const age = Date.now() - new Date(meta.createdAt).getTime();
        const holderAlive = isAlive(meta.pid);
        if (!holderAlive || age > 15_000) {
          await rm(SPAWN_LOCK, { recursive: true, force: true });
          return acquireSpawnLock();
        }
      } catch {
        // Can't read meta — break stale lock
        await rm(SPAWN_LOCK, { recursive: true, force: true });
        return acquireSpawnLock();
      }
      return false;
    }
    throw err;
  }
}

async function releaseSpawnLock(): Promise<void> {
  await rm(SPAWN_LOCK, { recursive: true, force: true });
}

/**
 * Ensure the daemon is running. Starts it if needed.
 * Returns connection info { host, port } or null on failure.
 */
export async function ensureServer(): Promise<DaemonInfo | null> {
  const info = readPidFile();

  if (info) {
    if (!isAlive(info.pid)) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return ensureServer();
    }

    // Check version mismatch (plugin was updated)
    const currentVersion = getInstalledVersion();
    if (currentVersion !== '0.0.0' && info.version !== currentVersion) {
      await killProcess(info.pid);
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return ensureServer();
    }

    // Verify responsive
    if (await ping(info.host, info.port)) {
      return info;
    }

    // Not responsive — kill and restart
    await killProcess(info.pid);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // Spawn new daemon — acquire lock to prevent concurrent starts
  if (!await acquireSpawnLock()) {
    // Another process is spawning — just wait for it
    return waitForReady();
  }
  try {
    spawnDaemon();
    return await waitForReady();
  } finally {
    await releaseSpawnLock();
  }
}

/**
 * POST /gather — request plugin output for a trigger. Used by hooks.
 */
export async function gatherFromDaemon(
  info: DaemonInfo,
  trigger: string,
  cwd?: string,
  session?: SessionStatusUpdate,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      trigger,
      cwd: cwd ?? process.cwd(),
      sessionId: session?.sessionId,
      provider: session?.provider,
      status: session?.status,
    });
    const req = request({
      host: info.host,
      port: info.port,
      path: '/gather',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15_000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data.text ?? '');
        } catch {
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

export async function registerSessionStatus(
  info: DaemonInfo,
  update: SessionStatusUpdate,
): Promise<void> {
  if (!update.sessionId) return;
  await postSessionEvent(info, '/session/register', update);
}

export async function unregisterSessionStatus(
  info: DaemonInfo,
  update: SessionStatusUpdate,
): Promise<void> {
  if (!update.sessionId) return;
  await postSessionEvent(info, '/session/unregister', update);
}

async function postSessionEvent(
  info: DaemonInfo,
  path: '/session/register' | '/session/unregister',
  update: SessionStatusUpdate,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(update);
    const req = request({
      host: info.host,
      port: info.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, res => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`${path} failed with status ${res.statusCode ?? 0}`));
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${path} timeout`)); });
    req.write(body);
    req.end();
  });
}

/**
 * POST /reload — tell the daemon to re-discover and re-import all plugins.
 * Returns { ok, loaded, errors } or null if no daemon is running.
 */
export async function reloadDaemon(): Promise<{ ok: boolean; loaded: string[]; errors: string[] } | null> {
  const info = readPidFile();
  if (!info) return null;
  if (!isAlive(info.pid)) return null;

  return new Promise((resolve, reject) => {
    const req = request({
      host: info.host,
      port: info.port,
      path: '/reload',
      method: 'POST',
      timeout: 10_000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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
export async function connectSSE(
  info: DaemonInfo,
  sessionId: string,
  provider?: string,
): Promise<IncomingMessage | null> {
  return new Promise(resolve => {
    const params = new URLSearchParams({ sessionId });
    if (provider) params.set('provider', provider);
    const req = request({
      host: info.host,
      port: info.port,
      path: `/events?${params.toString()}`,
      method: 'GET',
      timeout: 0, // no timeout for SSE
      headers: { Accept: 'text/event-stream', Connection: 'keep-alive' },
    }, res => {
      // Prevent Node from closing the socket due to inactivity
      res.socket?.setKeepAlive(true, 30_000);
      res.socket?.setTimeout(0);
      if (res.statusCode === 200) {
        resolve(res);
      } else {
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
export async function getDoctorFromDaemon(info: DaemonInfo): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: info.host,
      port: info.port,
      path: '/doctor',
      method: 'GET',
      timeout: 10_000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data.text ?? 'no output');
        } catch {
          resolve('failed to parse daemon response');
        }
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('daemon doctor timeout')); });
    req.end();
  });
}
