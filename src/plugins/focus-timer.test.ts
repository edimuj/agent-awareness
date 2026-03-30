import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './focus-timer.ts';

function tool(name: string) {
  const found = plugin.mcp?.tools.find(t => t.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

test('focus-timer break uses previous focus state and increments sessions correctly', async () => {
  const prevState = {
    status: 'focus',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    focusMinutes: 25,
    breakMinutes: 5,
    sessionsCompleted: 3,
    label: 'deep-work',
  };

  const result = await tool('break').handler({}, plugin.defaults, AbortSignal.timeout(1_000), prevState);
  assert.ok(result?.state);
  assert.equal(result.state?.status, 'break');
  assert.equal(result.state?.sessionsCompleted, 4);
  assert.equal(result.state?.label, null);
});

test('focus-timer stop preserves completion count from previous state', async () => {
  const prevState = {
    status: 'break',
    startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    focusMinutes: 25,
    breakMinutes: 5,
    sessionsCompleted: 7,
    label: null,
  };

  const result = await tool('stop').handler({}, plugin.defaults, AbortSignal.timeout(1_000), prevState);
  assert.ok(result?.state);
  assert.equal(result.state?.status, 'idle');
  assert.equal(result.state?.sessionsCompleted, 7);
});

test('focus-timer extend requires active focus session', async () => {
  const prevState = {
    status: 'idle',
    startedAt: null,
    endsAt: null,
    focusMinutes: 25,
    breakMinutes: 5,
    sessionsCompleted: 2,
    label: null,
  };

  const result = await tool('extend').handler({ minutes: 10 }, plugin.defaults, AbortSignal.timeout(1_000), prevState);
  assert.equal(result?.text, 'No active focus session to extend.');
  assert.equal(result?.state, undefined);
});

test('focus-timer status reports active focus timer from previous state', async () => {
  const prevState = {
    status: 'focus',
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    focusMinutes: 25,
    breakMinutes: 5,
    sessionsCompleted: 1,
    label: 'refactor',
  };

  const result = await tool('status').handler({}, plugin.defaults, AbortSignal.timeout(1_000), prevState);
  assert.ok(result?.text.includes('Focus:'));
  assert.ok(result?.state);
  assert.equal(result.state?.status, 'focus');
});
