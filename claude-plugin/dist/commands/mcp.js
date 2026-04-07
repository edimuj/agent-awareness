/**
 * MCP install/uninstall commands.
 *
 * Manages the .mcp.json file at the plugin root (next to .claude-plugin/).
 * Claude Code discovers MCP servers from installed plugin directories,
 * not from the rig config dir.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const MCP_JSON_PATH = join(PROJECT_ROOT, '.mcp.json');
const SERVER_SCRIPT = '${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts';
const MCP_ENTRY_KEY = 'agent-awareness';
async function loadMcpJson() {
    try {
        return JSON.parse(await readFile(MCP_JSON_PATH, 'utf8'));
    }
    catch {
        return {};
    }
}
async function saveMcpJson(data) {
    await writeFile(MCP_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
export async function mcpInstall() {
    const config = await loadMcpJson();
    if (config[MCP_ENTRY_KEY]) {
        console.log(`MCP server "${MCP_ENTRY_KEY}" already configured in ${MCP_JSON_PATH}`);
        return;
    }
    config[MCP_ENTRY_KEY] = {
        type: 'stdio',
        command: 'node',
        args: [SERVER_SCRIPT],
    };
    await saveMcpJson(config);
    console.log(`MCP server installed: ${MCP_JSON_PATH}`);
    console.log(`  command: node ${SERVER_SCRIPT}`);
    console.log(`  Restart Claude Code to pick up the new MCP server.`);
}
export async function mcpUninstall() {
    const config = await loadMcpJson();
    if (!config[MCP_ENTRY_KEY]) {
        console.log(`MCP server "${MCP_ENTRY_KEY}" not found in ${MCP_JSON_PATH}`);
        return;
    }
    delete config[MCP_ENTRY_KEY];
    await saveMcpJson(config);
    console.log(`MCP server removed from ${MCP_JSON_PATH}`);
}
export async function mcpStatus() {
    const config = await loadMcpJson();
    if (config[MCP_ENTRY_KEY]) {
        console.log(`MCP server: installed`);
        console.log(`  config: ${MCP_JSON_PATH}`);
        const entry = config[MCP_ENTRY_KEY];
        console.log(`  command: ${entry.command} ${entry.args.join(' ')}`);
    }
    else {
        console.log(`MCP server: not installed`);
        console.log(`  Run "agent-awareness mcp install" to set up`);
    }
}
