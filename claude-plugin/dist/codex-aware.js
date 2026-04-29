#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { codexLive } from "./commands/codex-live.js";
const USAGE = `codex-aware — start Codex with live agent-awareness context

Usage:
  codex-aware [--listen ws://127.0.0.1:PORT] [-- <codex args...>]

Examples:
  codex-aware
  codex-aware -- --model gpt-5.4
  codex-aware -- --ask-for-approval never --sandbox workspace-write
`;
const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h', default: false },
        listen: { type: 'string' },
        global: { type: 'boolean', default: false },
        project: { type: 'boolean', default: false },
    },
});
if (values.help) {
    console.log(USAGE);
    process.exit(0);
}
if (values.global && values.project) {
    console.error('Error: --global and --project are mutually exclusive');
    process.exit(2);
}
await codexLive({
    hooksScope: values.project ? 'project' : 'global',
    hooksFallbackToProject: !values.project,
    listenUrl: values.listen,
    codexArgs: positionals,
});
