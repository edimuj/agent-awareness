# agent-awareness

Modular awareness plugins for AI coding agents.

## Architecture

### Two-tier integration (separate paths, not stacked)

**Tier 1 — Hooks only** (no background processes)
- Startup hook fires `session-start` plugins → injects initial context
- Prompt hook fires `prompt`, `change:*`, and `interval:*` plugins inline
- Interval check: if enough time passed since `_updatedAt`, plugin fires on next prompt
- No ticker, no daemon, no MCP, no PID files

**Tier 2 — Central daemon + Monitor** (Claude realtime path)
- Startup hook fires `session-start` plugins → injects initial context
- Declarative monitor (`monitors/monitors.json`) auto-starts `awareness-monitor.mjs` — no hook instruction needed
- Central daemon handles intervals, change-detection, SSE broadcast, and doctor state
- `awareness-monitor.mjs` connects to daemon SSE, pipes events to stdout via Claude Code Monitor
- No MCP channels, no danger flags — Monitor is a built-in Claude Code feature

### Provider isolation
Each provider gets its own state directory — no shared state, no conflicts:
```
~/.cache/agent-awareness/
  claude-code/          ← all state for Claude Code
    state.json
    ticker-cache.json   (Tier 2 only)
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
- `src/providers/codex/` — Codex adapter (Tier 1 hooks)
- `src/hooks/` — Codex hook entry points compiled into provider packaging
- `src/mcp/server.ts` — Legacy MCP bridge (optional, for `awareness_doctor` tool only)
- `src/daemon/server.ts` — Central daemon server for the Claude realtime path
- `src/daemon/tick-loop.ts` — Shared ticker logic used by the daemon
- `src/commands/` — CLI commands (create, doctor, list, mcp)
- `hooks/` — Claude Code source hook entry points for local dev
- `config/default.json` — Default plugin configuration

### Claude Code plugin packaging
- `claude-plugin/` — Shipped plugin artifact (what marketplace installs)
  - `claude-plugin/.claude-plugin/plugin.json` — Plugin manifest
  - `claude-plugin/hooks/` — Hook scripts: session-start, prompt-submit, install-deps
  - `claude-plugin/hooks/hooks.json` — Hook event config
  - `claude-plugin/hooks/awareness-monitor.mjs` — Long-running SSE client for realtime delivery
  - `claude-plugin/monitors/monitors.json` — Declarative monitor config (auto-starts awareness-monitor.mjs)
  - `claude-plugin/skills/` — Claude Code skills (plugin-guide, troubleshooting)
  - `claude-plugin/.mcp.json` — Optional MCP server config (diagnostic `awareness_doctor` tool only)
  - `claude-plugin/dist/` — Compiled JS committed to git (required for git-sourced marketplace distribution)
- `.claude-plugin/marketplace.json` — Marketplace config, git relative source: `./claude-plugin`
- Root has NO `.mcp.json` — avoids project-level MCP conflict during dev

### Codex plugin packaging
- `codex-plugin/` — Shipped Codex-facing artifact bundle
  - `codex-plugin/.codex-plugin/plugin.json` — Plugin manifest
  - `codex-plugin/.codex-mcp.json` — Optional diagnostic MCP config
  - `codex-plugin/hooks.json` — Hook event config
  - `codex-plugin/hooks/` — Stable `.mjs` hook entry points
  - `codex-plugin/README.md` — Codex bundle contract and local-dev notes
- `agent-awareness codex setup` writes absolute hook commands to user Codex config, but the packaged Codex surface now stays under `codex-plugin/`
- Codex plugin/browser install can cache and enable the bundle, but it does not activate awareness hooks; setup remains the canonical integration path

### State initialization
All state-touching code must call `initStateDir(provider)` before any state operations.
This sets the provider-scoped `STATE_DIR` and runs one-time migration from old flat layout.

## Versioning — CRITICAL
Five version fields exist — **ALL published surfaces must stay in sync on every release**:
1. `package.json` `"version"` — npm registry version
2. `claude-plugin/package.json` `"version"` — npm package version (must match)
3. `claude-plugin/.claude-plugin/plugin.json` `"version"` — Claude Code plugin manifest
4. `codex-plugin/package.json` `"version"` — Codex plugin package version
5. `codex-plugin/.codex-plugin/plugin.json` `"version"` — Codex plugin manifest

## Publishing a new version
```bash
# 1. Bump version in all published places (e.g. 0.5.0 → 0.6.0)
#    - package.json
#    - claude-plugin/package.json
#    - claude-plugin/.claude-plugin/plugin.json
#    - codex-plugin/package.json
#    - codex-plugin/.codex-plugin/plugin.json

# 2. Commit and push
git add -A && git commit -m "release: v0.6.0" && git push

# 3. Publish npm packages (each runs prepublishOnly → builds dist/)
cd claude-plugin && npm publish && cd ..
cd codex-plugin && npm publish && cd ..

# 4. Update installed plugins across rigs
claude-rig update-plugins
```

The `prepublishOnly` script in each provider package runs `cd .. && npm run build`,
which compiles TS → `dist/` and copies it into `claude-plugin/dist/` and `codex-plugin/dist/`.
The provider npm `files` fields ship only the runtime artifacts needed by that provider package.

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
| Trigger | Tier 1 (hooks) | Tier 2 (daemon + Monitor) |
|---------|---------------|--------------|
| `session-start` | startup hook | startup hook (+ starts Monitor) |
| `prompt` | prompt hook | prompt hook |
| `change:hour` | checked on prompt | daemon ticker �� Monitor notification |
| `change:day` | checked on prompt | daemon ticker → Monitor notification |
| `interval:Nm` | checked on prompt | daemon ticker → Monitor notification |

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

## Monitor-based realtime delivery (Tier 2)
- Declarative monitor in `claude-plugin/monitors/monitors.json` — Claude Code auto-starts it at session start
- `awareness-monitor.mjs` connects to daemon SSE, outputs `[awareness:<plugin>] <text>` to stdout
- Each stdout line becomes a Monitor notification visible to Claude mid-conversation
- Dedup via SHA1 fingerprints per plugin (in-memory)
- Auto-reconnects on daemon restart, exits after MAX_RETRIES if daemon unreachable
- No session-start hook instruction, no source-field gating, no MCP SDK dependency

## Plugin hot-reload
- Daemon supports `POST /reload` — re-discovers all plugin sources, cache-busts ESM imports, runs lifecycle hooks
- Auto-triggered on every `session-start` gather — new sessions always get fresh plugins
- Manual: `agent-awareness reload` CLI command or `curl -X POST http://localhost:<port>/reload`
- Client function: `reloadDaemon()` from `src/daemon/client.ts`
- `/health` endpoint includes loaded plugin names for observability

## MCP server (src/mcp/server.ts) — legacy/optional
- Provides `awareness_doctor` diagnostic tool only
- Realtime delivery has moved to Monitor-based approach (above)
- Still ships in `.mcp.json` for diagnostics; deps installed via `CLAUDE_PLUGIN_DATA` pattern

## CLI
```bash
agent-awareness create <name>              # scaffold npm plugin package
agent-awareness create <name> --mcp        # scaffold with MCP tool example
agent-awareness create <name> --local      # scaffold local plugin
agent-awareness doctor                     # diagnose plugin loading, config, state
agent-awareness list                       # show discovered plugins + status
agent-awareness reload                     # hot-reload plugins in running daemon
agent-awareness mcp install                # add MCP server to Claude Code plugin config
agent-awareness mcp uninstall              # remove MCP server
agent-awareness mcp status                 # show MCP status
```

## Dev commands
```bash
node hooks/session-start.ts     # test Claude session-start (source TS, dev)
node hooks/prompt-submit.ts     # test Claude prompt-submit (source TS, dev)
node src/hooks/codex-session-start.ts   # test Codex session-start source hook
node src/hooks/codex-prompt-submit.ts   # test Codex prompt source hook
node claude-plugin/hooks/session-start.mjs  # test compiled hook (what users get)
timeout 3 node claude-plugin/hooks/awareness-monitor.mjs  # test monitor script (connects to daemon SSE)
node codex-plugin/hooks/codex-session-start.mjs  # test packaged Codex hook
node --test src/**/*.test.ts    # run tests
npx tsc --noEmit                # type-check
npm run build                   # emit JS to dist/ + types to types/
node src/cli.ts doctor          # test doctor command locally
claude --plugin-dir ./claude-plugin  # test plugin locally (full integration)
```

## Types & build for plugin developers
- `npm run build` emits JS to `dist/` and `.d.ts` to `types/`
- `claude-plugin/dist/` is committed to git (required for git-sourced marketplace); root `dist/` and `codex-plugin/dist/` are gitignored
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
Status: **supported for Tier 1 hooks only**.

- Source hook entry points: `src/hooks/codex-session-start.ts`, `src/hooks/codex-prompt-submit.ts`
- Packaged hook entry points: `codex-plugin/hooks/codex-session-start.mjs`, `codex-plugin/hooks/codex-prompt-submit.mjs`
- Direct adapter: `src/providers/codex/adapter.ts`
- Setup path: `agent-awareness codex setup`
- Marketplace/plugin install does not wire Codex hook config today
- Optional MCP: diagnostics only; do not treat it as realtime context injection
- Bundle docs: `codex-plugin/README.md`

Codex does not have an equivalent to Claude Code's Monitor capability, so Codex does not use the daemon/SSE path for realtime context delivery. Claude Code remains the only provider with realtime push (via Monitor).
