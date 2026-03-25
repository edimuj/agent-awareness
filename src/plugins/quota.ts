import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from 'node:https';
import type { AwarenessPlugin, PluginConfig, Trigger } from '../core/types.ts';

interface QuotaWindow {
  utilization: number;
  resets_at: string;
}

interface QuotaResponse {
  five_hour?: QuotaWindow;
  seven_day?: QuotaWindow;
}

export default {
  name: 'quota',
  description: 'Real Claude API quota utilization (5h burst + 7d weekly)',

  triggers: ['session-start', 'prompt', 'interval:10m'],

  defaults: {
    plan: 'claude-max',
    windowHours: 5,
    triggers: {
      'session-start': true,
      'interval:10m': true,
    },
  },

  async gather(_trigger: Trigger, config: PluginConfig, prevState) {
    const now = new Date();
    const sessionStart = (prevState?.sessionStart as string) ?? now.toISOString();
    const elapsedMs = now.getTime() - new Date(sessionStart).getTime();
    const elapsedMin = Math.round(elapsedMs / 60_000);

    const elapsedStr = elapsedMin < 60
      ? `${elapsedMin}min`
      : `${Math.floor(elapsedMin / 60)}h${String(elapsedMin % 60).padStart(2, '0')}min`;

    // Fetch real quota from Claude API
    const quota = await fetchClaudeQuota();

    if (!quota) {
      // Fallback: session duration only (no API access)
      return {
        text: `📊 Session: ${elapsedStr}`,
        state: { sessionStart, lastCheck: now.toISOString() },
      };
    }

    const parts = [`📊 Session: ${elapsedStr}`];

    if (quota.five_hour) {
      const pct = quota.five_hour.utilization;
      const reset = timeUntil(quota.five_hour.resets_at);
      let signal = '';
      if (pct >= 80) signal = ' ⚠️ CONSERVE';
      else if (pct >= 60) signal = ' — consider delegating';
      parts.push(`5h: ${pct}%${signal} (↻${reset})`);
    }

    if (quota.seven_day) {
      const pct = quota.seven_day.utilization;
      let signal = '';
      if (pct >= 90) signal = ' ⚠️';
      parts.push(`7d: ${pct}%${signal}`);
    }

    return {
      text: parts.join(' | '),
      state: { sessionStart, lastCheck: now.toISOString() },
    };
  },
} satisfies AwarenessPlugin;

async function fetchClaudeQuota(): Promise<QuotaResponse | null> {
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
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
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
