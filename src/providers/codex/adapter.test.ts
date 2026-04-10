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

const CODEX_SESSION_HOOK = ['codex-plugin/hooks/codex-session-start.mjs'];
const CODEX_PROMPT_HOOK = ['codex-plugin/hooks/codex-prompt-submit.mjs'];

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

  const { code, stderr } = await runNode(CODEX_SESSION_HOOK, { ...process.env, HOME: tempHome });

  assert.equal(code, 0);
  assert.match(stderr, /\[agent-awareness\] thrower: boom-from-test/);
});

test('codex session-start wires claims context and prunes stale claims', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');
  const staleClaim = join(tempHome, '.cache', 'agent-awareness', 'codex', 'claims', 'stale-plugin', 'expired.json');

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
    return { text: hasClaims ? 'WARNING: claims:enabled' : 'WARNING: claims:missing', state: {} };
  },
};
`,
  );

  const { code, stdout } = await runNode(CODEX_SESSION_HOOK, { ...process.env, HOME: tempHome });

  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.suppressOutput, true);
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
    return { text: 'WARNING: prompt:enabled', state: {} };
  },
};
`,
  );

  const { code, stdout } = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });

  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.suppressOutput, true);
  assert.deepEqual(payload.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /prompt:enabled/);
  assert.match(String(payload.hookSpecificOutput?.additionalContext ?? ''), /\|\|/);
});

test('codex prompt-submit fires interval plugins inline and respects persisted state', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');
  const stateDir = join(tempHome, '.cache', 'agent-awareness', 'codex');
  const statePath = join(stateDir, 'state.json');

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    join(pluginsDir, 'interval-check.ts'),
    `export default {
  name: 'interval-check',
  description: 'fires inline on prompt',
  triggers: ['interval:10m'],
  defaults: { triggers: { 'interval:10m': true } },
  gather() {
    return { text: 'WARNING: interval:inline', state: {} };
  },
};
`,
  );

  const first = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(first.code, 0);
  const firstPayload = JSON.parse(first.stdout);
  assert.deepEqual(firstPayload.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(String(firstPayload.hookSpecificOutput?.additionalContext ?? ''), /WARNING: interval:inline/);

  const second = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(second.code, 0);
  assert.equal(second.stdout.trim(), '');

  await writeFile(
    statePath,
    JSON.stringify({
      'interval-check': {
        _updatedAt: '2020-01-01T00:00:00.000Z',
      },
    }, null, 2) + '\n',
  );

  const third = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(third.code, 0);
  const thirdPayload = JSON.parse(third.stdout);
  assert.match(String(thirdPayload.hookSpecificOutput?.additionalContext ?? ''), /WARNING: interval:inline/);
});

test('codex prompt-submit ignores stale tier-2 ticker cache files', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');
  const cacheDir = join(tempHome, '.cache', 'agent-awareness', 'codex');
  const tickerCachePath = join(cacheDir, 'ticker-cache.json');

  await mkdir(configsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    tickerCachePath,
    JSON.stringify({
      stray: {
        text: 'This should stay ignored',
        gatheredAt: '2020-01-01T00:00:00.000Z',
      },
    }) + '\n',
  );

  const prompt = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout.trim(), '');
});

test('codex prompt-submit suppresses duplicate prompt facts already injected at session-start', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'agent-awareness-home-'));
  const pluginsDir = join(tempHome, '.config', 'agent-awareness', 'plugins');
  const configsDir = join(tempHome, '.config', 'agent-awareness', 'plugins.d');

  await mkdir(pluginsDir, { recursive: true });
  await mkdir(configsDir, { recursive: true });

  for (const name of DISABLED_PLUGIN_NAMES) {
    await writeFile(join(configsDir, `${name}.json`), '{ "enabled": false }\n');
  }

  await writeFile(
    join(pluginsDir, 'dupe.ts'),
    `export default {
  name: 'dupe',
  description: 'same fact on session-start and prompt',
  triggers: ['session-start', 'prompt'],
  defaults: { triggers: { 'session-start': true, 'prompt': true } },
  gather() {
    return { text: 'FAILED: duplicate fact', state: {} };
  },
};
`,
  );

  const started = await runNode(CODEX_SESSION_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(started.code, 0);
  const startPayload = JSON.parse(started.stdout);
  assert.match(String(startPayload.hookSpecificOutput?.additionalContext ?? ''), /FAILED: duplicate fact/);

  const prompt = await runNode(CODEX_PROMPT_HOOK, { ...process.env, HOME: tempHome });
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout.trim(), '');
});
