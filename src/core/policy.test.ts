import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInjectionPolicy } from './policy.ts';

test('policy injects a fact once and suppresses unchanged repeats by fingerprint', () => {
  const first = applyInjectionPolicy(
    [{ pluginName: 'ci', result: { text: 'FAILED: build red' } }],
    { event: 'prompt', previousMeta: {}, now: new Date('2026-04-02T10:00:00.000Z') },
  );
  assert.equal(first.results.length, 1);

  const second = applyInjectionPolicy(
    [{ pluginName: 'ci', result: { text: 'FAILED: build red' } }],
    { event: 'prompt', previousMeta: first.meta, now: new Date('2026-04-02T10:01:00.000Z') },
  );
  assert.equal(second.results.length, 0);
});

test('policy injects both info and warning — plugins decide what to return', () => {
  const out = applyInjectionPolicy(
    [
      { pluginName: 'time-date', result: { text: '10:05 CET Thu 2 Apr 2026' } },
      { pluginName: 'server-health', result: { text: 'WARNING: Swap above 50%' } },
    ],
    { event: 'prompt', previousMeta: {}, now: new Date('2026-04-02T10:05:00.000Z') },
  );

  assert.equal(out.results.length, 2);
});

test('policy enforces central char budget and prioritizes by severity', () => {
  const out = applyInjectionPolicy(
    [
      { pluginName: 'info', result: { text: 'status: all good' } },
      { pluginName: 'warn', result: { text: 'WARNING: queue lag high' } },
      { pluginName: 'crit', result: { text: 'FAILED: deploy to main' } },
    ],
    { event: 'prompt', previousMeta: {}, maxChars: 25 },
  );

  assert.equal(out.results.length, 1);
  assert.match(out.results[0]!.text, /FAILED: deploy to main/);
});

test('policy collapses multi-line warning tables to signal lines', () => {
  const out = applyInjectionPolicy(
    [{
      pluginName: 'server-health',
      result: {
        severity: 'warning',
        text: [
          'Server health:',
          'Disk: healthy',
          'Memory: healthy',
          'WARNING: Swap high',
          'CPU: healthy',
        ].join('\n'),
      },
    }],
    { event: 'prompt', previousMeta: {}, maxChars: 400 },
  );

  const rendered = out.results.map(r => r.text).join('\n');
  assert.match(rendered, /Server health:/);
  assert.match(rendered, /WARNING: Swap high/);
  assert.doesNotMatch(rendered, /Memory: healthy/);
});
