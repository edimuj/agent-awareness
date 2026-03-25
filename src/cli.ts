#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { create } from './commands/create.ts';
import { list } from './commands/list.ts';

const USAGE = `agent-awareness — modular awareness plugins for AI coding agents

Commands:
  create <name>     Scaffold a new awareness plugin
  list              Show all discovered plugins and their status

Options:
  --help, -h        Show this help

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
      description: values.description,
      triggers: (values.triggers ?? 'session-start,interval:10m').split(',').map(t => t.trim()),
    });
    break;
  }
  case 'list': {
    await list();
    break;
  }
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(2);
}
