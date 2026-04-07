import { codexHooksFeatureAvailable, codexHooksFeatureEnabled } from "./codex-hooks.js";
import { getInstalledCodexMcpEntry, parseCodexMcpEntry, pathExists, resolveConfiguredScriptPath, runCodex, smokeCodexMcpTools, } from "./codex-common.js";
import { resolveServerScript } from "./codex-mcp.js";
function printCheck(check) {
    const prefix = check.ok ? '  OK' : '  FAIL';
    console.log(`${prefix} ${check.name}: ${check.detail}`);
}
export async function codexDoctor() {
    const checks = [];
    // Codex CLI present
    const version = await runCodex(['--version']).catch(() => null);
    if (!version || version.code !== 0) {
        checks.push({
            name: 'codex-cli',
            ok: false,
            detail: 'Codex CLI not available in PATH',
        });
        for (const check of checks)
            printCheck(check);
        process.exitCode = 1;
        return;
    }
    checks.push({
        name: 'codex-cli',
        ok: true,
        detail: version.stdout.trim() || 'available',
    });
    // Hooks feature status (optional capability)
    const hooksAvailable = await codexHooksFeatureAvailable();
    const hooksEnabled = await codexHooksFeatureEnabled();
    if (hooksAvailable === null || hooksEnabled === null) {
        checks.push({
            name: 'codex-hooks-feature',
            ok: false,
            detail: 'Could not inspect feature flags (codex features list failed)',
        });
    }
    else if (!hooksAvailable) {
        checks.push({
            name: 'codex-hooks-feature',
            ok: true,
            detail: 'not available in this Codex build (hooks optional)',
        });
    }
    else {
        checks.push({
            name: 'codex-hooks-feature',
            ok: true,
            detail: hooksEnabled ? 'available and enabled' : 'available but disabled',
        });
    }
    // MCP registration
    let parsed = null;
    try {
        const entry = await getInstalledCodexMcpEntry();
        if (!entry) {
            checks.push({
                name: 'codex-mcp-entry',
                ok: false,
                detail: 'not installed (run: agent-awareness codex mcp install)',
            });
        }
        else {
            parsed = parseCodexMcpEntry(entry);
            checks.push({
                name: 'codex-mcp-entry',
                ok: true,
                detail: `${parsed.key} (${parsed.command ?? 'unknown command'})`,
            });
        }
    }
    catch (err) {
        checks.push({
            name: 'codex-mcp-entry',
            ok: false,
            detail: err.message,
        });
    }
    // MCP script path validity
    let scriptPath = null;
    if (parsed) {
        scriptPath = resolveConfiguredScriptPath(parsed, process.cwd());
        if (!scriptPath) {
            checks.push({
                name: 'codex-mcp-script',
                ok: false,
                detail: 'could not resolve configured script path from codex mcp get output',
            });
        }
        else {
            const exists = await pathExists(scriptPath);
            checks.push({
                name: 'codex-mcp-script',
                ok: exists,
                detail: exists ? scriptPath : `missing: ${scriptPath}`,
            });
        }
    }
    // MCP runtime smoke test (list tools + awareness_doctor call)
    if (parsed) {
        const command = parsed.command ?? 'node';
        const args = parsed.args.length > 0 ? parsed.args : [await resolveServerScript()];
        const smoke = await smokeCodexMcpTools(command, args, process.cwd());
        checks.push({
            name: 'codex-mcp-smoke',
            ok: smoke.ok,
            detail: smoke.ok
                ? `${smoke.toolCount} tools visible; awareness_doctor callable`
                : (smoke.error ?? 'unknown error'),
        });
    }
    console.log('agent-awareness codex doctor');
    console.log('');
    for (const check of checks)
        printCheck(check);
    const failed = checks.filter(check => !check.ok).length;
    console.log('');
    if (failed === 0) {
        console.log(`Status: healthy — ${checks.length} checks passed.`);
    }
    else {
        console.log(`Status: degraded — ${failed}/${checks.length} checks failed.`);
        process.exitCode = 1;
    }
}
