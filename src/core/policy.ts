import { createHash } from 'node:crypto';
import type { AwarenessChannel, AwarenessSeverity, GatherResult } from './types.ts';

const DEFAULT_MAX_CHARS_PROMPT = 500;
const DEFAULT_MAX_CHARS_SESSION_START = 800;
const MAX_SEEN_FINGERPRINTS = 512;

const CRITICAL_RE = /\b(fail(?:ed|ure)?|critical|error|outage|down|blocked|unhealthy|panic|oom)\b|🔴/i;
const WARNING_RE = /\b(warn(?:ing)?|degraded|stuck|pending|retry|recover(?:ed|ing)?|high)\b|🟡/i;
const SIGNAL_RE = /\b(fail(?:ed|ure)?|critical|error|warn(?:ing)?|degraded|unhealthy|blocked|down|recover(?:ed|ing)?)\b|[🔴🟡]/i;

export interface PolicyInput {
  pluginName: string;
  result: GatherResult;
}

export interface PolicyMetaState {
  seenFingerprints?: Record<string, string>;
}

export interface ApplyPolicyOptions {
  event: string;
  previousMeta?: PolicyMetaState;
  now?: Date;
  maxChars?: number;
  debugReasons?: boolean;
}

interface PolicyFact {
  text: string;
  severity: AwarenessSeverity;
  channel: AwarenessChannel;
  fingerprint: string;
  reason: string;
  order: number;
}

export interface ApplyPolicyResult {
  results: GatherResult[];
  meta: PolicyMetaState;
}

export function applyInjectionPolicy(
  inputs: PolicyInput[],
  options: ApplyPolicyOptions,
): ApplyPolicyResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const previousSeen = options.previousMeta?.seenFingerprints ?? {};
  const maxChars = resolveMaxChars(options);

  const candidates = normalizeFacts(inputs);
  const selected: GatherResult[] = [];
  let usedChars = 0;

  const nextSeen: Record<string, string> = { ...previousSeen };

  for (const fact of candidates) {
    if (fact.channel !== 'always') continue;
    if (previousSeen[fact.fingerprint]) continue;

    const text = options.debugReasons ? `[why:${fact.reason}] ${fact.text}` : fact.text;
    const extraChars = selected.length > 0 ? 1 : 0; // newline separator in renderer
    const projected = usedChars + extraChars + text.length;

    if (projected > maxChars) {
      const remaining = maxChars - usedChars - extraChars;
      if (selected.length === 0 && remaining > 20) {
        const truncated = truncate(text, remaining);
        selected.push({
          text: truncated,
          severity: fact.severity,
          channel: fact.channel,
          fingerprint: fact.fingerprint,
          updatedAt: nowIso,
          reason: fact.reason,
        });
        nextSeen[fact.fingerprint] = nowIso;
      }
      break;
    }

    selected.push({
      text,
      severity: fact.severity,
      channel: fact.channel,
      fingerprint: fact.fingerprint,
      updatedAt: nowIso,
      reason: fact.reason,
    });
    nextSeen[fact.fingerprint] = nowIso;
    usedChars = projected;
  }

  return {
    results: selected,
    meta: {
      seenFingerprints: pruneSeenFingerprints(nextSeen),
    },
  };
}

function resolveMaxChars(options: ApplyPolicyOptions): number {
  if (typeof options.maxChars === 'number' && options.maxChars > 0) {
    return Math.floor(options.maxChars);
  }

  const envOverride = parsePositiveInt(process.env.AGENT_AWARENESS_POLICY_MAX_CHARS);
  if (envOverride) return envOverride;

  if (options.event === 'session-start') {
    return parsePositiveInt(process.env.AGENT_AWARENESS_POLICY_MAX_CHARS_SESSION_START)
      ?? DEFAULT_MAX_CHARS_SESSION_START;
  }

  return parsePositiveInt(process.env.AGENT_AWARENESS_POLICY_MAX_CHARS_PROMPT)
    ?? DEFAULT_MAX_CHARS_PROMPT;
}

function normalizeFacts(inputs: PolicyInput[]): PolicyFact[] {
  const facts: PolicyFact[] = [];
  let order = 0;

  for (const entry of inputs) {
    const rawText = typeof entry.result.text === 'string' ? entry.result.text : '';
    const baseLines = rawText
      .split(/\r?\n+/)
      .map(line => line.trim())
      .filter(Boolean);
    if (baseLines.length === 0) continue;

    const baseSeverity = entry.result.severity ?? inferSeverity(rawText);
    const lines = collapseLines(baseLines, baseSeverity);

    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i]!;
      const severity = entry.result.severity ?? inferSeverity(text);
      const channel = entry.result.channel ?? defaultChannelForSeverity(severity);
      const providedFp = entry.result.fingerprint?.trim();
      const fingerprint = providedFp
        ? `${providedFp}:${i}`
        : hashFingerprint(`${entry.pluginName}:${text}`);

      facts.push({
        text,
        severity,
        channel,
        fingerprint,
        reason: buildReason(severity, channel),
        order: order++,
      });
    }
  }

  return facts.sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return a.order - b.order;
  });
}

function collapseLines(lines: string[], severity: AwarenessSeverity): string[] {
  if (lines.length <= 1) return lines;

  if (severity === 'info') {
    return [lines[0]!];
  }

  const signalLines = lines.filter(line => SIGNAL_RE.test(line));
  if (signalLines.length === 0) {
    return lines.slice(0, 2);
  }

  const header = lines[0]!;
  if (header === signalLines[0]) {
    return signalLines.slice(0, 4);
  }

  return [header, ...signalLines].slice(0, 4);
}

function defaultChannelForSeverity(_severity: AwarenessSeverity): AwarenessChannel {
  return 'always';
}

function severityRank(severity: AwarenessSeverity): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function inferSeverity(text: string): AwarenessSeverity {
  if (CRITICAL_RE.test(text)) return 'critical';
  if (WARNING_RE.test(text)) return 'warning';
  return 'info';
}

function buildReason(severity: AwarenessSeverity, channel: AwarenessChannel): string {
  return channel === 'always' ? `severity-${severity}` : 'on-demand';
}

function hashFingerprint(raw: string): string {
  return createHash('sha1').update(raw).digest('hex');
}

function pruneSeenFingerprints(seen: Record<string, string>): Record<string, string> {
  const ordered = Object.entries(seen)
    .sort((a, b) => {
      const delta = Date.parse(b[1]) - Date.parse(a[1]);
      if (Number.isNaN(delta)) return 0;
      return delta;
    })
    .slice(0, MAX_SEEN_FINGERPRINTS);

  return Object.fromEntries(ordered);
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}
