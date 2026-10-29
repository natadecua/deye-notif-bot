import type { Config } from './types.ts';
import { SafeError } from './errors.ts';
import { validateDaytime } from './daytime.ts';

export function validateDataHealth(c: Config): void {
  const p = c.dataHealth;
  if (p === undefined) return;
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.enabled !== 'boolean' ||
      (p.warnAfterMinutes !== undefined && (!Number.isInteger(p.warnAfterMinutes) || p.warnAfterMinutes < 15 || p.warnAfterMinutes > 120)) ||
      (p.delivery !== undefined && !['all-hours', 'daytime'].includes(p.delivery)) ||
      (p.allHoursConfirmed !== undefined && typeof p.allHoursConfirmed !== 'boolean') ||
      (p.enabled && (p.warnAfterMinutes === undefined || p.warnAfterMinutes * 60 <= c.maxAgeSeconds ||
        p.delivery === undefined || (p.delivery === 'all-hours' ? p.allHoursConfirmed !== true : !c.daytimeDischarge)))) {
    throw new SafeError('data_health_config_invalid');
  }
}

// Configuration visibility only: never inspect, advance or persist lifecycle metadata.
export function healthPreferencesText(c: Config): string {
  try {
    validateDataHealth(c);
    if (!c.dataHealth?.enabled) return 'Health notices: off. Optional local setup: npm run health:setup.';
    const p = c.dataHealth;
    let window = 'all hours, including at night';
    if (p.delivery === 'daytime') {
      validateDaytime(c.daytimeDischarge);
      const d = c.daytimeDischarge!;
      const hour = (n: number) => `${String(n).padStart(2, '0')}:00`;
      window = `only ${hour(d.startHour)}–${hour(d.endHour)} ${d.timeZone}`;
    }
    return `Health notices: on after ${p.warnAfterMinutes} minutes without an accepted fresh update; ${window}.` +
      (c.enabled ? '' : '\nHealth delivery paused: scheduled monitoring is disabled.') +
      '\nHealth notices are independent of battery notification switches; muting full/discharge alerts does not mute health.' +
      '\nConfiguration does not verify scheduled operation or message receipt. Change locally: npm run health:setup.';
  } catch {
    return 'Health notices: invalid saved settings; not ready. Review local health settings before deployment.';
  }
}
