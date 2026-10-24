import type { Config, HealthAlert, State } from './types.ts';
import { advanceDataHealth, settleDataHealthNotice, type HealthCandidate, type HealthObservation } from './data-health.ts';
import { daytimePeriod } from './daytime.ts';
import { displayTime } from './display-time.ts';

const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const id = (n: HealthCandidate) => `health:${n.kind}:${n.episodeAt}:${n.qualifiedAt}`;
function same(a: HealthCandidate, b: HealthCandidate | undefined): boolean {
  return !!b && a.kind === b.kind && a.policy === b.policy && a.episodeAt === b.episodeAt && a.qualifiedAt === b.qualifiedAt;
}
export function validHealthAlert(raw: unknown): boolean {
  const a = object(raw), n = object(a?.notice);
  return !!a && a.kind === 'health' && !Object.hasOwn(a, 'reading') && !!n &&
    (n.kind === 'stale' || n.kind === 'restored') && typeof n.policy === 'string' && n.policy.length <= 512 &&
    time(n.episodeAt) && time(n.qualifiedAt) && n.qualifiedAt >= n.episodeAt &&
    (n.kind !== 'stale' || n.qualifiedAt === n.episodeAt) &&
    a.id === `health:${n.kind}:${n.episodeAt}:${n.qualifiedAt}` && a.createdAt === n.qualifiedAt &&
    time(a.createdAt) && time(a.nextAttemptAt) && Number.isInteger(a.attempts) &&
    typeof a.attempts === 'number' && a.attempts >= 0 && a.attempts <= 3;
}
export function settleHealth(s: State, c: Config, a: HealthAlert, outcome: 'accepted' | 'abandoned', now: number): void {
  const result = settleDataHealthNotice(c, s.dataHealth, a.notice, outcome, now);
  if (result.status === 'ok') s.dataHealth = result.state;
}
export function makeBatteryRoom(s: State, c: Config, now: number): void {
  if (s.pending.length < 2) return;
  const health = s.pending.find((a): a is HealthAlert => a.kind === 'health');
  if (health) {
    settleHealth(s, c, health, 'abandoned', now);
    s.pending = s.pending.filter(a => a.kind !== 'health');
  }
}
export function syncHealth(s: State, c: Config, observation: HealthObservation, now: number): string | undefined {
  let result = advanceDataHealth(c, s.dataHealth, observation, now);
  if (result.status === 'paused') return;
  if (result.status !== 'ok') {
    if (result.status === 'off') delete s.dataHealth;
    s.pending = s.pending.filter(a => a.kind !== 'health');
    return result.status === 'invalid' ? result.code : undefined;
  }
  s.dataHealth = result.state;
  const old = s.pending.find((a): a is HealthAlert => a.kind === 'health');
  if (old && old.attempts >= 3 && same(old.notice, result.candidate)) {
    settleHealth(s, c, old, 'abandoned', now);
    result = advanceDataHealth(c, s.dataHealth, { kind: 'idle' }, now);
    if (result.status !== 'ok') return;
    s.dataHealth = result.state;
  }
  const candidate = result.candidate;
  s.pending = s.pending.filter(a => a.kind !== 'health' || same(a.notice, candidate));
  if (candidate && s.pending.length < 2 && !s.pending.some(a => a.kind === 'health')) {
    s.pending.push({ kind: 'health', id: id(candidate), notice: candidate,
      createdAt: candidate.qualifiedAt, attempts: 0, nextAttemptAt: now });
  }
  const queued = s.pending.find((a): a is HealthAlert => a.kind === 'health');
  if (queued) s.pending = [...s.pending.filter(a => a.kind !== 'health'), queued];
}
// Re-evaluate time/window/evidence after waits; never advance persisted state or poll.
export function healthMessage(s: State, c: Config, a: HealthAlert, now: number): string | undefined {
  const result = advanceDataHealth(c, s.dataHealth, { kind: 'idle' }, now);
  if (result.status !== 'ok' || !same(a.notice, result.candidate)) return;
  if (c.dataHealth?.delivery === 'daytime' && (!c.daytimeDischarge || !daytimePeriod(now, c.daytimeDischarge))) return;
  const metadata = result.state;
  let source: string;
  try {
    source = metadata.latestAt === undefined ? 'No accepted battery reading since monitoring of updates began.' :
      `Last accepted reading: ${displayTime(metadata.latestAt, c, 'readable')}\nSource age: ${Math.floor((now - metadata.latestAt) / 60_000)} minutes.`;
  } catch { return; } // Optional formatting cannot expose errors or interrupt battery checkpoints.
  if (a.notice.kind === 'restored') return `📡 New battery readings received\n\nTwo distinct fresh source readings observed.\n${source}\nObserved telemetry recovery is not proof of continuous service.`;
  return `📡 Battery updates delayed\n\nWarning age: ${c.dataHealth!.warnAfterMinutes} minutes.\n${source}\nCurrent battery charge and power are unknown. The cause is unknown; this does not establish a grid outage or an EV charging state.`;
}
