# agent-awareness Codex Bundle

This directory packages the Codex-specific runtime surface for `agent-awareness`.

## What this bundle contains

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `hooks.json` — Codex hook event config template
- `hooks/` — stable `.mjs` wrappers for the session-start and prompt hooks
- `.codex-mcp.json` — optional diagnostic MCP config
- `dist/` — built runtime copied in at publish/build time

## What works today

The supported Codex integration is still:

```bash
npm install -g agent-awareness
agent-awareness codex setup
```

That command writes absolute hook commands into the user's Codex config and points them at the packaged wrappers in this directory.

Optional diagnostics MCP is separate:

```bash
agent-awareness codex mcp install
agent-awareness codex doctor
```

That MCP surface is diagnostic only. It exposes `awareness_doctor`, but it does not deliver realtime context updates.

## What does not work today

Clean-room validation showed that installing the Codex plugin bundle through Codex's plugin/browser flow can cache and enable the bundle, but it does not create `hooks.json` in the user's Codex config and it does not activate awareness hooks.

So this directory is real provider packaging, not the canonical end-user install path.

Codex also does not currently have a documented equivalent to Claude Code channels in this repo, so there is no supported Codex realtime push path here.

## Local development

From the repository root:

```bash
npm run build
node codex-plugin/hooks/codex-session-start.mjs
node codex-plugin/hooks/codex-prompt-submit.mjs
```

The wrappers resolve in this order:

1. `codex-plugin/dist/`
2. repo-root `dist/`
3. repo-root `src/hooks/`

That keeps local development working before publish while still giving Codex stable packaged entrypoints.
