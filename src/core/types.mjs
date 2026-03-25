/**
 * Awareness plugin interface.
 *
 * Every awareness plugin exports an object conforming to this shape.
 * Plugins are provider-agnostic — they gather data and render it.
 * The provider adapter decides when/how to inject.
 *
 * Supported trigger types:
 *   'session-start'  — Fires once when the agent session begins
 *   'prompt'         — Fires on every user prompt submission
 *   'change:hour'    — Fires when the hour has changed since last check
 *   'change:day'     — Fires when the date has changed since last check
 *   'interval:Nm'    — Fires every N minutes (e.g., 'interval:10m')
 *
 * @typedef {'session-start' | 'prompt' | `change:${string}` | `interval:${string}`} Trigger
 *
 * @typedef {Object} GatherResult
 * @property {string} text - Compact rendered output for context injection
 * @property {Object} [state] - State to persist for change detection
 *
 * @typedef {Object} AwarenessPlugin
 * @property {string} name - Unique plugin identifier
 * @property {string} description - What this plugin provides
 * @property {Trigger[]} triggers - Supported trigger types
 * @property {Object} defaults - Default configuration
 * @property {(trigger: Trigger, config: Object, prevState: Object|null) => GatherResult|Promise<GatherResult>} gather
 */

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
  if (!match) return null;
  const [, n, unit] = match;
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000 };
  return parseInt(n) * multipliers[unit];
}
