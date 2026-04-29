#!/usr/bin/env node
/**
 * agent-awareness MCP server — thin adapter (Tier 2).
 *
 * Connects to the central daemon via SSE and forwards plugin results
 * to Claude Code via channel notifications. No ticker, no plugin loading.
 *
 * Usage: node src/mcp/server.ts
 */
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { ensureServer, connectSSE, getDoctorFromDaemon } from "../daemon/client.js";
const SESSION_ID = `mcp-${process.pid}-${Date.now()}`;
const CHANNEL_INSTRUCTIONS = [
    'Context updates from agent-awareness plugins arrive as <channel source="agent-awareness" plugin="..." severity="...">.',
    'These are one-way status updates — no reply expected.',
    'React to warnings and critical alerts proactively.',
    'Info-level updates provide ambient awareness context.',
].join(' ');
// Module-level daemon info — set after transport is connected
let daemon = null;
async function main() {
    // Create MCP server with channel capability
    const server = new Server({ name: 'agent-awareness', version: '0.1.0' }, {
        capabilities: {
            tools: {},
            resources: {},
            experimental: { 'claude/channel': {} },
        },
        instructions: CHANNEL_INSTRUCTIONS,
    });
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
                inputSchema: { type: 'object', properties: {} },
            }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === 'awareness_doctor') {
            let text;
            // Lazy-connect to daemon if not yet connected
            if (!daemon)
                daemon = await ensureServer();
            if (daemon) {
                try {
                    text = await getDoctorFromDaemon(daemon);
                }
                catch (err) {
                    text = `Failed to reach daemon: ${err.message}`;
                }
            }
            else {
                text = 'Daemon not available. Check: cat ~/.cache/agent-awareness/daemon.pid';
            }
            return { content: [{ type: 'text', text }] };
        }
        return {
            content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
            isError: true,
        };
    });
    // Start MCP transport FIRST — must complete before any stdout writes
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // NOW connect to daemon (after transport is ready for notifications)
    daemon = await ensureServer();
    if (daemon) {
        connectAndForward(server, daemon);
    }
    else {
        console.error('[agent-awareness-mcp] failed to connect to daemon');
    }
    // Clean shutdown
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
}
// --- SSE → Channel forwarding ---
const channelSeen = new Map();
async function connectAndForward(server, daemonInfo) {
    // Re-resolve daemon on every connect (port may have changed after restart)
    const info = daemonInfo ?? await ensureServer();
    if (!info) {
        console.error('[agent-awareness-mcp] no daemon available, retry in 30s');
        setTimeout(() => connectAndForward(server), 30_000);
        return;
    }
    daemon = info; // update module-level ref for doctor tool
    const stream = await connectSSE(info, SESSION_ID, 'claude-code');
    if (!stream) {
        console.error('[agent-awareness-mcp] failed to connect SSE stream, retry in 10s');
        setTimeout(() => connectAndForward(server), 10_000);
        return;
    }
    let buffer = '';
    stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? ''; // keep incomplete part
        for (const part of parts) {
            const lines = part.split('\n');
            let eventType = '';
            let data = '';
            for (const line of lines) {
                if (line.startsWith('event: '))
                    eventType = line.slice(7);
                else if (line.startsWith('data: '))
                    data += line.slice(6);
                else if (line.startsWith(':'))
                    continue; // comment
            }
            if (eventType === 'plugin-result' && data) {
                try {
                    const result = JSON.parse(data);
                    pushToChannel(server, result.plugin, result.text);
                }
                catch { /* bad JSON, skip */ }
            }
        }
    });
    stream.on('end', () => {
        console.error('[agent-awareness-mcp] SSE stream ended, reconnecting...');
        setTimeout(() => connectAndForward(server), 5_000); // re-resolve daemon
    });
    stream.on('error', () => {
        setTimeout(() => connectAndForward(server), 5_000); // re-resolve daemon
    });
}
function pushToChannel(server, pluginName, text) {
    const fingerprint = createHash('sha1').update(`${pluginName}:${text}`).digest('hex');
    // Dedup — same content from same plugin doesn't push twice
    if (channelSeen.get(pluginName) === fingerprint)
        return;
    channelSeen.set(pluginName, fingerprint);
    server.notification({
        method: 'notifications/claude/channel',
        params: {
            content: text,
            meta: { plugin: pluginName.replace(/-/g, '_') },
        },
    }).catch(err => {
        console.error('[agent-awareness-mcp] channel push failed:', err?.message ?? err);
    });
}
main().catch(err => {
    console.error('[agent-awareness-mcp] fatal:', err);
    process.exit(1);
});
