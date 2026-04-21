# agent-awareness

Your AI coding agent is blind. It doesn't know what time it is, that it's burning through quota, that a deploy just failed, or that your toddler's nap ends in 20 minutes.

**agent-awareness** gives agents senses. A plugin system that injects real-world context into AI coding agents — anything you can query with code, your agent can know about. Continuously.

```
[agent-awareness]
Session: 2h14min | 5h: 35% (↻3h22m) | 7d: 48%
14:32 CET Wed 26 Mar 2026 | Week 13 | Business hours
Weather Stockholm: 12°C partly cloudy | Wind: 8km/h | Sunset: 18:45
Focus: 18min left (deep work) | Energy: peak → stay ambitious
Coffee: 1 cup left — brewing recommended before next session
```

Six lines. Your agent now knows more about your world than most humans you work with.

## What can agents be aware of?

Anything. That's the point. Here's what ships built-in:

| Plugin | What it knows |
|--------|--------------|
| **time-date** | Time, date, weekday, week number, business hours |

Everything else ships as installable npm plugins. Common ones:
- `agent-awareness-plugin-quota`
- `agent-awareness-plugin-system`
- `agent-awareness-plugin-weather`
- `agent-awareness-plugin-energy-curve`
- `agent-awareness-plugin-focus-timer`

The plugin system is where it gets interesting:

- **Home automation** — "The living room is 24°C, toddler's room is 19°C, front door locked"
- **Infrastructure** — "3 pods restarting in staging, prod latency p99 at 340ms"
- **GitHub** — "PR #47 has 2 approvals, CI green. Issue #52 assigned to you 3h ago"
- **Calendar** — "Next meeting in 45min with 3 attendees, prep doc unread"
- **Build pipeline** — "Last deploy: 12min ago, 2 flaky tests skipped"
- **Team** — "Sarah pushed to main 8min ago, 4 files overlap with your branch"
- **Health** — "You've been coding for 3h straight, last break was 2h ago"
- **Finance** — "AWS spend today: $4.20, on track for monthly target"
- **Smart home** — "Washing machine done 20min ago, dryer available"

If you can `fetch()` it, `exec()` it, or `readFile()` it — your agent can know about it. Write a `gather()` function, return a string, done.

For real-world examples, check out [agent-awareness-plugins](https://github.com/edimuj/agent-awareness-plugins) — it now hosts the former built-ins (`quota`, `system`, `weather`, `energy-curve`, `focus-timer`) plus community plugins like **github-watcher** and **server-health**.

## Install

As a Claude Code plugin (installed via marketplace):

```bash
# Add the marketplace (one-time)
/plugin marketplace add edimuj/agent-awareness

# Install
/plugin install agent-awareness@agent-awareness
```

For Codex CLI:
```bash
npm install -g agent-awareness
agent-awareness codex setup           # hooks-only setup (supported Codex path)
```
Run this once, then use Codex in any project.

Install additional awareness plugins globally (recommended):
```bash
npm install -g agent-awareness-plugin-quota
npm install -g agent-awareness-plugin-system
npm install -g agent-awareness-plugin-weather
npm install -g agent-awareness-plugin-energy-curve
npm install -g agent-awareness-plugin-focus-timer
```

Why not `npx` for Codex setup? The supported path writes stable on-disk hook commands into Codex config, so setup has to point at a real install. The optional Codex diagnostic MCP entry has the same path-stability requirement.

Codex packaging artifacts live under `codex-plugin/`:
- `codex-plugin/.codex-plugin/plugin.json`
- `codex-plugin/.codex-mcp.json`
- `codex-plugin/hooks.json`
- `codex-plugin/hooks/`
- `codex-plugin/README.md`

Codex note: the supported integration in this repo is hooks-only. Clean-room validation showed that Codex marketplace/plugin install can cache and enable the `codex-plugin/` bundle, but it does not create hook config or activate awareness hooks. Use `agent-awareness codex setup`. Codex also does not currently have a documented equivalent to Claude Code channels, so real-time context push is not part of the Codex provider today. Optional Codex MCP support is diagnostic only. See [`codex-plugin/README.md`](./codex-plugin/README.md) for the exact contract of the packaged Codex bundle.

## Build your own plugin in 5 minutes

```bash
# npm package (share with the world)
npx agent-awareness create weather-alerts

# Local plugin (just for you)
npx agent-awareness create my-secret-sauce --local
```

Full authoring guide (step-by-step, caveats, troubleshooting, best practices, examples):
[`docs/plugin-creator-guide.md`](./docs/plugin-creator-guide.md)

Fill in `gather()`. That's the whole API:

```typescript
import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from 'agent-awareness';

interface CoffeeState extends Record<string, unknown> {
  cups: number;
  lastBrew: string;
}

export default {
  name: 'coffee-level',
  description: 'Tracks remaining coffee supply via smart scale',
  triggers: ['session-start', 'interval:30m'],
  defaults: {
    triggers: { 'session-start': true, 'interval:30m': true },
    scaleEndpoint: 'http://kitchen-scale.local/api/weight',
  },

  async gather(trigger, config, prevState, context) {
    const weight = await fetch(config.scaleEndpoint as string, { signal: context.signal });
    const cups = Math.floor((await weight.json()).grams / 250);

    if (cups > 2) return null; // not worth mentioning

    return {
      text: cups === 0
        ? 'Coffee: EMPTY — brewing strongly recommended'
        : `Coffee: ${cups} cup${cups > 1 ? 's' : ''} left`,
      state: { cups, lastBrew: prevState?.lastBrew ?? 'unknown' },
    };
  },
} satisfies AwarenessPlugin<CoffeeState>;
```

Key details:
- **`context.signal`** — AbortSignal for cancellation. Use it in `fetch()`, `execFile()`, etc.
- **`context.log`** — Structured logging (`context.log?.warn('scale offline')`)
- **Generic state** — `AwarenessPlugin<CoffeeState>` gives you typed `prevState` with zero casts
- **Return `null`** to suppress output — only inject when there's something worth saying
- **Auto-discovered** — no registration, no config editing, no restart

## Plugin sources

Plugins load from four places (later overrides earlier by name):

1. **Built-in** — currently `time-date` only
2. **Global npm** — `npm install -g agent-awareness-plugin-*` (recommended for users)
3. **Local npm** — `npm install agent-awareness-plugin-*` in the agent-awareness directory
4. **Local** — drop a `.ts` file in `~/.config/agent-awareness/plugins/`

## Publishing plugins to npm

The scaffold (`agent-awareness create`) sets up everything you need. The key requirement: **npm plugins must ship compiled `.js` files** — Node 24+ blocks TypeScript inside `node_modules/`.

If you want a complete publish workflow and troubleshooting checklist, see:
[`docs/plugin-creator-guide.md`](./docs/plugin-creator-guide.md)

The scaffold generates a `tsconfig.build.json` with `rewriteRelativeImportExtensions` that compiles `.ts` → `.js` correctly, and a `prepublishOnly` script that builds automatically before `npm publish`.

```bash
cd agent-awareness-plugin-my-plugin
npm install             # install devDependencies
npm run build           # compile .ts → .js
npm install -g .        # test globally before publishing
npm publish             # ship it
```

Local plugins (`--local`) don't need a build step — they run raw TypeScript since they're not inside `node_modules/`.

## Configuration

Each plugin gets its own config file. No monoliths:

```
~/.config/agent-awareness/plugins.d/weather.json
```

```json
{
  "latitude": 59.33,
  "longitude": 18.07,
  "city": "Stockholm"
}
```

Config layers deep-merge: plugin defaults → package defaults → user global → rig/project override.

Set `AGENT_AWARENESS_CONFIG` for per-project or per-rig overrides.

## Integration modes

agent-awareness is a progressive system, but providers do not all expose the same surfaces.

| Mode | Provider | What you get | Setup |
|------|----------|--------------|-------|
| **Hooks only** | Claude Code, Codex | Context injection at session start and on prompt. `interval:*` and `change:*` are evaluated inline on prompt. | Default baseline. |
| **Realtime path** | Claude Code | Central daemon runs interval/change checks, Monitor delivers updates mid-conversation. No special flags needed. | Automatic — SessionStart hook starts the Monitor. |
| **Diagnostics MCP** | Codex | Optional `awareness_doctor` MCP tool only. No realtime delivery, no hook activation. | `agent-awareness codex mcp install` |

On the Claude realtime path, a central daemon owns the ticker loop and SSE broadcast. The SessionStart hook instructs Claude to start a persistent Monitor that connects to the daemon's SSE stream. Each plugin result is output to stdout and arrives as a Monitor notification — real-time, mid-conversation, no special flags or channel approvals needed.

Current provider support:
- Claude Code: hooks baseline plus realtime daemon/Monitor path (automatic when daemon is available).
- Codex: hooks only as the supported awareness path. Optional MCP exists for diagnostics, but it does not provide real-time context injection.

Codex integration:
```bash
agent-awareness codex setup          # install supported Codex hooks integration
agent-awareness codex doctor         # diagnose Codex hooks + optional MCP health
```

## Lifecycle hooks

Simple plugins just need `gather()`. Plugins that manage daemons, connections, or caches use lifecycle hooks:

```typescript
export default {
  // ...
  async onInstall() { /* download models, create cache dirs */ },
  async onStart()   { /* spawn daemon, connect to service */ },
  onStop()          { /* graceful shutdown */ },
  onUninstall()     { /* clean up everything */ },
} satisfies AwarenessPlugin;
```

## Execution safety

All plugin execution — triggers, MCP, background ticks — routes through a unified dispatcher:

- **Per-plugin queue** — bounded (default 3), drops oldest on overflow
- **Timeout** — 30s default, configurable per-plugin
- **Serial per plugin** — prevents state races
- **Parallel across plugins** — one slow plugin doesn't block others
- **Errors never crash** — failures → null, logged to stderr

Community plugins can't hang your agent or eat unbounded memory:

```json
{ "timeout": 10000, "maxQueue": 5 }
```

## Multi-agent coordination

When you run multiple agent sessions in parallel (e.g., different rigs via [claude-rig](https://github.com/edimuj/claude-rig)), they all receive the same plugin notifications. Getting notified is fine — but when a plugin says "act" (e.g., "fix the CI failure on this PR"), you don't want three agents racing to push competing fix commits.

agent-awareness solves this at the framework level with two mechanisms:

### State locking

All state reads and writes go through an atomic file lock. The ticker, prompt hooks, and MCP server can run concurrently without corrupting `state.json`.

This is automatic — plugins don't need to do anything.

### Event claiming

Before rendering an "act"-level directive, plugins can _claim_ the event. Only the first session to claim it gets the "act" framing — other sessions see a downgraded "notify" with a note that another session is handling it.

```typescript
async gather(trigger, config, prevState, context) {
  const events = detectEvents(prevState);

  for (const event of events) {
    if (getAutonomy(event.type, config) === 'act' && context.claims) {
      const { claimed } = await context.claims.tryClaim(event.key);
      if (!claimed) {
        // Another session is handling this — downgrade to notify
        event.autonomy = 'notify';
        event.note = 'being handled by another session';
      }
    }
  }

  return { text: formatEvents(events), state: newState };
}
```

Claims are:
- **Scoped per plugin** — different plugins can claim the same event key independently
- **Auto-expiring** — default 30 minutes, configurable per claim
- **PID-aware** — if the claiming session dies, the claim is automatically released
- **Pruned at session start** — expired claims are cleaned up automatically

The full `context.claims` API:

| Method | Description |
|--------|-------------|
| `tryClaim(eventKey, ttlMinutes?)` | Claim an event. Returns `{ claimed: true }` or `{ claimed: false, holder }` |
| `isClaimedByOther(eventKey)` | Check without claiming |
| `release(eventKey)` | Release your claim (e.g., after completing the action) |

## Background daemon (Claude realtime path)

`interval:10m` means every 10 minutes — not "whenever you happen to type after 10 minutes."

A central daemon process runs the ticker loop once per machine for the Claude Code realtime path. When the first session starts, the session-start hook auto-spawns the daemon. The daemon:

- Loads all plugins once
- Runs interval/change triggers on schedule
- Broadcasts results to all connected sessions via SSE
- Auto-shuts down after 15 minutes of inactivity

The delivery mechanism is Claude Code's built-in Monitor feature. The SessionStart hook instructs Claude to start a persistent `awareness-monitor.mjs` script that connects to the daemon's SSE stream. Each plugin result is output to stdout, which Monitor delivers as a real-time notification. No MCP channels, no `--dangerously-load-development-channels` flag, no special permissions.

On compact/clear, the SessionStart hook re-fires to re-inject context (since Claude lost its context window), but skips the Monitor instruction — the Monitor from the original startup is still running.

Multiple sessions share one daemon — no duplicated API calls, no state races.

## Provider-aware

Plugins know which agent they're running under via `context.provider`. The quota plugin uses this to fetch the right data for Claude vs Codex automatically. Same plugin, different agent, correct data.

Built-in: **Claude Code**, **Codex**. Adding your own is ~60 lines.

## CLI

```bash
agent-awareness create <name>          # scaffold npm plugin
agent-awareness create <name> --local  # scaffold local plugin
agent-awareness doctor                 # diagnose loading, config, logs
agent-awareness list                   # show plugins + status
agent-awareness mcp install            # add MCP server to Claude Code
agent-awareness mcp uninstall          # remove MCP server from Claude Code
agent-awareness mcp status             # check Claude Code MCP config
agent-awareness codex hooks install --global   # add global Codex hooks (~/.codex/hooks.json)
agent-awareness codex hooks install --project  # add project hooks (./.codex/hooks.json)
agent-awareness codex hooks uninstall --global # remove global Codex hooks
agent-awareness codex hooks uninstall --project # remove project hooks
agent-awareness codex hooks status --global    # check global hooks config
agent-awareness codex hooks status --project   # check project hooks config
agent-awareness codex mcp install      # add optional diagnostic MCP server to Codex
agent-awareness codex mcp uninstall    # remove optional Codex MCP server
agent-awareness codex mcp status       # check optional Codex MCP config
agent-awareness codex setup            # install supported Codex hooks integration
agent-awareness codex doctor           # diagnose Codex hooks + optional MCP
```

## Diagnostics

```bash
agent-awareness doctor    # full health check
```

**Log file:** `~/.cache/agent-awareness/claude-code/agent-awareness.log` — captures ticker errors, plugin failures, lock contention. Auto-rotates at 256 KB. The `doctor` command shows the log location and file size.

**MCP tool:** `awareness_doctor` — same diagnostics, available to agents (requires MCP server; optional).

## Requirements

- Node.js 24+ (runs TypeScript natively — no build step)

## License

MIT
