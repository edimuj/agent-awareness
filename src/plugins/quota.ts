import type { AwarenessPlugin, PluginConfig, Trigger } from '../core/types.ts';

export default {
  name: 'quota',
  description: 'Session duration, usage window awareness, conservation signals',

  triggers: ['session-start', 'prompt', 'interval:10m'],

  defaults: {
    plan: 'claude-max',
    windowHours: 5,
    triggers: {
      'session-start': true,
      'interval:10m': true,
    },
  },

  gather(_trigger: Trigger, config: PluginConfig, prevState) {
    const now = new Date();
    const sessionStart = (prevState?.sessionStart as string) ?? now.toISOString();
    const elapsedMs = now.getTime() - new Date(sessionStart).getTime();
    const elapsedMin = Math.round(elapsedMs / 60_000);
    const windowHours = (config.windowHours as number) ?? 5;
    const windowMin = windowHours * 60;
    const pct = Math.min(100, Math.round((elapsedMin / windowMin) * 100));

    // Conservation signals at thresholds
    let signal = '';
    if (pct >= 80) signal = ' ⚠️ CONSERVE';
    else if (pct >= 60) signal = ' — consider delegating';

    const elapsedStr = elapsedMin < 60
      ? `${elapsedMin}min`
      : `${Math.floor(elapsedMin / 60)}h${String(elapsedMin % 60).padStart(2, '0')}min`;

    return {
      text: `📊 Session: ${elapsedStr} | ~${pct}% of ${windowHours}h window${signal}`,
      state: { sessionStart, lastCheck: now.toISOString() },
    };
  },
} satisfies AwarenessPlugin;
