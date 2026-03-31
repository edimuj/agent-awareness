---
name: troubleshooting
description: This skill should be used when the user asks about "agent-awareness logs", "plugin not loading", "MCP tools missing", "debug agent-awareness", "plugin errors", "claim system", "ticker not running", "awareness not working", wants to diagnose agent-awareness issues, check plugin health, find log files, understand the claim system, or troubleshoot any agent-awareness related problem.
version: 0.1.0
---

# agent-awareness Troubleshooting & Operations

## Quick Diagnostics

### Doctor command (first thing to run)

```bash
# CLI
npx agent-awareness doctor

# MCP tool (agents can call this)
awareness_doctor
```

Shows: plugin sources, loaded/failed plugins, config paths, log location, overall health status.

### Key paths

| Path | Purpose |
|------|---------|
| `~/.cache/agent-awareness/state.json` | Plugin state (persisted between sessions) |
| `~/.cache/agent-awareness/agent-awareness.log` | Log file (ticker errors, plugin failures) |
| `~/.cache/agent-awareness/ticker-cache.json` | Cached interval results |
| `~/.cache/agent-awareness/ticker.pid` | Background ticker PID |
| `~/.cache/agent-awareness/claims/` | Multi-agent event claim files |
| `~/.config/agent-awareness/plugins/` | Local plugin directory |
| `~/.config/agent-awareness/plugins.d/` | Per-plugin config overrides |

### Check what's loaded

```bash
npx agent-awareness list       # all plugins + enabled/disabled status
npx agent-awareness doctor     # loaded + failed + config paths
```

## Common Problems

### Plugin not loading

**Symptom:** Plugin installed but not appearing in `doctor` or `list` output.

**Causes:**
1. **Missing `.js` files** — npm plugins must ship compiled JavaScript. Node 24+ blocks TypeScript inside `node_modules/`.
   - Fix: `cd plugin-dir && npm run build && npm install -g .`
   - Check: `ls node_modules/agent-awareness-plugin-*/index.js`

2. **Wrong exports in package.json** — must point to `.js`, not `.ts`:
   ```json
   "exports": { ".": "./index.js" },
   "main": "./index.js"
   ```

3. **Missing root index.ts** — the loader looks for `index.ts` at the plugin root, not `src/`. Must have:
   ```typescript
   // index.ts (root)
   export { default } from './src/index.ts';
   ```

4. **Validation failure** — plugin must have `name`, `description`, `triggers`, `defaults`, `gather` function. Check `doctor` output for specific error.

### MCP tools not appearing

**Symptom:** Plugin loads but MCP tools don't show up in Claude Code.

**Causes:**
1. **MCP server not installed:**
   ```bash
   npx agent-awareness mcp install   # adds server to .mcp.json
   npx agent-awareness mcp status    # verify
   ```

2. **Plugin disabled** — check config: `~/.config/agent-awareness/plugins.d/<name>.json` must have `"enabled": true` or be absent (defaults to enabled).

3. **MCP server needs restart** — after installing new plugins, restart the MCP connection in Claude Code (reopen `/mcp` dialog).

### Ticker not running (interval plugins silent)

**Symptom:** `interval:*` triggers never fire, no background data.

**Check:**
```bash
# Is ticker running?
cat ~/.cache/agent-awareness/ticker.pid
ps -p $(cat ~/.cache/agent-awareness/ticker.pid) 2>/dev/null

# Check log for ticker errors
tail -20 ~/.cache/agent-awareness/agent-awareness.log
```

**Fix:** The ticker auto-starts on `session-start` if any enabled plugin uses interval triggers. Force restart by starting a new session.

### Stale state / corrupt state.json

**Symptom:** Plugin behaving oddly, showing old data, or errors about JSON parsing.

**Fix:**
```bash
# Reset all plugin state
rm ~/.cache/agent-awareness/state.json

# Reset specific plugin state (manual JSON edit)
# Or just delete and let plugins re-initialize on next session
```

### Config not taking effect

**Resolution order (later overrides earlier):**
1. Plugin defaults (built-in)
2. Package defaults (`config/default.json` in agent-awareness)
3. User global: `~/.config/agent-awareness/plugins.d/<name>.json`
4. Rig override: `$AGENT_AWARENESS_CONFIG/plugins.d/<name>.json`

Check the `AGENT_AWARENESS_CONFIG` environment variable — rig-specific config overrides user global.

## Multi-Agent Claim System

### How it works

When multiple Claude Code sessions run concurrently, the claim system prevents duplicate actions on the same event. Claims are file-based, stored in `~/.cache/agent-awareness/claims/<plugin>/`.

**Flow:**
1. Plugin detects an event (e.g., CI failure on PR #42)
2. Calls `context.claims.tryClaim('pr-42:checks_failed')`
3. If first to claim → `{ status: 'claimed' }` → plugin acts on it
4. If another session already claimed → `{ status: 'claimed_by_other' }` → plugin downgrades to notify

### Debugging claims

Use the `claim-debugger` plugin (install: `npm install -g agent-awareness-plugin-claim-debugger`):

| MCP Tool | Purpose |
|----------|---------|
| `awareness_claim_debugger_simulate` | Claim an event as this session |
| `awareness_claim_debugger_contend` | Create a fake foreign claim (tests downgrade path) |
| `awareness_claim_debugger_release` | Release a claim |
| `awareness_claim_debugger_claims` | List all active claims |
| `awareness_claim_debugger_inspect` | Inspect a specific claim |

### Claim properties
- **Scoped per plugin** — `pr-pilot` claims don't affect `server-health` claims
- **PID-aware** — if the claiming session dies, the claim becomes reclaimable
- **Auto-expiring** — default TTL 30 minutes, configurable per plugin
- **Pruned at session start** — expired claims cleaned up automatically

## Log File

**Location:** `~/.cache/agent-awareness/agent-awareness.log`

Contains:
- Background ticker errors (plugin failures during interval execution)
- Dispatcher warnings (queue overflow, timeout)
- Lock contention events

The log auto-rotates at 256 KB (keeps one `.1` backup).

**Reading the log:**
```bash
tail -50 ~/.cache/agent-awareness/agent-awareness.log     # recent entries
grep "ERROR\|FAIL" ~/.cache/agent-awareness/agent-awareness.log  # errors only
```

## Plugin Discovery Details

The loader scans four sources. For npm packages (global and local), it looks for packages named `agent-awareness-plugin-*` and imports them via their `exports` field.

**Global npm path:** resolved via `npm root -g` (works with nvm, volta, fnm).

**For global plugins to work**, the published package must include compiled `.js` files. Raw `.ts` files fail with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on Node 24+.
