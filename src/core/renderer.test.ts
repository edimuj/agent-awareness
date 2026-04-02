import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render } from './renderer.ts';

describe('render', () => {
  it('wraps results with [agent-awareness] header', () => {
    const result = render([{ text: 'hello', state: {} }]);
    assert.equal(result, '[agent-awareness]\nhello');
  });

  it('joins multiple results with newlines', () => {
    const result = render([
      { text: 'line1', state: {} },
      { text: 'line2', state: {} },
      { text: 'line3', state: {} },
    ]);
    assert.equal(result, '[agent-awareness]\nline1\nline2\nline3');
  });

  it('filters out empty text results', () => {
    const result = render([
      { text: 'keep', state: {} },
      { text: '', state: {} },
      { text: 'also keep', state: {} },
    ]);
    assert.equal(result, '[agent-awareness]\nkeep\nalso keep');
  });

  it('returns empty string when all results are empty', () => {
    const result = render([
      { text: '', state: {} },
      { text: '', state: {} },
    ]);
    assert.equal(result, '');
  });

  it('returns empty string for empty input array', () => {
    assert.equal(render([]), '');
  });
});
