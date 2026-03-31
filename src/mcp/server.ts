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
} from '@modelcontextprotocol/sdk/types.js';
import { Registry } from '../core/registry.ts';
import { PluginDispatcher } from '../core/dispatcher.ts';
import { loadPlugins } from '../core/loader.ts';
import { loadState, getPluginState, setPluginState, withState } from '../core/state.ts';
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

  if (toolMap.size === 0) {
    console.error('[agent-awareness-mcp] No plugins with MCP tools found.');
  }

  // Create low-level server with tools capability
  const server = new Server(
    { name: 'agent-awareness', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

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

main().catch(err => {
  console.error('[agent-awareness-mcp] Fatal:', err);
  process.exit(1);
});
