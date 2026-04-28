# Claude Code Provider

agent-awareness integrates with Claude Code through two tiers. You get the first one automatically. The second kicks in when you install via the marketplace plugin.

## Tier 1: Hooks only

The baseline. Works everywhere, no background processes.

- **Session start** hook fires all `session-start` plugins, injecting context at the top of the conversation
- **Prompt submit** hook fires `prompt`, `change:*`, and `interval:*` plugins inline with each user prompt
- Interval and change triggers are checked against `_updatedAt` timestamps. If enough time has passed, the plugin fires on the next prompt

This is what you get with a bare install. No daemon, no PID files, no ticker.

## Tier 2: Realtime path (daemon + Monitor)

The full experience. A central daemon runs interval checks on schedule and pushes results to active sessions mid-conversation. No prompt required.

**How it works:**

1. Session-start hook spawns the daemon (if not already running)
2. A declarative plugin monitor (`monitors/monitors.json`) auto-starts `awareness-monitor.mjs`
3. The monitor connects to the daemon's SSE stream
4. Each plugin result is output to stdout and arrives as a real-time Monitor notification

`interval:10m` means every 10 minutes, not "whenever you happen to type after 10 minutes."

**The daemon:**

- Loads all plugins once, runs interval/change triggers on schedule
- Broadcasts results to all connected sessions via SSE
- Multiple sessions share one daemon. No duplicated API calls, no state races
- Auto-shuts down after 15 minutes with no registered sessions

**Activity tracking:**

The daemon tracks session activity through prompt gathers. If no session has sent a prompt within the idle timeout (default 10 minutes), the ticker pauses. No wasted API calls or token-burning updates pushed to idle sessions. Activity resumes on the next prompt.

Configure in `config/default.json`:
```json
{
  "activity": {
    "idleTimeoutMinutes": 10
  }
}
```

The `/health` endpoint exposes activity state:
```json
{
  "activity": {
    "sessionActive": true,
    "lastPromptAt": "2026-04-28T14:32:00.000Z",
    "idleSince": null,
    "idleTimeoutMinutes": 10
  }
}
```

## Install

As a Claude Code plugin (marketplace):

```bash
/plugin marketplace add edimuj/agent-awareness
/plugin install agent-awareness@agent-awareness
```

Then install awareness plugins globally for auto-discovery:

```bash
npm install -g agent-awareness-plugin-quota
npm install -g agent-awareness-plugin-weather
# etc.
```

## Diagnostics

```bash
agent-awareness doctor
```

Full health check: plugin loading, config resolution, state paths, log file size.

**Log file:** `~/.cache/agent-awareness/claude-code/agent-awareness.log`
Captures ticker errors, plugin failures, lock contention. Auto-rotates at 256 KB.

**Daemon health:**
```bash
curl -s http://127.0.0.1:<port>/health | jq .
curl -s http://127.0.0.1:<port>/doctor
```

The daemon port is in `~/.cache/agent-awareness/daemon.pid`.

## Requirements

- Node.js 24+
- Claude Code v2.1.105+ (required for declarative plugin monitors on the realtime path)
