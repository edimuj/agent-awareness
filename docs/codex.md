# Codex Provider

agent-awareness integrates with Codex in two layers:

- **Hooks baseline**: session-start and prompt-submit context injection.
- **Live mode**: `codex app-server` + sidecar delivery for realtime daemon updates while the session is running.

## How Hooks Work

- Session-start hook fires all `session-start` plugins, injecting context at conversation start.
- Prompt hook fires `prompt`, `change:*`, and `interval:*` plugins inline with each user prompt.
- Interval triggers are evaluated on prompt unless you use live mode.

## How Live Mode Works

`agent-awareness codex live` starts a managed `codex app-server`, launches Codex with `--remote`, and sets live-mode environment for the Codex hooks. The `SessionStart` hook receives the active Codex thread id and starts one sidecar for that thread.

The sidecar connects to the agent-awareness daemon SSE stream and delivers plugin updates into the running Codex thread. If Codex is currently responding, updates are steered into the active turn when possible; otherwise they arrive as a new live turn.

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

## Starting Codex

Hooks-only mode uses normal Codex startup:

```bash
codex
```

Realtime mode uses the `codex-aware` launcher:

```bash
codex-aware
```

Pass Codex arguments after the subcommand:

```bash
codex-aware -- --model gpt-5.4
codex-aware -- --ask-for-approval never --sandbox workspace-write
```

Use `--listen ws://127.0.0.1:<port>` if you need a fixed app-server URL.

`agent-awareness codex live` remains available as the long-form equivalent.

## CLI commands

```bash
agent-awareness codex setup                      # install Codex hooks integration
codex-aware                                      # preferred realtime Codex launcher
agent-awareness codex live                       # long-form equivalent
agent-awareness codex doctor                     # diagnose Codex hooks
agent-awareness codex hooks install --global     # add global hooks (~/.codex/config.toml)
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

Live-mode runtime files are written under:

```text
~/.cache/agent-awareness/codex-live/
```

**Log file:** `~/.cache/agent-awareness/codex/agent-awareness.log`

## Packaging

The Codex plugin artifacts live under `codex-plugin/`:

```text
codex-plugin/
├── .codex-plugin/plugin.json   plugin manifest
├── hooks.json                  hook event config
├── hooks/                      compiled .mjs hook entry points
└── README.md                   bundle contract
```

Codex marketplace/plugin install can cache and enable the bundle, but it does not create hook config or activate awareness hooks. `agent-awareness codex setup` remains the canonical install path.

## Limitations

- Live mode requires Codex app-server support.
- Plain `codex` is not aliased or hijacked; use `codex-aware` for realtime updates.
- Hooks remain the fallback path when live mode is not used or app-server startup fails.
