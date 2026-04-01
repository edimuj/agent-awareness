#!/usr/bin/env node

/**
 * agent-awareness MCP server.
 *
 * Stdio transport — designed for Claude Code integration.
 * Auto-discovers plugins with mcp.tools defined, registers them as
 * MCP tools with scoped names (awareness_<plugin>_<tool>), and routes
 * calls through the PluginDispatcher for timeout + queue protection.
 *
 * Uses the low-level Server class (not McpServer) to support plain
 * JSON Schema input definitions without requiring Zod.
 *
 * Usage: node src/mcp/server.ts
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Registry } from '../core/registry.ts';
import { PluginDispatcher } from '../core/dispatcher.ts';
import { loadPlugins } from '../core/loader.ts';
import { loadState, getPluginState, setPluginState, withState, STATE_DIR } from '../core/state.ts';
import type { McpToolDef, PluginState } from '../core/types.ts';
import { createClaimContext } from '../core/claims.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

const dispatcher = new PluginDispatcher();

/** Scope a tool name: awareness_<plugin>_<tool> */
function scopedName(pluginName: string, toolName: string): string {
  return `awareness_${pluginName.replace(/-/g, '_')}_${toolName}`;
}

async function main(): Promise<void> {
  // Load plugins and config
  const registry = new Registry();
  const { plugins, errors } = await loadPlugins();

  for (const plugin of plugins) {
    registry.register(plugin);
  }
  for (const { source, error } of errors) {
    console.error(`[agent-awareness-mcp] ${source}: ${error}`);
  }

  await registry.loadConfig(DEFAULT_CONFIG);

  // Configure per-plugin dispatcher limits
  for (const plugin of registry.getEnabledPlugins()) {
    const config = registry.getPluginConfig(plugin.name);
    if (config?.timeout || config?.maxQueue) {
      dispatcher.configure(plugin.name, {
        timeout: config.timeout as number | undefined,
        maxQueue: config.maxQueue as number | undefined,
      });
    }
  }

  // Collect all MCP tools from enabled plugins
  const toolMap = new Map<string, { pluginName: string; tool: McpToolDef }>();

  for (const plugin of registry.getEnabledPlugins()) {
    if (!plugin.mcp?.tools?.length) continue;

    for (const tool of plugin.mcp.tools) {
      const scoped = scopedName(plugin.name, tool.name);
      toolMap.set(scoped, { pluginName: plugin.name, tool });
    }
  }

  // Built-in doctor tool — always available
  toolMap.set('awareness_doctor', {
    pluginName: '_builtin',
    tool: {
      name: 'doctor',
      description: 'Diagnose agent-awareness health — shows loaded/failed plugins, config paths, log location, and actionable hints',
      inputSchema: { type: 'object' as const, properties: {} },
      async handler() {
        return { text: await runDoctor(registry, errors), state: {} };
      },
    },
  });

  if (toolMap.size <= 1) {
    console.error('[agent-awareness-mcp] No plugins with MCP tools found.');
  }

  // Create low-level server with tools + resources capabilities
  const server = new Server(
    { name: 'agent-awareness', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Advertise empty resource lists so MCP clients don't fail discovery on "Method not found".
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  // Handle tools/list — return all registered tools with JSON Schema
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...toolMap.entries()].map(([scoped, { tool }]) => ({
      name: scoped,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // Handle tools/call — route through dispatcher
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = toolMap.get(name);

    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const { pluginName, tool } = entry;

    await registry.refreshConfigIfStale();
    const config = registry.getPluginConfig(pluginName)!;
    const preState = await loadState();
    const prevState = getPluginState(preState, pluginName);

    const result = await dispatcher.dispatch(pluginName, (signal) =>
      tool.handler(args ?? {}, config, signal, prevState),
    );

    // Atomic state update under lock
    if (result?.state) {
      await withState((state: PluginState) =>
        setPluginState(state, pluginName, result.state),
      );
    }

    return {
      content: [{
        type: 'text' as const,
        text: result?.text ?? `[${pluginName}] No response (timeout or error)`,
      }],
    };
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Generate doctor report as text (for MCP tool output). */
async function runDoctor(
  registry: Registry,
  loadErrors: Array<{ source: string; error: string }>,
): Promise<string> {
  const lines: string[] = ['agent-awareness doctor', ''];

  // Plugin sources
  let globalRoot: string | null = null;
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* npm not available */ }

  lines.push('Plugin sources:');
  lines.push(`  builtin:  ${join(PROJECT_ROOT, 'src', 'plugins')}`);
  lines.push(`  npm:      ${join(PROJECT_ROOT, 'node_modules')}`);
  lines.push(`  global:   ${globalRoot ?? '(npm root -g failed)'}`);
  lines.push(`  local:    ${join(homedir(), '.config', 'agent-awareness', 'plugins')}`);

  // Paths
  const logFile = join(STATE_DIR, 'agent-awareness.log');
  lines.push('', 'Paths:');
  lines.push(`  state:  ${STATE_DIR}`);
  lines.push(`  log:    ${logFile}`);

  const logStat = await stat(logFile).catch(() => null);
  if (logStat) {
    lines.push(`          (${(logStat.size / 1024).toFixed(1)} KB, modified: ${logStat.mtime.toISOString().slice(0, 19)})`);
  }

  // Loaded plugins
  const enabled = registry.getEnabledPlugins();
  lines.push('', `Loaded (${enabled.length}):`);
  for (const plugin of enabled) {
    const mcpCount = plugin.mcp?.tools?.length ?? 0;
    const mcpStr = mcpCount > 0 ? ` [${mcpCount} MCP]` : '';
    lines.push(`  OK  ${plugin.name}${mcpStr}`);
  }

  // Errors
  const realErrors = loadErrors.filter(e => !e.source.includes('.test.'));
  if (realErrors.length > 0) {
    lines.push('', `Errors (${realErrors.length}):`);
    for (const { source, error } of realErrors) {
      const shortError = error.length > 120 ? error.slice(0, 117) + '...' : error;
      lines.push(`  FAIL ${source}: ${shortError}`);
    }
  }

  // Summary
  const total = enabled.length + realErrors.length;
  const status = realErrors.length === 0 ? 'healthy' : 'degraded';
  lines.push('', `Status: ${status} — ${enabled.length} loaded, ${realErrors.length} failed (${total} discovered)`);

  return lines.join('\n');
}

main().catch(err => {
  console.error('[agent-awareness-mcp] Fatal:', err);
  process.exit(1);
});
