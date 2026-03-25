import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from 'node:https';
import { spawn } from 'node:child_process';
import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from '../core/types.ts';

/** Normalized quota shape — same for all providers. */
interface Quota {
  burst: { utilization: number; resetsAt: string } | null;
  weekly: { utilization: number; resetsAt: string } | null;
}

/** Provider-specific quota fetchers. */
const FETCHERS: Record<string, () => Promise<Quota | null>> = {
  'claude-code': fetchClaudeQuota,
  'codex': fetchCodexQuota,
};

export default {
  name: 'quota',
  description: 'Real API quota utilization — adapts to the running provider',

  triggers: ['session-start', 'prompt', 'interval:10m'],

  defaults: {
    triggers: {
      'session-start': true,
      'interval:10m': true,
    },
  },

  async gather(_trigger: Trigger, config: PluginConfig, prevState, context: GatherContext) {
    const now = new Date();
    const sessionStart = (prevState?.sessionStart as string) ?? now.toISOString();
    const elapsedMs = now.getTime() - new Date(sessionStart).getTime();
    const elapsedMin = Math.round(elapsedMs / 60_000);

    const elapsedStr = elapsedMin < 60
      ? `${elapsedMin}min`
      : `${Math.floor(elapsedMin / 60)}h${String(elapsedMin % 60).padStart(2, '0')}min`;

    // Dispatch to provider-specific fetcher
    const fetcher = FETCHERS[context.provider];
    const quota = fetcher ? await fetcher() : null;

    if (!quota) {
      return {
        text: `Session: ${elapsedStr}`,
        state: { sessionStart, lastCheck: now.toISOString() },
      };
    }

    const parts = [`Session: ${elapsedStr}`];

    if (quota.burst) {
      const pct = quota.burst.utilization;
      const reset = timeUntil(quota.burst.resetsAt);
      let signal = '';
      if (pct >= 80) signal = ' CONSERVE';
      else if (pct >= 60) signal = ' — consider delegating';
      parts.push(`5h: ${pct}%${signal} (↻${reset})`);
    }

    if (quota.weekly) {
      const pct = quota.weekly.utilization;
      let signal = '';
      if (pct >= 90) signal = ' WARNING';
      parts.push(`7d: ${pct}%${signal}`);
    }

    return {
      text: parts.join(' | '),
      state: { sessionStart, lastCheck: now.toISOString() },
    };
  },
} satisfies AwarenessPlugin;

// --- Claude Code ---

async function fetchClaudeQuota(): Promise<Quota | null> {
  const credsPath = join(homedir(), '.claude', '.credentials.json');
  let token: string;
  try {
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    token = creds.claudeAiOauth?.accessToken;
  } catch {
    return null;
  }
  if (!token) return null;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        timeout: 5_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const raw = JSON.parse(body);
            resolve({
              burst: raw.five_hour ? {
                utilization: raw.five_hour.utilization,
                resetsAt: raw.five_hour.resets_at,
              } : null,
              weekly: raw.seven_day ? {
                utilization: raw.seven_day.utilization,
                resetsAt: raw.seven_day.resets_at,
              } : null,
            });
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- Codex ---

async function fetchCodexQuota(): Promise<Quota | null> {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let reqId = 0;
    const pending = new Map<number, (msg: Record<string, unknown>) => void>();

    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (let nl = stdout.indexOf('\n'); nl !== -1; nl = stdout.indexOf('\n')) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg); }
        } catch { /* ignore non-JSON */ }
      }
    });

    proc.on('error', () => { clearTimeout(timer); resolve(null); });

    function rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      return new Promise((res, rej) => {
        const id = ++reqId;
        pending.set(id, (msg) => {
          if (msg.error) rej(new Error((msg.error as Record<string, string>).message));
          else res(msg.result as Record<string, unknown>);
        });
        proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    (async () => {
      try {
        await rpc('initialize', { clientInfo: { name: 'agent-awareness', version: '1.0.0' } });
        const result = await rpc('account/rateLimits/read');
        clearTimeout(timer);
        proc.kill();

        const limits = result.rateLimits as Record<string, Record<string, unknown>> | undefined;
        if (!limits) { resolve(null); return; }

        resolve({
          burst: limits.primary ? {
            utilization: limits.primary.usedPercent as number,
            resetsAt: new Date((limits.primary.resetsAt as number) * 1000).toISOString(),
          } : null,
          weekly: limits.secondary ? {
            utilization: limits.secondary.usedPercent as number,
            resetsAt: new Date((limits.secondary.resetsAt as number) * 1000).toISOString(),
          } : null,
        });
      } catch {
        clearTimeout(timer);
        proc.kill();
        resolve(null);
      }
    })();
  });
}

function timeUntil(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
}
