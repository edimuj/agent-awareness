import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadPlugins } from './loader.ts';

test('loadPlugins supports npm packages with object-shaped exports maps', async (t) => {
  const id = `${Date.now()}-${process.pid}`;
  const pkgName = `agent-awareness-plugin-test-exports-${id}`;
  const pluginName = `test-exports-${id}`;
  const pkgDir = join(process.cwd(), 'node_modules', pkgName);

  await mkdir(pkgDir, { recursive: true });
  t.after(async () => {
    await rm(pkgDir, { recursive: true, force: true });
  });

  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '0.0.1',
      type: 'module',
      exports: {
        '.': {
          import: './index.js',
        },
      },
    }, null, 2) + '\n',
  );

  await writeFile(
    join(pkgDir, 'index.js'),
    `export default {
  name: '${pluginName}',
  description: 'test plugin for exports map',
  triggers: ['session-start'],
  defaults: { triggers: { 'session-start': true } },
  gather() { return { text: 'ok', state: {} }; },
};
`,
  );

  const { plugins, errors } = await loadPlugins();
  assert.ok(plugins.some(p => p.name === pluginName));
  assert.equal(errors.find(e => e.source === `npm:${pkgName}`), undefined);
});

test('loadPlugins supports local plugin directories with index.js', async (t) => {
  const id = `${Date.now()}-${process.pid}`;
  const dirName = `test-local-js-${id}`;
  const pluginName = `local-js-${id}`;
  const localRoot = join(homedir(), '.config', 'agent-awareness', 'plugins');
  const pluginDir = join(localRoot, dirName);

  await mkdir(pluginDir, { recursive: true });
  t.after(async () => {
    await rm(pluginDir, { recursive: true, force: true });
  });

  await writeFile(
    join(pluginDir, 'index.js'),
    `export default {
  name: '${pluginName}',
  description: 'local js plugin test',
  triggers: ['session-start'],
  defaults: { triggers: { 'session-start': true } },
  gather() { return { text: 'ok', state: {} }; },
};
`,
  );

  const { plugins, errors } = await loadPlugins();
  assert.ok(plugins.some(p => p.name === pluginName));
  assert.equal(errors.find(e => e.source === `local:${dirName}`), undefined);
});
