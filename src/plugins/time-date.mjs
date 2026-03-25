/** @type {import('../core/types.mjs').AwarenessPlugin} */
export default {
  name: 'time-date',
  description: 'Current time, date, day of week, week number, business hours',

  triggers: ['session-start', 'prompt', 'change:hour', 'change:day'],

  defaults: {
    timezone: 'auto',
    locale: 'auto',
    businessHours: { start: 9, end: 17 },
    triggers: {
      'session-start': 'full',
      'change:hour': 'compact',
    },
  },

  gather(trigger, config, _prevState) {
    const now = new Date();
    const tz = resolveTimezone(config.timezone);

    const timeStr = now.toLocaleTimeString('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const tzAbbr = getTimezoneAbbr(now, tz);
    const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
    const dateStr = now.toLocaleDateString('en-GB', {
      timeZone: tz, day: 'numeric', month: 'short', year: 'numeric',
    });
    const hour = parseInt(now.toLocaleTimeString('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }));
    const weekNum = getWeekNumber(now);

    // Business hours detection
    const { start, end } = config.businessHours ?? { start: 9, end: 17 };
    const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const dayOfWeek = localDate.getDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isBusinessHours = isWeekday && hour >= start && hour < end;
    const hoursLabel = isBusinessHours ? 'Business hours'
      : isWeekday ? 'After hours' : 'Weekend';

    const state = {
      lastHour: hour,
      lastDay: now.toISOString().slice(0, 10),
    };

    // Determine output mode from trigger config
    const mode = typeof config.triggers?.[trigger] === 'string'
      ? config.triggers[trigger] : 'full';

    if (mode === 'compact') {
      return { text: `🕐 ${timeStr} ${tzAbbr} ${dayName}`, state };
    }

    return {
      text: `🕐 ${timeStr} ${tzAbbr} ${dayName} ${dateStr} | Week ${weekNum} | ${hoursLabel}`,
      state,
    };
  },
};

function resolveTimezone(tz) {
  if (!tz || tz === 'auto') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return tz;
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}

// Intl gives 'GMT+1' for Europe/Stockholm — map to conventional abbreviations
const TZ_ABBR_MAP = {
  'Europe/Stockholm': { standard: 'CET', daylight: 'CEST' },
  'Europe/Berlin': { standard: 'CET', daylight: 'CEST' },
  'Europe/Paris': { standard: 'CET', daylight: 'CEST' },
  'Europe/London': { standard: 'GMT', daylight: 'BST' },
  'America/New_York': { standard: 'EST', daylight: 'EDT' },
  'America/Chicago': { standard: 'CST', daylight: 'CDT' },
  'America/Los_Angeles': { standard: 'PST', daylight: 'PDT' },
};

function getTimezoneAbbr(date, tz) {
  const mapped = TZ_ABBR_MAP[tz];
  if (mapped) {
    // Check if DST is active by comparing UTC offset in Jan vs now
    const jan = new Date(date.getFullYear(), 0, 1);
    const janOffset = new Date(jan.toLocaleString('en-US', { timeZone: tz })) - jan;
    const nowOffset = new Date(date.toLocaleString('en-US', { timeZone: tz })) - date;
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
