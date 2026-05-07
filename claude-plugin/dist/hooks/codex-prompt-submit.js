import { run } from "../providers/codex/adapter.js";
function formatForHookContext(text) {
    return text
        .split(/\r?\n+/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(' || ');
}
const output = await run('prompt');
if (output) {
    process.stdout.write(JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: formatForHookContext(output),
        },
    }));
}
