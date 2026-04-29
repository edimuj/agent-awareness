import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT_ROOT = process.cwd();
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli.ts');
const CODEX_PLUGIN_DIR = join(PROJECT_ROOT, 'codex-plugin');

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface MinimalWebSocket {
  close(): void;
  send(data: string): void;
  addEventListener(
    type: 'close' | 'error' | 'message' | 'open',
    listener: (event: { data?: unknown; message?: string }) => void,
    options?: { once?: boolean },
  ): void;
}

interface JsonRpcClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface PluginSummary {
  installed: boolean;
  enabled: boolean;
}

interface PluginReadResult {
  plugin: {
    summary: PluginSummary;
    skills: unknown[];
    apps: unknown[];
    mcpServers: string[];
  };
}

interface PluginListResult {
  marketplaces: Array<{
    plugins: PluginSummary[];
  }>;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function hasCodexCli(): Promise<boolean> {
  try {
    const result = await runCommand('codex', ['--version'], process.env);
    return result.code === 0;
  } catch {
    return false;
  }
}

function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a TCP port for Codex app-server'));
        return;
      }
      const { port } = address;
      server.close(err => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function connectJsonRpcClient(port: number): Promise<JsonRpcClient> {
  const WebSocketCtor = (globalThis as typeof globalThis & {
    WebSocket: new (url: string) => MinimalWebSocket;
  }).WebSocket;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ws = new WebSocketCtor(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket connect timeout')), 250);
        ws.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        ws.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket connect error'));
        }, { once: true });
      });

      const pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        timeout: NodeJS.Timeout;
        method: string;
      }>();
      let nextId = 1;

      ws.addEventListener('message', event => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        const data = JSON.parse(raw) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (typeof data.id !== 'number') return;
        const entry = pending.get(data.id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        pending.delete(data.id);
        if (data.error) {
          entry.reject(new Error(`${entry.method}: ${JSON.stringify(data.error)}`));
        } else {
          entry.resolve(data.result);
        }
      });

      return {
        call(method: string, params: Record<string, unknown>): Promise<unknown> {
          const id = nextId++;
          const payload = { jsonrpc: '2.0', id, method, params };
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              reject(new Error(`Timeout waiting for ${method}`));
            }, 10_000);
            pending.set(id, { resolve, reject, timeout, method });
            ws.send(JSON.stringify(payload));
          });
        },
        close(): void {
          ws.close();
        },
      };
    } catch (err) {
      lastError = err as Error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw lastError ?? new Error('Failed to connect to Codex app-server');
}

function startCodexAppServer(
  env: NodeJS.ProcessEnv,
  port: number,
): ReturnType<typeof spawn> {
  return spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('codex setup writes global hook commands to config.toml and removes legacy hooks.json', { timeout: 30_000 }, async t => {
  if (!(await hasCodexCli())) t.skip('codex CLI not available in PATH');

  const base = await mkdtemp(join(tmpdir(), 'agent-awareness-codex-setup-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const homeDir = join(base, 'home');
  const codexHomeDir = join(base, 'codex-home');
  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHomeDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHomeDir,
  };

  const setup = await runCommand('node', [CLI_ENTRY, 'codex', 'setup', '--global'], env);
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);

  const expectedSession = `node ${quotePath(join(PROJECT_ROOT, 'codex-plugin', 'hooks', 'codex-session-start.mjs'))}`;
  const expectedPrompt = `node ${quotePath(join(PROJECT_ROOT, 'codex-plugin', 'hooks', 'codex-prompt-submit.mjs'))}`;
  const configToml = await readFile(join(codexHomeDir, 'config.toml'), 'utf8');

  assert.match(configToml, /# agent-awareness hooks: begin/);
  assert.match(configToml, /\[\[hooks\.SessionStart\]\]/);
  assert.match(configToml, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(configToml, new RegExp(`command = ${JSON.stringify(expectedSession).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(configToml, new RegExp(`command = ${JSON.stringify(expectedPrompt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(join(codexHomeDir, 'hooks.json')), false, 'global setup should not create legacy hooks.json');

  const features = await runCommand('codex', ['features', 'list'], env);
  assert.equal(features.code, 0, features.stderr || features.stdout);
  assert.match(features.stdout, /^codex_hooks\s+.+\s+true$/m);
});

test('codex plugin install enables the bundle but does not create hooks config', { timeout: 30_000 }, async t => {
  if (!(await hasCodexCli())) t.skip('codex CLI not available in PATH');

  const base = await mkdtemp(join(tmpdir(), 'agent-awareness-codex-plugin-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const homeDir = join(base, 'home');
  const codexHomeDir = join(base, 'codex-home');
  const repoDir = join(base, 'repo');
  const pluginDir = join(repoDir, 'plugins', 'agent-awareness');
  const marketplacePath = join(repoDir, '.agents', 'plugins', 'marketplace.json');
  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHomeDir, { recursive: true });
  await mkdir(join(repoDir, 'plugins'), { recursive: true });
  await mkdir(join(repoDir, '.agents', 'plugins'), { recursive: true });
  await cp(CODEX_PLUGIN_DIR, pluginDir, { recursive: true });

  await writeFile(
    marketplacePath,
    JSON.stringify({
      name: 'local-repo',
      plugins: [
        {
          name: 'agent-awareness',
          source: { source: 'local', path: './plugins/agent-awareness' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Coding',
        },
      ],
    }, null, 2) + '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHomeDir,
  };

  const port = await getFreePort();
  const appServer = startCodexAppServer(env, port);
  let serverStderr = '';
  appServer.stderr?.on('data', chunk => { serverStderr += chunk.toString(); });
  t.after(() => {
    appServer.kill();
  });

  const client = await connectJsonRpcClient(port);
  t.after(() => {
    client.close();
  });

  await client.call('initialize', {
    clientInfo: { name: 'agent-awareness-test', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  });

  const before = await client.call('plugin/read', {
    marketplacePath,
    pluginName: 'agent-awareness',
  }) as PluginReadResult;
  const install = await client.call('plugin/install', {
    marketplacePath,
    pluginName: 'agent-awareness',
    forceRemoteSync: false,
  }) as { authPolicy: string; appsNeedingAuth: unknown[] };
  const after = await client.call('plugin/read', {
    marketplacePath,
    pluginName: 'agent-awareness',
  }) as PluginReadResult;
  const listed = await client.call('plugin/list', {
    cwds: [repoDir],
    forceRemoteSync: false,
  }) as PluginListResult;

  assert.equal(before.plugin.summary.installed, false);
  assert.equal(install.authPolicy, 'ON_INSTALL');
  assert.deepEqual(install.appsNeedingAuth, []);
  assert.equal(after.plugin.summary.installed, true);
  assert.equal(after.plugin.summary.enabled, true);
  assert.equal(after.plugin.skills.length, 0, serverStderr);
  assert.equal(after.plugin.apps.length, 0, serverStderr);
  assert.equal(after.plugin.mcpServers.length, 0, serverStderr);
  assert.equal(listed.marketplaces[0]?.plugins[0]?.installed, true);

  const hooksPath = join(codexHomeDir, 'hooks.json');
  assert.equal(existsSync(hooksPath), false, 'plugin install should not create Codex hooks config');

  const configToml = await readFile(join(codexHomeDir, 'config.toml'), 'utf8');
  assert.match(configToml, /\[plugins\."agent-awareness@local-repo"\]/);
  assert.match(configToml, /enabled = true/);
});
