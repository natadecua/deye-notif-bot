import type { Alert, Config, Reading, State } from './types.ts';
import { notificationEnabled, stateIdentity } from './config.ts';
import { SafeError } from './errors.ts';
import { chargingProfileReference } from './profiles.ts';
import { activeChargingSession, chargingSummary, type BotState } from './bot-state.ts';

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
      (s.latestReading !== undefined && (!s.latestReading || !finite(s.latestReading.at) ||
        !finite(s.latestReading.soc) || s.latestReading.soc > 100 || !finite(s.latestReading.dischargeWatts) ||
        s.latestReading.at !== s.lastReadingAt)) ||
      !Array.isArray(s.pending) || s.pending.length > 2 || s.pending.some(a =>
        !a || !['full', 'discharge'].includes(a.kind) || typeof a.id !== 'string' ||
        !a.reading || !finite(a.reading.at) || !finite(a.reading.soc) || a.reading.soc > 100 ||
        !finite(a.reading.dischargeWatts) || !finite(a.createdAt) || !finite(a.nextAttemptAt) ||
        !Number.isInteger(a.attempts) || a.attempts < 0 || a.attempts > 3)) {
    throw new SafeError('state_invalid');
  }
  const identity = stateIdentity(c);
  if (s.identity === identity) return s;
  // Before profile/preferences support the identity appended the EV object.
  // Migrate that metadata without rearming otherwise identical battery cycles.
  try {
    const legacy = JSON.parse(s.identity);
    if (Array.isArray(legacy) && legacy.length === 11 &&
        JSON.stringify(legacy.slice(0, 10)) === identity) {
      s.identity = identity;
      return s;
    }
  } catch { /* An unrecognized identity starts a new measurement interpretation. */ }
  return initialState(c);
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
  s.latestReading = { ...r };
  const enqueue = (kind: Alert['kind']) => {
    if (notificationEnabled(c, kind)) {
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
export function batteryLoadSummary(c: Config): string {
  return 'Load breakdown: unknown. Battery output alone does not identify individual loads or total home consumption.' +
    (c.ev.enabled ? '\nHousehold / EV split: unknown.' : '');
}
export function alertText(a: Alert, c: Config, context?: { bot?: BotState; now: number }): string {
  // Format explicitly in UTC, independent of the Worker host's locale/timezone.
  const date = new Date(a.reading.at);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const when = `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${date.toISOString().slice(11, 19)} UTC`;
  const footer = `\n\nReading: ${when}\nDeye Cloud data may be delayed.`;
  if (a.kind === 'full') {
    const title = c.fullSoc === 100 ? '🔋 House battery full' : '🔋 House battery charge target reached';
    const target = c.fullSoc === 100 ? '' : `\nAlert target: ${c.fullSoc}%`;
    return `${title}\n\nCharge: ${a.reading.soc}%${target}${footer}`;
  }
  let text = `⚡ House battery supplying power\n\nBattery discharge: ${Math.round(a.reading.dischargeWatts)} W\nCharge: ${a.reading.soc}%\nAbove ${c.dischargeWatts} W in two distinct readings.\n\n${batteryLoadSummary(c)}`;
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
