import type { Alert, Config, Reading, State } from './types.ts';
import { stateIdentity } from './config.ts';
import { SafeError } from './errors.ts';

export const ALERT_TTL_MS = 30 * 60 * 1000;
export function initialState(c: Config): State {
  return { version: 1, identity: stateIdentity(c), fullArmed: true, dischargeArmed: true,
    highCount: 0, pending: [], apiFailures: 0, apiRetryAt: 0 };
}
export function decodeState(value: string | null, c: Config): State {
  if (value === null) return initialState(c);
  let s: State;
  try { s = JSON.parse(value); } catch { throw new SafeError('state_invalid'); }
  // Fail closed on corruption; silently resetting could spam a latched cycle.
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!s || s.version !== 1 || typeof s.identity !== 'string' ||
      typeof s.fullArmed !== 'boolean' || typeof s.dischargeArmed !== 'boolean' ||
      !Number.isInteger(s.highCount) || s.highCount < 0 || s.highCount > 2 ||
      !Number.isInteger(s.apiFailures) || s.apiFailures < 0 || !finite(s.apiRetryAt) ||
      (s.lastReadingAt !== undefined && !finite(s.lastReadingAt)) ||
      !Array.isArray(s.pending) || s.pending.length > 2 || s.pending.some(a =>
        !a || !['full', 'discharge'].includes(a.kind) || typeof a.id !== 'string' ||
        !a.reading || !finite(a.reading.at) || !finite(a.reading.soc) || a.reading.soc > 100 ||
        !finite(a.reading.dischargeWatts) || !finite(a.createdAt) || !finite(a.nextAttemptAt) ||
        !Number.isInteger(a.attempts) || a.attempts < 0 || a.attempts > 3)) {
    throw new SafeError('state_invalid');
  }
  return s.identity === stateIdentity(c) ? s : initialState(c);
}
export function expirePending(s: State, now: number): void {
  s.pending = s.pending.filter(a => now - a.createdAt <= ALERT_TTL_MS && a.attempts < 3);
}
export function resetAfterGap(s: State, c: Config, now: number): void {
  if (s.lastReadingAt === undefined || now - s.lastReadingAt > c.maxGapSeconds * 1000) s.highCount = 0;
}
export function transition(s: State, r: Reading, c: Config, now: number): 'accepted' | 'duplicate' | 'out_of_order' {
  if (s.lastReadingAt !== undefined && r.at <= s.lastReadingAt) {
    return r.at === s.lastReadingAt ? 'duplicate' : 'out_of_order';
  }
  if (s.lastReadingAt === undefined || r.at - s.lastReadingAt > c.maxGapSeconds * 1000) s.highCount = 0;
  s.lastReadingAt = r.at;
  const enqueue = (kind: Alert['kind']) => {
    s.pending.push({ id: `${kind}:${r.at}`, kind, reading: r, createdAt: now, attempts: 0, nextAttemptAt: now });
  };
  if (r.soc < c.fullRearmSoc) {
    s.fullArmed = true;
    s.pending = s.pending.filter(a => a.kind !== 'full');
  }
  if (s.fullArmed && r.soc >= c.fullSoc) {
    s.fullArmed = false;
    enqueue('full');
  }
  if (r.dischargeWatts < c.dischargeRearmWatts) {
    s.dischargeArmed = true;
    s.pending = s.pending.filter(a => a.kind !== 'discharge');
  }
  if (s.dischargeArmed) {
    s.highCount = r.dischargeWatts > c.dischargeWatts ? Math.min(2, s.highCount + 1) : 0;
    if (s.highCount >= 2) {
      s.dischargeArmed = false;
      s.highCount = 0;
      enqueue('discharge');
    }
  }
  return 'accepted';
}
export function alertText(a: Alert, c: Config): string {
  const when = new Date(a.reading.at).toISOString();
  if (a.kind === 'full') {
    return `House battery reached ${a.reading.soc}% SOC (threshold ${c.fullSoc}%).\nReading: ${when}. Cloud data may be delayed.`;
  }
  let text = `House battery is supplying sustained demand: ${Math.round(a.reading.dischargeWatts)} W. Discharge exceeded ${c.dischargeWatts} W in two distinct readings.\nIf the EV is charging, consider reducing its charging current manually. Inverter telemetry cannot identify the EV as the cause.`;
  if (c.ev.enabled && c.ev.confirmed && c.ev.phases && c.ev.voltage && c.ev.minimumAmps) {
    const amps = Math.ceil(a.reading.dischargeWatts / (c.ev.phases * c.ev.voltage));
    text += `\nApproximate reduction: ${amps} A${c.ev.phases === 3 ? ' per phase (balanced three-phase)' : ' (single-phase)'} at ${c.ev.voltage} V line-to-neutral. Current EV amperage is unknown: check it first. Only reduce if the resulting setting stays at or above your charger's supported minimum of ${c.ev.minimumAmps} A; otherwise pause charging manually if appropriate. No target current is calculated.`;
  }
  return `${text}\nReading: ${when}. Cloud data may be delayed.`;
}
