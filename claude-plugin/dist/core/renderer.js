/**
 * Combines multiple plugin gather results into a single compact block.
 *
 * Output example:
 *   [agent-awareness]
 *   14:32 CET Wed 25 Mar 2026 | Week 13 | Business hours
 *   Session: 38min | 5h: 12% (↻4h22m) | 7d: 31%
 *   Disk: 67% | Mem: 4.2G free | Load: 1.2
 *   Weather Stockholm: 7°C, overcast | Wind: 24km/h | Sunset: 18:13
 */
export function render(gatherResults) {
    const lines = gatherResults
        .map(r => r.text)
        .filter(Boolean);
    if (lines.length === 0)
        return '';
    return `[agent-awareness]\n${lines.join('\n')}`;
}
