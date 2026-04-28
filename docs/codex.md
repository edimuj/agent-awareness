# Codex Provider

agent-awareness integrates with Codex through **hooks only** (Tier 1). Codex does not currently have an equivalent to Claude Code's Monitor capability, so there is no realtime push path.

## How it works

- Session-start hook fires all `session-start` plugins, injecting context at conversation start
- Prompt hook fires `prompt`, `change:*`, and `interval:*` plugins inline with each user prompt
- Interval triggers are evaluated on prompt. "Every 10 minutes" means "on the first prompt after 10 minutes have passed"

## Setup

```bash
npm install -g agent-awareness
agent-awareness codex setup
```

This writes hook commands into your Codex config. Run it once, then use Codex in any project.

Why `npm install -g` and not `npx`? The setup writes stable on-disk hook paths into Codex config. They need to point at a real install.

Then install awareness plugins globally:

```bash
npm install -g agent-awareness-plugin-quota
npm install -g agent-awareness-plugin-weather
# etc.
```

## CLI commands

```bash
agent-awareness codex setup                      # install Codex hooks integration
agent-awareness codex doctor                     # diagnose Codex hooks
agent-awareness codex hooks install --global     # add global hooks (~/.codex/hooks.json)
agent-awareness codex hooks install --project    # add project hooks (./.codex/hooks.json)
agent-awareness codex hooks uninstall --global   # remove global hooks
agent-awareness codex hooks uninstall --project  # remove project hooks
agent-awareness codex hooks status --global      # check global hooks config
agent-awareness codex hooks status --project     # check project hooks config
```

## Diagnostics

```bash
agent-awareness codex doctor
```

Checks: Codex installation, hooks config, plugin loading, state paths.

**Log file:** `~/.cache/agent-awareness/codex/agent-awareness.log`

## Packaging

The Codex plugin artifacts live under `codex-plugin/`:

```
codex-plugin/
├── .codex-plugin/plugin.json   plugin manifest
├── hooks.json                  hook event config
├── hooks/                      compiled .mjs hook entry points
└── README.md                   bundle contract
```

Codex marketplace/plugin install can cache and enable the bundle, but it does not create hook config or activate awareness hooks. `agent-awareness codex setup` remains the canonical integration path.

## Limitations

- **No realtime push**: Codex lacks a Monitor equivalent, so updates only arrive on prompt
- **Hooks only**: no daemon, no SSE, no background ticker
- **Setup required**: marketplace install alone doesn't activate hooks
