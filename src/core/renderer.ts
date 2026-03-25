import type { GatherResult } from './types.ts';

/**
 * Combines multiple plugin gather results into a single compact block.
 *
 * Output example:
 *   [agent-awareness]
 *   🕐 14:32 CET Wed 25 Mar 2026 | Week 13 | Business hours
 *   📊 Session: 38min | ~12% of 5h window
 *   💻 Disk: 67% | Mem: 4.2G free | Load: 1.2
 */
export function render(gatherResults: GatherResult[]): string {
  const lines = gatherResults
    .map(r => r.text)
    .filter(Boolean);

  if (lines.length === 0) return '';

  return `[agent-awareness]\n${lines.join('\n')}`;
}
