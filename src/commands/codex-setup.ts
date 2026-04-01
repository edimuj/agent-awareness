import { codexHooksFeatureAvailable, codexHooksInstall } from './codex-hooks.ts';
import { codexMcpInstall, resolveServerScript } from './codex-mcp.ts';
import {
  getInstalledCodexMcpEntry,
  parseCodexMcpEntry,
  smokeCodexMcpTools,
} from './codex-common.ts';

export async function codexSetup(): Promise<void> {
  // 1. MCP installation (required)
  process.exitCode = undefined;
  await codexMcpInstall();
  if (process.exitCode && process.exitCode !== 0) return;

  // 2. Hooks installation (optional, feature-gated)
  const hooksAvailable = await codexHooksFeatureAvailable();
  if (hooksAvailable === true) {
    process.exitCode = undefined;
    await codexHooksInstall();
    if (process.exitCode && process.exitCode !== 0) return;
  } else if (hooksAvailable === false) {
    console.log('Codex hooks feature not available in this Codex build — skipping hooks install.');
  } else {
    console.log('Could not inspect Codex feature flags — skipping hooks install.');
  }

  // 3. Smoke test MCP tools/list + awareness_doctor call
  const installed = await getInstalledCodexMcpEntry();
  if (!installed) {
    console.error('Codex MCP server is not installed after setup.');
    process.exitCode = 1;
    return;
  }

  const parsed = parseCodexMcpEntry(installed);
  const command = parsed.command ?? 'node';
  const args = parsed.args.length > 0 ? parsed.args : [await resolveServerScript()];

  const smoke = await smokeCodexMcpTools(command, args, process.cwd());
  if (!smoke.ok) {
    console.error(`Codex MCP smoke test failed: ${smoke.error ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  const doctorHeadline = smoke.doctorText?.split('\n')[0] ?? 'awareness_doctor';
  console.log(`Codex setup complete. MCP smoke passed (${smoke.toolCount} tools, ${doctorHeadline}).`);
  console.log('Restart Codex sessions to pick up any new hook or MCP configuration.');
}
