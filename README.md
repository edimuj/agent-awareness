# agent-awareness

Your AI coding agent doesn't know what time it is. It doesn't know it's burning through quota. It has no idea there's a thunderstorm outside or that your disk is 98% full.

**agent-awareness** fixes that. It's a modular plugin system that injects real-world context into AI coding agents — so they can make better decisions without you having to tell them.

```
[agent-awareness]
Session: 2h14min | 5h: 35% (↻3h22m) | 7d: 48%
Disk: 67% | Mem: 4.2G free | Load: 1.2
14:32 CET Wed 25 Mar 2026 | Week 13 | Business hours
Weather Stockholm: 12°C, partly cloudy | Wind: 8km/h | Sunset: 18:45
```

Four lines. Zero tokens wasted. Your agent now knows more about your world than most humans you work with.

## Built-in plugins

| Plugin | What it knows |
|--------|--------------|
| **quota** | Real API utilization from Claude & Codex — not wall-clock guessing |
| **system** | Disk, memory, load — warns before your box catches fire |
| **time-date** | Time, date, weekday, week number, business hours |
| **weather** | Live weather via Open-Meteo — auto-detects your location, no API key |
| **energy-curve** | Adapts agent style to your energy rhythm — pick a profile or define custom schedules |
| **focus-timer** | Pomodoro focus timer — agent adapts behavior during focus/break sessions (MCP-enabled) |

## Install

As a Claude Code plugin:

```bash
# 1. Add the marketplace (one-time)
/plugin marketplace add edimuj/agent-awareness

# 2. Install the plugin
/plugin install agent-awareness@edimuj
```

Or browse available plugins interactively with `/plugin` → "Discover" tab.

For manual installation from a local clone:
```bash
git clone https://github.com/edimuj/agent-awareness.git
cd agent-awareness && npm install
/plugin install /path/to/agent-awareness
```

## Build your own plugin

```bash
# npm package (for sharing)
npx agent-awareness create weather-alerts

# With MCP real-time tools
npx agent-awareness create home-sensors --mcp

# Local plugin (for you)
npx agent-awareness create my-secret-sauce --local
```

That gives you a typed skeleton. Fill in `gather()`, and you're done:

```typescript
import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from 'agent-awareness';

export default {
  name: 'coffee-level',
  description: 'Tracks remaining coffee supply',
  triggers: ['session-start', 'interval:30m'],
  defaults: {
    triggers: { 'session-start': true, 'interval:30m': true },
  },

  gather(trigger: Trigger, config: PluginConfig, prevState, context: GatherContext) {
    const cups = estimateCupsRemaining();
    if (cups > 2) return null; // not worth mentioning
    return {
      text: `Coffee: ${cups} cups left — consider brewing`,
      state: { cups },
    };
  },
} satisfies AwarenessPlugin;
```

Plugins are auto-discovered. No registration, no config editing, no restart ceremony.

## Plugin sources

Plugins are loaded from three places (later overrides earlier by name):

1. **Built-in** — ships with agent-awareness
2. **npm** — `npm install agent-awareness-plugin-*` and it just works
3. **Local** — drop a `.ts` file in `~/.config/agent-awareness/plugins/`

## Configuration

Each plugin gets its own config file. No monoliths.

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

Config layers deep-merge in order: plugin defaults → package defaults → user global → rig/project override.

Set `AGENT_AWARENESS_CONFIG` to a directory for rig-specific or project-specific overrides.

## Lifecycle hooks

Simple plugins just implement `gather()`. Advanced plugins that manage daemons, connections, or external resources can use lifecycle hooks:

```typescript
export default {
  // ...
  async onInstall() { /* download models, create cache dirs */ },
  async onStart()   { /* spawn daemon, connect to service */ },
  onStop()          { /* graceful shutdown */ },
  onUninstall()     { /* clean up everything */ },
} satisfies AwarenessPlugin;
```

## MCP server (optional)

For plugins that need real-time interaction, agent-awareness includes an MCP server. The agent can query plugin data on demand — not just at prompt time.

```bash
agent-awareness mcp install    # add to Claude Code config
agent-awareness mcp uninstall  # remove it
agent-awareness mcp status     # check configuration
```

Plugins opt into MCP by defining tools in their `mcp` field. The MCP server auto-discovers them:

```typescript
export default {
  name: 'home-sensors',
  // ... gather(), triggers, etc.

  mcp: {
    tools: [{
      name: 'temperature',
      description: 'Get current temperature from home sensors',
      inputSchema: { type: 'object', properties: { room: { type: 'string' } } },
      async handler(params, config, signal) {
        const temp = await fetchSensor(params.room as string, { signal });
        return { text: `${params.room}: ${temp}°C` };
      },
    }],
  },
} satisfies AwarenessPlugin;
```

Tool names are auto-scoped: `home-sensors` + `temperature` → `awareness_home_sensors_temperature`. All calls go through the same dispatcher with timeout and queue protection — a misbehaving plugin can't hang the MCP server or starve other plugins.

The MCP server is **completely optional**. Plugins work fine without it — `gather()` handles trigger-based context injection as always. MCP adds real-time query capability on top.

## Execution safety

All plugin calls — hook triggers, MCP events, background ticks — route through a unified dispatcher:

- **Per-plugin queue** — bounded (default 3), drops oldest on overflow
- **Timeout** — 30s default, configurable per-plugin via `timeout` in config
- **Serial per plugin** — prevents state races within a plugin
- **Parallel across plugins** — one plugin hanging doesn't block others
- **Errors never crash** — failures log to stderr and return null (skipped)

Community plugins can't hang your agent or eat unbounded memory. Configure per-plugin:

```json
{
  "timeout": 10000,
  "maxQueue": 5
}
```

## Provider-aware

Plugins know which agent they're running under via `context.provider`. The quota plugin uses this to automatically fetch the right quota data for whichever agent is running. Same plugin, different data.

Built-in provider: **Claude Code**. Adding your own is ~60 lines — see [Creating a Provider](docs/creating-a-provider.md).

## Background ticker

`interval:10m` means every 10 minutes — not "whenever you happen to type after 10 minutes." A background ticker process handles exact timing and caches results for near-zero latency on prompt.

## Conditional injection

`gather()` can return `null` to suppress output. Only inject when there's something worth saying:

```typescript
gather(trigger, config, prevState, context) {
  const memPct = Math.round((1 - freemem() / totalmem()) * 100);
  if (memPct < 80) return null; // everything's fine, save tokens
  return { text: `Memory: ${memPct}% WARNING`, state: {} };
}
```

## CLI

```bash
agent-awareness create <name>          # scaffold npm plugin package
agent-awareness create <name> --mcp    # scaffold with MCP tool example
agent-awareness create <name> --local  # scaffold local plugin
agent-awareness list                   # show discovered plugins + status
agent-awareness mcp install            # add MCP server to Claude Code
agent-awareness mcp uninstall          # remove MCP server
agent-awareness mcp status             # show MCP config status
```

## Requirements

- Node.js 24+ (runs TypeScript natively — no build step)

## License

MIT
