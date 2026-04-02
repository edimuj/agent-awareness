import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DISABLED_PLUGIN_NAMES = [
  'time-date',
  'quota',
  'system',
  'focus-timer',
  'energy-curve',
  'weather',
  'actions-watcher',
  'claim-debugger',
  'github-watcher',
  'pr-pilot',
  'server-health',
];

async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn('node', args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const code = await new Promise<number | null>(resolve => {
    child.on('close', resolve);
  });

  return { code, stdout, stderr };
}

test('codex hook isolates plugin failures instead of crashing', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    join(pluginsDir, 'thrower.ts'),
    `export default {
  name: 'thrower',
  description: 'throws from gather',
  triggers: ['session-start'],
  defaults: { triggers: { 'session-start': true } },
  gather() {
    throw new Error('boom-from-test');
  },
};
`,
  );

  const { code, stderr } = await runNode(
    ['hooks/codex-session-start.ts'],
    { ...process.env, HOME: tempHome },
  );

  assert.equal(code, 0);
  assert.match(stderr, /\[agent-awareness\] thrower: boom-from-test/);
});

test('codex session-start wires claims context and prunes stale claims', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');
  const staleClaim = join(tempHome, '.cache', 'agent-awareness', 'claims', 'stale-plugin', 'expired.json');

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });
  await mkdir(dirname(staleClaim), { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    staleClaim,
    JSON.stringify({
      holder: 'dead-host:999999',
      pid: 999999,
      claimedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:01:00.000Z',
    }, null, 2) + '\n',
  );

  await writeFile(
    join(pluginsDir, 'claims-check.ts'),
    `export default {
  name: 'claims-check',
  description: 'validates claims context',
  triggers: ['session-start'],
  defaults: { triggers: { 'session-start': true } },
  async gather(_trigger, _config, _prevState, context) {
    const hasClaims = !!(context.claims && typeof context.claims.tryClaim === 'function');
    return { text: hasClaims ? 'claims:enabled' : 'claims:missing', state: {} };
  },
};
`,
  );

  const { code, stdout } = await runNode(
    ['hooks/codex-session-start.ts'],
    { ...process.env, HOME: tempHome },
  );

  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /claims:enabled/);
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /\|\|/);

  const staleStillExists = await stat(staleClaim).then(
    () => true,
    () => false,
  );
  assert.equal(staleStillExists, false);
});

test('codex prompt-submit emits valid JSON hook output shape', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    join(pluginsDir, 'prompt-check.ts'),
    `export default {
  name: 'prompt-check',
  description: 'ensures prompt hook output',
  triggers: ['prompt'],
  defaults: { triggers: { 'prompt': true } },
  gather() {
    return { text: 'prompt:enabled', state: {} };
  },
};
`,
  );

  const { code, stdout } = await runNode(
    ['hooks/codex-prompt-submit.ts'],
    { ...process.env, HOME: tempHome },
  );

  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /prompt:enabled/);
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /\|\|/);
});

test('codex prompt-submit surfaces ticker cache once per gatheredAt', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');
  const cacheDir = join(tempHome, '.cache', 'agent-awareness');
  const tickerCachePath = join(cacheDir, 'ticker-cache.json');

  await mkdir(configsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    tickerCachePath,
    JSON.stringify({
      'interval-demo': {
        text: 'Interval payload',
        gatheredAt: '2026-04-02T08:00:00.000Z',
      },
    }) + '\n',
  );

  const first = await runNode(
    ['hooks/codex-prompt-submit.ts'],
    { ...process.env, HOME: tempHome },
  );
  assert.equal(first.code, 0);
  const firstPayload = JSON.parse(first.stdout);
  assert.deepEqual(firstPayload.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(String(firstPayload.hookSpecificOutput?.additionalContext ?? ''), /Interval payload/);

  const second = await runNode(
    ['hooks/codex-prompt-submit.ts'],
    { ...process.env, HOME: tempHome },
  );
  assert.equal(second.code, 0);
  assert.equal(second.stdout.trim(), '');

  await writeFile(
    tickerCachePath,
    JSON.stringify({
      'interval-demo': {
        text: 'Interval payload',
        gatheredAt: '2026-04-02T08:10:00.000Z',
      },
    }) + '\n',
  );

  const third = await runNode(
    ['hooks/codex-prompt-submit.ts'],
    { ...process.env, HOME: tempHome },
  );
  assert.equal(third.code, 0);
  const thirdPayload = JSON.parse(third.stdout);
  assert.match(String(thirdPayload.hookSpecificOutput?.additionalContext ?? ''), /Interval payload/);
});
