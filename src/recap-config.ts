import { SafeError } from './errors.ts';
import { zonedDateParts } from './daytime.ts';
import type { Config } from './types.ts';

export interface DailyRecapPolicy {
  enabled: true;
  timeZone: string;
  hour: number;
  minute: number;
  scheduleConfirmed: true;
}
export function validateDailyRecap(raw: unknown, installationTimeZone?: string): DailyRecapPolicy | undefined {
  if (raw === undefined) return;
  const p = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const invalid = () => { throw new SafeError('daily_recap_config_invalid'); };
  if (!p || typeof p.enabled !== 'boolean') return invalid();
  if (!p.enabled) {
    if (Object.keys(p).length !== 1 || !Object.hasOwn(p, 'enabled')) return invalid();
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

// Configuration only: never read/advance recap metadata or promise operation/receipt.
export function recapPreferencesText(c: Config, brief = false): string {
  try {
    const p = validateDailyRecap(c.dailyRecap, c.daytimeDischarge?.timeZone);
    if (brief) {
      const label = p ? c.enabled ? 'on (configured)' : 'paused (configured on)' : 'off';
      return `Recap: ${label}${p && c.telegram?.enabled ? '; /settings for policy.' : '.'}`;
    }
    if (!p) return 'Recap: off. Optional local setup: npm run recap:setup.';
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    return `Recap: on at ${time} ${p.timeZone} (configured).` +
      (c.enabled ? '' : '\nRecap delivery paused: scheduled monitoring is disabled.') +
      '\nRecap is independent of battery notification switches; muting full/discharge does not mute recap.' +
      '\nConfiguration does not verify scheduled operation or message receipt. Change locally: npm run recap:setup.';
  } catch {
    return 'Recap: invalid saved settings; not ready. Review local recap settings before deployment.';
  }
}
