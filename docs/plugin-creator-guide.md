# Plugin Creator Guide

This guide is for building `agent-awareness` plugins that are reliable, low-noise, and easy to ship.

## 1) Choose plugin type

Use one of these scaffolds:

```bash
# npm package (shareable)
agent-awareness create my-plugin

# npm package with MCP tools
agent-awareness create my-plugin --mcp

# local-only plugin (no publish/build required)
agent-awareness create my-plugin --local
```

Use npm package mode for anything you expect other people to install.

## 2) Implement the minimum plugin contract

Every plugin exports a default `AwarenessPlugin` with:

1. `name`
2. `description`
3. `triggers`
4. `defaults`
5. `gather(trigger, config, prevState, context)`

Minimal example:

```ts
import type { AwarenessPlugin } from 'agent-awareness';

export default {
  name: 'hello',
  description: 'Example plugin',
  triggers: ['session-start', 'interval:10m'],
  defaults: {
    triggers: {
      'session-start': true,
      'interval:10m': true,
    },
  },
  async gather(_trigger, _config, _prevState, context) {
    return { text: `provider=${context.provider}` };
  },
} satisfies AwarenessPlugin;
```

## 3) Use triggers intentionally

Prefer low-noise triggers by default:

1. `session-start` for initial baseline context
2. `interval:*` for periodic checks
3. `change:*` for event-style updates

Avoid broad `prompt` triggers unless absolutely necessary.

## 4) Use context for relevance

`GatherContext` includes useful runtime metadata:

1. `context.provider` (`codex`, `claude-code`, etc.)
2. `context.cwd` and `context.gitRoot` (when available)
3. `context.sessionRepo` (GitHub `owner/repo`, inferred from active git remote when available)
4. `context.signal` for cancellation
5. `context.log` for structured warnings/errors
6. `context.claims` for multi-session event claiming

Example: prioritize session repo by default.

```ts
const allRepos = (config.repos as string[]) ?? [];
const sessionRepo = (context.sessionRepo ?? '').toLowerCase();
const repos = sessionRepo
  ? allRepos.filter((r) => r.toLowerCase() === sessionRepo)
  : allRepos;
```

## 5) Keep output agent-oriented

Good plugin output is:

1. Short
2. Actionable
3. Change-driven
4. Plain (no decorative symbols/emojis)

Return `null` when there is nothing worth injecting.

## 6) Manage state carefully

Use `prevState` + returned `state` to detect deltas and suppress repeats.

Pattern:

1. Read previous cursor/timestamp/hash
2. Compute new events
3. Update state regardless of whether text is emitted
4. Emit text only when something changed

## 7) Handle cancellation and failures

1. Pass `context.signal` to network/process calls
2. Treat transient failures as non-fatal
3. Log warnings via `context.log?.warn(...)`
4. Return `null` or empty text on partial outages instead of crashing

## 8) Use claims for "act" events

If plugin output can trigger action (fix CI, respond to PR, etc.), claim first:

```ts
const key = `repo:${repo}:run:${runId}`;
const claimed = await context.claims?.tryClaim(key, 20);
if (claimed && !claimed.claimed) return null;
```

This prevents multiple concurrent sessions from taking the same action.

## 9) Add MCP tools only when needed

Use MCP for on-demand actions and deep inspection, not for routine periodic text.

Typical MCP tools:

1. `check` (force refresh now)
2. `status` (inspect internal state)
3. `list` (enumerate tracked entities)

## 10) Test before publish

Recommended checks:

```bash
# in plugin repo/workspace
npm run build
npm test

# in agent-awareness repo (integration sanity)
agent-awareness list
agent-awareness doctor
```

For Codex integration:

```bash
agent-awareness codex doctor
```

## 11) Publish checklist (npm plugins)

Node 24+ requires shipped JavaScript inside `node_modules`.

Before publishing:

1. Ensure package includes compiled `.js`
2. Ensure `exports`/`main` point to JS entrypoint
3. Run tests and typecheck
4. Bump version
5. Publish

```bash
npm version patch --no-git-tag-version
npm run build
npm publish
```

## Common caveats

1. npm plugins cannot rely on raw `.ts` execution inside `node_modules`
2. Avoid high-frequency noisy text; it burns context tokens
3. Keep trigger semantics deterministic (timezone/day boundaries matter)
4. Avoid long-running shell calls without timeout/cancel handling
5. Don’t assume session repo is always available; fallback gracefully

## Troubleshooting quick map

1. Plugin not loading:
   `agent-awareness doctor` and verify package name pattern `agent-awareness-plugin-*`
2. MCP tools missing:
   verify plugin exports `mcp.tools` and restart MCP session/client
3. Repeated output:
   verify state cursor updates and change detection logic
4. No interval output:
   verify trigger config and ticker startup in logs
5. Context fields missing:
   plugin must tolerate absent optional context fields (`sessionRepo`, `claims`, `log`)

## Reference docs

1. Provider internals: [creating-a-provider.md](./creating-a-provider.md)
2. Main project README: [../README.md](../README.md)
