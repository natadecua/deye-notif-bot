import type { Config, DaytimeDischarge } from './types.ts';
import { SafeError } from './errors.ts';

// One installation/timezone per Worker; avoid an unbounded formatter cache.
let cachedZone: string | undefined, cachedFormatter: Intl.DateTimeFormat | undefined;
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (timeZone !== cachedZone || !cachedFormatter) {
    const next = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    cachedFormatter = next; cachedZone = timeZone;
  }
  return cachedFormatter;
}
export function validateDaytime(raw: unknown): void {
  if (raw === undefined) return;
  const p = raw as DaytimeDischarge;
  if (!p || Array.isArray(p) || typeof p.timeZone !== 'string' || p.timeZone.length > 64 ||
      !Number.isInteger(p.startHour) || p.startHour < 0 || p.startHour > 23 ||
      !Number.isInteger(p.endHour) || p.endHour <= p.startHour || p.endHour > 24 ||
      !Number.isInteger(p.minimumMinutes) || p.minimumMinutes < 1 || p.minimumMinutes > 120) {
    throw new SafeError('daytime_discharge_invalid');
  }
  try { formatter(p.timeZone); } catch { throw new SafeError('daytime_discharge_invalid'); }
}
export function daytimePeriod(at: number, p: DaytimeDischarge): string | undefined {
  const parts = formatter(p.timeZone).formatToParts(new Date(at));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const hour = Number(part('hour'));
  return hour >= p.startHour && hour < p.endHour ? `${part('year')}-${part('month')}-${part('day')}` : undefined;
}
export function dischargeWindowOpen(c: Config, readingAt: number, now: number): boolean {
  if (!c.daytimeDischarge) return true;
  const period = daytimePeriod(readingAt, c.daytimeDischarge);
  return period !== undefined && period === daytimePeriod(now, c.daytimeDischarge);
}
export function daytimeIdentity(c: Config): string | undefined {
  const p = c.daytimeDischarge;
  return p ? JSON.stringify([p.timeZone, p.startHour, p.endHour, p.minimumMinutes]) : undefined;
}
export function daytimeSummary(c: Config): string {
  const p = c.daytimeDischarge;
  const hour = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return p ? `${hour(p.startHour)}–${hour(p.endHour)} ${p.timeZone}; ${p.minimumMinutes} minutes of sampled discharge` : '';
}
