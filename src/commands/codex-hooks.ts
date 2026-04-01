/**
 * Codex hooks install/uninstall/status commands.
 *
 * Installs repository-local hooks.json entries for agent-awareness and
 * enables the codex_hooks feature flag via Codex CLI.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const HOOKS_JSON_PATH = join(PROJECT_ROOT, 'hooks.json');

const SESSION_EVENT = 'SessionStart';
const PROMPT_EVENT = 'UserPromptSubmit';

const SESSION_COMMAND = 'node ./hooks/codex-session-start.ts';
const PROMPT_COMMAND = 'node ./hooks/codex-prompt-submit.ts';

const SESSION_TIMEOUT_SECONDS = 15;
const PROMPT_TIMEOUT_SECONDS = 10;

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface HookCommandConfig {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  async?: unknown;
}

interface HookRuleConfig {
  matcher?: unknown;
  hooks?: unknown;
}

interface HooksJsonConfig {
  hooks?: unknown;
}

async function runCodex(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function printCodexMissingHelp(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error('Codex CLI not found in PATH.');
    console.error('Install or expose `codex` first, then rerun this command.');
    return;
  }
  console.error(`Failed to run Codex CLI: ${(err as Error).message}`);
}

function normalizeHooksConfig(raw: unknown): { hooks: Record<string, HookRuleConfig[]> } {
  const asObject = (raw && typeof raw === 'object') ? raw as HooksJsonConfig : {};
  const hooksRaw = asObject.hooks;
  const hooks: Record<string, HookRuleConfig[]> = {};

  if (hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)) {
    for (const [event, value] of Object.entries(hooksRaw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        hooks[event] = value
          .filter(rule => rule && typeof rule === 'object')
          .map(rule => ({ ...(rule as HookRuleConfig) }));
      }
    }
  }

  return { hooks };
}

async function loadHooksConfig(): Promise<{ hooks: Record<string, HookRuleConfig[]> }> {
  try {
    const parsed = JSON.parse(await readFile(HOOKS_JSON_PATH, 'utf8'));
    return normalizeHooksConfig(parsed);
  } catch {
    return { hooks: {} };
  }
}

async function saveHooksConfig(config: { hooks: Record<string, HookRuleConfig[]> }): Promise<void> {
  await writeFile(HOOKS_JSON_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function ruleHooks(rule: HookRuleConfig): HookCommandConfig[] {
  if (!Array.isArray(rule.hooks)) return [];
  return rule.hooks
    .filter(hook => hook && typeof hook === 'object')
    .map(hook => ({ ...(hook as HookCommandConfig) }));
}

function isAgentAwarenessCommand(hook: HookCommandConfig): boolean {
  return hook.type === 'command'
    && typeof hook.command === 'string'
    && (hook.command === SESSION_COMMAND || hook.command === PROMPT_COMMAND);
}

function hasCommandForEvent(
  hooks: Record<string, HookRuleConfig[]>,
  event: string,
  command: string,
): boolean {
  const rules = hooks[event];
  if (!Array.isArray(rules)) return false;
  for (const rule of rules) {
    for (const hook of ruleHooks(rule)) {
      if (hook.type === 'command' && hook.command === command) return true;
    }
  }
  return false;
}

function upsertEventHook(
  hooks: Record<string, HookRuleConfig[]>,
  event: string,
  command: string,
  timeout: number,
): void {
  const rules = Array.isArray(hooks[event]) ? hooks[event] : [];
  hooks[event] = rules;

  for (const rule of rules) {
    const normalizedHooks = ruleHooks(rule);
    if (normalizedHooks.length === 0) continue;
    let touched = false;
    for (const hook of normalizedHooks) {
      if (hook.type === 'command' && hook.command === command) {
        hook.type = 'command';
        hook.command = command;
        hook.timeout = timeout;
        delete hook.async;
        touched = true;
      }
    }
    if (touched) {
      rule.hooks = normalizedHooks;
      return;
    }
  }

  rules.push({
    hooks: [
      {
        type: 'command',
        command,
        timeout,
      },
    ],
  });
}

function removeAgentAwarenessHooks(hooks: Record<string, HookRuleConfig[]>): number {
  let removed = 0;

  for (const [event, rules] of Object.entries(hooks)) {
    const nextRules: HookRuleConfig[] = [];

    for (const rule of rules) {
      const normalizedHooks = ruleHooks(rule);
      const keptHooks = normalizedHooks.filter(hook => {
        const shouldRemove = isAgentAwarenessCommand(hook);
        if (shouldRemove) removed += 1;
        return !shouldRemove;
      });

      if (keptHooks.length > 0) {
        nextRules.push({ ...rule, hooks: keptHooks });
      }
    }

    if (nextRules.length > 0) {
      hooks[event] = nextRules;
    } else {
      delete hooks[event];
    }
  }

  return removed;
}

function countRemainingCommands(hooks: Record<string, HookRuleConfig[]>): number {
  let count = 0;
  for (const rules of Object.values(hooks)) {
    for (const rule of rules) {
      for (const hook of ruleHooks(rule)) {
        if (hook.type === 'command' && typeof hook.command === 'string') count += 1;
      }
    }
  }
  return count;
}

export async function codexHooksFeatureAvailable(): Promise<boolean | null> {
  const listed = await runCodex(['features', 'list']);
  if (listed.code !== 0) return null;

  return listed.stdout
    .split('\n')
    .map(part => part.trim())
    .some(part => part.startsWith('codex_hooks '));
}

export async function codexHooksFeatureEnabled(): Promise<boolean | null> {
  const listed = await runCodex(['features', 'list']);
  if (listed.code !== 0) return null;

  const line = listed.stdout
    .split('\n')
    .map(part => part.trim())
    .find(part => part.startsWith('codex_hooks '));

  if (!line) return null;
  return /\btrue$/.test(line);
}

export async function codexHooksInstall(): Promise<void> {
  let enabled: CommandResult;
  try {
    enabled = await runCodex(['features', 'enable', 'codex_hooks']);
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  if (enabled.code !== 0) {
    console.error(`Failed to enable Codex hooks feature (exit ${enabled.code ?? 'unknown'}).`);
    if (enabled.stderr.trim()) console.error(enabled.stderr.trim());
    process.exitCode = 1;
    return;
  }

  const config = await loadHooksConfig();
  upsertEventHook(config.hooks, SESSION_EVENT, SESSION_COMMAND, SESSION_TIMEOUT_SECONDS);
  upsertEventHook(config.hooks, PROMPT_EVENT, PROMPT_COMMAND, PROMPT_TIMEOUT_SECONDS);
  await saveHooksConfig(config);

  console.log(`Codex hooks installed: ${HOOKS_JSON_PATH}`);
  console.log(`  ${SESSION_EVENT}: ${SESSION_COMMAND}`);
  console.log(`  ${PROMPT_EVENT}: ${PROMPT_COMMAND}`);
  console.log('  Restart Codex sessions to pick up hook changes.');
}

export async function codexHooksUninstall(): Promise<void> {
  let config = await loadHooksConfig();
  const removed = removeAgentAwarenessHooks(config.hooks);

  if (removed > 0) {
    await saveHooksConfig(config);
    console.log(`Removed ${removed} agent-awareness Codex hook(s) from ${HOOKS_JSON_PATH}`);
  } else {
    console.log(`No agent-awareness Codex hooks found in ${HOOKS_JSON_PATH}`);
  }

  const remaining = countRemainingCommands(config.hooks);
  if (remaining > 0) {
    console.log(`Codex hooks feature left enabled (${remaining} other hook command(s) still configured).`);
    return;
  }

  let disabled: CommandResult;
  try {
    disabled = await runCodex(['features', 'disable', 'codex_hooks']);
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  if (disabled.code !== 0) {
    console.error(`Failed to disable Codex hooks feature (exit ${disabled.code ?? 'unknown'}).`);
    if (disabled.stderr.trim()) console.error(disabled.stderr.trim());
    process.exitCode = 1;
    return;
  }

  console.log('Codex hooks feature disabled (no hook commands remain).');
}

export async function codexHooksStatus(): Promise<void> {
  let featureEnabled: boolean | null;
  try {
    featureEnabled = await codexHooksFeatureEnabled();
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  const config = await loadHooksConfig();
  const sessionInstalled = hasCommandForEvent(config.hooks, SESSION_EVENT, SESSION_COMMAND);
  const promptInstalled = hasCommandForEvent(config.hooks, PROMPT_EVENT, PROMPT_COMMAND);
  const hooksInstalled = sessionInstalled && promptInstalled;

  const featureLabel = featureEnabled === null ? 'unknown' : (featureEnabled ? 'enabled' : 'disabled');
  console.log(`Codex hooks feature: ${featureLabel}`);
  console.log(`Agent-awareness Codex hooks: ${hooksInstalled ? 'installed' : 'not installed'}`);
  console.log(`  config: ${HOOKS_JSON_PATH}`);
  if (!hooksInstalled) {
    console.log('  Run "agent-awareness codex hooks install" to set up');
  }
}
