# agent-awareness

Modular awareness plugins for AI coding agents.

## Architecture
- **TypeScript** — Node 24 native strip-types, no build step. `erasableSyntaxOnly` enforced
- `src/core/` — Plugin engine: registry, renderer, state, types
- `src/plugins/` — Awareness plugins (one file each, provider-agnostic)
- `src/providers/claude-code/` — Claude Code provider adapter
- `hooks/` — Claude Code hook entry points (thin wrappers around adapter)
- `hooks/hooks.json` — Hook event configuration (SessionStart, UserPromptSubmit)
- `config/default.json` — Default plugin configuration
- `.claude-plugin/plugin.json` — Claude Code plugin manifest

## Plugin interface
Each plugin exports: `{ name, description, triggers, defaults, gather(trigger, config, prevState) → { text, state } }`

### Lifecycle hooks (all optional)
| Hook | When | Use case |
|------|------|----------|
| `onInstall()` | First-time setup | Create dirs, download resources, validate deps |
| `onUninstall()` | Plugin removal | Remove caches, state files, free resources |
| `onStart()` | Session begins | Spawn daemons, connect services, warm caches |
| `onStop()` | Session ends | Graceful shutdown, flush buffers, kill children |

## Trigger system
| Trigger | Fires when |
|---------|-----------|
| `session-start` | Session begins (once) |
| `prompt` | Every user prompt |
| `change:hour` | Hour boundary crossed (checked on prompt) |
| `change:day` | Date boundary crossed (checked on prompt) |
| `interval:Nm` | N minutes since last fire (checked on prompt) |

## State
- Persisted at `~/.cache/agent-awareness/state.json`
- Each plugin gets own namespace, auto-timestamped via `_updatedAt`

## Plugin discovery (loader)
Three sources, scanned in priority order (later overrides earlier by name):
1. **Built-in** — `src/plugins/*.ts` (ships with the package)
2. **npm** — `node_modules/agent-awareness-plugin-*` (auto-discovered)
3. **Local** — `~/.config/agent-awareness/plugins/` (private plugins, .ts files or dirs with index.ts)

Plugin packs (array default export) are supported — one npm package can provide multiple plugins.

## Config
- Defaults: `config/default.json`
- User overrides: `~/.config/agent-awareness/config.json` (deep merged)

## CLI
```bash
agent-awareness create <name>              # scaffold npm plugin package
agent-awareness create <name> --local      # scaffold local plugin (~/.config/...)
agent-awareness list                       # show discovered plugins + status
```

## Dev commands
```bash
node hooks/session-start.ts     # test session-start output
node hooks/prompt-submit.ts     # test prompt-submit output
node --test src/**/*.test.ts    # run tests
npx tsc --noEmit                # type-check (no build step — Node runs .ts natively)
```

## Current plugins
| Plugin | File | What it provides |
|--------|------|-----------------|
| time-date | `src/plugins/time-date.ts` | Time, date, weekday, week number, business hours |
| quota | `src/plugins/quota.ts` | Real Claude API utilization (5h burst + 7d weekly) |
| system | `src/plugins/system.ts` | Disk usage, memory, load average, threshold warnings |
| weather | `src/plugins/weather.ts` | Local weather via Open-Meteo (temp, wind, sunset, no API key) |
