# agent-awareness

Modular awareness plugins for AI coding agents.

## Architecture
- `src/core/` — Plugin engine: registry, renderer, state, types
- `src/plugins/` — Awareness plugins (one file each, provider-agnostic)
- `src/providers/claude-code/` — Claude Code provider adapter
- `hooks/` — Claude Code hook entry points (thin wrappers around adapter)
- `hooks/hooks.json` — Hook event configuration (SessionStart, UserPromptSubmit)
- `config/default.json` — Default plugin configuration
- `.claude-plugin/plugin.json` — Claude Code plugin manifest

## Plugin interface
Each plugin in `src/plugins/` exports: `{ name, description, triggers, defaults, gather(trigger, config, prevState) → { text, state } }`

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

## Config
- Defaults: `config/default.json`
- User overrides: `~/.config/agent-awareness/config.json` (deep merged)

## Dev commands
```bash
node hooks/session-start.mjs    # test session-start output
node hooks/prompt-submit.mjs    # test prompt-submit output
node --test src/**/*.test.mjs   # run tests
```

## Current plugins
| Plugin | File | What it provides |
|--------|------|-----------------|
| time-date | `src/plugins/time-date.mjs` | Time, date, weekday, week number, business hours |
| quota | `src/plugins/quota.mjs` | Session duration, usage window %, conservation signals |
| system | `src/plugins/system.mjs` | Disk usage, memory, load average, threshold warnings |
