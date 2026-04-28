# Claude Code Provider

agent-awareness runs as a Claude Code plugin. Install it, restart your session, and your agent gets realtime context.

## How it works

When your session starts, two things happen:

1. The **session-start hook** fires all plugins and injects their output at the top of the conversation
2. A **background daemon** starts (if not already running) and begins polling interval and change-detection triggers on schedule

A declarative plugin monitor (`monitors/monitors.json`) connects to the daemon's SSE stream and delivers plugin results as real-time notifications, mid-conversation, without waiting for your next prompt.

`interval:10m` means every 10 minutes, not "whenever you happen to type after 10 minutes."

On each prompt, the **prompt hook** also fires prompt-triggered plugins inline, so plugins that only care about prompt events don't need the daemon at all.

## The daemon

A single daemon process runs per machine, shared across all sessions.

- Loads all plugins once, runs interval/change triggers on schedule
- Broadcasts results to all connected sessions via SSE
- No duplicated API calls, no state races between sessions
- Auto-shuts down after 15 minutes with no registered sessions

If the daemon is unavailable (startup failure, killed manually), everything still works. The prompt hook falls back to evaluating interval and change triggers inline, so updates arrive on your next prompt instead of in the background. No configuration needed, no error to deal with.

## Activity tracking

The daemon tracks session activity through prompt gathers. If no session has sent a prompt within 10 minutes, the ticker pauses. No wasted API calls or token-burning updates pushed to idle sessions. Activity resumes on the next prompt.

You can check activity state via the daemon's `/health` endpoint.

## Install

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
- Claude Code v2.1.105+ (required for declarative plugin monitors)
