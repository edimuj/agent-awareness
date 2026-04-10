import { codexHooksFeatureAvailable, codexHooksFeatureEnabled } from './codex-hooks.ts';
import {
  getInstalledCodexMcpEntry,
  parseCodexMcpEntry,
  pathExists,
  resolveConfiguredScriptPath,
  runCodex,
  smokeCodexMcpTools,
} from './codex-common.ts';
import { resolveServerScript } from './codex-mcp.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function renderCheck(check: Check): string {
  const prefix = check.ok ? '  OK' : '  FAIL';
  return `${prefix} ${check.name}: ${check.detail}`;
}

export async function collectCodexDoctorChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const version = await runCodex(['--version']).catch(() => null);
  if (!version || version.code !== 0) {
    return [{
      name: 'codex-cli',
      ok: false,
      detail: 'Codex CLI not available in PATH',
    }];
  }

  checks.push({
    name: 'codex-cli',
    ok: true,
    detail: version.stdout.trim() || 'available',
  });

  const hooksAvailable = await codexHooksFeatureAvailable();
  const hooksEnabled = await codexHooksFeatureEnabled();
  if (hooksAvailable === null || hooksEnabled === null) {
    checks.push({
      name: 'codex-hooks-feature',
      ok: false,
      detail: 'Could not inspect feature flags (codex features list failed)',
    });
  } else if (!hooksAvailable) {
    checks.push({
      name: 'codex-hooks-feature',
      ok: false,
      detail: 'not available in this Codex build',
    });
  } else if (!hooksEnabled) {
    checks.push({
      name: 'codex-hooks-feature',
      ok: false,
      detail: 'available but disabled (run: agent-awareness codex setup)',
    });
  } else {
    checks.push({
      name: 'codex-hooks-feature',
      ok: true,
      detail: 'available and enabled',
    });
  }

  let parsed: ReturnType<typeof parseCodexMcpEntry> | null = null;
  try {
    const entry = await getInstalledCodexMcpEntry();
    if (!entry) {
      checks.push({
        name: 'codex-mcp-entry',
        ok: true,
        detail: 'not installed (optional for Codex)',
      });
    } else {
      parsed = parseCodexMcpEntry(entry);
      checks.push({
        name: 'codex-mcp-entry',
        ok: true,
        detail: `${parsed.key} (${parsed.command ?? 'unknown command'})`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'codex-mcp-entry',
      ok: false,
      detail: (err as Error).message,
    });
  }

  let scriptPath: string | null = null;
  if (parsed) {
    scriptPath = resolveConfiguredScriptPath(parsed, process.cwd());
    if (!scriptPath) {
      checks.push({
        name: 'codex-mcp-script',
        ok: false,
        detail: 'could not resolve configured script path from codex mcp get output',
      });
    } else {
      const exists = await pathExists(scriptPath);
      checks.push({
        name: 'codex-mcp-script',
        ok: exists,
        detail: exists ? scriptPath : `missing: ${scriptPath}`,
      });
    }
  }

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

  return checks;
}

export function formatCodexDoctorReport(checks: Check[]): { text: string; failed: number } {
  const failed = checks.filter(check => !check.ok).length;
  const lines: string[] = ['agent-awareness codex doctor', ''];

  for (const check of checks) {
    lines.push(renderCheck(check));
  }

  lines.push('');
  if (failed === 0) {
    lines.push(`Status: healthy — ${checks.length} checks passed.`);
  } else {
    lines.push(`Status: degraded — ${failed}/${checks.length} checks failed.`);
  }

  return { text: lines.join('\n'), failed };
}

export async function codexDoctorReport(): Promise<{ text: string; failed: number }> {
  return formatCodexDoctorReport(await collectCodexDoctorChecks());
}

export async function codexDoctor(): Promise<void> {
  const report = await codexDoctorReport();
  console.log(report.text);
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}
