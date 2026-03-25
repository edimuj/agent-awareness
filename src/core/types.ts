/**
 * Trigger types that control when a plugin fires.
 *
 *   'session-start'  — Once when the agent session begins
 *   'prompt'         — Every user prompt submission
 *   'change:hour'    — When the hour has changed since last check
 *   'change:day'     — When the date has changed since last check
 *   'interval:Nm'    — Every N minutes (e.g., 'interval:10m')
 */
export type Trigger =
  | 'session-start'
  | 'prompt'
  | `change:${string}`
  | `interval:${string}`;

/** Result returned by a plugin's gather function. */
export interface GatherResult {
  /** Compact rendered output for context injection. */
  text: string;
  /** State to persist for change detection. */
  state?: Record<string, unknown>;
}

/** Plugin configuration — plugin defaults merged with user overrides. */
export interface PluginConfig {
  enabled?: boolean;
  triggers?: Record<string, boolean | string>;
  [key: string]: unknown;
}

/**
 * Runtime context passed to gather() by the provider adapter.
 * Tells plugins which agent they're running under so they can
 * adapt behavior (e.g., fetch Claude quota vs Codex quota).
 */
export interface GatherContext {
  /** Provider identifier: 'claude-code', 'codex', 'aider', etc. */
  provider: string;
  /** Provider-specific metadata (model, session ID, etc.) */
  [key: string]: unknown;
}

/**
 * The awareness plugin interface.
 *
 * Every awareness plugin — built-in, npm, or local — must conform to this shape.
 * Plugins are provider-agnostic: they gather data and render it as text.
 * The provider adapter decides when and how to inject the output.
 *
 * Lifecycle hooks are optional. Simple plugins only need name + gather.
 * Advanced plugins (daemons, external services) use lifecycle hooks
 * to manage resources that outlive a single gather() call.
 */
export interface AwarenessPlugin {
  /** Unique plugin identifier (e.g., 'time-date', 'weather'). */
  name: string;
  /** Human-readable description of what this plugin provides. */
  description: string;
  /** Trigger types this plugin supports. */
  triggers: Trigger[];
  /** Default configuration values. */
  defaults: PluginConfig;
  /** Gather awareness data for the given trigger. */
  gather(
    trigger: Trigger,
    config: PluginConfig,
    prevState: Record<string, unknown> | null,
    context: GatherContext,
  ): GatherResult | null | Promise<GatherResult | null>;

  // --- Lifecycle hooks (all optional) ---

  /** First-time setup: create directories, download resources, validate dependencies. */
  onInstall?(): Promise<void> | void;
  /** Cleanup: remove caches, state files, stop daemons, free resources. */
  onUninstall?(): Promise<void> | void;
  /** Session start: spawn daemons, connect to services, warm caches. */
  onStart?(): Promise<void> | void;
  /** Session end: graceful shutdown, flush buffers, kill child processes. */
  onStop?(): Promise<void> | void;
}

/** Persisted state — each plugin gets its own namespace. */
export interface PluginState {
  [pluginName: string]: Record<string, unknown> & { _updatedAt?: string };
}

export const TRIGGERS = {
  SESSION_START: 'session-start' as const,
  PROMPT: 'prompt' as const,
  CHANGE_HOUR: 'change:hour' as const,
  CHANGE_DAY: 'change:day' as const,
};

/**
 * Parse an interval trigger string like 'interval:10m' into milliseconds.
 * Supports s (seconds), m (minutes), h (hours).
 */
export function parseInterval(trigger: string): number | null {
  const match = trigger.match(/^interval:(\d+)([smh])$/);
  if (!match) return null;
  const [, n, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  return parseInt(n!) * multipliers[unit!]!;
}
