/**
 * MCP install/uninstall commands.
 *
 * Manages the .mcp.json file that Claude Code reads to discover MCP servers.
 * Install adds the agent-awareness MCP server entry.
 * Uninstall removes it.
 *
 * Location: writes to $CLAUDE_CONFIG_DIR/.mcp.json if in a rig,
 * otherwise ~/.claude/.mcp.json — same resolution Claude Code uses.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SERVER_SCRIPT = join(PROJECT_ROOT, 'src', 'mcp', 'server.ts');

const MCP_ENTRY_KEY = 'agent-awareness';

function getMcpJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, '.mcp.json');
}

async function loadMcpJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { mcpServers: {} };
  }
}

async function saveMcpJson(path: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function mcpInstall(): Promise<void> {
  const path = getMcpJsonPath();
  const config = await loadMcpJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (servers[MCP_ENTRY_KEY]) {
    console.log(`MCP server "${MCP_ENTRY_KEY}" already configured in ${path}`);
    return;
  }

  servers[MCP_ENTRY_KEY] = {
    command: 'node',
    args: [SERVER_SCRIPT],
    type: 'stdio',
  };

  config.mcpServers = servers;
  await saveMcpJson(path, config);
  console.log(`MCP server installed: ${path}`);
  console.log(`  command: node ${SERVER_SCRIPT}`);
  console.log(`  Restart Claude Code to pick up the new MCP server.`);
}

export async function mcpUninstall(): Promise<void> {
  const path = getMcpJsonPath();
  const config = await loadMcpJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (!servers[MCP_ENTRY_KEY]) {
    console.log(`MCP server "${MCP_ENTRY_KEY}" not found in ${path}`);
    return;
  }

  delete servers[MCP_ENTRY_KEY];
  config.mcpServers = servers;
  await saveMcpJson(path, config);
  console.log(`MCP server removed from ${path}`);
}

export async function mcpStatus(): Promise<void> {
  const path = getMcpJsonPath();
  const config = await loadMcpJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (servers[MCP_ENTRY_KEY]) {
    console.log(`MCP server: installed`);
    console.log(`  config: ${path}`);
    const entry = servers[MCP_ENTRY_KEY] as Record<string, unknown>;
    console.log(`  command: ${entry.command} ${(entry.args as string[]).join(' ')}`);
  } else {
    console.log(`MCP server: not installed`);
    console.log(`  Run "agent-awareness mcp install" to set up`);
  }
}
