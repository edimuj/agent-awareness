import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from '../core/types.ts';

export default {
  name: 'time-date',
  description: 'Current time, date, day of week, week number, business hours',

  triggers: ['session-start', 'prompt', 'change:hour', 'change:day'],

  defaults: {
    timezone: 'auto',
    locale: 'auto',
    showTime: true,
    showTimezone: true,
    showDay: true,
    showDate: true,
    showWeekNumber: true,
    showBusinessHours: true,
    businessHours: { start: 9, end: 17 },
    // Labels can be customized per use case
    labels: {
      businessHours: 'Business hours',
      afterHours: 'After hours',
      weekend: 'Weekend',
    },
    triggers: {
      'session-start': 'full',
      'change:hour': 'compact',
    },
  },

  gather(trigger: Trigger, config: PluginConfig, _prevState, _context: GatherContext) {
    const now = new Date();
    const tz = resolveTimezone(config.timezone as string);
    const labels = (config.labels as Record<string, string>) ?? {};

    const hour = parseInt(now.toLocaleTimeString('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }));

    const state = {
      lastHour: hour,
      lastDay: now.toISOString().slice(0, 10),
    };

    // Determine output mode from trigger config
    const mode = typeof config.triggers?.[trigger] === 'string'
      ? config.triggers[trigger] : 'full';

    // Build parts based on what's enabled
    const parts: string[] = [];

    // Time + timezone
    if (config.showTime !== false) {
      const timeStr = now.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      if (config.showTimezone !== false) {
        parts.push(`${timeStr} ${getTimezoneAbbr(now, tz)}`);
      } else {
        parts.push(timeStr);
      }
    }

    // Day name
    if (config.showDay !== false) {
      parts.push(now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }));
    }

    // Compact mode stops here
    if (mode === 'compact') {
      return { text: parts.join(' '), state };
    }

    // Date
    if (config.showDate !== false) {
      parts.push(now.toLocaleDateString('en-GB', {
        timeZone: tz, day: 'numeric', month: 'short', year: 'numeric',
      }));
    }

    // Separator between inline parts and pipe-delimited sections
    const sections: string[] = [parts.join(' ')];

    // Week number
    if (config.showWeekNumber !== false) {
      sections.push(`Week ${getWeekNumber(now)}`);
    }

    // Business hours
    if (config.showBusinessHours !== false) {
      const bh = (config.businessHours as { start: number; end: number }) ?? { start: 9, end: 17 };
      const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const dayOfWeek = localDate.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
      const isBusinessHours = isWeekday && hour >= bh.start && hour < bh.end;
      const hoursLabel = isBusinessHours
        ? (labels.businessHours ?? 'Business hours')
        : isWeekday
          ? (labels.afterHours ?? 'After hours')
          : (labels.weekend ?? 'Weekend');
      sections.push(hoursLabel);
    }

    return { text: sections.join(' | '), state };
  },
} satisfies AwarenessPlugin;

function resolveTimezone(tz: string | undefined): string {
  if (!tz || tz === 'auto') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return tz;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

// Intl gives 'GMT+1' for Europe/Stockholm — map to conventional abbreviations
const TZ_ABBR_MAP: Record<string, { standard: string; daylight: string }> = {
  'Europe/Stockholm': { standard: 'CET', daylight: 'CEST' },
  'Europe/Berlin': { standard: 'CET', daylight: 'CEST' },
  'Europe/Paris': { standard: 'CET', daylight: 'CEST' },
  'Europe/London': { standard: 'GMT', daylight: 'BST' },
  'America/New_York': { standard: 'EST', daylight: 'EDT' },
  'America/Chicago': { standard: 'CST', daylight: 'CDT' },
  'America/Los_Angeles': { standard: 'PST', daylight: 'PDT' },
};

function getTimezoneAbbr(date: Date, tz: string): string {
  const mapped = TZ_ABBR_MAP[tz];
  if (mapped) {
    const jan = new Date(date.getFullYear(), 0, 1);
    const janOffset = new Date(jan.toLocaleString('en-US', { timeZone: tz })).getTime() - jan.getTime();
    const nowOffset = new Date(date.toLocaleString('en-US', { timeZone: tz })).getTime() - date.getTime();
    return nowOffset > janOffset ? mapped.daylight : mapped.standard;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(date);
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}
