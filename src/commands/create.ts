import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOCAL_PLUGIN_DIR = join(homedir(), '.config', 'agent-awareness', 'plugins');

interface CreateOptions {
  name: string;
  local: boolean;
  mcp: boolean;
  description?: string;
  triggers: string[];
}

export async function create(opts: CreateOptions): Promise<void> {
  if (opts.local) {
    await createLocal(opts);
  } else {
    await createNpm(opts);
  }
}

async function createLocal(opts: CreateOptions): Promise<void> {
  await mkdir(LOCAL_PLUGIN_DIR, { recursive: true });
  const filePath = join(LOCAL_PLUGIN_DIR, `${opts.name}.ts`);

  try {
    await stat(filePath);
    console.error(`Error: ${filePath} already exists`);
    process.exit(1);
  } catch { /* doesn't exist — good */ }

  await writeFile(filePath, generatePluginSource(opts));
  console.log(`Created local plugin: ${filePath}`);
  console.log(`\nIt will be auto-discovered on next session start. No install needed.`);
}

async function createNpm(opts: CreateOptions): Promise<void> {
  const dirName = `agent-awareness-plugin-${opts.name}`;
  const dir = join(process.cwd(), dirName);

  try {
    await stat(dir);
    console.error(`Error: ${dir} already exists`);
    process.exit(1);
  } catch { /* doesn't exist — good */ }

  await mkdir(dir, { recursive: true });

  const pkgJson = {
    name: dirName,
    version: '0.1.0',
    description: opts.description ?? `Agent awareness plugin: ${opts.name}`,
    type: 'module',
    exports: { '.': './index.ts' },
    keywords: ['agent-awareness-plugin', 'ai', 'agent', 'awareness'],
    peerDependencies: { 'agent-awareness': '>=0.2.0' },
    license: 'MIT',
  };

  await writeFile(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
  await writeFile(join(dir, 'index.ts'), generatePluginSource(opts));
  await writeFile(join(dir, 'README.md'), generateReadme(opts));

  console.log(`Created plugin package: ${dirName}/`);
  console.log(`  ${dirName}/package.json`);
  console.log(`  ${dirName}/index.ts`);
  console.log(`  ${dirName}/README.md`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${dirName}`);
  console.log(`  # Edit index.ts — fill in the gather() function`);
  console.log(`  npm link && cd ${getProjectRoot()} && npm link ${dirName}`);
  console.log(`  node hooks/session-start.ts  # test it`);
  console.log(`  npm publish                  # share with the community`);
}

function generatePluginSource(opts: CreateOptions): string {
  const triggersStr = opts.triggers.map(t => `'${t}'`).join(', ');
  const triggerDefaults = opts.triggers
    .map(t => `      '${t}': true,`)
    .join('\n');
  const desc = opts.description ?? `TODO: describe what ${opts.name} provides`;

  const mcpBlock = opts.mcp ? `

  // MCP tools — real-time interaction via MCP server.
  // Tool names are auto-scoped: "${opts.name}" + "status" → "awareness_${opts.name.replace(/-/g, '_')}_status"
  // Install the MCP server: agent-awareness mcp install
  mcp: {
    tools: [
      {
        name: 'status',
        description: 'Get current ${opts.name} status',
        inputSchema: {
          type: 'object' as const,
          properties: {
            verbose: { type: 'boolean', description: 'Include detailed info' },
          },
        },
        async handler(params: Record<string, unknown>, config: PluginConfig, signal: AbortSignal) {
          // TODO: return real-time data
          return {
            text: '${opts.name} status: replace with real data',
            state: {},
          };
        },
      },
    ],
  },
` : '';

  return `import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from 'agent-awareness';

export default {
  name: '${opts.name}',
  description: '${desc}',
  triggers: [${triggersStr}],

  defaults: {
    triggers: {
${triggerDefaults}
    },
  },

  // Optional lifecycle hooks — uncomment as needed:
  // async onInstall() { /* first-time setup: create dirs, download resources */ },
  // async onUninstall() { /* cleanup: remove caches, state files */ },
  // async onStart() { /* session start: spawn daemons, connect services */ },
  // onStop() { /* session end: graceful shutdown */ },

  gather(trigger: Trigger, config: PluginConfig, prevState, context: GatherContext) {
    // context.provider — which agent ('claude-code', 'codex', etc.)
    // context.signal  — AbortSignal for cancellation (check in slow I/O)
    // context.log     — structured logging ({ warn, error })
    // TODO: gather awareness data and return compact text
    return {
      text: \`${opts.name}: replace this with real output\`,
      state: {},
    };
  },${mcpBlock}
} satisfies AwarenessPlugin;
`;
}

function generateReadme(opts: CreateOptions): string {
  const dirName = `agent-awareness-plugin-${opts.name}`;
  const desc = opts.description ?? `Agent awareness plugin: ${opts.name}`;

  const mcpSection = opts.mcp ? `
## MCP (real-time)

This plugin includes MCP tools for real-time interaction. To enable:

\`\`\`bash
agent-awareness mcp install   # add MCP server to Claude Code
\`\`\`

The MCP server auto-discovers plugins with tools. Restart Claude Code after installing.
` : '';

  return `# ${dirName}

${desc}

## Install

\`\`\`bash
npm install ${dirName}
\`\`\`

Plugins are auto-discovered by agent-awareness — no configuration needed.

## Configuration

Override defaults in \`~/.config/agent-awareness/plugins.d/${opts.name}.json\`:

\`\`\`json
{
  "enabled": true
}
\`\`\`
${mcpSection}
## License

MIT
`;
}

function getProjectRoot(): string {
  // Best-effort: assume we're running from the agent-awareness project
  return process.env.npm_config_local_prefix ?? '.';
}
