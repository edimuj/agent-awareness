export const TRIGGERS = {
    SESSION_START: 'session-start',
    PROMPT: 'prompt',
    CHANGE_HOUR: 'change:hour',
    CHANGE_DAY: 'change:day',
};
/**
 * Parse an interval trigger string like 'interval:10m' into milliseconds.
 * Supports s (seconds), m (minutes), h (hours).
 */
export function parseInterval(trigger) {
    const match = trigger.match(/^interval:(\d+)([smh])$/);
    if (!match)
        return null;
    const [, n, unit] = match;
    const value = parseInt(n, 10);
    if (value <= 0)
        return null;
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000 };
    return value * multipliers[unit];
}
