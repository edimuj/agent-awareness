# Creating a Provider

A provider is the bridge between agent-awareness and a specific AI coding agent (Claude Code, Codex, Aider, etc.). It handles how and when awareness data gets injected into the agent's context.

## What a provider does

1. Creates a `Registry` and loads all discovered plugins
2. Loads config
3. Runs the awareness pipeline on events (session start, prompt, etc.)
4. Returns rendered text for the agent to consume
5. Manages the background ticker for interval-based plugins

## Architecture

```
your-agent/
  ├── src/providers/your-agent/
  │   └── adapter.ts          ← the provider adapter
  └── hooks/
      ├── your-agent-session-start.ts   ← hook entry points
      └── your-agent-prompt-submit.ts
```

## Step 1: Create the adapter

Create `src/providers/your-agent/adapter.ts`. The adapter is ~60 lines — most of it is boilerplate that's identical across providers. The only thing that changes is the provider name in `GatherContext`.

```typescript
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from '../../core/registry.ts';
import { render } from '../../core/renderer.ts';
import {
  loadState, saveState, getPluginState, setPluginState,
  loadTickerCache, writeTickerPid, readTickerPid, clearTickerPid,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import { parseInterval } from '../../core/types.ts';
import type { GatherContext, GatherResult, Trigger } from '../../core/types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');
const TICKER_SCRIPT = join(PROJECT_ROOT, 'src', 'daemon', 'ticker.ts');

// This is the only line that differs between providers
const CONTEXT: GatherContext = { provider: 'your-agent' };
```

The rest of the adapter (createRegistry, manageTicker, run, stop) is identical to the reference implementation in `src/providers/claude-code/adapter.ts`. Copy it.

## Step 2: Create hook entry points

Hooks are thin wrappers that call your adapter's `run()` function. Each agent has its own way of invoking hooks — the entry points adapt to that.

```typescript
// hooks/your-agent-session-start.ts
import { run } from '../src/providers/your-agent/adapter.ts';

if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('session-start');
if (output) process.stdout.write(output);
```

```typescript
// hooks/your-agent-prompt-submit.ts
import { run } from '../src/providers/your-agent/adapter.ts';

if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', () => {});
}

const output = await run('prompt');
if (output) process.stdout.write(output);
```

## Step 3: Wire hooks to your agent

How you wire these hooks depends on your agent's extension model:

### Claude Code
Uses `hooks/hooks.json` with event-based hook configuration:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node hooks/session-start.ts" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node hooks/prompt-submit.ts", "async": true }] }]
  }
}
```

### Codex
Uses configuration or instructions injection — see Codex-specific documentation.

### Other agents
If your agent supports running a command at session start or before each prompt, point it at the hook entry points. The hooks write to stdout — capture that output and inject it into context however your agent supports it.

For agents without hook support, you can call the adapter directly from a wrapper script:
```bash
# Inject at session start
AWARENESS=$(node /path/to/agent-awareness/hooks/your-agent-session-start.ts)
your-agent --instructions "$AWARENESS" "$@"
```

## Step 4: Add provider-specific plugin logic (optional)

If your agent has provider-specific APIs (like Claude's quota API or Codex's rate limits), add a fetcher to the relevant plugin. The quota plugin uses `context.provider` to dispatch:

```typescript
const FETCHERS: Record<string, () => Promise<Quota | null>> = {
  'claude-code': fetchClaudeQuota,
  'codex': fetchCodexQuota,
  'your-agent': fetchYourAgentQuota,  // add your fetcher here
};
```

Plugins that don't need provider-specific logic work across all providers unchanged.

## Events

The adapter's `run()` function accepts these event strings:

| Event | When to fire |
|-------|-------------|
| `session-start` | Agent session begins |
| `prompt` | User submits a prompt |

The `prompt` event also evaluates `change:hour`, `change:day`, and `interval:*` triggers internally.

## Testing

```bash
# Test your adapter directly
node hooks/your-agent-session-start.ts

# List discovered plugins
node src/cli.ts list
```

## Reference implementations

- `src/providers/claude-code/adapter.ts` — full-featured with ticker management
- `src/providers/codex/adapter.ts` — identical structure, different provider context
