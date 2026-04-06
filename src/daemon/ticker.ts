/**
 * Background ticker daemon (standalone).
 *
 * Spawned at session start when any plugin uses interval:* triggers
 * and the MCP server is not handling ticks. Runs gather() on schedule,
 * caches text results for the prompt hook to read. Exits cleanly on SIGTERM.
 *
 * Usage: node src/daemon/ticker.ts <provider>
 */

import { setupTicker, tick } from './tick-loop.ts';
import { writeTickerPid, writeTickerOwner } from '../core/state.ts';

const provider = process.argv[2] ?? 'claude-code';

async function main(): Promise<void> {
  const setup = await setupTicker(provider);

  if (!setup) {
    process.exit(0); // nothing to tick
  }

  const { registry, schedules, tickMs, context } = setup;

  if (process.pid) {
    await writeTickerPid(process.pid);
    await writeTickerOwner('daemon');
  }

  // Initial gather
  await tick(registry, schedules, context);

  const timer = setInterval(() => tick(registry, schedules, context), tickMs);

  // Clean shutdown
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
