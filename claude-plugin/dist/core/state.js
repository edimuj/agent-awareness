import { readFile, writeFile, mkdir, unlink, rename, cp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { withStateLock, setLockDir } from "./lock.js";
const BASE_DIR = join(homedir(), '.cache', 'agent-awareness');
/** Provider-scoped state directory. Must call initStateDir() before using state functions. */
export let STATE_DIR = '';
/**
 * Initialize the state directory for a specific provider.
 * Must be called once at startup before any state operations.
 * Runs one-time migration from old flat layout if needed.
 */
export async function initStateDir(provider) {
    STATE_DIR = join(BASE_DIR, provider);
    setLockDir(join(STATE_DIR, 'state.lock'));
    await mkdir(STATE_DIR, { recursive: true });
    await migrateFromFlatLayout(provider);
}
/**
 * Migrate old flat ~/.cache/agent-awareness/ files into provider subdir.
 * Only runs once — skips if provider dir already has state.json.
 */
async function migrateFromFlatLayout(provider) {
    const providerState = join(STATE_DIR, 'state.json');
    const oldState = join(BASE_DIR, 'state.json');
    // Skip if provider state already exists or old state doesn't
    const [hasNew, hasOld] = await Promise.all([
        access(providerState).then(() => true, () => false),
        access(oldState).then(() => true, () => false),
    ]);
    if (hasNew || !hasOld)
        return;
    // Move files from flat layout to provider subdir
    const filesToMove = ['state.json', 'ticker-cache.json', 'channel-seen.json', 'agent-awareness.log', 'agent-awareness.log.1'];
    for (const file of filesToMove) {
        const src = join(BASE_DIR, file);
        const dst = join(STATE_DIR, file);
        try {
            await rename(src, dst);
        }
        catch { /* file doesn't exist — skip */ }
    }
    // Copy claims directory
    const oldClaims = join(BASE_DIR, 'claims');
    const newClaims = join(STATE_DIR, 'claims');
    try {
        await cp(oldClaims, newClaims, { recursive: true });
        await rm(oldClaims, { recursive: true, force: true });
    }
    catch { /* no claims dir — skip */ }
    // Clean up old ticker files
    for (const file of ['ticker.pid', 'ticker-owner']) {
        try {
            await unlink(join(BASE_DIR, file));
        }
        catch { /* skip */ }
    }
}
// --- Plugin state ---
export async function loadState() {
    try {
        return JSON.parse(await readFile(join(STATE_DIR, 'state.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
export async function saveState(state) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(join(STATE_DIR, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}
export function getPluginState(state, pluginName) {
    return state[pluginName] ?? null;
}
export function setPluginState(state, pluginName, pluginState) {
    return { ...state, [pluginName]: { ...pluginState, _updatedAt: new Date().toISOString() } };
}
/**
 * Atomic read-modify-write for plugin state.
 * Acquires file lock, loads state, calls transform, saves result, releases lock.
 */
export async function withState(fn) {
    return withStateLock(async () => {
        const state = await loadState();
        const updated = await fn(state);
        await saveState(updated);
        return updated;
    });
}
export async function loadTickerCache() {
    try {
        return JSON.parse(await readFile(join(STATE_DIR, 'ticker-cache.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
export async function saveTickerCache(cache) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(join(STATE_DIR, 'ticker-cache.json'), JSON.stringify(cache) + '\n');
}
// --- Ticker PID (MCP server process tracking) ---
export async function writeTickerPid(pid) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(join(STATE_DIR, 'ticker.pid'), String(pid) + '\n');
}
export async function readTickerPid() {
    try {
        const raw = await readFile(join(STATE_DIR, 'ticker.pid'), 'utf8');
        return parseInt(raw.trim()) || null;
    }
    catch {
        return null;
    }
}
export async function clearTickerPid() {
    try {
        await unlink(join(STATE_DIR, 'ticker.pid'));
    }
    catch { /* already gone */ }
}
// --- Channel-seen fingerprints (Tier 2 / MCP dedup) ---
export async function loadChannelSeen() {
    try {
        return JSON.parse(await readFile(join(STATE_DIR, 'channel-seen.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
export async function saveChannelSeen(seen) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(join(STATE_DIR, 'channel-seen.json'), JSON.stringify(seen) + '\n');
}
export async function clearChannelSeen() {
    try {
        await unlink(join(STATE_DIR, 'channel-seen.json'));
    }
    catch { /* already gone */ }
}
