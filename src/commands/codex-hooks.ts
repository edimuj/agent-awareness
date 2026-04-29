/**
 * Codex hooks install/uninstall/status commands.
 *
 * Installs agent-awareness hook entries in either:
 * - Global Codex config file: ~/.codex/config.toml (default)
 * - Project-local hooks file: ./.codex/hooks.json (optional)
 *
 * Also enables/disables the codex_hooks feature flag via Codex CLI.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CODEX_PLUGIN_ROOT = join(PROJECT_ROOT, 'codex-plugin');

const SESSION_EVENT = 'SessionStart';
const PROMPT_EVENT = 'UserPromptSubmit';

const SESSION_TIMEOUT_SECONDS = 15;
const PROMPT_TIMEOUT_SECONDS = 10;
const TOML_BLOCK_BEGIN = '# agent-awareness hooks: begin';
const TOML_BLOCK_END = '# agent-awareness hooks: end';

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

interface ResolvedHookCommands {
  session: string;
  prompt: string;
}

export type HooksScope = 'global' | 'project';

export interface CodexHooksOptions {
  scope?: HooksScope;
  fallbackToProject?: boolean;
  quiet?: boolean;
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

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return configured;
  return join(home, '.codex');
}

export function resolveHooksJsonPath(
  scope: HooksScope,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (scope === 'global') return join(resolveCodexHome(env, home), 'hooks.json');
  return join(cwd, '.codex', 'hooks.json');
}

export function resolveCodexConfigTomlPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(resolveCodexHome(env, home), 'config.toml');
}

function otherScope(scope: HooksScope): HooksScope {
  return scope === 'global' ? 'project' : 'global';
}

async function loadHooksConfig(hooksJsonPath: string): Promise<{ hooks: Record<string, HookRuleConfig[]> }> {
  try {
    const parsed = JSON.parse(await readFile(hooksJsonPath, 'utf8'));
    return normalizeHooksConfig(parsed);
  } catch {
    return { hooks: {} };
  }
}

async function saveHooksConfig(
  hooksJsonPath: string,
  config: { hooks: Record<string, HookRuleConfig[]> },
): Promise<void> {
  await mkdir(dirname(hooksJsonPath), { recursive: true });
  await writeFile(hooksJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

async function loadText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlHookBlock(commands: ResolvedHookCommands): string {
  return [
    TOML_BLOCK_BEGIN,
    `[[hooks.${SESSION_EVENT}]]`,
    `[[hooks.${SESSION_EVENT}.hooks]]`,
    'type = "command"',
    `command = ${tomlString(commands.session)}`,
    `timeout = ${SESSION_TIMEOUT_SECONDS}`,
    '',
    `[[hooks.${PROMPT_EVENT}]]`,
    `[[hooks.${PROMPT_EVENT}.hooks]]`,
    'type = "command"',
    `command = ${tomlString(commands.prompt)}`,
    `timeout = ${PROMPT_TIMEOUT_SECONDS}`,
    TOML_BLOCK_END,
    '',
  ].join('\n');
}

function removeTomlHookBlock(text: string): { text: string; removed: boolean } {
  const start = text.indexOf(TOML_BLOCK_BEGIN);
  const end = text.indexOf(TOML_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + TOML_BLOCK_END.length;
    const next = text.slice(0, start).replace(/\n{2,}$/, '\n') + text.slice(afterEnd).replace(/^\n{1,2}/, '\n');
    const normalized = next.endsWith('\n') ? next : `${next}\n`;
    const cleaned = removeTomlHookBlock(normalized);
    return { text: cleaned.text, removed: true };
  }

  // Older/dev builds may have left a partial managed block behind. Remove only
  // hook tables that contain agent-awareness commands, preserving unrelated
  // hooks such as Agent Relay.
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line === TOML_BLOCK_BEGIN || line === TOML_BLOCK_END) {
      removed = true;
      index += 1;
      continue;
    }

    if (/^\[\[hooks\.[^\]]+\]\]$/.test(line.trim())) {
      const block: string[] = [];
      do {
        block.push(lines[index]!);
        index += 1;
      } while (index < lines.length && !/^\s*\[/.test(lines[index]!.trim()));

      const blockText = block.join('\n');
      const isEmptyAwarenessEventTable = block.length === 1
        && (
          block[0]!.trim() === `[[hooks.${SESSION_EVENT}]]`
          || block[0]!.trim() === `[[hooks.${PROMPT_EVENT}]]`
        );
      if (isEmptyAwarenessEventTable || blockText.includes('codex-session-start') || blockText.includes('codex-prompt-submit')) {
        removed = true;
        continue;
      }
      kept.push(...block);
      continue;
    }

    kept.push(line);
    index += 1;
  }

  if (!removed) return { text, removed: false };
  const next = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return { text: next, removed: true };
}

export function removeAgentAwarenessHooksFromConfigTomlText(text: string): string {
  return removeTomlHookBlock(text).text;
}

async function installHooksInConfigToml(configTomlPath: string, commands: ResolvedHookCommands): Promise<void> {
  await mkdir(dirname(configTomlPath), { recursive: true });
  const current = await loadText(configTomlPath);
  const withoutBlock = removeTomlHookBlock(current).text.trimEnd();
  const next = `${withoutBlock}${withoutBlock ? '\n\n' : ''}${renderTomlHookBlock(commands)}`;
  await writeFile(configTomlPath, next, 'utf8');
}

async function uninstallHooksFromConfigToml(configTomlPath: string): Promise<number> {
  const current = await loadText(configTomlPath);
  const removed = removeTomlHookBlock(current);
  if (removed.removed) {
    await writeFile(configTomlPath, removed.text, 'utf8');
    return 2;
  }
  return 0;
}

function hasCommandInConfigToml(text: string, command: string): boolean {
  return text.includes(`command = ${tomlString(command)}`)
    || text.includes(`command = '${command.replace(/'/g, "\\'")}'`);
}

function countTomlHookCommands(text: string): number {
  return [...text.matchAll(/^\s*command\s*=/gm)].length;
}

async function cleanupLegacyHooksJson(hooksJsonPath: string): Promise<void> {
  const config = await loadHooksConfig(hooksJsonPath);
  const removed = removeAgentAwarenessHooks(config.hooks);
  if (removed === 0) return;
  if (countRemainingCommands(config.hooks) === 0) {
    await rm(hooksJsonPath, { force: true });
    return;
  }
  await saveHooksConfig(hooksJsonPath, config);
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
    && (
      hook.command.includes('codex-session-start')
      || hook.command.includes('codex-prompt-submit')
    );
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

function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveHookCommands(): Promise<ResolvedHookCommands> {
  const pluginSession = join(CODEX_PLUGIN_ROOT, 'hooks', 'codex-session-start.mjs');
  const pluginPrompt = join(CODEX_PLUGIN_ROOT, 'hooks', 'codex-prompt-submit.mjs');
  if (await exists(pluginSession) && await exists(pluginPrompt)) {
    return {
      session: `node ${quotePath(pluginSession)}`,
      prompt: `node ${quotePath(pluginPrompt)}`,
    };
  }

  const distSession = join(PROJECT_ROOT, 'dist', 'hooks', 'codex-session-start.js');
  const distPrompt = join(PROJECT_ROOT, 'dist', 'hooks', 'codex-prompt-submit.js');
  if (await exists(distSession) && await exists(distPrompt)) {
    return {
      session: `node ${quotePath(distSession)}`,
      prompt: `node ${quotePath(distPrompt)}`,
    };
  }

  const srcSession = join(PROJECT_ROOT, 'src', 'hooks', 'codex-session-start.ts');
  const srcPrompt = join(PROJECT_ROOT, 'src', 'hooks', 'codex-prompt-submit.ts');
  return {
    session: `node ${quotePath(srcSession)}`,
    prompt: `node ${quotePath(srcPrompt)}`,
  };
}

function printInstallSuccess(hooksJsonPath: string, commands: ResolvedHookCommands, scope: HooksScope): void {
  console.log(`Codex hooks installed (${scope}): ${hooksJsonPath}`);
  console.log(`  ${SESSION_EVENT}: ${commands.session}`);
  console.log(`  ${PROMPT_EVENT}: ${commands.prompt}`);
  console.log('  Restart Codex sessions to pick up hook changes.');
}

function printTomlInstallSuccess(configTomlPath: string, commands: ResolvedHookCommands): void {
  console.log(`Codex hooks installed (global): ${configTomlPath}`);
  console.log(`  ${SESSION_EVENT}: ${commands.session}`);
  console.log(`  ${PROMPT_EVENT}: ${commands.prompt}`);
  console.log('  Restart Codex sessions to pick up hook changes.');
}

export async function codexHooksInstall(options: CodexHooksOptions = {}): Promise<void> {
  const preferredScope = options.scope ?? 'global';
  const commands = await resolveHookCommands();

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

  if (preferredScope === 'global') {
    const configTomlPath = resolveCodexConfigTomlPath();
    try {
      await installHooksInConfigToml(configTomlPath, commands);
      await cleanupLegacyHooksJson(resolveHooksJsonPath('global'));
      if (!options.quiet) printTomlInstallSuccess(configTomlPath, commands);
      return;
    } catch (err) {
      if (!options.fallbackToProject) {
        console.error(`Failed to write Codex config at ${configTomlPath}: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.warn(`Warning: could not write global Codex config at ${configTomlPath}.`);
      const fallbackScope: HooksScope = 'project';
      const fallbackPath = resolveHooksJsonPath(fallbackScope);
      console.warn(`Falling back to project hooks config: ${fallbackPath}`);
      try {
        const config = await loadHooksConfig(fallbackPath);
        upsertEventHook(config.hooks, SESSION_EVENT, commands.session, SESSION_TIMEOUT_SECONDS);
        upsertEventHook(config.hooks, PROMPT_EVENT, commands.prompt, PROMPT_TIMEOUT_SECONDS);
        await saveHooksConfig(fallbackPath, config);
        if (!options.quiet) printInstallSuccess(fallbackPath, commands, fallbackScope);
      } catch (fallbackErr) {
        console.error(`Failed to write fallback project hooks config at ${fallbackPath}: ${(fallbackErr as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
  }

  const preferredPath = resolveHooksJsonPath(preferredScope);
  try {
    const config = await loadHooksConfig(preferredPath);
    upsertEventHook(config.hooks, SESSION_EVENT, commands.session, SESSION_TIMEOUT_SECONDS);
    upsertEventHook(config.hooks, PROMPT_EVENT, commands.prompt, PROMPT_TIMEOUT_SECONDS);
    await saveHooksConfig(preferredPath, config);
    if (!options.quiet) printInstallSuccess(preferredPath, commands, preferredScope);
    return;
  } catch (err) {
    console.error(`Failed to write Codex hooks config at ${preferredPath}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function codexHooksUninstall(options: CodexHooksOptions = {}): Promise<void> {
  const scope = options.scope ?? 'global';
  let removed = 0;

  if (scope === 'global') {
    const configTomlPath = resolveCodexConfigTomlPath();
    removed += await uninstallHooksFromConfigToml(configTomlPath);
  }

  const hooksJsonPath = resolveHooksJsonPath(scope);
  let config = await loadHooksConfig(hooksJsonPath);
  removed += removeAgentAwarenessHooks(config.hooks);

  if (removed > 0) {
    if (countRemainingCommands(config.hooks) === 0) {
      await rm(hooksJsonPath, { force: true });
    } else {
      await saveHooksConfig(hooksJsonPath, config);
    }
    console.log(`Removed ${removed} agent-awareness Codex hook(s)`);
  } else {
    console.log('No agent-awareness Codex hooks found');
  }

  let remaining = countRemainingCommands(config.hooks);
  if (scope === 'global') {
    remaining += countTomlHookCommands(await loadText(resolveCodexConfigTomlPath()));
  }
  if (remaining === 0) {
    const secondaryPath = resolveHooksJsonPath(otherScope(scope));
    const secondaryConfig = await loadHooksConfig(secondaryPath);
    remaining = countRemainingCommands(secondaryConfig.hooks);
  }

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

export async function codexHooksStatus(options: CodexHooksOptions = {}): Promise<void> {
  const scope = options.scope ?? 'global';
  const commands = await resolveHookCommands();
  let featureEnabled: boolean | null;
  try {
    featureEnabled = await codexHooksFeatureEnabled();
  } catch (err) {
    printCodexMissingHelp(err);
    process.exitCode = 1;
    return;
  }

  const hooksJsonPath = resolveHooksJsonPath(scope);
  const config = await loadHooksConfig(hooksJsonPath);
  const configTomlPath = resolveCodexConfigTomlPath();
  const configToml = scope === 'global' ? await loadText(configTomlPath) : '';
  const sessionInstalled = hasCommandForEvent(config.hooks, SESSION_EVENT, commands.session)
    || hasCommandInConfigToml(configToml, commands.session);
  const promptInstalled = hasCommandForEvent(config.hooks, PROMPT_EVENT, commands.prompt)
    || hasCommandInConfigToml(configToml, commands.prompt);
  const hooksInstalled = sessionInstalled && promptInstalled;

  const featureLabel = featureEnabled === null ? 'unknown' : (featureEnabled ? 'enabled' : 'disabled');
  console.log(`Codex hooks feature: ${featureLabel}`);
  console.log(`Agent-awareness Codex hooks (${scope}): ${hooksInstalled ? 'installed' : 'not installed'}`);
  console.log(`  config: ${scope === 'global' ? configTomlPath : hooksJsonPath}`);
  if (!hooksInstalled) {
    if (scope === 'global') {
      console.log('  Run "agent-awareness codex hooks install --global" to set up');
    } else {
      console.log('  Run "agent-awareness codex hooks install --project" to set up');
    }
  }
}
