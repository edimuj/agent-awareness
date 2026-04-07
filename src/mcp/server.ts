#!/usr/bin/env node

/**
 * agent-awareness MCP server (Tier 2).
 *
 * Stdio transport for Claude Code integration.
 * Declares claude/channel capability for real-time context push.
 * Runs the ticker loop internally — handles all interval/change triggers.
 *
 * Tier 2: startup hook provides initial context, MCP handles everything else.
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
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { Registry } from '../core/registry.ts';
import { loadPlugins } from '../core/loader.ts';
import { initStateDir, STATE_DIR, writeTickerPid, clearTickerPid, saveChannelSeen, clearChannelSeen, loadState } from '../core/state.ts';
import { setupTicker, tick } from '../daemon/tick-loop.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

const CHANNEL_INSTRUCTIONS = [
  'Context updates from agent-awareness plugins arrive as <channel source="agent-awareness" plugin="..." severity="...">.',
  'These are one-way status updates — no reply expected.',
  'React to warnings and critical alerts proactively.',
  'Info-level updates provide ambient awareness context.',
].join(' ');

async function main(): Promise<void> {
  await initStateDir('claude-code');

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

  // Create MCP server with channel capability
  const server = new Server(
    { name: 'agent-awareness', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  // Empty resource lists so clients don't fail discovery
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  // MCP tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'awareness_doctor',
      description: 'Diagnose agent-awareness health — shows loaded/failed plugins, config paths, log location, and actionable hints',
      inputSchema: { type: 'object' as const, properties: {} },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'awareness_doctor') {
      return {
        content: [{ type: 'text' as const, text: await runDoctor(registry, errors) }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  });

  // Start transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start internal ticker
  await startInternalTicker(server);

  // Clean shutdown
  const cleanup = async () => {
    if (tickerTimer) clearInterval(tickerTimer);
    await clearTickerPid();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

let tickerTimer: ReturnType<typeof setInterval> | null = null;

async function startInternalTicker(server: Server): Promise<void> {
  // setupTicker calls initStateDir internally, but it's already done above
  const setup = await setupTicker('claude-code');
  if (!setup) return;

  const { registry, schedules, tickMs, context } = setup;

  if (process.pid) {
    await writeTickerPid(process.pid);
  }

  // Channel deduplication
  const channelSeen = new Map<string, string>();
  let lastSessionStartedAt = '';

  const onResult = async (pluginName: string, text: string) => {
    const fingerprint = hashFingerprint(`${pluginName}:${text}`);

    if (channelSeen.get(fingerprint) === text) return;
    channelSeen.set(fingerprint, text);

    // Push via channel
    server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { plugin: pluginName.replace(/-/g, '_') },
      },
    }).catch(() => { /* channel not active */ });

    // Persist for prompt hook dedup (if prompt hook is also active)
    saveChannelSeen(Object.fromEntries(channelSeen)).catch(() => {});
  };

  // Detect session resets
  const checkSessionReset = async () => {
    try {
      const state = await loadState();
      const meta = state.__agent_awareness_meta_claude_code as
        { sessionStartedAt?: string } | undefined;
      const current = meta?.sessionStartedAt ?? '';
      if (lastSessionStartedAt && current !== lastSessionStartedAt) {
        channelSeen.clear();
        await clearChannelSeen();
      }
      lastSessionStartedAt = current;
    } catch { /* skip */ }
  };

  // Initial tick
  await checkSessionReset();
  await tick(registry, schedules, context, { onResult });

  // Periodic ticks
  tickerTimer = setInterval(async () => {
    await checkSessionReset();
    await tick(registry, schedules, context, { onResult });
  }, tickMs);
}

function hashFingerprint(raw: string): string {
  return createHash('sha1').update(raw).digest('hex');
}

async function runDoctor(
  registry: Registry,
  loadErrors: Array<{ source: string; error: string }>,
): Promise<string> {
  const lines: string[] = ['agent-awareness doctor', ''];

  let globalRoot: string | null = null;
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* npm not available */ }

  lines.push('Plugin sources:');
  lines.push(`  builtin:  ${join(PROJECT_ROOT, 'src', 'plugins')}`);
  lines.push(`  npm:      ${join(PROJECT_ROOT, 'node_modules')}`);
  lines.push(`  global:   ${globalRoot ?? '(npm root -g failed)'}`);
  lines.push(`  local:    ${join(homedir(), '.config', 'agent-awareness', 'plugins')}`);

  lines.push('', 'Paths:');
  lines.push(`  state:  ${STATE_DIR}`);

  const logFile = join(STATE_DIR, 'agent-awareness.log');
  lines.push(`  log:    ${logFile}`);
  const logStat = await stat(logFile).catch(() => null);
  if (logStat) {
    lines.push(`          (${(logStat.size / 1024).toFixed(1)} KB, modified: ${logStat.mtime.toISOString().slice(0, 19)})`);
  }

  const enabled = registry.getEnabledPlugins();
  lines.push('', `Loaded (${enabled.length}):`);
  for (const plugin of enabled) {
    lines.push(`  OK  ${plugin.name}`);
  }

  lines.push('', `Ticker: ${tickerTimer ? 'running (internal)' : 'not started'}`);

  const realErrors = loadErrors.filter(e => !e.source.includes('.test.'));
  if (realErrors.length > 0) {
    lines.push('', `Errors (${realErrors.length}):`);
    for (const { source, error } of realErrors) {
      const shortError = error.length > 120 ? error.slice(0, 117) + '...' : error;
      lines.push(`  FAIL ${source}: ${shortError}`);
    }
  }

  const total = enabled.length + realErrors.length;
  const status = realErrors.length === 0 ? 'healthy' : 'degraded';
  lines.push('', `Status: ${status} — ${enabled.length} loaded, ${realErrors.length} failed (${total} discovered)`);

  return lines.join('\n');
}

main().catch(err => {
  console.error('[agent-awareness-mcp] Fatal:', err);
  process.exit(1);
});
