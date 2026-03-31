#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { create } from './commands/create.ts';
import { doctor } from './commands/doctor.ts';
import { list } from './commands/list.ts';
import { mcpInstall, mcpUninstall, mcpStatus } from './commands/mcp.ts';

const USAGE = `agent-awareness — modular awareness plugins for AI coding agents

Commands:
  create <name>     Scaffold a new awareness plugin
  doctor            Diagnose plugin loading, config, and log status
  list              Show all discovered plugins and their status
  mcp install       Add MCP server to Claude Code config
  mcp uninstall     Remove MCP server from Claude Code config
  mcp status        Show MCP server configuration status

Options:
  --help, -h        Show this help

Create options:
  --local           Create as a local plugin (~/.config/agent-awareness/plugins/)
  --mcp             Include MCP tool scaffolding for real-time interaction
  --description     Plugin description (default: prompted)
  --triggers        Comma-separated triggers (default: session-start,interval:10m)
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    local: { type: 'boolean', default: false },
    mcp: { type: 'boolean', default: false },
    description: { type: 'string' },
    triggers: { type: 'string', default: 'session-start,interval:10m' },
  },
});

const command = positionals[0];

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
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
      mcp: values.mcp ?? false,
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
  case 'mcp': {
    const sub = positionals[1];
    switch (sub) {
      case 'install':
        await mcpInstall();
        break;
      case 'uninstall':
        await mcpUninstall();
        break;
      case 'status':
        await mcpStatus();
        break;
      default:
        console.error(`Unknown mcp subcommand: ${sub ?? '(none)'}\nUsage: agent-awareness mcp [install|uninstall|status]`);
        process.exit(2);
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(2);
}
