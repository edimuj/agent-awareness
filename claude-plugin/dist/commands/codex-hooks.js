/**
 * Codex hooks install/uninstall/status commands.
 *
 * Installs agent-awareness hook entries in either:
 * - Global Codex hooks file: ~/.codex/hooks.json (default)
 * - Project-local hooks file: ./.codex/hooks.json (optional)
 *
 * Also enables/disables the codex_hooks feature flag via Codex CLI.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
async function runCodex(args) {
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
function printCodexMissingHelp(err) {
    if (err.code === 'ENOENT') {
        console.error('Codex CLI not found in PATH.');
        console.error('Install or expose `codex` first, then rerun this command.');
        return;
    }
    console.error(`Failed to run Codex CLI: ${err.message}`);
}
function normalizeHooksConfig(raw) {
    const asObject = (raw && typeof raw === 'object') ? raw : {};
    const hooksRaw = asObject.hooks;
    const hooks = {};
    if (hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)) {
        for (const [event, value] of Object.entries(hooksRaw)) {
            if (Array.isArray(value)) {
                hooks[event] = value
                    .filter(rule => rule && typeof rule === 'object')
                    .map(rule => ({ ...rule }));
            }
        }
    }
    return { hooks };
}
export function resolveCodexHome(env = process.env, home = homedir()) {
    const configured = env.CODEX_HOME?.trim();
    if (configured)
        return configured;
    return join(home, '.codex');
}
export function resolveHooksJsonPath(scope, cwd = process.cwd(), env = process.env, home = homedir()) {
    if (scope === 'global')
        return join(resolveCodexHome(env, home), 'hooks.json');
    return join(cwd, '.codex', 'hooks.json');
}
function otherScope(scope) {
    return scope === 'global' ? 'project' : 'global';
}
async function loadHooksConfig(hooksJsonPath) {
    try {
        const parsed = JSON.parse(await readFile(hooksJsonPath, 'utf8'));
        return normalizeHooksConfig(parsed);
    }
    catch {
        return { hooks: {} };
    }
}
async function saveHooksConfig(hooksJsonPath, config) {
    await mkdir(dirname(hooksJsonPath), { recursive: true });
    await writeFile(hooksJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
function ruleHooks(rule) {
    if (!Array.isArray(rule.hooks))
        return [];
    return rule.hooks
        .filter(hook => hook && typeof hook === 'object')
        .map(hook => ({ ...hook }));
}
function isAgentAwarenessCommand(hook) {
    return hook.type === 'command'
        && typeof hook.command === 'string'
        && (hook.command.includes('codex-session-start')
            || hook.command.includes('codex-prompt-submit'));
}
function hasCommandForEvent(hooks, event, command) {
    const rules = hooks[event];
    if (!Array.isArray(rules))
        return false;
    for (const rule of rules) {
        for (const hook of ruleHooks(rule)) {
            if (hook.type === 'command' && hook.command === command)
                return true;
        }
    }
    return false;
}
function upsertEventHook(hooks, event, command, timeout) {
    const rules = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = rules;
    for (const rule of rules) {
        const normalizedHooks = ruleHooks(rule);
        if (normalizedHooks.length === 0)
            continue;
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
function removeAgentAwarenessHooks(hooks) {
    let removed = 0;
    for (const [event, rules] of Object.entries(hooks)) {
        const nextRules = [];
        for (const rule of rules) {
            const normalizedHooks = ruleHooks(rule);
            const keptHooks = normalizedHooks.filter(hook => {
                const shouldRemove = isAgentAwarenessCommand(hook);
                if (shouldRemove)
                    removed += 1;
                return !shouldRemove;
            });
            if (keptHooks.length > 0) {
                nextRules.push({ ...rule, hooks: keptHooks });
            }
        }
        if (nextRules.length > 0) {
            hooks[event] = nextRules;
        }
        else {
            delete hooks[event];
        }
    }
    return removed;
}
function countRemainingCommands(hooks) {
    let count = 0;
    for (const rules of Object.values(hooks)) {
        for (const rule of rules) {
            for (const hook of ruleHooks(rule)) {
                if (hook.type === 'command' && typeof hook.command === 'string')
                    count += 1;
            }
        }
    }
    return count;
}
export async function codexHooksFeatureAvailable() {
    const listed = await runCodex(['features', 'list']);
    if (listed.code !== 0)
        return null;
    return listed.stdout
        .split('\n')
        .map(part => part.trim())
        .some(part => part.startsWith('codex_hooks '));
}
export async function codexHooksFeatureEnabled() {
    const listed = await runCodex(['features', 'list']);
    if (listed.code !== 0)
        return null;
    const line = listed.stdout
        .split('\n')
        .map(part => part.trim())
        .find(part => part.startsWith('codex_hooks '));
    if (!line)
        return null;
    return /\btrue$/.test(line);
}
function quotePath(path) {
    return `"${path.replace(/"/g, '\\"')}"`;
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveHookCommands() {
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
function printInstallSuccess(hooksJsonPath, commands, scope) {
    console.log(`Codex hooks installed (${scope}): ${hooksJsonPath}`);
    console.log(`  ${SESSION_EVENT}: ${commands.session}`);
    console.log(`  ${PROMPT_EVENT}: ${commands.prompt}`);
    console.log('  Restart Codex sessions to pick up hook changes.');
}
export async function codexHooksInstall(options = {}) {
    const preferredScope = options.scope ?? 'global';
    const commands = await resolveHookCommands();
    let enabled;
    try {
        enabled = await runCodex(['features', 'enable', 'codex_hooks']);
    }
    catch (err) {
        printCodexMissingHelp(err);
        process.exitCode = 1;
        return;
    }
    if (enabled.code !== 0) {
        console.error(`Failed to enable Codex hooks feature (exit ${enabled.code ?? 'unknown'}).`);
        if (enabled.stderr.trim())
            console.error(enabled.stderr.trim());
        process.exitCode = 1;
        return;
    }
    const preferredPath = resolveHooksJsonPath(preferredScope);
    try {
        const config = await loadHooksConfig(preferredPath);
        upsertEventHook(config.hooks, SESSION_EVENT, commands.session, SESSION_TIMEOUT_SECONDS);
        upsertEventHook(config.hooks, PROMPT_EVENT, commands.prompt, PROMPT_TIMEOUT_SECONDS);
        await saveHooksConfig(preferredPath, config);
        printInstallSuccess(preferredPath, commands, preferredScope);
        return;
    }
    catch (err) {
        if (!(preferredScope === 'global' && options.fallbackToProject)) {
            console.error(`Failed to write Codex hooks config at ${preferredPath}: ${err.message}`);
            process.exitCode = 1;
            return;
        }
    }
    const fallbackScope = 'project';
    const fallbackPath = resolveHooksJsonPath(fallbackScope);
    console.warn(`Warning: could not write global Codex hooks config at ${preferredPath}.`);
    console.warn(`Falling back to project hooks config: ${fallbackPath}`);
    try {
        const config = await loadHooksConfig(fallbackPath);
        upsertEventHook(config.hooks, SESSION_EVENT, commands.session, SESSION_TIMEOUT_SECONDS);
        upsertEventHook(config.hooks, PROMPT_EVENT, commands.prompt, PROMPT_TIMEOUT_SECONDS);
        await saveHooksConfig(fallbackPath, config);
        printInstallSuccess(fallbackPath, commands, fallbackScope);
    }
    catch (err) {
        console.error(`Failed to write fallback project hooks config at ${fallbackPath}: ${err.message}`);
        process.exitCode = 1;
    }
}
export async function codexHooksUninstall(options = {}) {
    const scope = options.scope ?? 'global';
    const hooksJsonPath = resolveHooksJsonPath(scope);
    let config = await loadHooksConfig(hooksJsonPath);
    const removed = removeAgentAwarenessHooks(config.hooks);
    if (removed > 0) {
        await saveHooksConfig(hooksJsonPath, config);
        console.log(`Removed ${removed} agent-awareness Codex hook(s) from ${hooksJsonPath}`);
    }
    else {
        console.log(`No agent-awareness Codex hooks found in ${hooksJsonPath}`);
    }
    let remaining = countRemainingCommands(config.hooks);
    if (remaining === 0) {
        const secondaryPath = resolveHooksJsonPath(otherScope(scope));
        const secondaryConfig = await loadHooksConfig(secondaryPath);
        remaining = countRemainingCommands(secondaryConfig.hooks);
    }
    if (remaining > 0) {
        console.log(`Codex hooks feature left enabled (${remaining} other hook command(s) still configured).`);
        return;
    }
    let disabled;
    try {
        disabled = await runCodex(['features', 'disable', 'codex_hooks']);
    }
    catch (err) {
        printCodexMissingHelp(err);
        process.exitCode = 1;
        return;
    }
    if (disabled.code !== 0) {
        console.error(`Failed to disable Codex hooks feature (exit ${disabled.code ?? 'unknown'}).`);
        if (disabled.stderr.trim())
            console.error(disabled.stderr.trim());
        process.exitCode = 1;
        return;
    }
    console.log('Codex hooks feature disabled (no hook commands remain).');
}
export async function codexHooksStatus(options = {}) {
    const scope = options.scope ?? 'global';
    const commands = await resolveHookCommands();
    let featureEnabled;
    try {
        featureEnabled = await codexHooksFeatureEnabled();
    }
    catch (err) {
        printCodexMissingHelp(err);
        process.exitCode = 1;
        return;
    }
    const hooksJsonPath = resolveHooksJsonPath(scope);
    const config = await loadHooksConfig(hooksJsonPath);
    const sessionInstalled = hasCommandForEvent(config.hooks, SESSION_EVENT, commands.session);
    const promptInstalled = hasCommandForEvent(config.hooks, PROMPT_EVENT, commands.prompt);
    const hooksInstalled = sessionInstalled && promptInstalled;
    const featureLabel = featureEnabled === null ? 'unknown' : (featureEnabled ? 'enabled' : 'disabled');
    console.log(`Codex hooks feature: ${featureLabel}`);
    console.log(`Agent-awareness Codex hooks (${scope}): ${hooksInstalled ? 'installed' : 'not installed'}`);
    console.log(`  config: ${hooksJsonPath}`);
    if (!hooksInstalled) {
        if (scope === 'global') {
            console.log('  Run "agent-awareness codex hooks install --global" to set up');
        }
        else {
            console.log('  Run "agent-awareness codex hooks install --project" to set up');
        }
    }
}
