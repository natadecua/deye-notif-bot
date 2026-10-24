import type { Config } from './types.ts';
import { SafeError } from './errors.ts';

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
