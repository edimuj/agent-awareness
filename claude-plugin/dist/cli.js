#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { codexDoctor } from "./commands/codex-doctor.js";
import { codexHooksInstall, codexHooksStatus, codexHooksUninstall } from "./commands/codex-hooks.js";
import { codexLive } from "./commands/codex-live.js";
import { codexMcpInstall, codexMcpStatus, codexMcpUninstall } from "./commands/codex-mcp.js";
import { codexSetup } from "./commands/codex-setup.js";
import { create } from "./commands/create.js";
import { doctor } from "./commands/doctor.js";
import { list } from "./commands/list.js";
import { reloadDaemon } from "./daemon/client.js";
const USAGE = `agent-awareness — modular awareness plugins for AI coding agents

Commands:
  create <name>     Scaffold a new awareness plugin
  doctor            Diagnose plugin loading, config, and log status
  list              Show all discovered plugins and their status
  reload            Hot-reload plugins in the running daemon
  codex setup       Install the supported Codex hooks integration
  codex live        Start Codex with realtime agent-awareness context injection (prefer: codex-aware)
  codex doctor      Diagnose Codex hooks and optional MCP health
  codex mcp ...     Manage optional Codex MCP server (install|uninstall|status)
  codex hooks ...   Manage Codex hooks (install|uninstall|status) [--global|--project]

Options:
  --help, -h        Show this help
  --global          Use global Codex config (~/.codex/config.toml) for codex hooks/setup
  --project         Use project hook config (./.codex/hooks.json) for codex hooks/setup
  --listen          WebSocket URL for codex app-server when using codex live

Create options:
  --local           Create as a local plugin (~/.config/agent-awareness/plugins/)
  --description     Plugin description (default: prompted)
  --triggers        Comma-separated triggers (default: session-start,interval:10m)
`;
const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h', default: false },
        local: { type: 'boolean', default: false },
        global: { type: 'boolean', default: false },
        project: { type: 'boolean', default: false },
        listen: { type: 'string' },
        description: { type: 'string' },
        triggers: { type: 'string', default: 'session-start,interval:10m' },
    },
});
const command = positionals[0];
if (values.help) {
    console.log(USAGE);
    process.exit(0);
}
if (!command) {
    console.log(USAGE);
    process.exit(2);
}
switch (command) {
    case 'create': {
        const name = positionals[1];
        if (!name) {
            console.error('Error: plugin name required\nUsage: agent-awareness create <name> [--local]');
            process.exit(2);
        }
        if (!/^[a-z][a-z0-9-]*$/.test(name)) {
            console.error('Error: plugin name must be lowercase alphanumeric with hyphens (e.g., "weather", "git-monitor")');
            process.exit(2);
        }
        await create({
            name,
            local: values.local ?? false,
            description: values.description,
            triggers: (values.triggers ?? 'session-start,interval:10m').split(',').map(t => t.trim()),
        });
        break;
    }
    case 'doctor': {
        await doctor();
        break;
    }
    case 'list': {
        await list();
        break;
    }
    case 'reload': {
        const result = await reloadDaemon();
        if (!result) {
            console.error('No daemon running — nothing to reload');
            process.exit(1);
        }
        console.log(`Reloaded ${result.loaded.length} plugins: ${result.loaded.join(', ')}`);
        if (result.errors.length) {
            for (const err of result.errors)
                console.error(`  error: ${err}`);
        }
        break;
    }
    case 'codex': {
        if (values.global && values.project) {
            console.error('Error: --global and --project are mutually exclusive');
            process.exit(2);
        }
        const hookScope = values.project ? 'project' : 'global';
        const sub = positionals[1];
        if (sub === 'setup') {
            await codexSetup({
                hooksScope: hookScope,
                hooksFallbackToProject: !values.project,
            });
            break;
        }
        if (sub === 'live' || sub === 'start') {
            await codexLive({
                hooksScope: hookScope,
                hooksFallbackToProject: !values.project,
                listenUrl: values.listen,
                codexArgs: positionals.slice(2),
            });
            break;
        }
        if (sub === 'doctor') {
            await codexDoctor();
            break;
        }
        if (sub !== 'mcp' && sub !== 'hooks') {
            console.error(`Unknown codex subcommand: ${sub ?? '(none)'}\nUsage: agent-awareness codex [setup|live|doctor|mcp|hooks] [install|uninstall|status]`);
            process.exit(2);
        }
        const action = positionals[2];
        if (sub === 'mcp') {
            switch (action) {
                case 'install':
                    await codexMcpInstall();
                    break;
                case 'uninstall':
                    await codexMcpUninstall();
                    break;
                case 'status':
                    await codexMcpStatus();
                    break;
                default:
                    console.error(`Unknown codex mcp subcommand: ${action ?? '(none)'}\nUsage: agent-awareness codex mcp [install|uninstall|status]`);
                    process.exit(2);
            }
            break;
        }
        switch (action) {
            case 'install':
                await codexHooksInstall({
                    scope: hookScope,
                    fallbackToProject: !values.project,
                });
                break;
            case 'uninstall':
                await codexHooksUninstall({ scope: hookScope });
                break;
            case 'status':
                await codexHooksStatus({ scope: hookScope });
                break;
            default:
                console.error(`Unknown codex hooks subcommand: ${action ?? '(none)'}\nUsage: agent-awareness codex hooks [install|uninstall|status] [--global|--project]`);
                process.exit(2);
        }
        break;
    }
    default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(2);
}
