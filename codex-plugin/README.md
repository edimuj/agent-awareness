# agent-awareness Codex Bundle

This directory packages the Codex-specific runtime surface for `agent-awareness`.

## What this bundle contains

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `hooks.json` — Codex hook event config template
- `hooks/` — stable `.mjs` wrappers for the session-start and prompt hooks
- `.codex-mcp.json` — optional diagnostic MCP config
- `dist/` — built runtime copied in at publish/build time

## Supported install path

```bash
npm install -g agent-awareness
agent-awareness codex setup
```

That command writes absolute hook commands into the user's Codex config and points them at the packaged wrappers in this directory.

Realtime Codex sessions use the live launcher:

```bash
codex-aware
```

The launcher starts `codex app-server`, opens Codex with `--remote`, and lets the session-start hook attach a live sidecar to the active thread. The sidecar subscribes to the agent-awareness daemon SSE stream and delivers updates into the running Codex session. `agent-awareness codex live` is the long-form equivalent.

Optional diagnostics MCP is separate:

```bash
agent-awareness codex mcp install
agent-awareness codex doctor
```

That MCP surface is diagnostic only. It exposes `awareness_doctor`; realtime delivery is handled by the app-server sidecar, not MCP.

## Marketplace/plugin install caveat

Clean-room validation showed that installing the Codex plugin bundle through Codex's plugin/browser flow can cache and enable the bundle, but it does not create `hooks.json` in the user's Codex config and it does not activate awareness hooks.

So this directory is real provider packaging, not the canonical end-user install path.

## Local development

From the repository root:

```bash
npm run build
node codex-plugin/hooks/codex-session-start.mjs
node codex-plugin/hooks/codex-prompt-submit.mjs
codex-aware
```

The wrappers resolve in this order:

1. `codex-plugin/dist/`
2. repo-root `dist/`
3. repo-root `src/hooks/`

That keeps local development working before publish while still giving Codex stable packaged entrypoints.
