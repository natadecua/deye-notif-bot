import type { Config } from './types.ts';
import { SafeError } from './errors.ts';
import { stateIdentity } from './config.ts';
import { zonedDateParts } from './daytime.ts';

// Preparation contract only; deliberately not imported by the Worker entry graph.
export interface DailyRecapPolicy {
  enabled: true;
  timeZone: string;
  hour: number;
  minute: number;
  scheduleConfirmed: true;
}
export interface DailyRecapState {
  version: 1;
  policy: string;
  resolvedDay: string;
  observedAt: number;
}
export interface DailyRecapSlot {
  policy: string;
  localDate: string;
  dueAt: number;
  expiresAt: number;
}
export type DailyRecapResult = { status: 'off' | 'paused' } |
  { status: 'invalid'; code: 'daily_recap_state_invalid' | 'daily_recap_clock_invalid' } |
  { status: 'ok'; state: DailyRecapState; resetPending: boolean; candidate?: DailyRecapSlot };

const MINUTE = 60_000, TTL = 15 * MINUTE, LAST_TIME = 253402300799999;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= LAST_TIME;
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const at = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === v;
}
function local(at: number, zone: string) {
  const parts = zonedDateParts(at, zone);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  if (!date(day)) throw new SafeError('daily_recap_clock_invalid');
  return { day, minute: Number(part('hour')) * 60 + Number(part('minute')), second: Number(part('second')) };
}
export function validateDailyRecap(raw: unknown, installationTimeZone?: string): DailyRecapPolicy | undefined {
  if (raw === undefined) return;
  const p = object(raw), invalid = () => { throw new SafeError('daily_recap_config_invalid'); };
  if (!p || typeof p.enabled !== 'boolean') return invalid();
  if (!p.enabled) {
    if (Object.keys(p).length !== 1) return invalid();
    return;
  }
  if (Object.keys(p).length !== 5 || Object.keys(p).some(k =>
      !['enabled', 'timeZone', 'hour', 'minute', 'scheduleConfirmed'].includes(k)) ||
      p.scheduleConfirmed !== true || typeof p.timeZone !== 'string' || p.timeZone.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(p.timeZone) ||
      (installationTimeZone !== undefined && p.timeZone !== installationTimeZone) ||
      typeof p.hour !== 'number' || !Number.isInteger(p.hour) || p.hour < 0 || p.hour > 23 ||
      typeof p.minute !== 'number' || !Number.isInteger(p.minute) || p.minute < 0 || p.minute > 55 || p.minute % 5 !== 0) return invalid();
  try { zonedDateParts(0, p.timeZone); } catch { return invalid(); }
  return { enabled: true, timeZone: p.timeZone, hour: p.hour, minute: p.minute, scheduleConfirmed: true };
}
function policyIdentity(c: Config, p: DailyRecapPolicy): string {
  return JSON.stringify([stateIdentity(c), p.timeZone, p.hour, p.minute]);
}
function validIdentity(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p) || p.length !== 4 || JSON.stringify(p) !== raw ||
        typeof p[0] !== 'string' || typeof p[1] !== 'string' || p[1].length > 64 ||
        !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(p[1]) || !Number.isInteger(p[2]) || p[2] < 0 || p[2] > 23 ||
        !Number.isInteger(p[3]) || p[3] < 0 || p[3] > 55 || p[3] % 5 !== 0) return false;
    const m = JSON.parse(p[0]);
    return Array.isArray(m) && m.length === 10 && JSON.stringify(m) === p[0] &&
      ['eu', 'am', 'india'].includes(m[0]) && Number.isSafeInteger(m[1]) && m[1] > 0 &&
      ['W', 'kW'].includes(m[2]) && ['iso-offset', 'unix-seconds', 'unix-milliseconds'].includes(m[3]) &&
      m.slice(4).every(v => typeof v === 'number' && Number.isFinite(v)) &&
      m[4] > 0 && m[4] <= 100 && m[5] >= 0 && m[5] < m[4] && m[7] >= 0 && m[6] > m[7] &&
      m[8] >= 60 && m[8] <= 3600 && m[9] >= 300 && m[9] <= 3600;
  } catch { return false; }
}
function decode(raw: unknown): DailyRecapState | undefined {
  const s = object(raw);
  if (!s || s.version !== 1 || !validIdentity(s.policy) ||
      !date(s.resolvedDay) || !time(s.observedAt)) return;
  // Do not copy unknown metadata, history or message bodies into a result.
  return { version: 1, policy: s.policy, resolvedDay: s.resolvedDay, observedAt: s.observedAt };
}
export function advanceDailyRecap(c: Config, rawPolicy: unknown, rawState: unknown, now: number): DailyRecapResult {
  if (!c.enabled) return { status: 'paused' };
  const p = validateDailyRecap(rawPolicy, c.daytimeDischarge?.timeZone);
  if (!p) return { status: 'off' };
  if (!time(now)) return { status: 'invalid', code: 'daily_recap_clock_invalid' };
  const previous = rawState === undefined ? undefined : decode(rawState);
  if (rawState !== undefined && !previous) return { status: 'invalid', code: 'daily_recap_state_invalid' };
  if (previous && now < previous.observedAt) return { status: 'ok', state: previous, resetPending: true };
  let current: ReturnType<typeof local>;
  try { current = local(now, p.timeZone); } catch { return { status: 'invalid', code: 'daily_recap_clock_invalid' }; }
  const identity = policyIdentity(c, p);
  if (!previous || previous.policy !== identity) return { status: 'ok', resetPending: true,
    state: { version: 1, policy: identity, resolvedDay: current.day, observedAt: now } };
  const state = { ...previous, observedAt: now };
  const result: Extract<DailyRecapResult, { status: 'ok' }> = { status: 'ok', state, resetPending: false };
  const elapsed = current.minute - (p.hour * 60 + p.minute);
  if (current.day <= state.resolvedDay || elapsed < 0) return result;
  // Resolve even when missed. Future admission may skip capacity; never remint today.
  state.resolvedDay = current.day;
  if (elapsed >= 15) return result;
  const dueAt = now - elapsed * MINUTE - current.second * 1000 - now % 1000, expiresAt = dueAt + TTL;
  if (!time(dueAt) || !time(expiresAt)) return result;
  const original = local(dueAt, p.timeZone);
  if (original.day !== current.day || original.minute !== p.hour * 60 + p.minute || original.second !== 0) return result;
  result.candidate = { policy: identity, localDate: current.day, dueAt, expiresAt };
  return result;
}
export function dailyRecapSlotOpen(c: Config, rawPolicy: unknown, rawState: unknown, rawSlot: unknown, now: number): boolean {
  if (!c.enabled || !time(now)) return false;
  try {
    const p = validateDailyRecap(rawPolicy, c.daytimeDischarge?.timeZone), s = decode(rawState), slot = object(rawSlot);
    if (!p || !s || !slot || slot.policy !== policyIdentity(c, p) || slot.policy !== s.policy ||
        !date(slot.localDate) || slot.localDate !== s.resolvedDay || !time(slot.dueAt) || !time(slot.expiresAt) ||
        slot.dueAt % 1000 !== 0 || slot.expiresAt !== slot.dueAt + TTL || slot.dueAt > s.observedAt ||
        now < s.observedAt || now < slot.dueAt || now >= slot.expiresAt) return false;
    const original = local(slot.dueAt, p.timeZone), current = local(now, p.timeZone), minute = p.hour * 60 + p.minute;
    return original.day === slot.localDate && original.minute === minute && original.second === 0 &&
      current.day === slot.localDate && current.minute >= minute && current.minute < minute + 15;
  } catch { return false; }
}
