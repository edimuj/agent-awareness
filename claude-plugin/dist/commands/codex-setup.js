import { codexHooksFeatureAvailable, codexHooksInstall } from "./codex-hooks.js";
export async function codexSetup(options = {}) {
    const hooksAvailable = await codexHooksFeatureAvailable();
    if (hooksAvailable === false) {
        console.error('Codex hooks feature is not available in this Codex build.');
        console.error('Hooks are the supported agent-awareness integration for Codex right now.');
        process.exitCode = 1;
        return;
    }
    if (hooksAvailable === null) {
        console.log('Could not inspect Codex feature flags. Attempting hooks install anyway.');
    }
    process.exitCode = undefined;
    await codexHooksInstall({
        scope: options.hooksScope ?? 'global',
        fallbackToProject: options.hooksFallbackToProject ?? true,
    });
    if (process.exitCode && process.exitCode !== 0)
        return;
    console.log('Codex setup complete. Hooks are installed.');
    console.log('Realtime context push is not supported for Codex in this repo today.');
    console.log('Restart Codex sessions to pick up hook configuration changes.');
}
