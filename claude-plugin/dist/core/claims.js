/**
 * Event claiming system for multi-agent coordination.
 *
 * When multiple agent sessions run concurrently (e.g., different claude-rig
 * setups), they all receive the same plugin notifications. Notifications are
 * fine — but when a plugin's autonomy level says "act", only ONE agent should
 * act. Claims prevent duplicate work.
 *
 * Design:
 *   ~/.cache/agent-awareness/claims/<plugin>/<event-key>.json
 *   Each claim file contains: { holder, pid, claimedAt, expiresAt }
 *   Claim access is serialized per event via lock directories:
 *   <event-key>.json.lock (atomic mkdir + stale-lock cleanup)
 *   Expired or dead-PID claims are auto-cleaned on access
 *
 * Plugins call context.claims.tryClaimEvent(key) before rendering "act"-level
 * directives. If claimed by another session, downgrade to "notify".
 */
import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { STATE_DIR } from "./state.js";
function getClaimsDir() {
    if (!STATE_DIR)
        throw new Error('STATE_DIR not initialized — call initStateDir() first');
    return join(STATE_DIR, 'claims');
}
/** Default claim TTL: 30 minutes. */
const DEFAULT_TTL_MS = 30 * 60_000;
const CLAIM_LOCK_STALE_MS = 10_000;
const CLAIM_LOCK_RETRY_MS = 20;
const CLAIM_LOCK_MAX_WAIT_MS = 5_000;
function holder() {
    return `${hostname()}:${process.pid}`;
}
function claimDir(pluginName) {
    return join(getClaimsDir(), pluginName);
}
function claimFile(pluginName, eventKey) {
    // Sanitize eventKey for filesystem: replace / and # with _
    const safe = eventKey.replace(/[/\\#:]/g, '_');
    return join(claimDir(pluginName), `${safe}.json`);
}
function claimLockDir(path) {
    return `${path}.lock`;
}
async function readClaim(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return null;
    }
}
async function readClaimLockMeta(path) {
    try {
        return JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
function isExpired(claim) {
    return Date.now() > new Date(claim.expiresAt).getTime();
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
function isHolderAlive(claim) {
    // Only check PID if same host
    if (!claim.holder.startsWith(hostname() + ':'))
        return true; // assume remote is alive
    return isPidAlive(claim.pid);
}
function isOurs(claim) {
    return claim.holder === holder();
}
async function writeClaim(path, ttlMs) {
    const now = new Date();
    const info = {
        holder: holder(),
        pid: process.pid,
        claimedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(info, null, 2) + '\n');
}
async function tryAcquireClaimLock(path) {
    const lockDirPath = claimLockDir(path);
    try {
        await mkdir(dirname(path), { recursive: true });
        await mkdir(lockDirPath);
        const meta = { pid: process.pid, createdAt: new Date().toISOString() };
        await writeFile(join(lockDirPath, 'meta.json'), JSON.stringify(meta) + '\n');
        return true;
    }
    catch (err) {
        if (err.code === 'EEXIST')
            return false;
        throw err;
    }
}
async function releaseClaimLock(path) {
    await rm(claimLockDir(path), { recursive: true, force: true });
}
async function isClaimLockStale(lockDirPath) {
    const meta = await readClaimLockMeta(lockDirPath);
    if (!meta) {
        const info = await stat(lockDirPath).catch(() => null);
        if (!info)
            return true;
        return Date.now() - info.mtimeMs > CLAIM_LOCK_STALE_MS;
    }
    if (!isPidAlive(meta.pid))
        return true;
    return Date.now() - Date.parse(meta.createdAt) > CLAIM_LOCK_STALE_MS;
}
async function withClaimLock(path, fn) {
    const lockDirPath = claimLockDir(path);
    const deadline = Date.now() + CLAIM_LOCK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        if (await tryAcquireClaimLock(path)) {
            try {
                return await fn();
            }
            finally {
                await releaseClaimLock(path);
            }
        }
        if (await isClaimLockStale(lockDirPath)) {
            await releaseClaimLock(path);
            continue;
        }
        await new Promise(resolve => setTimeout(resolve, CLAIM_LOCK_RETRY_MS));
    }
    console.error('[agent-awareness] claim lock timeout - force-breaking stale lock');
    await releaseClaimLock(path);
    if (await tryAcquireClaimLock(path)) {
        try {
            return await fn();
        }
        finally {
            await releaseClaimLock(path);
        }
    }
    throw new Error('failed to acquire claim lock');
}
/**
 * Create a ClaimContext scoped to a specific plugin.
 */
export function createClaimContext(pluginName) {
    return {
        async tryClaim(eventKey, ttlMinutes) {
            const path = claimFile(pluginName, eventKey);
            const ttlMs = (ttlMinutes ?? (DEFAULT_TTL_MS / 60_000)) * 60_000;
            return withClaimLock(path, async () => {
                const existing = await readClaim(path);
                if (existing) {
                    // We already own it — refresh the TTL
                    if (isOurs(existing)) {
                        await writeClaim(path, ttlMs);
                        return { claimed: true };
                    }
                    // Expired or holder dead — reclaim
                    if (isExpired(existing) || !isHolderAlive(existing)) {
                        await writeClaim(path, ttlMs);
                        return { claimed: true };
                    }
                    // Held by another live session
                    return { claimed: false, holder: existing.holder };
                }
                // No existing claim — take it
                await writeClaim(path, ttlMs);
                return { claimed: true };
            });
        },
        async isClaimedByOther(eventKey) {
            const path = claimFile(pluginName, eventKey);
            return withClaimLock(path, async () => {
                const existing = await readClaim(path);
                if (!existing)
                    return false;
                if (isOurs(existing))
                    return false;
                if (isExpired(existing) || !isHolderAlive(existing)) {
                    await rm(path, { force: true });
                    return false;
                }
                return true;
            });
        },
        async release(eventKey) {
            const path = claimFile(pluginName, eventKey);
            await withClaimLock(path, async () => {
                const existing = await readClaim(path);
                // Only release our own claims
                if (existing && isOurs(existing)) {
                    await rm(path, { force: true });
                }
            });
        },
    };
}
/**
 * Clean up all expired or dead-holder claims.
 * Called periodically (e.g., at session start).
 */
export async function pruneExpiredClaims() {
    let pruned = 0;
    let pluginDirs;
    try {
        pluginDirs = await readdir(getClaimsDir());
    }
    catch {
        return 0; // no claims dir yet
    }
    for (const dir of pluginDirs) {
        const dirPath = join(getClaimsDir(), dir);
        let files;
        try {
            files = await readdir(dirPath);
        }
        catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith('.json'))
                continue;
            const path = join(dirPath, file);
            const claim = await readClaim(path);
            if (claim && (isExpired(claim) || !isHolderAlive(claim))) {
                await rm(path, { force: true });
                pruned++;
            }
        }
    }
    return pruned;
}
