import { appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from "./state.js";
const MAX_LOG_SIZE = 256 * 1024; // 256 KB — rotate when exceeded
function getLogFile() {
    if (!STATE_DIR)
        throw new Error('STATE_DIR not initialized — call initStateDir() first');
    return join(STATE_DIR, 'agent-awareness.log');
}
/** Append a timestamped line to the log file. */
export async function logToFile(message) {
    const logFile = getLogFile();
    await mkdir(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19);
    await appendFile(logFile, `${ts} ${message}\n`);
}
/** Rotate log if over size limit. Keeps one previous (.1) file. */
export async function rotateLogIfNeeded() {
    const logFile = getLogFile();
    try {
        const s = await stat(logFile);
        if (s.size > MAX_LOG_SIZE) {
            await rename(logFile, logFile + '.1');
        }
    }
    catch { /* file doesn't exist yet — nothing to rotate */ }
}
/** Open a file descriptor for the log (for spawn stdio redirect). Caller must closeSync(fd). */
export function openLogFd() {
    mkdirSync(STATE_DIR, { recursive: true });
    return openSync(getLogFile(), 'a');
}
