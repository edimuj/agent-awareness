import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from './registry.ts';
import type { AwarenessPlugin, PluginState, Trigger } from './types.ts';

const TEST_PLUGIN: AwarenessPlugin = {
  name: 'test-change-day',
  description: 'test plugin for day change behavior',
  triggers: ['change:day'],
  defaults: {
    triggers: {
      'change:day': true,
    },
  },
  gather(_trigger: Trigger) {
    return { text: 'x', state: {} };
  },
};

function withMockedDate<T>(fn: () => T): T {
  const OriginalDate = Date;

  class MockDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super('2026-03-27T00:30:00.000Z');
      } else {
        super(...(args as ConstructorParameters<typeof Date>));
      }
    }

    static now(): number {
      return new OriginalDate('2026-03-27T00:30:00.000Z').getTime();
    }

    toISOString(): string {
      return '2026-03-27T00:30:00.000Z';
    }

    // Simulate a local timezone where the local day is still 2026-03-26.
    getFullYear(): number { return 2026; }
    getMonth(): number { return 2; } // March (0-based)
    getDate(): number { return 26; }
  }

  (globalThis as { Date: DateConstructor }).Date = MockDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = OriginalDate;
  }
}

test('change:day does not trigger when local day key has not changed', () => {
  withMockedDate(() => {
    const registry = new Registry();
    registry.register(TEST_PLUGIN);

    const state: PluginState = {
      'test-change-day': {
        lastDay: '2026-03-26',
      },
    };

    const triggered = registry.getTriggeredPlugins('prompt', state);
    assert.equal(triggered.length, 0);
  });
});

test('change:day triggers when local day key changed', () => {
  withMockedDate(() => {
    const registry = new Registry();
    registry.register(TEST_PLUGIN);

    const state: PluginState = {
      'test-change-day': {
        lastDay: '2026-03-25',
      },
    };

    const triggered = registry.getTriggeredPlugins('prompt', state);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0]?.plugin.name, 'test-change-day');
    assert.equal(triggered[0]?.trigger, 'change:day');
  });
});
