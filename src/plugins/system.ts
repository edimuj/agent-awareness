import { freemem, totalmem, loadavg } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { AwarenessPlugin, PluginConfig, Trigger } from '../core/types.ts';

export default {
  name: 'system',
  description: 'Disk space, memory, system load awareness with threshold warnings',

  triggers: ['session-start', 'prompt', 'interval:15m'],

  defaults: {
    diskPath: '/',
    triggers: {
      'session-start': true,
      'interval:15m': true,
    },
    warn: {
      diskPct: 90,
      memoryPct: 85,
    },
  },

  async gather(_trigger: Trigger, config: PluginConfig, _prevState) {
    const warn = (config.warn as { diskPct?: number; memoryPct?: number }) ?? {};
    const memFree = freemem();
    const memTotal = totalmem();
    const memPct = Math.round((1 - memFree / memTotal) * 100);
    const memWarn = memPct >= (warn.memoryPct ?? 85) ? ' WARNING' : '';
    const load = loadavg()[0].toFixed(1);

    let diskStr = '';
    try {
      const stats = await statfs((config.diskPath as string) ?? '/');
      const diskTotal = stats.blocks * stats.bsize;
      const diskFree = stats.bavail * stats.bsize;
      const diskPct = Math.round((1 - diskFree / diskTotal) * 100);
      const diskWarn = diskPct >= (warn.diskPct ?? 90) ? ' WARNING' : '';
      diskStr = `Disk: ${diskPct}%${diskWarn}`;
    } catch {
      diskStr = 'Disk: N/A';
    }

    return {
      text: `${diskStr} | Mem: ${formatBytes(memFree)} free${memWarn} | Load: ${load}`,
      state: {},
    };
  },
} satisfies AwarenessPlugin;

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + 'G';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + 'M';
  return (bytes / 1e3).toFixed(0) + 'K';
}
