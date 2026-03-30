import type { AwarenessPlugin, GatherContext, GatherResult, McpToolDef, PluginConfig, Trigger } from '../core/types.ts';

/**
 * Focus timer (Pomodoro) plugin.
 *
 * The agent can start/stop/extend focus sessions and adapts its behavior:
 * - During focus: dense responses, no tangents, no "should we wrap up?"
 * - During break: suggests stepping away, lighter interaction
 * - Between sessions: normal behavior
 *
 * MCP tools enable bidirectional interaction — the agent can start a session
 * when it sees complex work ahead, or the user can start one manually.
 */

interface TimerState {
  status: 'idle' | 'focus' | 'break';
  startedAt: string | null;
  endsAt: string | null;
  focusMinutes: number;
  breakMinutes: number;
  sessionsCompleted: number;
  label: string | null;
}

const DEFAULT_STATE: TimerState = {
  status: 'idle',
  startedAt: null,
  endsAt: null,
  focusMinutes: 25,
  breakMinutes: 5,
  sessionsCompleted: 0,
  label: null,
};

function getTimer(prevState: Record<string, unknown> | null): TimerState {
  if (!prevState?.status) return { ...DEFAULT_STATE };
  return prevState as unknown as TimerState;
}

function elapsed(startedAt: string): number {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000);
}

function remaining(endsAt: string): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 60_000));
}

function isExpired(endsAt: string | null): boolean {
  if (!endsAt) return false;
  return Date.now() >= new Date(endsAt).getTime();
}

function formatTimer(timer: TimerState): string {
  if (timer.status === 'idle') return '';

  if (timer.status === 'focus') {
    if (isExpired(timer.endsAt)) {
      return `Focus: ${timer.focusMinutes}min complete -- time for a break`;
    }
    const left = remaining(timer.endsAt!);
    const total = timer.focusMinutes;
    const label = timer.label ? ` [${timer.label}]` : '';
    return `Focus: ${total - left}/${total}min${label} -- deep work, stay dense and focused`;
  }

  if (timer.status === 'break') {
    if (isExpired(timer.endsAt)) {
      return `Break over -- ready for next focus session (#${timer.sessionsCompleted + 1})`;
    }
    const left = remaining(timer.endsAt!);
    return `Break: ${left}min left -- suggest stepping away`;
  }

  return '';
}

function startFocus(timer: TimerState, minutes: number, label: string | null): TimerState {
  const now = new Date();
  return {
    ...timer,
    status: 'focus',
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    focusMinutes: minutes,
    label,
  };
}

function startBreak(timer: TimerState, minutes: number): TimerState {
  const now = new Date();
  return {
    ...timer,
    status: 'break',
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    breakMinutes: minutes,
    sessionsCompleted: timer.sessionsCompleted + 1,
    label: null,
  };
}

function startBreakFromState(timer: TimerState, minutes: number): TimerState {
  const now = new Date();
  const completed = timer.status === 'focus'
    ? timer.sessionsCompleted + 1
    : timer.sessionsCompleted;
  return {
    ...timer,
    status: 'break',
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    breakMinutes: minutes,
    sessionsCompleted: completed,
    label: null,
  };
}

function stopTimer(timer: TimerState): TimerState {
  const completed = timer.status === 'focus' && isExpired(timer.endsAt)
    ? timer.sessionsCompleted + 1
    : timer.sessionsCompleted;
  return { ...DEFAULT_STATE, sessionsCompleted: completed };
}

// --- MCP tool definitions ---

const toolStart: McpToolDef = {
  name: 'start',
  description: 'Start a focus session (Pomodoro). Adapts agent behavior to deep work mode.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Focus duration in minutes (default: from config)' },
      label: { type: 'string', description: 'Optional label for the session (e.g., "refactor auth")' },
    },
  },
  async handler(params, config, _signal, prevState) {
    const minutes = (params.minutes as number) ?? (config.focusMinutes as number) ?? 25;
    const label = (params.label as string) ?? null;
    const timer = startFocus(getTimer(prevState), minutes, label);
    return {
      text: `Focus started: ${minutes}min${label ? ` [${label}]` : ''}. Deep work mode active.`,
      state: timer as unknown as Record<string, unknown>,
    };
  },
};

const toolBreak: McpToolDef = {
  name: 'break',
  description: 'End focus session and start a break.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Break duration in minutes (default: from config)' },
    },
  },
  async handler(params, config, _signal, prevState) {
    const minutes = (params.minutes as number) ?? (config.breakMinutes as number) ?? 5;
    const timer = startBreakFromState(getTimer(prevState), minutes);
    return {
      text: `Break started: ${minutes}min. Step away, stretch, hydrate.`,
      state: timer as unknown as Record<string, unknown>,
    };
  },
};

const toolStop: McpToolDef = {
  name: 'stop',
  description: 'Stop the current focus session or break. Returns to normal mode.',
  inputSchema: { type: 'object' },
  async handler(_params, _config, _signal, prevState) {
    const timer = stopTimer(getTimer(prevState));
    return {
      text: 'Focus timer stopped. Normal mode.',
      state: timer as unknown as Record<string, unknown>,
    };
  },
};

const toolExtend: McpToolDef = {
  name: 'extend',
  description: 'Extend the current focus session. Use when in flow state.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Additional minutes (default: 10)' },
    },
  },
  async handler(params, _config, _signal, prevState) {
    const extra = (params.minutes as number) ?? 10;
    const timer = getTimer(prevState);
    if (timer.status !== 'focus') {
      return {
        text: 'No active focus session to extend.',
      };
    }

    // Extend from existing end time when active; otherwise from now.
    const now = new Date();
    const base = timer.endsAt && !isExpired(timer.endsAt)
      ? new Date(timer.endsAt)
      : now;
    const endsAt = new Date(base.getTime() + extra * 60_000).toISOString();
    return {
      text: `Focus extended by ${extra}min. Keep going.`,
      state: { ...timer, status: 'focus', endsAt } as unknown as Record<string, unknown>,
    };
  },
};

const toolStatus: McpToolDef = {
  name: 'status',
  description: 'Get current focus timer status — elapsed time, remaining time, sessions completed.',
  inputSchema: { type: 'object' },
  async handler(_params, _config, _signal, prevState) {
    const timer = getTimer(prevState);
    const status = formatTimer(timer);
    return {
      text: status || `Focus timer: idle (sessions completed: ${timer.sessionsCompleted})`,
      state: timer as unknown as Record<string, unknown>,
    };
  },
};

export default {
  name: 'focus-timer',
  description: 'Pomodoro focus timer — agent adapts behavior during focus/break sessions',

  triggers: ['session-start', 'prompt'],

  defaults: {
    focusMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    longBreakAfter: 4,
    autoBreak: true,
    triggers: {
      'session-start': true,
      'prompt': true,
    },
  },

  gather(trigger: Trigger, config: PluginConfig, prevState, _context: GatherContext): GatherResult | null {
    const timer = getTimer(prevState);

    // Auto-transition: focus expired → start break
    if (timer.status === 'focus' && isExpired(timer.endsAt) && config.autoBreak !== false) {
      const isLongBreak = (config.longBreakAfter as number) > 0
        && (timer.sessionsCompleted + 1) % (config.longBreakAfter as number) === 0;
      const breakMins = isLongBreak
        ? (config.longBreakMinutes as number) ?? 15
        : (config.breakMinutes as number) ?? 5;
      const breakTimer = startBreak(timer, breakMins);
      const breakType = isLongBreak ? 'Long break' : 'Break';
      return {
        text: `${breakType}: ${breakMins}min -- session #${breakTimer.sessionsCompleted} complete, step away`,
        state: breakTimer as unknown as Record<string, unknown>,
      };
    }

    // Auto-transition: break expired → back to idle
    if (timer.status === 'break' && isExpired(timer.endsAt)) {
      return {
        text: `Break over -- ready for focus session #${timer.sessionsCompleted + 1}`,
        state: stopTimer(timer) as unknown as Record<string, unknown>,
      };
    }

    const text = formatTimer(timer);
    if (!text) return null; // idle — no injection

    return {
      text,
      state: timer as unknown as Record<string, unknown>,
    };
  },

  mcp: {
    tools: [toolStart, toolBreak, toolStop, toolExtend, toolStatus],
  },
} satisfies AwarenessPlugin;
