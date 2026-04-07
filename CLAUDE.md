# agent-awareness

Modular awareness plugins for AI coding agents.

## Architecture

### Two-tier integration (separate paths, not stacked)

**Tier 1 — Hooks only** (no background processes)
- Startup hook fires `session-start` plugins → injects initial context
- Prompt hook fires `prompt`, `change:*`, and `interval:*` plugins inline
- Interval check: if enough time passed since `_updatedAt`, plugin fires on next prompt
- No ticker, no daemon, no MCP, no PID files

**Tier 2 — Startup hook + MCP** (full experience)
- Startup hook same as Tier 1 (one-shot initial context)
- MCP server handles everything else: intervals, change-detection, channel push
- Internal ticker runs all `interval:*` and `change:*` triggers periodically
- Real-time push via `claude/channel` experimental capability
- No prompt hook needed — MCP channel replaces it

### Provider isolation
Each provider gets its own state directory — no shared state, no conflicts:
```
~/.cache/agent-awareness/
  claude-code/          ← all state for Claude Code
    state.json
    ticker-cache.json   (Tier 2 only)
    channel-seen.json   (Tier 2 only)
    claims/
    agent-awareness.log
    state.lock/
```
Plugins are provider-agnostic — they receive `GatherContext` and don't know which provider calls them.

### Core structure
- **TypeScript** — Node 24 native strip-types, no build step for core. `erasableSyntaxOnly` enforced
- **Build pipeline** — `npm run build` emits JS to `dist/` and types to `types/` (for npm consumers only)
- `src/core/` — Plugin engine: registry, renderer, state, types, dispatcher, loader, lock, claims, log
- `src/plugins/` — Built-in awareness plugins (one file each, provider-agnostic)
- `src/providers/claude-code/` — Claude Code adapter (Tier 1 hooks)
- `src/mcp/server.ts` — MCP server with internal ticker (Tier 2)
- `src/daemon/tick-loop.ts` — Shared ticker logic used by MCP server
- `src/commands/` — CLI commands (create, doctor, list, mcp)
- `hooks/` — Claude Code hook entry points (thin wrappers around adapter)
- `config/default.json` — Default plugin configuration
- `skills/` — Claude Code skills (plugin-guide, troubleshooting)
- `.claude-plugin/plugin.json` — Claude Code plugin manifest

### State initialization
All state-touching code must call `initStateDir(provider)` before any state operations.
This sets the provider-scoped `STATE_DIR` and runs one-time migration from old flat layout.

## Versioning — CRITICAL
Three version fields exist — **ALL must be bumped together on every release**:
1. `package.json` `"version"` — npm registry version
2. `.claude-plugin/plugin.json` `"version"` — Claude Code marketplace version
3. `.codex-plugin/plugin.json` `"version"` — Codex marketplace version

## Plugin interface
Each plugin exports: `{ name, description, triggers, defaults, gather(trigger, config, prevState, context) → { text, state } }`

### Lifecycle hooks (all optional)
| Hook | When | Use case |
|------|------|----------|
| `onInstall()` | First-time setup | Create dirs, download resources |
| `onUninstall()` | Plugin removal | Remove caches, state files |
| `onStart()` | Session begins | Connect services, warm caches |
| `onStop()` | Session ends | Graceful shutdown, flush buffers |

## Trigger system
| Trigger | Tier 1 (hooks) | Tier 2 (MCP) |
|---------|---------------|--------------|
| `session-start` | startup hook | startup hook |
| `prompt` | prompt hook | not used |
| `change:hour` | checked on prompt | MCP ticker |
| `change:day` | checked on prompt | MCP ticker |
| `interval:Nm` | checked on prompt | MCP ticker + channel push |

## Dispatcher (src/core/dispatcher.ts)
All plugin execution routes through PluginDispatcher:
- Per-plugin bounded queue (default 3, configurable via `maxQueue`)
- Serial per plugin, parallel across plugins
- AbortSignal timeout (default 30s, configurable via `timeout`)
- Errors → null + stderr log, never crashes the pipeline

## State & Logging
- Provider-scoped at `~/.cache/agent-awareness/<provider>/`
- Initialize with `initStateDir(provider)` before any reads/writes
- Each plugin gets own namespace, auto-timestamped via `_updatedAt`
- All state writes use `withState()` (atomic read-modify-write under file lock)
- Log auto-rotates at 256 KB (keeps one `.1` backup)

## Multi-agent coordination

### State locking (`src/core/lock.ts`)
- Atomic `mkdir()`-based lock inside provider state dir
- Lock dir set by `setLockDir()` called from `initStateDir()`
- Stale threshold: 30s. Dead PID or expired → force-broken
- `withStateLock(fn)` — low-level; `withState(fn)` — high-level read-modify-write

### Event claiming (`src/core/claims.ts`)
- Claims dir inside provider state dir: `<state>/claims/<plugin>/<event-key>.json`
- Default TTL: 30 minutes. Dead PID → auto-reclaim
- `createClaimContext(pluginName)` → `ClaimContext` with `tryClaim`, `isClaimedByOther`, `release`

## Plugin discovery (loader)
Four sources, scanned in priority order (later overrides earlier by name):
1. **Built-in** — `src/plugins/*.ts`
2. **Global npm** — `npm root -g` → `agent-awareness-plugin-*`
3. **Local npm** — `node_modules/agent-awareness-plugin-*`
4. **Local** — `~/.config/agent-awareness/plugins/`

**CRITICAL: npm plugins must ship compiled `.js`** — Node 24 blocks TypeScript inside `node_modules/`.

## Config
Per-plugin config, layered resolution (each layer deep-merges):
1. Plugin built-in `defaults`
2. Package defaults: `config/default.json` → `plugins.<name>`
3. User global: `~/.config/agent-awareness/plugins.d/<name>.json`
4. Rig/project: `$AGENT_AWARENESS_CONFIG/plugins.d/<name>.json`

## MCP server (src/mcp/server.ts)
- Tier 2 only — stdio transport for Claude Code
- Runs internal ticker for interval/change triggers
- Pushes via `claude/channel` capability (real-time, between prompts)
- Built-in `awareness_doctor` tool
- Channel dedup via SHA1 fingerprints (in-memory + on-disk)
- Session reset detection clears dedup state

## CLI
```bash
agent-awareness create <name>              # scaffold npm plugin package
agent-awareness create <name> --mcp        # scaffold with MCP tool example
agent-awareness create <name> --local      # scaffold local plugin
agent-awareness doctor                     # diagnose plugin loading, config, state
agent-awareness list                       # show discovered plugins + status
agent-awareness mcp install                # add MCP server to Claude Code plugin config
agent-awareness mcp uninstall              # remove MCP server
agent-awareness mcp status                 # show MCP status
```

## Dev commands
```bash
node hooks/session-start.ts     # test session-start output
node hooks/prompt-submit.ts     # test prompt-submit output
node --test src/**/*.test.ts    # run tests
npx tsc --noEmit                # type-check
npm run build                   # emit JS to dist/ + types to types/
node src/cli.ts doctor          # test doctor command locally
```

## Types & build for plugin developers
- `npm run build` emits JS to `dist/` and `.d.ts` to `types/` (both gitignored)
- `exports` map points to `dist/` so npm consumers get `.js`
- Core runs raw `.ts` — build output is only for downstream consumers
- `AwarenessPlugin<TState>` is generic — plugins get typed state without casts
- `GatherContext` provides `signal?: AbortSignal`, `log?: { warn, error }`, `claims?: ClaimContext`

## Current plugins
| Plugin | File | What it provides |
|--------|------|-----------------|
| time-date | `src/plugins/time-date.ts` | Time, date, weekday, week number, business hours |

Additional plugins ship from `agent-awareness-plugins` repo
(`agent-awareness-plugin-*` npm packages, auto-discovered by the loader).

## Codex provider
Status: **experimental, not actively maintained**. Source kept at `src/providers/codex/` but not tested or guaranteed to work. Claude Code is the primary supported provider.
