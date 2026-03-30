import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval } from './types.ts';

test('parseInterval accepts valid positive intervals', () => {
  assert.equal(parseInterval('interval:1s'), 1_000);
  assert.equal(parseInterval('interval:10m'), 600_000);
  assert.equal(parseInterval('interval:2h'), 7_200_000);
});

test('parseInterval rejects zero-length intervals', () => {
  assert.equal(parseInterval('interval:0s'), null);
  assert.equal(parseInterval('interval:0m'), null);
  assert.equal(parseInterval('interval:00h'), null);
});

test('parseInterval rejects invalid formats', () => {
  assert.equal(parseInterval('interval:-1m'), null);
  assert.equal(parseInterval('interval:m'), null);
  assert.equal(parseInterval('interval:15d'), null);
  assert.equal(parseInterval('prompt'), null);
});
