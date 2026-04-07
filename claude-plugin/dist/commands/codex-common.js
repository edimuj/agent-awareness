import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { LEGACY_MCP_ENTRY_KEY, MCP_ENTRY_KEY } from "./codex-mcp.js";
export async function runCodex(args) {
    return new Promise((resolveResult, reject) => {
        const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => resolveResult({ code, stdout, stderr }));
    });
}
export async function getInstalledCodexMcpEntry() {
    const primary = await runCodex(['mcp', 'get', MCP_ENTRY_KEY]);
    if (primary.code === 0)
        return { key: MCP_ENTRY_KEY, stdout: primary.stdout };
    if (primary.code !== 1) {
        throw new Error(primary.stderr.trim() || `codex mcp get ${MCP_ENTRY_KEY} failed (exit ${primary.code ?? 'unknown'})`);
    }
    const legacy = await runCodex(['mcp', 'get', LEGACY_MCP_ENTRY_KEY]);
    if (legacy.code === 0)
        return { key: LEGACY_MCP_ENTRY_KEY, stdout: legacy.stdout };
    if (legacy.code !== 1) {
        throw new Error(legacy.stderr.trim() || `codex mcp get ${LEGACY_MCP_ENTRY_KEY} failed (exit ${legacy.code ?? 'unknown'})`);
    }
    return null;
}
export function parseCodexMcpEntry(entry) {
    const commandMatch = entry.stdout.match(/^\s*command:\s+(.+)$/m);
    const argsMatch = entry.stdout.match(/^\s*args:\s+(.+)$/m);
    const commandRaw = commandMatch?.[1]?.trim() ?? null;
    const argsRaw = argsMatch?.[1]?.trim() ?? '';
    const args = (!argsRaw || argsRaw === '-')
        ? []
        : argsRaw.split(/\s+/).filter(Boolean);
    return {
        key: entry.key,
        command: commandRaw === '-' ? null : commandRaw,
        args,
    };
}
export function resolveConfiguredScriptPath(parsed, cwd) {
    if (parsed.args.length === 0)
        return null;
    const firstArg = parsed.args[0];
    return isAbsolute(firstArg) ? firstArg : resolve(cwd, firstArg);
}
export async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function smokeCodexMcpTools(command, args, cwd) {
    const transport = new StdioClientTransport({ command, args, cwd });
    const client = new Client({ name: 'agent-awareness-codex-smoke', version: '0.0.1' });
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        const toolCount = listed.tools?.length ?? 0;
        if (toolCount === 0) {
            return { ok: false, toolCount: 0, doctorText: null, error: 'MCP listed zero tools' };
        }
        const hasDoctor = listed.tools?.some(t => t.name === 'awareness_doctor') ?? false;
        if (!hasDoctor) {
            return { ok: false, toolCount, doctorText: null, error: 'awareness_doctor tool not found' };
        }
        const called = await client.request({
            method: 'tools/call',
            params: { name: 'awareness_doctor', arguments: {} },
        }, CallToolResultSchema);
        const doctorText = (called.content ?? [])
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('\n')
            .trim();
        if (called.isError) {
            return { ok: false, toolCount, doctorText: doctorText || null, error: 'awareness_doctor returned isError=true' };
        }
        return {
            ok: true,
            toolCount,
            doctorText: doctorText || null,
            error: null,
        };
    }
    catch (err) {
        return {
            ok: false,
            toolCount: 0,
            doctorText: null,
            error: err.message,
        };
    }
    finally {
        await transport.close().catch(() => { });
    }
}
