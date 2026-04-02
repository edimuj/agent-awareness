import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import plugin from './time-date.ts';

const defaults = plugin.defaults;

describe('time-date plugin', () => {
  describe('metadata', () => {
    it('has correct name and triggers', () => {
      assert.equal(plugin.name, 'time-date');
      assert.deepEqual(plugin.triggers, ['session-start', 'prompt', 'change:hour', 'change:day']);
    });

    it('has all expected default config keys', () => {
      assert.equal(defaults.showTime, true);
      assert.equal(defaults.showTimezone, true);
      assert.equal(defaults.showDay, true);
      assert.equal(defaults.showDate, true);
      assert.equal(defaults.showWeekNumber, true);
      assert.equal(defaults.showBusinessHours, true);
      assert.deepEqual(defaults.businessHours, { start: 9, end: 17 });
    });
  });

  describe('gather — full mode', () => {
    it('returns text with time, day, date, week, and business hours', () => {
      const result = plugin.gather('session-start', { ...defaults }, null, {} as any);
      assert.ok(result.text, 'should produce text');
      // Full mode has pipe-delimited sections
      assert.ok(result.text.includes('|'), 'full mode should have pipe separators');
      assert.ok(result.text.includes('Week'), 'should include week number');
    });

    it('returns state with lastHour and lastDay', () => {
      const result = plugin.gather('session-start', { ...defaults }, null, {} as any);
      assert.ok(result.state, 'should return state');
      const state = result.state as Record<string, unknown>;
      assert.equal(typeof state.lastHour, 'number');
      assert.ok(state.lastHour >= 0 && state.lastHour <= 23, 'hour should be 0-23');
      assert.match(state.lastDay as string, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('shows business hours label during weekday work hours', () => {
      const config = {
        ...defaults,
        timezone: 'UTC',
        labels: { businessHours: 'WORK', afterHours: 'OFF', weekend: 'REST' },
      };
      const result = plugin.gather('session-start', config, null, {} as any);
      // We can't control the clock, but we can verify it picks one of the labels
      const text = result.text;
      const hasLabel = text.includes('WORK') || text.includes('OFF') || text.includes('REST');
      assert.ok(hasLabel, 'should include a business hours label');
    });
  });

  describe('gather — compact mode', () => {
    it('returns short text without pipe sections', () => {
      const config = {
        ...defaults,
        triggers: { 'change:hour': 'compact' },
      };
      const result = plugin.gather('change:hour', config, null, {} as any);
      assert.ok(result.text, 'should produce text');
      assert.ok(!result.text.includes('Week'), 'compact mode should not include week');
      assert.ok(!result.text.includes('|'), 'compact mode should not have pipe separators');
    });
  });

  describe('gather — config toggles', () => {
    it('respects showTime: false', () => {
      const config = {
        ...defaults,
        showTime: false,
        showTimezone: false,
        showDay: true,
        showDate: false,
        showWeekNumber: false,
        showBusinessHours: false,
      };
      const result = plugin.gather('session-start', config, null, {} as any);
      // With only showDay, should be just a short day name
      assert.ok(result.text.length < 20, 'should be very short with most options off');
      // Should not contain time pattern HH:MM
      assert.ok(!/\d{2}:\d{2}/.test(result.text), 'should not contain time');
    });

    it('respects showWeekNumber: false', () => {
      const config = { ...defaults, showWeekNumber: false };
      const result = plugin.gather('session-start', config, null, {} as any);
      assert.ok(!result.text.includes('Week'), 'should not include week number');
    });

    it('respects showBusinessHours: false', () => {
      const config = { ...defaults, showBusinessHours: false };
      const result = plugin.gather('session-start', config, null, {} as any);
      const labels = [
        defaults.labels.businessHours,
        defaults.labels.afterHours,
        defaults.labels.weekend,
      ];
      for (const label of labels) {
        assert.ok(!result.text.includes(label), `should not include "${label}"`);
      }
    });

    it('respects showDate: false', () => {
      const config = { ...defaults, showDate: false };
      const result = plugin.gather('session-start', config, null, {} as any);
      // Date format is "2 Apr 2026" — check no year pattern
      const yearPattern = /\b20\d{2}\b/;
      // The first section (before first |) should not have a year
      const firstSection = result.text.split('|')[0];
      assert.ok(!yearPattern.test(firstSection), 'should not include date with year');
    });
  });

  describe('gather — timezone handling', () => {
    it('handles explicit timezone', () => {
      const config = { ...defaults, timezone: 'America/New_York' };
      const result = plugin.gather('session-start', config, null, {} as any);
      // Should contain EST or EDT
      assert.ok(
        result.text.includes('EST') || result.text.includes('EDT'),
        'should show NY timezone abbreviation',
      );
    });

    it('handles auto timezone (default)', () => {
      const config = { ...defaults, timezone: 'auto' };
      const result = plugin.gather('session-start', config, null, {} as any);
      assert.ok(result.text, 'should produce text with auto timezone');
    });
  });

  describe('gather — trigger fallback', () => {
    it('uses full mode for unrecognized trigger', () => {
      const result = plugin.gather('prompt', { ...defaults }, null, {} as any);
      // prompt is not in triggers config → defaults to full
      assert.ok(result.text.includes('|'), 'should use full mode for unconfigured trigger');
    });
  });
});
