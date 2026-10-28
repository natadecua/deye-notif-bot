import type { Alert, Config, PendingAlert, Reading, State } from './types.ts';
import { notificationEnabled, stateIdentity } from './config.ts';
import { SafeError } from './errors.ts';
import { chargingProfileReference } from './profiles.ts';
import { activeChargingSession, chargingSummary, type BotState } from './bot-state.ts';
import { daytimeIdentity, daytimePeriod, daytimeSummary, dischargeWindowOpen } from './daytime.ts';
import { displayTime } from './display-time.ts';
import { makeBatteryRoom, validHealthAlert } from './health-outbox.ts';
import { validRecapAlert } from './recap-outbox.ts';

export const ALERT_TTL_MS = 30 * 60 * 1000;
export function isBatteryAlert(a: PendingAlert): a is Alert { return a.kind === 'full' || a.kind === 'discharge'; }
export function initialState(c: Config): State {
  return { version: 1, identity: stateIdentity(c), fullArmed: true, dischargeArmed: true,
    highCount: 0, pending: [], apiFailures: 0, apiRetryAt: 0,
    ...(c.daytimeDischarge ? { dischargePolicyIdentity: daytimeIdentity(c) } : {}) };
}
export function resetDischargeConfirmation(s: State): void {
  s.highCount = 0;
  delete s.highStartedAt;
}
function syncDaytimePolicy(s: State, c: Config): State {
  const identity = daytimeIdentity(c);
  if (s.dischargePolicyIdentity !== identity) {
    s.dischargeArmed = true;
    resetDischargeConfirmation(s);
    delete s.dischargeDay;
    s.pending = s.pending.filter(a => a.kind !== 'discharge');
    if (identity === undefined) delete s.dischargePolicyIdentity;
    else s.dischargePolicyIdentity = identity;
  }
  return s;
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
      (s.highStartedAt !== undefined && (!finite(s.highStartedAt) || s.lastReadingAt === undefined || s.highStartedAt > s.lastReadingAt)) ||
      (s.dischargeDay !== undefined && (typeof s.dischargeDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.dischargeDay))) ||
      (s.dischargePolicyIdentity !== undefined && (typeof s.dischargePolicyIdentity !== 'string' || s.dischargePolicyIdentity.length > 256)) ||
      !Number.isInteger(s.apiFailures) || s.apiFailures < 0 || !finite(s.apiRetryAt) ||
      (s.lastReadingAt !== undefined && !finite(s.lastReadingAt)) ||
      (s.latestReading !== undefined && (!s.latestReading || !finite(s.latestReading.at) ||
        !finite(s.latestReading.soc) || s.latestReading.soc > 100 || !finite(s.latestReading.dischargeWatts) ||
        s.latestReading.at !== s.lastReadingAt)) ||
      !Array.isArray(s.pending) || s.pending.length > 2 || s.pending.filter(a => a?.kind === 'health').length > 1 ||
      s.pending.filter(a => a?.kind === 'recap').length > 1 || s.pending.some(a =>
        a?.kind === 'health' ? !validHealthAlert(a) :
        a?.kind === 'recap' ? !validRecapAlert(a) :
        !a || !['full', 'discharge'].includes(a.kind) || typeof a.id !== 'string' ||
        !a.reading || !finite(a.reading.at) || !finite(a.reading.soc) || a.reading.soc > 100 ||
        !finite(a.reading.dischargeWatts) || !finite(a.createdAt) || !finite(a.nextAttemptAt) ||
        !Number.isInteger(a.attempts) || a.attempts < 0 || a.attempts > 3)) {
    throw new SafeError('state_invalid');
  }
  const identity = stateIdentity(c);
  if (s.identity === identity) return syncDaytimePolicy(s, c);
  // Before profile/preferences support the identity appended the EV object.
  // Migrate that metadata without rearming otherwise identical battery cycles.
  try {
    const legacy = JSON.parse(s.identity);
    if (Array.isArray(legacy) && legacy.length === 11 &&
        JSON.stringify(legacy.slice(0, 10)) === identity) {
      s.identity = identity;
      return syncDaytimePolicy(s, c);
    }
  } catch { /* An unrecognized identity starts a new measurement interpretation. */ }
  return initialState(c);
}
export function expirePending(s: State, now: number): void {
  // Informational expiry/exhaustion is settled without minting a new candidate.
  s.pending = s.pending.filter(a => !isBatteryAlert(a) || (now - a.createdAt <= ALERT_TTL_MS && a.attempts < 3));
}
export function resetAfterGap(s: State, c: Config, now: number): void {
  if (s.lastReadingAt === undefined || now - s.lastReadingAt > c.maxGapSeconds * 1000) resetDischargeConfirmation(s);
}
export function transition(s: State, r: Reading, c: Config, now: number): 'accepted' | 'duplicate' | 'out_of_order' {
  if (s.lastReadingAt !== undefined && r.at <= s.lastReadingAt) {
    return r.at === s.lastReadingAt ? 'duplicate' : 'out_of_order';
  }
  if (s.lastReadingAt === undefined || r.at - s.lastReadingAt > c.maxGapSeconds * 1000) resetDischargeConfirmation(s);
  s.lastReadingAt = r.at;
  s.latestReading = { ...r };
  const enqueue = (kind: Alert['kind']) => {
    if (notificationEnabled(c, kind)) {
      makeBatteryRoom(s, c, now);
      s.pending.push({ id: `${kind}:${r.at}`, kind, reading: r, createdAt: now, attempts: 0, nextAttemptAt: now });
    }
  };
  if (r.soc < c.fullRearmSoc) {
    s.fullArmed = true;
    s.pending = s.pending.filter(a => a.kind !== 'full');
  }
  if (s.fullArmed && r.soc >= c.fullSoc) {
    s.fullArmed = false;
    enqueue('full');
  }
  if (c.daytimeDischarge) {
    if (!dischargeWindowOpen(c, r.at, now)) {
      resetDischargeConfirmation(s);
      s.pending = s.pending.filter(a => a.kind !== 'discharge');
      return 'accepted';
    }
    const day = daytimePeriod(r.at, c.daytimeDischarge)!;
    if (day !== s.dischargeDay) {
      s.dischargeDay = day;
      s.dischargeArmed = true;
      resetDischargeConfirmation(s);
      s.pending = s.pending.filter(a => a.kind !== 'discharge');
    }
  }
  if (r.dischargeWatts < c.dischargeRearmWatts) {
    s.dischargeArmed = true;
    s.pending = s.pending.filter(a => a.kind !== 'discharge');
  }
  if (s.dischargeArmed) {
    if (r.dischargeWatts > c.dischargeWatts) {
      if (c.daytimeDischarge && s.highCount === 0) s.highStartedAt = r.at;
      s.highCount = Math.min(2, s.highCount + 1);
    } else resetDischargeConfirmation(s);
    const durationMet = !c.daytimeDischarge || (s.highStartedAt !== undefined &&
      r.at - s.highStartedAt >= c.daytimeDischarge.minimumMinutes * 60_000);
    if (s.highCount >= 2 && durationMet) {
      s.dischargeArmed = false;
      resetDischargeConfirmation(s);
      enqueue('discharge');
    }
  }
  return 'accepted';
}
export function batteryLoadSummary(c: Config): string {
  return 'Load breakdown: unknown. Battery output alone does not identify individual loads or total home consumption.' +
    (c.ev.enabled ? '\nHousehold / EV split: unknown.' : '');
}
export function alertText(a: PendingAlert, c: Config, context?: { bot?: BotState; now: number }): string {
  if (a.kind === 'health') throw new SafeError('health_event_requires_context');
  if (a.kind === 'recap') throw new SafeError('recap_event_requires_context');
  const when = displayTime(a.reading.at, c, 'readable');
  const footer = `\n\nReading: ${when}\nDeye Cloud data may be delayed.`;
  if (a.kind === 'full') {
    const title = c.fullSoc === 100 ? '🔋 House battery full' : '🔋 House battery charge target reached';
    const target = c.fullSoc === 100 ? '' : `\nAlert target: ${c.fullSoc}%`;
    return `${title}\n\nCharge: ${a.reading.soc}%${target}${footer}`;
  }
  const title = c.daytimeDischarge ? '☀️ Daytime battery use' : '⚡ House battery supplying power';
  const confirmation = c.daytimeDischarge ? `Above ${c.dischargeWatts} W across readings spanning at least ${c.daytimeDischarge.minimumMinutes} minutes.\nWindow: ${daytimeSummary(c)}.` :
    `Above ${c.dischargeWatts} W in two distinct readings.`;
  let text = `${title}\n\nBattery discharge: ${Math.round(a.reading.dischargeWatts)} W\nCharge: ${a.reading.soc}%\n${confirmation}\n\n${batteryLoadSummary(c)}`;
  const session = context ? activeChargingSession(context.bot, context.now) : undefined;
  if (c.ev.enabled) {
    text += `\n\n${context ? chargingSummary(context.bot, c, context.now) : 'EV charging: unknown'}`;
    if (session?.status !== 'not_charging') {
      text += '\nIf the EV is charging, consider reducing its charging current manually. Inverter telemetry cannot identify the EV as the cause.';
    }
  }
  if (c.ev.enabled && session?.status !== 'not_charging' && c.ev.confirmed && c.ev.phases && c.ev.voltage && c.ev.minimumAmps) {
    if (c.ev.profiles?.length) {
      text += `\n\n${chargingProfileReference(c.ev)}\nCurrent EV amperage is unknown: check the car first. Use only a supported lower setting if appropriate, staying at or above the configured minimum of ${c.ev.minimumAmps} A; otherwise pause manually if appropriate. No setting is selected automatically.`;
    } else {
      const amps = Math.ceil(a.reading.dischargeWatts / (c.ev.phases * c.ev.voltage));
      text += `\n\nApproximate reduction: ${amps} A${c.ev.phases === 3 ? ' per phase (balanced three-phase)' : ' (single-phase)'} at ${c.ev.voltage} V line-to-neutral. Current EV amperage is unknown: check it first. Only reduce if the resulting setting stays at or above your charger's supported minimum of ${c.ev.minimumAmps} A; otherwise pause charging manually if appropriate. No target current is calculated.`;
    }
  }
  return `${text}${footer}`;
}
