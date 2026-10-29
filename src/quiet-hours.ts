import type { Config } from './types.ts';
import { SafeError } from './errors.ts';
import { zonedDateParts } from './daytime.ts';

export interface QuietCategories { full: boolean; discharge: boolean; health: boolean; recap: boolean }
export interface QuietHoursPolicy {
  enabled: true;
  timeZone: string;
  startMinute: number;
  endMinute: number;
  categories: QuietCategories;
  suppressionConfirmed: true;
}
export interface QuietHoursState { version: 1; lastObservedAt: number }
export type QuietHoursResult = { status: 'off' | 'paused' } |
  { status: 'invalid'; code: 'quiet_hours_state_invalid' | 'quiet_hours_clock_invalid'; muted: QuietCategories } |
  { status: 'ok'; state: QuietHoursState; reason: 'quiet' | 'open' | 'rollback'; muted: QuietCategories };

const categories = ['full', 'discharge', 'health', 'recap'] as const;
const fields = ['enabled', 'timeZone', 'startMinute', 'endMinute', 'categories', 'suppressionConfirmed'];
const object = (raw: unknown): Record<string, unknown> | undefined =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
const exact = (raw: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(raw).length === keys.length && keys.every(k => Object.hasOwn(raw, k));
const minute = (raw: unknown): raw is number => typeof raw === 'number' && Number.isInteger(raw) &&
  raw >= 0 && raw <= 1435 && raw % 5 === 0;
const time = (raw: unknown): raw is number => typeof raw === 'number' && Number.isSafeInteger(raw) &&
  raw >= 0 && raw <= 253402300799999;
const unmuted = (): QuietCategories => ({ full: false, discharge: false, health: false, recap: false });

// Isolated preparation only: no Config/State acceptance, Worker import, IO or delivery.
// The existing base context is validated by the caller, as with recap preparation.
export function validateQuietHours(raw: unknown,
  context: Pick<Config, 'daytimeDischarge' | 'dailyRecap'> = {}): QuietHoursPolicy | undefined {
  if (raw === undefined) return;
  const p = object(raw), invalid = () => { throw new SafeError('quiet_hours_config_invalid'); };
  if (!p || typeof p.enabled !== 'boolean') return invalid();
  if (!p.enabled) {
    if (!exact(p, ['enabled'])) return invalid();
    return;
  }
  const flags = object(p.categories);
  if (!exact(p, fields) || p.suppressionConfirmed !== true ||
      typeof p.timeZone !== 'string' || p.timeZone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(p.timeZone) ||
      (context.daytimeDischarge !== undefined && p.timeZone !== context.daytimeDischarge.timeZone) ||
      (context.dailyRecap?.enabled && p.timeZone !== context.dailyRecap.timeZone) ||
      !minute(p.startMinute) || !minute(p.endMinute) || p.startMinute === p.endMinute ||
      !flags || !exact(flags, categories) || categories.some(k => typeof flags[k] !== 'boolean') ||
      !categories.some(k => flags[k] === true)) return invalid();
  try { zonedDateParts(0, p.timeZone); } catch { return invalid(); }
  return { enabled: true, timeZone: p.timeZone, startMinute: p.startMinute, endMinute: p.endMinute,
    categories: { full: flags.full as boolean, discharge: flags.discharge as boolean,
      health: flags.health as boolean, recap: flags.recap as boolean }, suppressionConfirmed: true };
}
function decode(raw: unknown): QuietHoursState | undefined {
  const s = object(raw);
  return s && exact(s, ['version', 'lastObservedAt']) && s.version === 1 && time(s.lastObservedAt)
    ? { version: 1, lastObservedAt: s.lastObservedAt } : undefined;
}
export function advanceQuietHours(c: Config, rawPolicy: unknown, rawState: unknown, now: number): QuietHoursResult {
  if (!c.enabled) return { status: 'paused' };
  const p = validateQuietHours(rawPolicy, c);
  if (!p) return { status: 'off' };
  if (!time(now)) return { status: 'invalid', code: 'quiet_hours_clock_invalid', muted: p.categories };
  const previous = rawState === undefined ? undefined : decode(rawState);
  if (rawState !== undefined && !previous) return { status: 'invalid', code: 'quiet_hours_state_invalid', muted: p.categories };
  if (previous && now < previous.lastObservedAt) return { status: 'ok', state: previous, reason: 'rollback', muted: p.categories };
  let localMinute: number;
  try {
    const parts = zonedDateParts(now, p.timeZone);
    const hour = Number(parts.find(v => v.type === 'hour')?.value), m = Number(parts.find(v => v.type === 'minute')?.value);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
      throw new SafeError('quiet_hours_clock_invalid');
    }
    localMinute = hour * 60 + m;
  } catch { return { status: 'invalid', code: 'quiet_hours_clock_invalid', muted: p.categories }; }
  const quiet = p.startMinute < p.endMinute ? localMinute >= p.startMinute && localMinute < p.endMinute :
    localMinute >= p.startMinute || localMinute < p.endMinute;
  return { status: 'ok', state: { version: 1, lastObservedAt: now }, reason: quiet ? 'quiet' : 'open',
    muted: quiet ? p.categories : unmuted() };
}
