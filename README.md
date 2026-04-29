# agent-awareness

Your AI coding agent is blind. It doesn't know what time it is, that it's burning through quota, that a deploy just failed, or that your toddler's nap ends in 20 minutes.

**agent-awareness** gives agents senses. A plugin system that injects real-world context into AI coding agents, not just at startup but continuously throughout the session. A background daemon monitors your plugins on schedule and pushes updates to the agent in real time. Your agent's world view stays current without you doing anything.

```
[agent-awareness]
Session: 2h14min | 5h: 35% (↻3h22m) | 7d: 48%
14:32 CET Wed 26 Mar 2026 | Week 13 | Business hours
Weather Stockholm: 12°C partly cloudy | Wind: 8km/h | Sunset: 18:45
```

Three lines. Your agent now knows more about your world than most humans you work with.

## What can agents be aware of?

Anything. That's the point. Built-in:

| Plugin | What it knows |
|--------|--------------|
| **time-date** | Time, date, weekday, week number, business hours |

Everything else ships as installable npm plugins (`agent-awareness-plugin-*`). Some examples:
- **Quota**: subscription usage, reset times, burn rate
- **Weather**: temperature, conditions, sunset
- **System**: CPU, memory, disk
- **GitHub**: PR status, CI results, assigned issues
- **Home automation**: room temperatures, door locks, appliance status
- **Infrastructure**: pod health, latency percentiles, deploy recency

If you can `fetch()` it, `exec()` it, or `readFile()` it, your agent can know about it.

For real-world examples, check out [agent-awareness-plugins](https://github.com/edimuj/agent-awareness-plugins).

## Quick start

### Claude Code

```bash
/plugin marketplace add edimuj/agent-awareness
/plugin install agent-awareness@agent-awareness
```

That's it. Restart your session. Your agent gets context at startup and keeps receiving updates in real time as things change. For details on the daemon, activity tracking, and diagnostics: [docs/claude-code.md](./docs/claude-code.md)

### Codex

```bash
npm install -g agent-awareness
agent-awareness codex setup
codex-aware                  # preferred: realtime updates via Codex app-server
```

Full setup guide and CLI reference: [docs/codex.md](./docs/codex.md)

### Add more senses

Install plugins globally. They're auto-discovered:

```bash
npm install -g agent-awareness-plugin-quota
npm install -g agent-awareness-plugin-weather
```

## Build your own plugin

```bash
npx agent-awareness create coffee-level          # npm package
npx agent-awareness create my-secret-sauce --local  # local only
```

Fill in `gather()`. That's the whole API:

```typescript
import type { AwarenessPlugin } from 'agent-awareness';

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

- **Return `null`** to suppress output. Only inject when there's something worth saying.
- **`context.signal`**: AbortSignal for cancellation. Pass it to `fetch()`, `execFile()`, etc.
- **Auto-discovered**: no registration, no config editing, no restart.

Full authoring guide: [docs/plugin-creator-guide.md](./docs/plugin-creator-guide.md)

## Plugin sources

Plugins load from four places (later overrides earlier by name):

1. **Built-in**: `time-date`
2. **Global npm**: `npm install -g agent-awareness-plugin-*`
3. **Local npm**: `node_modules/agent-awareness-plugin-*`
4. **Local**: `~/.config/agent-awareness/plugins/`

## Configuration

Each plugin gets its own config file:

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

Config layers deep-merge: plugin defaults > package defaults > user global > rig/project override. Set `AGENT_AWARENESS_CONFIG` for per-project overrides.

## Execution safety

All plugin execution routes through a unified dispatcher:

- **Per-plugin queue**: bounded (default 3), drops oldest on overflow
- **Timeout**: 30s default, configurable per-plugin
- **Serial per plugin**: prevents state races
- **Parallel across plugins**: one slow plugin doesn't block others
- **Errors never crash**: failures resolve to null, logged to stderr

```json
{ "timeout": 10000, "maxQueue": 5 }
```

## Multi-agent coordination

When multiple sessions run in parallel, they all receive the same plugin notifications. That's fine for awareness, but when a plugin says "act" (fix the CI failure, merge the PR), you don't want three agents racing each other.

**State locking**: all reads/writes go through an atomic file lock. Automatic. Plugins don't need to do anything.

**Event claiming**: before rendering an "act" directive, plugins can claim the event. First session to claim it gets the "act" framing; others see a downgraded "notify" with a note that another session is handling it.

```typescript
async gather(trigger, config, prevState, context) {
  if (context.claims) {
    const { claimed } = await context.claims.tryClaim('ci-failure-pr-47');
    if (!claimed) return { text: 'CI failure on PR #47 (another session is on it)', state };
  }
  return { text: 'CI failure on PR #47 — fix it', state };
}
```

Claims auto-expire (default 30min), release on session death, and are pruned at session start.

## CLI

```bash
agent-awareness create <name>          # scaffold npm plugin
agent-awareness create <name> --local  # scaffold local plugin
agent-awareness doctor                 # diagnose loading, config, logs
agent-awareness list                   # show plugins + status
agent-awareness reload                 # hot-reload plugins in running daemon
```

Provider-specific commands: [Claude Code](./docs/claude-code.md) · [Codex](./docs/codex.md)

## Providers

agent-awareness is provider-agnostic. Plugins receive a `GatherContext` with `context.provider` and don't need to know which agent they're running under.

| Provider | Hooks | Realtime | Docs |
|----------|:-----:|:--------:|------|
| Claude Code | ✓ | ✓ | [docs/claude-code.md](./docs/claude-code.md) |
| Codex | ✓ | ✓ via `codex-aware` | [docs/codex.md](./docs/codex.md) |

Adding your own provider is ~60 lines. See [docs/creating-a-provider.md](./docs/creating-a-provider.md).

## Requirements

- Node.js 24+

## License

MIT
