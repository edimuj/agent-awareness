# Creating a Provider

A provider is the bridge between `agent-awareness` and a specific coding agent.
The provider-specific part should stay thin. The core engine already handles:

1. Plugin discovery and config loading
2. Trigger matching, including `change:*` and `interval:*`
3. Dispatch, timeouts, and error isolation
4. Injection policy and rendering
5. Provider-scoped state

## Current model

Use a hooks-first adapter as the default provider shape.

```text
your-agent/
  ├── src/providers/your-agent/adapter.ts
  ├── src/hooks/
  │   ├── your-agent-session-start.ts
  │   └── your-agent-prompt-submit.ts
  └── your-agent-plugin/
      └── hooks/
          ├── your-agent-session-start.mjs
          └── your-agent-prompt-submit.mjs
```

The direct adapter should:

1. Call `initStateDir('<provider>')`
2. Build a registry and load config
3. Resolve `GatherContext` with the provider name
4. Run all triggered plugins inline
5. Persist plugin state and policy fingerprints
6. Return rendered text for the hook wrapper to inject

That is the entire Tier 1 integration.

## Reference pattern

Start from the direct adapters in:

- `src/providers/claude-code/adapter.ts`
- `src/providers/codex/adapter.ts`

They both follow the same structure. The only meaningful provider-specific inputs are:

- provider name passed to `initStateDir()`
- provider name passed to `resolveGatherContext()`
- hook output formatting required by the target agent

## Minimal adapter shape

```typescript
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Registry } from '../../core/registry.ts';
import { PluginDispatcher } from '../../core/dispatcher.ts';
import { render } from '../../core/renderer.ts';
import { applyInjectionPolicy } from '../../core/policy.ts';
import {
  initStateDir, loadState, getPluginState, setPluginState, withState,
} from '../../core/state.ts';
import { loadPlugins } from '../../core/loader.ts';
import type { GatherContext, GatherResult, PluginState, Trigger } from '../../core/types.ts';
import type { PolicyInput } from '../../core/policy.ts';
import { createClaimContext, pruneExpiredClaims } from '../../core/claims.ts';
import { resolveGatherContext } from '../../core/session-context.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'config', 'default.json');

const dispatcher = new PluginDispatcher();
let initialized = false;

export async function run(event: string): Promise<string> {
  if (!initialized) {
    await initStateDir('your-agent');
    initialized = true;
  }

  const registry = await createRegistry();
  const context: GatherContext = await resolveGatherContext('your-agent');

  if (event === 'session-start') {
    await registry.startPlugins();
    await pruneExpiredClaims();
  }

  const preState = await loadState();
  const triggered = registry.getTriggeredPlugins(event, preState);
  const dispatchEntries = triggered.map(({ plugin, trigger }) => ({
    pluginName: plugin.name,
    executor: (signal: AbortSignal) => {
      const config = registry.getPluginConfig(plugin.name)!;
      const prevState = getPluginState(preState, plugin.name);
      const claims = createClaimContext(plugin.name);
      return Promise.resolve(plugin.gather(trigger as Trigger, config, prevState, { ...context, signal, claims }));
    },
  }));

  const dispatched = await dispatcher.dispatchAll(dispatchEntries);
  const gatheredResults = dispatched
    .filter((entry): entry is { pluginName: string; result: GatherResult } => !!entry.result)
    .map(({ pluginName, result }) => ({ pluginName, result }));

  const policyInputs: PolicyInput[] = gatheredResults.map(({ pluginName, result }) => ({
    pluginName,
    result,
  }));

  const policy = applyInjectionPolicy(policyInputs, { event });

  await withState((state: PluginState) => {
    for (const { pluginName, result } of gatheredResults) {
      state = setPluginState(state, pluginName, result.state);
    }
    return state;
  });

  if (policy.results.length === 0) return '';
  return render(policy.results);
}
```

## Hooks

Source hook entry points should stay dumb. They call `run()` and format the
output for the agent surface.

```typescript
import { run } from '../src/providers/your-agent/adapter.ts';

const output = await run('session-start');
if (output) process.stdout.write(output);
```

If the provider ships a packaged plugin bundle, keep tiny wrappers in
`<provider>-plugin/hooks/` that import the built hook entry points from `dist/`
or fall back to repo source during local development.

If you publish a provider bundle, add a `README.md` inside `<provider>-plugin/`
that states the real install contract. Packaging a provider bundle does not
automatically mean that the target agent's plugin browser or marketplace flow
activates hooks correctly.

For Codex specifically, the supported hook locations are documented as:

- `~/.codex/hooks.json`
- `<repo>/.codex/hooks.json`

## Realtime support

Do not bake realtime delivery into the direct adapter.

If an agent later supports a proper realtime path, keep it separate:

1. Tier 1 stays direct hooks
2. Tier 2 becomes a thin provider-specific transport layer
3. Shared ticker or daemon code stays provider-agnostic wherever possible

That is already how Claude Code is split in this repo. Codex currently only
uses Tier 1.

## Testing

At minimum, cover:

1. State initialization for the provider
2. Hook output shape
3. Interval triggers firing inline on prompt
4. Duplicate fingerprint suppression across session-start and prompt
5. Claims context wiring on session-start

Run provider tests directly:

```bash
node --test src/providers/your-agent/adapter.test.ts
```
