import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from '../core/types.ts';

/**
 * Energy level definition — a time range with a level and optional custom prompt.
 */
interface EnergyRange {
  hours: string;       // "08-12" or "22-06" (wraps midnight)
  level: string;       // energy level key
  prompt?: string;     // custom prompt override
}

interface EnergyLevel {
  score: number;
  label: string;
  prompt: string;
}

/** Built-in energy levels with default agent guidance. */
const LEVELS: Record<string, EnergyLevel> = {
  off:          { score: 0.0, label: 'OFF',          prompt: '' },
  low:          { score: 0.2, label: 'LOW',          prompt: 'User energy is low. Favor brevity, avoid proposing large refactors. Suggest break points.' },
  waking:       { score: 0.3, label: 'waking up',    prompt: 'User is warming up. Start with status/overview before diving into code.' },
  slow:         { score: 0.3, label: 'relaxed',      prompt: 'Relaxed pace. Short responses, no urgency.' },
  recovering:   { score: 0.4, label: 'recovering',   prompt: 'Post-dip recovery. Moderate complexity, avoid context-heavy tasks.' },
  'winding-down': { score: 0.4, label: 'winding down', prompt: 'Energy fading. Wrap up loose ends, avoid starting new threads. Suggest checkpoints.' },
  steady:       { score: 0.6, label: 'steady',       prompt: 'Normal working energy. Standard interaction style.' },
  'second-wind': { score: 0.7, label: 'second wind', prompt: 'Renewed focus window. Good time for review or medium-complexity tasks.' },
  rising:       { score: 0.8, label: 'rising',       prompt: 'Energy building. Good for ramping into complex work.' },
  peak:         { score: 1.0, label: 'PEAK',         prompt: 'Peak energy. Full depth, complex reasoning, ambitious tasks welcome.' },
};

/**
 * Built-in profiles — predefined energy curves for common chronotypes.
 * Each profile defines weekday ranges. Weekend shifts +2h automatically.
 */
const PROFILES: Record<string, EnergyRange[]> = {
  'early-bird': [
    { hours: '05-06', level: 'waking' },
    { hours: '06-08', level: 'rising' },
    { hours: '08-12', level: 'peak' },
    { hours: '12-13', level: 'recovering' },
    { hours: '13-15', level: 'steady' },
    { hours: '15-18', level: 'winding-down' },
    { hours: '18-21', level: 'low' },
    { hours: '21-05', level: 'off' },
  ],
  'nine-to-five': [
    { hours: '07-08', level: 'waking' },
    { hours: '08-09', level: 'rising' },
    { hours: '09-12', level: 'peak' },
    { hours: '12-14', level: 'recovering' },
    { hours: '14-17', level: 'steady' },
    { hours: '17-19', level: 'winding-down' },
    { hours: '19-23', level: 'low' },
    { hours: '23-07', level: 'off' },
  ],
  'night-owl': [
    { hours: '10-12', level: 'waking' },
    { hours: '12-14', level: 'slow' },
    { hours: '14-18', level: 'steady' },
    { hours: '18-20', level: 'rising' },
    { hours: '20-02', level: 'peak' },
    { hours: '02-04', level: 'winding-down' },
    { hours: '04-10', level: 'off' },
  ],
  'split-shift': [
    { hours: '05-06', level: 'waking' },
    { hours: '06-10', level: 'peak' },
    { hours: '10-12', level: 'winding-down' },
    { hours: '12-18', level: 'low' },
    { hours: '18-20', level: 'rising' },
    { hours: '20-00', level: 'peak' },
    { hours: '00-02', level: 'winding-down' },
    { hours: '02-05', level: 'off' },
  ],
};

export default {
  name: 'energy-curve',
  description: 'Adapts agent style to user energy rhythm — profiles, custom schedules, weekday/weekend',

  triggers: ['session-start', 'change:hour'],

  defaults: {
    // Tier 1: pick a profile (null = use startHour or custom ranges)
    profile: 'nine-to-five',
    // Tier 2: generate curve from start-of-day hour (null = use profile)
    startHour: null,
    // Tier 3: full custom ranges (null = use profile or startHour)
    weekday: null,
    weekend: null,
    // Weekend auto-shift when using profile or startHour (hours)
    weekendShift: 2,
    // Timezone (auto = system)
    timezone: 'auto',
    triggers: {
      'session-start': true,
      'change:hour': true,
    },
  },

  gather(trigger: Trigger, config: PluginConfig, prevState, _context: GatherContext) {
    const tz = resolveTimezone(config.timezone as string);
    const now = new Date();
    const hour = currentHour(now, tz);
    const isWeekend = checkWeekend(now, tz);

    // Resolve the active schedule
    const ranges = resolveRanges(config, isWeekend);
    if (!ranges.length) return null;

    // Find current energy range
    const match = findRange(ranges, hour);
    if (!match) return null;

    const levelKey = match.level;
    const level = LEVELS[levelKey];
    if (!level || levelKey === 'off') return null;

    // Only inject when level changes (or on session-start)
    if (trigger === 'change:hour' && prevState?.lastLevel === levelKey) return null;

    const prompt = match.prompt ?? level.prompt;
    const hoursLabel = match.hours;

    const parts = [`Energy: ${level.label} (${hoursLabel})`];
    if (prompt) parts.push(prompt);

    if (isWeekend) parts[0] = parts[0].replace(')', ', weekend)');

    return {
      text: parts.join(' -- '),
      state: { lastLevel: levelKey, lastHour: hour },
    };
  },
} satisfies AwarenessPlugin;

/**
 * Resolve which ranges to use based on config tier.
 * Priority: custom ranges > startHour > profile.
 */
function resolveRanges(config: PluginConfig, isWeekend: boolean): EnergyRange[] {
  // Tier 3: full custom ranges
  const customWeekday = config.weekday as EnergyRange[] | null;
  const customWeekend = config.weekend as EnergyRange[] | null;
  if (customWeekday) {
    if (isWeekend && customWeekend) return customWeekend;
    if (isWeekend) return shiftRanges(customWeekday, (config.weekendShift as number) ?? 2);
    return customWeekday;
  }

  // Tier 2: generate from startHour
  const startHour = config.startHour as number | null;
  if (startHour != null) {
    const base = generateFromStartHour(startHour);
    if (isWeekend) return shiftRanges(base, (config.weekendShift as number) ?? 2);
    return base;
  }

  // Tier 1: built-in profile
  const profileName = (config.profile as string) ?? 'nine-to-five';
  const base = PROFILES[profileName];
  if (!base) return [];
  if (isWeekend) return shiftRanges(base, (config.weekendShift as number) ?? 2);
  return base;
}

/**
 * Generate energy ranges from a start-of-day hour.
 * Models a typical energy curve with post-lunch dip and second wind.
 */
function generateFromStartHour(start: number): EnergyRange[] {
  const h = (offset: number) => (start + offset) % 24;
  return [
    { hours: `${fmt(h(0))}-${fmt(h(1))}`,  level: 'waking' },
    { hours: `${fmt(h(1))}-${fmt(h(3))}`,  level: 'rising' },
    { hours: `${fmt(h(3))}-${fmt(h(6))}`,  level: 'peak' },
    { hours: `${fmt(h(6))}-${fmt(h(8))}`,  level: 'recovering' },
    { hours: `${fmt(h(8))}-${fmt(h(10))}`, level: 'second-wind' },
    { hours: `${fmt(h(10))}-${fmt(h(13))}`, level: 'winding-down' },
    { hours: `${fmt(h(13))}-${fmt(h(16))}`, level: 'low' },
    { hours: `${fmt(h(16))}-${fmt(h(0))}`, level: 'off' },
  ];
}

/** Shift all ranges forward by N hours (for weekends). */
function shiftRanges(ranges: EnergyRange[], shift: number): EnergyRange[] {
  return ranges.map(r => {
    const [startH, endH] = parseHours(r.hours);
    return {
      ...r,
      hours: `${fmt((startH + shift) % 24)}-${fmt((endH + shift) % 24)}`,
    };
  });
}

/** Check if hour falls within a range (handles midnight wrapping). */
function findRange(ranges: EnergyRange[], hour: number): EnergyRange | undefined {
  return ranges.find(r => {
    const [start, end] = parseHours(r.hours);
    if (start < end) return hour >= start && hour < end;
    // Wraps midnight: e.g., 22-06
    return hour >= start || hour < end;
  });
}

/** Parse "08-12" → [8, 12] */
function parseHours(spec: string): [number, number] {
  const [s, e] = spec.split('-').map(Number);
  return [s, e];
}

/** Format hour as two digits: 8 → "08" */
function fmt(h: number): string {
  return String(h).padStart(2, '0');
}

function currentHour(date: Date, tz: string): number {
  return parseInt(date.toLocaleTimeString('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }));
}

function checkWeekend(date: Date, tz: string): boolean {
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const day = localDate.getDay();
  return day === 0 || day === 6;
}

function resolveTimezone(tz: string | undefined): string {
  if (!tz || tz === 'auto') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz;
}
