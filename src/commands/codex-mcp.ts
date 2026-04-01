/**
 * Codex MCP install/uninstall/status commands.
 *
 * Uses the Codex CLI MCP manager so the server is registered in
 * ~/.codex/config.toml under mcp_servers.<name>.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DIST_SERVER_SCRIPT = join(PROJECT_ROOT, 'dist', 'mcp', 'server.js');
const SRC_SERVER_SCRIPT = join(PROJECT_ROOT, 'src', 'mcp', 'server.ts');
export const MCP_ENTRY_KEY = 'agent_awareness';
export const LEGACY_MCP_ENTRY_KEY = 'agent-awareness';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCodex(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function printCodexMissingHelp(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error('Codex CLI not found in PATH.');
    console.error('Install or expose `codex` first, then rerun this command.');
    return;
  }
  console.error(`Failed to run Codex CLI: ${(err as Error).message}`);
}

async function getMcpEntry(key: string): Promise<CommandResult> {
  return runCodex(['mcp', 'get', key]);
}

export async function resolveServerScript(): Promise<string> {
  try {
    await stat(DIST_SERVER_SCRIPT);
    return DIST_SERVER_SCRIPT;
  } catch {
    return SRC_SERVER_SCRIPT;
  }
}

export async function codexMcpInstall(): Promise<void> {
  let current: CommandResult;
  let legacy: CommandResult;
  const serverScript = await resolveServerScript();

  try {
    current = await getMcpEntry(MCP_ENTRY_KEY);
    legacy = await getMcpEntry(LEGACY_MCP_ENTRY_KEY);
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  if (current.code === 0) {
    console.log(`Codex MCP server "${MCP_ENTRY_KEY}" is already configured.`);
    if (current.stdout.trim()) console.log(current.stdout.trim());
    return;
  }

  if (current.code !== 1) {
    console.error(`Failed to inspect Codex MCP config (exit ${current.code ?? 'unknown'}).`);
    if (current.stderr.trim()) console.error(current.stderr.trim());
    process.exitCode = 1;
    return;
  }

  if (legacy.code !== 0 && legacy.code !== 1) {
    console.error(`Failed to inspect legacy Codex MCP config (exit ${legacy.code ?? 'unknown'}).`);
    if (legacy.stderr.trim()) console.error(legacy.stderr.trim());
    process.exitCode = 1;
    return;
  }

  const added = await runCodex(['mcp', 'add', MCP_ENTRY_KEY, '--', 'node', serverScript]);
  if (added.code !== 0) {
    console.error(`Failed to add Codex MCP server "${MCP_ENTRY_KEY}" (exit ${added.code ?? 'unknown'}).`);
    if (added.stderr.trim()) console.error(added.stderr.trim());
    process.exitCode = 1;
    return;
  }

  if (legacy.code === 0) {
    const removedLegacy = await runCodex(['mcp', 'remove', LEGACY_MCP_ENTRY_KEY]);
    if (removedLegacy.code !== 0) {
      console.warn(`Warning: installed "${MCP_ENTRY_KEY}" but failed to remove legacy "${LEGACY_MCP_ENTRY_KEY}".`);
      if (removedLegacy.stderr.trim()) console.warn(removedLegacy.stderr.trim());
    } else {
      console.log(`Migrated legacy MCP key "${LEGACY_MCP_ENTRY_KEY}" -> "${MCP_ENTRY_KEY}".`);
    }
  }

  console.log(`Codex MCP server installed: ${MCP_ENTRY_KEY}`);
  console.log(`  command: node ${serverScript}`);
  if (added.stdout.trim()) console.log(added.stdout.trim());
}

export async function codexMcpUninstall(): Promise<void> {
  const keys = [MCP_ENTRY_KEY, LEGACY_MCP_ENTRY_KEY];
  let removedAny = false;

  for (const key of keys) {
    let removed: CommandResult;
    try {
      removed = await runCodex(['mcp', 'remove', key]);
    } catch (err) {
      printCodexMissingHelp(err);
      process.exitCode = 1;
      return;
    }

    if (removed.code === 1) continue;
    if (removed.code !== 0) {
      console.error(`Failed to remove Codex MCP server "${key}" (exit ${removed.code ?? 'unknown'}).`);
      if (removed.stderr.trim()) console.error(removed.stderr.trim());
      process.exitCode = 1;
      return;
    }

    removedAny = true;
    if (removed.stdout.trim()) {
      console.log(removed.stdout.trim());
    } else {
      console.log(`Codex MCP server "${key}" removed.`);
    }
  }

  if (!removedAny) {
    console.log('Codex MCP server: not installed');
  }
}

export async function codexMcpStatus(): Promise<void> {
  let current: CommandResult;
  let legacy: CommandResult;
  try {
    current = await getMcpEntry(MCP_ENTRY_KEY);
    legacy = await getMcpEntry(LEGACY_MCP_ENTRY_KEY);
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  if (current.code === 0) {
    console.log('Codex MCP server: installed');
    if (current.stdout.trim()) console.log(current.stdout.trim());
    return;
  }

  if (current.code !== 1) {
    console.error(`Failed to inspect Codex MCP server status (exit ${current.code ?? 'unknown'}).`);
    if (current.stderr.trim()) console.error(current.stderr.trim());
    process.exitCode = 1;
    return;
  }

  if (legacy.code === 0) {
    console.log('Codex MCP server: installed (legacy key)');
    if (legacy.stdout.trim()) console.log(legacy.stdout.trim());
    console.log(`  Run "agent-awareness codex mcp install" to migrate to "${MCP_ENTRY_KEY}"`);
    return;
  }

  if (legacy.code === 1) {
    console.log('Codex MCP server: not installed');
    console.log('  Run "agent-awareness codex mcp install" to set up');
    return;
  }

  console.error(`Failed to inspect legacy Codex MCP server status (exit ${legacy.code ?? 'unknown'}).`);
  if (legacy.stderr.trim()) console.error(legacy.stderr.trim());
  process.exitCode = 1;
}
