import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
