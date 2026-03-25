import { freemem, totalmem, loadavg, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from '../core/types.ts';

export default {
  name: 'system',
  description: 'Disk space, memory, system load awareness with threshold warnings',

  triggers: ['session-start', 'prompt', 'interval:15m'],

  defaults: {
    diskPath: '/',
    showDisk: true,
    showMemory: true,
    showLoad: true,
    // Only inject when at least one metric exceeds a threshold.
    // Set to false to always inject regardless of thresholds.
    onlyWhenWarning: false,
    thresholds: {
      diskPct: 80,
      memoryPct: 80,
      loadPerCpu: 2.0,
    },
    messages: {
      disk: 'WARNING',
      memory: 'WARNING',
      load: 'HIGH',
    },
    triggers: {
      'session-start': true,
      'interval:15m': true,
    },
  },

  async gather(_trigger: Trigger, config: PluginConfig, _prevState, _context: GatherContext) {
    const thresholds = (config.thresholds as Record<string, number>) ?? {};
    const messages = (config.messages as Record<string, string>) ?? {};
    const parts: string[] = [];
    let anyWarning = false;

    // Disk
    if (config.showDisk !== false) {
      try {
        const stats = await statfs((config.diskPath as string) ?? '/');
        const diskTotal = stats.blocks * stats.bsize;
        const diskFree = stats.bavail * stats.bsize;
        const diskPct = Math.round((1 - diskFree / diskTotal) * 100);
        const threshold = thresholds.diskPct ?? 80;
        const warn = diskPct >= threshold;
        if (warn) anyWarning = true;
        parts.push(`Disk: ${diskPct}%${warn ? ` ${messages.disk ?? 'WARNING'}` : ''}`);
      } catch {
        parts.push('Disk: N/A');
      }
    }

    // Memory
    if (config.showMemory !== false) {
      const memFree = freemem();
      const memTotal = totalmem();
      const memPct = Math.round((1 - memFree / memTotal) * 100);
      const threshold = thresholds.memoryPct ?? 80;
      const warn = memPct >= threshold;
      if (warn) anyWarning = true;
      parts.push(`Mem: ${formatBytes(memFree)} free${warn ? ` ${messages.memory ?? 'WARNING'}` : ''}`);
    }

    // Load
    if (config.showLoad !== false) {
      const load = loadavg()[0];
      const numCpus = cpus().length;
      const loadThreshold = thresholds.loadPerCpu ?? 2.0;
      const warn = load >= (loadThreshold * numCpus);
      if (warn) anyWarning = true;
      parts.push(`Load: ${load.toFixed(1)}${warn ? ` ${messages.load ?? 'HIGH'}` : ''}`);
    }

    if (parts.length === 0) return null;

    // If onlyWhenWarning is true, suppress output when everything is fine
    if (config.onlyWhenWarning === true && !anyWarning) return null;

    return {
      text: parts.join(' | '),
      state: {},
    };
  },
} satisfies AwarenessPlugin;

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + 'G';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + 'M';
  return (bytes / 1e3).toFixed(0) + 'K';
}
