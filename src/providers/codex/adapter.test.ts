import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILTIN_PLUGIN_NAMES = [
  'time-date',
  'quota',
  'system',
  'focus-timer',
  'energy-curve',
  'weather',
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

  for (const name of BUILTIN_PLUGIN_NAMES) {
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
