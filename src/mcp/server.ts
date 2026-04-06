#!/usr/bin/env node

/**
 * agent-awareness MCP server.
 *
 * Stdio transport — one-way context injection into Claude Code / Codex sessions.
 * Declares claude/channel capability for real-time push when enabled.
 * Runs the ticker loop internally — no separate daemon needed.
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
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Registry } from '../core/registry.ts';
import { loadPlugins } from '../core/loader.ts';
import { STATE_DIR, writeTickerPid, writeTickerOwner, clearTickerPid, clearTickerOwner, saveChannelSeen, clearChannelSeen, loadState } from '../core/state.ts';
import { setupTicker, tick } from '../daemon/tick-loop.ts';
import { createHash } from 'node:crypto';

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
  // Load plugins and config (needed for doctor diagnostic + ticker)
  const registry = new Registry();
  const { plugins, errors } = await loadPlugins();

  for (const plugin of plugins) {
    registry.register(plugin);
  }
  for (const { source, error } of errors) {
    console.error(`[agent-awareness-mcp] ${source}: ${error}`);
  }

  await registry.loadConfig(DEFAULT_CONFIG);

  // Create server with tools, resources, and channel capabilities
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

  // Advertise empty resource lists so MCP clients don't fail discovery on "Method not found".
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  // Only built-in doctor tool — plugins do NOT register tools here
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

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start internal ticker after MCP connection is established
  await startInternalTicker(server);

  // Clean shutdown
  const cleanup = async () => {
    if (tickerTimer) clearInterval(tickerTimer);
    await clearTickerPid();
    await clearTickerOwner();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

let tickerTimer: ReturnType<typeof setInterval> | null = null;

async function startInternalTicker(server: Server): Promise<void> {
  const setup = await setupTicker('claude-code');
  if (!setup) return; // no interval plugins

  const { registry, schedules, tickMs, context } = setup;

  // Register as ticker owner
  if (process.pid) {
    await writeTickerPid(process.pid);
    await writeTickerOwner('mcp');
  }

  // Channel deduplication — tracks pushed fingerprints in memory + on disk
  const channelSeen = new Map<string, string>();
  let lastSessionStartedAt = '';

  const onResult = async (pluginName: string, text: string) => {
    const fingerprint = hashFingerprint(`${pluginName}:${text}`);

    // Deduplicate: skip if same text was already pushed this session
    if (channelSeen.get(fingerprint) === text) return;
    channelSeen.set(fingerprint, text);

    // Push via channel (silently ignored if not active)
    server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { plugin: pluginName.replace(/-/g, '_'), source: 'agent_awareness' },
      },
    }).catch(() => { /* channel not active or disconnected */ });

    // Persist fingerprints so prompt hook can skip already-pushed data
    const diskSeen = Object.fromEntries(channelSeen);
    saveChannelSeen(diskSeen).catch(() => {});
  };

  // Detect session resets: clear channel-seen when sessionStartedAt changes
  const checkSessionReset = async () => {
    try {
      const state = await loadState();
      const meta = state.__agent_awareness_prompt_meta_claude_code as
        { sessionStartedAt?: string } | undefined;
      const current = meta?.sessionStartedAt ?? '';
      if (lastSessionStartedAt && current !== lastSessionStartedAt) {
        channelSeen.clear();
        await clearChannelSeen();
      }
      lastSessionStartedAt = current;
    } catch { /* state read failed — skip */ }
  };

  // Initial gather
  await checkSessionReset();
  await tick(registry, schedules, context, { onResult });

  // Periodic tick with session reset detection
  tickerTimer = setInterval(async () => {
    await checkSessionReset();
    await tick(registry, schedules, context, { onResult });
  }, tickMs);
}

function hashFingerprint(raw: string): string {
  return createHash('sha1').update(raw).digest('hex');
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
    lines.push(`  OK  ${plugin.name}`);
  }

  // Ticker status
  lines.push('', `Ticker: ${tickerTimer ? 'running (internal)' : 'not started'}`);

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
