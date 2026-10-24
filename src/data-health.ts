import type { Config } from './types.ts';
import { stateIdentity } from './config.ts';
import { validateDataHealth } from './health-config.ts';

// Pure preparation only. Monitor/transport/status do not invoke this module yet.
const MINUTE = 60_000, TTL = 30 * MINUTE, REARM = 60 * MINUTE;
export type HealthObservation = { kind: 'accepted'; at: number } |
  { kind: 'idle' | 'failed' | 'duplicate' | 'out_of_order' };
type NoticeKind = 'stale' | 'restored';
interface Notice { kind: NoticeKind; qualifiedAt: number; consumed: boolean }
export interface DataHealthState {
  version: 1;
  policy: string;
  activatedAt: number;
  observedAt: number;
  latestAt?: number;
  phase: 'watching' | 'missing' | 'recovered';
  episodeAt?: number;
  staleAcknowledged: boolean;
  recoveryFirstAt?: number;
  notice?: Notice;
}
export interface HealthCandidate { kind: NoticeKind; policy: string; episodeAt: number; qualifiedAt: number }
export type HealthResult = { status: 'off' | 'paused' } |
  { status: 'invalid'; code: 'data_health_state_invalid' } |
  { status: 'ok'; state: DataHealthState; candidate?: HealthCandidate };
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) &&
  Number.isInteger(v) && v >= 0 && v <= 8.64e15;
function policy(c: Config): string {
  const p = c.dataHealth!, d = p.delivery === 'daytime' ? c.daytimeDischarge : undefined;
  return JSON.stringify([stateIdentity(c), p.warnAfterMinutes, p.delivery,
    d ? [d.timeZone, d.startHour, d.endHour] : null]);
}
function initial(c: Config, now: number): DataHealthState {
  return { version: 1, policy: policy(c), activatedAt: now, observedAt: now,
    phase: 'watching', staleAcknowledged: false };
}
function decode(raw: unknown): DataHealthState | undefined {
  const v = object(raw), n = v?.notice === undefined ? undefined : object(v.notice);
  if (!v || v.version !== 1 || typeof v.policy !== 'string' || v.policy.length > 512 ||
      !time(v.activatedAt) || !time(v.observedAt) || v.activatedAt > v.observedAt ||
      typeof v.phase !== 'string' || !['watching', 'missing', 'recovered'].includes(v.phase) || typeof v.staleAcknowledged !== 'boolean' ||
      (v.latestAt !== undefined && (!time(v.latestAt) || v.latestAt > v.observedAt)) ||
      (v.episodeAt !== undefined && (!time(v.episodeAt) || v.episodeAt < v.activatedAt || v.episodeAt > v.observedAt)) ||
      (v.recoveryFirstAt !== undefined && (!time(v.recoveryFirstAt) || !time(v.latestAt) || v.recoveryFirstAt > v.latestAt)) ||
      (v.notice !== undefined && (!n || typeof n.kind !== 'string' || !['stale', 'restored'].includes(n.kind) ||
        !time(n.qualifiedAt) || !time(v.episodeAt) || n.qualifiedAt < v.episodeAt || n.qualifiedAt > v.observedAt ||
        typeof n.consumed !== 'boolean')) ||
      (v.phase === 'watching' ? v.episodeAt !== undefined || v.notice !== undefined ||
        v.recoveryFirstAt !== undefined || v.staleAcknowledged : v.episodeAt === undefined) ||
      (n?.kind === 'stale' && (v.phase !== 'missing' || n.qualifiedAt !== v.episodeAt)) ||
      (n?.kind === 'restored' && (v.phase !== 'recovered' || !v.staleAcknowledged)) ||
      (n?.kind === 'restored' && !n.consumed && (!time(v.recoveryFirstAt) ||
        !time(v.latestAt) || v.recoveryFirstAt >= v.latestAt)) ||
      (v.phase === 'recovered' && v.latestAt === undefined)) return undefined;
  // Copy an allowlist, never reflect unknown upstream/private metadata.
  return { version: 1, policy: v.policy, activatedAt: v.activatedAt, observedAt: v.observedAt,
    phase: v.phase as DataHealthState['phase'], staleAcknowledged: v.staleAcknowledged,
    ...(v.latestAt === undefined ? {} : { latestAt: v.latestAt as number }),
    ...(v.episodeAt === undefined ? {} : { episodeAt: v.episodeAt as number }),
    ...(v.recoveryFirstAt === undefined ? {} : { recoveryFirstAt: v.recoveryFirstAt as number }),
    ...(n ? { notice: { kind: n.kind as NoticeKind, qualifiedAt: n.qualifiedAt as number, consumed: n.consumed as boolean } } : {}) };
}
function consume(s: DataHealthState): void { if (s.notice) s.notice.consumed = true; }
function result(s: DataHealthState): HealthResult {
  const n = s.notice;
  return { status: 'ok', state: s, ...(n && !n.consumed ? { candidate: {
    kind: n.kind, policy: s.policy, episodeAt: s.episodeAt!, qualifiedAt: n.qualifiedAt,
  } } : {}) };
}

export function advanceDataHealth(c: Config, raw: unknown, observation: HealthObservation, now: number): HealthResult {
  if (!c.enabled) return { status: 'paused' };
  validateDataHealth(c);
  if (!c.dataHealth?.enabled) return { status: 'off' };
  if (!time(now)) return { status: 'paused' };
  let s = raw === undefined ? initial(c, now) : decode(raw);
  if (!s) return { status: 'invalid', code: 'data_health_state_invalid' };
  // Preserve the original record until the clock catches up; never reset its grace.
  if (now < s.observedAt) return { status: 'paused' };
  if (s.policy !== policy(c)) s = initial(c, now);
  s.observedAt = now;
  const fresh = (at: number) => at <= now && now - at <= c.maxAgeSeconds * 1000;
  const evidenceExpired = s.latestAt === undefined || !fresh(s.latestAt) ||
    now - s.latestAt > c.maxGapSeconds * 1000 ||
    (s.recoveryFirstAt !== undefined && (!fresh(s.recoveryFirstAt) ||
      s.latestAt! - s.recoveryFirstAt > c.maxGapSeconds * 1000));
  if (evidenceExpired) {
    delete s.recoveryFirstAt;
    if (s.notice?.kind === 'restored') consume(s);
  }
  const accepted = observation.kind === 'accepted' && time(observation.at) && fresh(observation.at) &&
    (s.latestAt === undefined || observation.at > s.latestAt);
  if (accepted) {
    const at = observation.at, previous = s.latestAt;
    s.latestAt = at;
    if (s.phase === 'missing') {
      consume(s);
      if (s.recoveryFirstAt !== undefined && at - s.recoveryFirstAt <= c.maxGapSeconds * 1000) {
        s.phase = 'recovered';
        if (s.staleAcknowledged) s.notice = { kind: 'restored', qualifiedAt: now, consumed: false };
        else delete s.notice;
      } else s.recoveryFirstAt = at;
    } else if (s.phase === 'recovered') {
      if (previous !== undefined && at - previous <= c.maxGapSeconds * 1000 && fresh(previous)) {
        s.recoveryFirstAt = previous;
      } else {
        delete s.recoveryFirstAt;
        consume(s);
      }
    }
  } else if (observation.kind !== 'idle') {
    delete s.recoveryFirstAt;
    if (s.notice?.kind === 'restored') consume(s);
  }
  const age = now - Math.max(s.activatedAt, s.latestAt ?? s.activatedAt);
  if (s.phase !== 'missing' && age >= c.dataHealth.warnAfterMinutes! * MINUTE &&
      (s.episodeAt === undefined || now - s.episodeAt >= REARM)) {
    s.phase = 'missing'; s.episodeAt = now; s.staleAcknowledged = false;
    delete s.recoveryFirstAt;
    s.notice = { kind: 'stale', qualifiedAt: now, consumed: false };
  }
  if (s.notice && now - s.notice.qualifiedAt > TTL) consume(s);
  return result(s);
}

// A pure acknowledgement boundary for later dispatch. No send/retry/KV operation.
export function settleDataHealthNotice(c: Config, raw: unknown, candidate: HealthCandidate | undefined,
  outcome: 'accepted' | 'abandoned', now: number): HealthResult {
  const current = advanceDataHealth(c, raw, { kind: 'idle' }, now);
  if (current.status !== 'ok' || !candidate || !current.candidate ||
      !['accepted', 'abandoned'].includes(outcome) ||
      candidate.policy !== current.candidate.policy || candidate.kind !== current.candidate.kind ||
      candidate.episodeAt !== current.candidate.episodeAt || candidate.qualifiedAt !== current.candidate.qualifiedAt) return current;
  if (outcome === 'accepted' && candidate.kind === 'stale') current.state.staleAcknowledged = true;
  consume(current.state);
  return result(current.state);
}
