import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginDispatcher, type Executor } from './dispatcher.ts';

/** Helper: executor that resolves after `ms` with given text. */
function delayedExecutor(text: string, ms: number): Executor {
  return async (signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    return { text, state: {} };
  };
}

/** Helper: executor that resolves immediately. */
function immediateExecutor(text: string): Executor {
  return async () => ({ text, state: { value: text } });
}

/** Helper: executor that throws. */
function failingExecutor(msg: string): Executor {
  return async () => { throw new Error(msg); };
}

describe('PluginDispatcher', () => {
  describe('dispatch', () => {
    it('executes and returns result', async () => {
      const d = new PluginDispatcher();
      const result = await d.dispatch('test', immediateExecutor('hello'));
      assert.deepEqual(result, { text: 'hello', state: { value: 'hello' } });
    });

    it('returns null on executor error (never rejects)', async () => {
      const d = new PluginDispatcher();
      const result = await d.dispatch('test', failingExecutor('boom'));
      assert.equal(result, null);
    });

    it('returns null on timeout', async () => {
      const d = new PluginDispatcher({ defaultTimeout: 50 });
      const result = await d.dispatch('slow', delayedExecutor('late', 500));
      assert.equal(result, null);
    });

    it('passes AbortSignal to executor', async () => {
      const d = new PluginDispatcher({ defaultTimeout: 50 });
      let receivedSignal: AbortSignal | undefined;
      await d.dispatch('test', async (signal) => {
        receivedSignal = signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        return { text: 'done', state: {} };
      });
      assert.ok(receivedSignal, 'signal should be provided');
      assert.ok(receivedSignal!.aborted, 'signal should be aborted after timeout');
    });
  });

  describe('serial per-plugin execution', () => {
    it('processes same-plugin dispatches serially', async () => {
      const d = new PluginDispatcher();
      const order: number[] = [];

      const a = d.dispatch('p', async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 50));
        order.push(2);
        return { text: 'a', state: {} };
      });

      const b = d.dispatch('p', async () => {
        order.push(3);
        return { text: 'b', state: {} };
      });

      await Promise.all([a, b]);
      // A must complete (1,2) before B starts (3)
      assert.deepEqual(order, [1, 2, 3]);
    });

    it('executes different plugins in parallel', async () => {
      const d = new PluginDispatcher();
      const order: string[] = [];

      const a = d.dispatch('alpha', async () => {
        order.push('alpha-start');
        await new Promise(r => setTimeout(r, 50));
        order.push('alpha-end');
        return { text: 'a', state: {} };
      });

      const b = d.dispatch('beta', async () => {
        order.push('beta-start');
        await new Promise(r => setTimeout(r, 50));
        order.push('beta-end');
        return { text: 'b', state: {} };
      });

      await Promise.all([a, b]);
      // Both should start before either finishes
      const alphaStart = order.indexOf('alpha-start');
      const betaStart = order.indexOf('beta-start');
      const alphaEnd = order.indexOf('alpha-end');
      const betaEnd = order.indexOf('beta-end');
      assert.ok(alphaStart < alphaEnd);
      assert.ok(betaStart < betaEnd);
      assert.ok(betaStart < alphaEnd, 'beta should start before alpha finishes');
    });
  });

  describe('queue management', () => {
    it('drops oldest entries when queue overflows', async () => {
      const d = new PluginDispatcher({ defaultMaxQueue: 2 });
      const results: (string | null)[] = [];

      // First dispatch starts processing immediately — occupies the executor
      const first = d.dispatch('q', delayedExecutor('first', 100));

      // These three pile into the queue (max 2) — 'second' gets dropped
      const second = d.dispatch('q', immediateExecutor('second'));
      const third = d.dispatch('q', immediateExecutor('third'));
      const fourth = d.dispatch('q', immediateExecutor('fourth'));

      const [r1, r2, r3, r4] = await Promise.all([first, second, third, fourth]);
      results.push(
        r1?.text ?? null,
        r2?.text ?? null,
        r3?.text ?? null,
        r4?.text ?? null,
      );

      // 'first' completes normally, 'second' gets dropped (null), 'third' and 'fourth' run
      assert.equal(results[0], 'first');
      assert.equal(results[1], null, 'second should be dropped (oldest in overflow)');
      assert.equal(results[2], 'third');
      assert.equal(results[3], 'fourth');
    });

    it('reports queue depth', async () => {
      const d = new PluginDispatcher({ defaultMaxQueue: 5 });

      // Occupy the executor
      const blocker = d.dispatch('q', delayedExecutor('block', 200));

      // Queue up entries
      const p1 = d.dispatch('q', immediateExecutor('1'));
      const p2 = d.dispatch('q', immediateExecutor('2'));

      assert.equal(d.queueDepth('q'), 2);
      assert.equal(d.queueDepth('unknown'), 0);

      await Promise.all([blocker, p1, p2]);
    });

    it('reports processing state', async () => {
      const d = new PluginDispatcher();
      assert.equal(d.isProcessing('p'), false);

      let resolveInner: (() => void) | undefined;
      const processing = d.dispatch('p', async () => {
        await new Promise<void>(r => { resolveInner = r; });
        return { text: 'done', state: {} };
      });

      // Give the executor a tick to start
      await new Promise(r => setTimeout(r, 10));
      assert.equal(d.isProcessing('p'), true);

      resolveInner!();
      await processing;
      assert.equal(d.isProcessing('p'), false);
    });
  });

  describe('configure', () => {
    it('respects per-plugin timeout', async () => {
      const d = new PluginDispatcher({ defaultTimeout: 5000 });
      d.configure('fast', { timeout: 50 });

      const result = await d.dispatch('fast', delayedExecutor('slow', 500));
      assert.equal(result, null, 'should timeout with plugin-specific limit');
    });

    it('respects per-plugin queue limit', async () => {
      const d = new PluginDispatcher({ defaultMaxQueue: 10 });
      d.configure('tight', { maxQueue: 1 });

      // Occupy executor
      const blocker = d.dispatch('tight', delayedExecutor('block', 100));

      // Queue: maxQueue=1, so second dispatch fills queue, third overflows
      const a = d.dispatch('tight', immediateExecutor('a'));
      const b = d.dispatch('tight', immediateExecutor('b'));

      const [rBlock, rA, rB] = await Promise.all([blocker, a, b]);
      assert.equal(rBlock?.text, 'block');
      assert.equal(rA, null, 'a should be dropped (overflow)');
      assert.equal(rB?.text, 'b');
    });
  });

  describe('dispatchAll', () => {
    it('runs multiple plugins in parallel and collects results', async () => {
      const d = new PluginDispatcher();
      const results = await d.dispatchAll([
        { pluginName: 'a', executor: immediateExecutor('alpha') },
        { pluginName: 'b', executor: immediateExecutor('beta') },
        { pluginName: 'c', executor: failingExecutor('gamma-fail') },
      ]);

      assert.equal(results.length, 3);
      assert.equal(results[0].pluginName, 'a');
      assert.equal(results[0].result?.text, 'alpha');
      assert.equal(results[1].pluginName, 'b');
      assert.equal(results[1].result?.text, 'beta');
      assert.equal(results[2].pluginName, 'c');
      assert.equal(results[2].result, null, 'failed executor returns null');
    });
  });

  describe('error isolation', () => {
    it('continues processing queue after error', async () => {
      const d = new PluginDispatcher();

      // First: error. Second: success.
      const r1 = d.dispatch('p', failingExecutor('fail'));
      const r2 = d.dispatch('p', immediateExecutor('ok'));

      const [result1, result2] = await Promise.all([r1, r2]);
      assert.equal(result1, null);
      assert.equal(result2?.text, 'ok');
    });

    it('continues processing queue after timeout', async () => {
      const d = new PluginDispatcher({ defaultTimeout: 30 });

      const r1 = d.dispatch('p', delayedExecutor('too-slow', 500));
      const r2 = d.dispatch('p', immediateExecutor('next'));

      const [result1, result2] = await Promise.all([r1, r2]);
      assert.equal(result1, null, 'timed out');
      assert.equal(result2?.text, 'next', 'next in queue should still run');
    });
  });
});
