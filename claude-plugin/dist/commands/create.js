import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
const LOCAL_PLUGIN_DIR = join(homedir(), '.config', 'agent-awareness', 'plugins');
export async function create(opts) {
    if (opts.local) {
        await createLocal(opts);
    }
    else {
        await createNpm(opts);
    }
}
async function createLocal(opts) {
    await mkdir(LOCAL_PLUGIN_DIR, { recursive: true });
    const filePath = join(LOCAL_PLUGIN_DIR, `${opts.name}.ts`);
    try {
        await stat(filePath);
        console.error(`Error: ${filePath} already exists`);
        process.exit(1);
    }
    catch { /* doesn't exist — good */ }
    await writeFile(filePath, generatePluginSource(opts));
    console.log(`Created local plugin: ${filePath}`);
    console.log(`\nIt will be auto-discovered on next session start. No install needed.`);
}
async function createNpm(opts) {
    const dirName = `agent-awareness-plugin-${opts.name}`;
    const dir = join(process.cwd(), dirName);
    const srcDir = join(dir, 'src');
    try {
        await stat(dir);
        console.error(`Error: ${dir} already exists`);
        process.exit(1);
    }
    catch { /* doesn't exist — good */ }
    await mkdir(srcDir, { recursive: true });
    const pkgJson = {
        name: dirName,
        version: '0.1.0',
        description: opts.description ?? `Agent awareness plugin: ${opts.name}`,
        type: 'module',
        exports: { '.': './index.js' },
        main: './index.js',
        files: ['index.js', 'src/**/*.js', 'src/**/*.d.ts', 'README.md'],
        scripts: {
            build: 'tsc -p tsconfig.build.json',
            typecheck: 'tsc --noEmit',
            prepublishOnly: 'npm run build',
        },
        keywords: ['agent-awareness-plugin', 'ai', 'agent', 'awareness'],
        peerDependencies: { 'agent-awareness': '>=0.4.0' },
        devDependencies: { 'agent-awareness': '^0.4.0', typescript: '^5.8', '@types/node': '^25.5.0' },
        license: 'MIT',
    };
    const tsconfigBuild = {
        compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
            declaration: true,
            rewriteRelativeImportExtensions: true,
        },
        include: ['index.ts', 'src/**/*.ts'],
        exclude: ['**/*.test.ts'],
    };
    const tsconfig = {
        compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
        },
        include: ['index.ts', 'src/**/*.ts'],
    };
    const gitignore = 'node_modules/\n*.js\n*.d.ts\n*.map\n';
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
    await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify(tsconfigBuild, null, 2) + '\n');
    await writeFile(join(dir, '.gitignore'), gitignore);
    await writeFile(join(dir, 'index.ts'), `export { default } from './src/index.ts';\n`);
    await writeFile(join(srcDir, 'index.ts'), generatePluginSource(opts));
    await writeFile(join(dir, 'README.md'), generateReadme(opts));
    console.log(`Created plugin package: ${dirName}/`);
    console.log(`  package.json       — npm package (exports compiled .js)`);
    console.log(`  tsconfig.build.json — build config (emits .js + .d.ts)`);
    console.log(`  index.ts           — re-export entry point`);
    console.log(`  src/index.ts       — plugin source`);
    console.log(`  README.md`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${dirName}`);
    console.log(`  npm install          # install agent-awareness types`);
    console.log(`  # Edit src/index.ts — fill in the gather() function`);
    console.log(`  npm run build        # compile .ts → .js`);
    console.log(`  npm install -g .     # install globally for testing`);
    console.log(`  npm publish          # share with the community`);
}
function generatePluginSource(opts) {
    const triggersStr = opts.triggers.map(t => `'${t}'`).join(', ');
    const triggerDefaults = opts.triggers
        .map(t => `      '${t}': true,`)
        .join('\n');
    const desc = opts.description ?? `TODO: describe what ${opts.name} provides`;
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
    // Useful context fields:
    // context.provider        — which agent ('claude-code', 'codex', etc.)
    // context.sessionRepo     — active repo (owner/repo) when detectable
    // context.cwd / context.gitRoot — execution paths when available
    // context.signal          — AbortSignal for cancellation in slow I/O
    // context.log             — structured logging ({ warn, error })
    // context.claims          — event claiming across concurrent sessions
    //
    // TODO: gather awareness data and only emit when something changed/relevant.
    // Return null to stay silent when there is no actionable update.
    return null;
  },
} satisfies AwarenessPlugin;
`;
}
function generateReadme(opts) {
    const dirName = `agent-awareness-plugin-${opts.name}`;
    const desc = opts.description ?? `Agent awareness plugin: ${opts.name}`;
    return `# ${dirName}

${desc}

## Install

\`\`\`bash
npm install -g ${dirName}
\`\`\`

The agent-awareness loader auto-discovers \`agent-awareness-plugin-*\` packages from both global and local \`node_modules/\`.

## Authoring guide

See the plugin creator guide for step-by-step patterns (MCP-first design, caveats, troubleshooting):

- <https://github.com/edimuj/agent-awareness/blob/main/docs/plugin-creator-guide.md>

## Configuration

Override defaults in \`~/.config/agent-awareness/plugins.d/${opts.name}.json\`:

\`\`\`json
{
  "enabled": true
}
\`\`\`

## License

MIT
`;
}
