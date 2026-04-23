import type { GatherResult } from './types.ts';

export interface RenderOptions {
  showPluginNames?: boolean;
}

/**
 * Combines multiple plugin gather results into a single compact block.
 *
 * With showPluginNames (default):
 *   [agent-awareness]
 *   [time-date] 14:32 CET Wed 25 Mar 2026 | Week 13 | Business hours
 *   [quota] Session: 38min | 5h: 12% (↻4h22m) | 7d: 31%
 *   [server-health] Disk: 67% | Mem: 4.2G free | Load: 1.2
 *
 * Without showPluginNames:
 *   [agent-awareness]
 *   14:32 CET Wed 25 Mar 2026 | Week 13 | Business hours
 *   Session: 38min | 5h: 12% (↻4h22m) | 7d: 31%
 */
export function render(gatherResults: GatherResult[], options?: RenderOptions): string {
  const showNames = options?.showPluginNames !== false;

  const lines = gatherResults
    .map(r => {
      if (!r.text) return '';
      return showNames && r.pluginName ? `[${r.pluginName}] ${r.text}` : r.text;
    })
    .filter(Boolean);

  if (lines.length === 0) return '';

  return `[agent-awareness]\n${lines.join('\n')}`;
}
