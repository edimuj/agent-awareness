/**
 * Background ticker daemon (standalone).
 *
 * Optional — only needed when MCP server is not running.
 * Runs gather() on schedule, caches text results.
 * Exits cleanly on SIGTERM.
 *
 * Usage: node src/daemon/ticker.ts <provider>
 */
import { setupTicker, tick } from "./tick-loop.js";
import { writeTickerPid } from "../core/state.js";
const provider = process.argv[2] ?? 'claude-code';
async function main() {
    const setup = await setupTicker(provider);
    if (!setup) {
        process.exit(0);
    }
    const { registry, schedules, tickMs, context } = setup;
    if (process.pid) {
        await writeTickerPid(process.pid);
    }
    await tick(registry, schedules, context);
    const timer = setInterval(() => tick(registry, schedules, context), tickMs);
    process.on('SIGTERM', () => {
        clearInterval(timer);
        process.exit(0);
    });
    process.on('SIGINT', () => {
        clearInterval(timer);
        process.exit(0);
    });
}
main();
