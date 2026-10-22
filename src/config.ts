import type { Alert, Config, NotificationPreferences } from './types.ts';
import { SafeError } from './errors.ts';
import { validateChargingProfiles } from './profiles.ts';
import { validateDaytime } from './daytime.ts';

export const HOSTS = {
  eu: 'https://eu1-developer.deyecloud.com/v1.0',
  am: 'https://us1-developer.deyecloud.com/v1.0',
  india: 'https://india-developer.deyecloud.com/v1.0',
} as const;

export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new SafeError('config_invalid');
  const c = raw as Config;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (typeof c.enabled !== 'boolean' || typeof c.measurementsConfirmed !== 'boolean' ||
      !Object.hasOwn(HOSTS, c.region) || !Number.isSafeInteger(c.stationId) || c.stationId < 0 ||
      !['W', 'kW'].includes(c.powerUnit) ||
      !['iso-offset', 'unix-seconds', 'unix-milliseconds'].includes(c.timestampMode) ||
      ![c.fullSoc, c.fullRearmSoc, c.dischargeWatts, c.dischargeRearmWatts,
        c.maxAgeSeconds, c.maxGapSeconds].every(finite) ||
      c.fullSoc > 100 || c.fullSoc <= 0 || c.fullRearmSoc < 0 || c.fullRearmSoc >= c.fullSoc ||
      c.dischargeRearmWatts < 0 || c.dischargeWatts <= c.dischargeRearmWatts ||
      c.maxAgeSeconds < 60 || c.maxAgeSeconds > 3600 ||
      c.maxGapSeconds < 300 || c.maxGapSeconds > 3600 ||
      !c.ev || typeof c.ev.enabled !== 'boolean') throw new SafeError('config_invalid');
  if (c.enabled && (!c.measurementsConfirmed || c.stationId === 0)) {
    throw new SafeError('setup_not_confirmed');
  }
  if (c.ev.enabled && (c.ev.confirmed !== true || ![1, 3].includes(c.ev.phases!) ||
      !finite(c.ev.voltage) || c.ev.voltage < 100 || c.ev.voltage > 300 ||
      !finite(c.ev.minimumAmps) || c.ev.minimumAmps <= 0 || c.ev.minimumAmps > 100)) {
    throw new SafeError('ev_config_unconfirmed');
  }
  if (c.notifications !== undefined && (!c.notifications || Array.isArray(c.notifications) ||
      typeof c.notifications.full !== 'boolean' || typeof c.notifications.discharge !== 'boolean')) {
    throw new SafeError('notification_preferences_invalid');
  }
  validateChargingProfiles(c.ev);
  validateDaytime(c.daytimeDischarge);
  if (c.telegram !== undefined && (!c.telegram || Array.isArray(c.telegram) ||
      typeof c.telegram.enabled !== 'boolean')) throw new SafeError('telegram_preferences_invalid');
  return c;
}

export function notificationPreferences(c: Config): NotificationPreferences {
  return c.notifications ?? { full: true, discharge: true };
}

export function notificationEnabled(c: Config, kind: Alert['kind']): boolean {
  return notificationPreferences(c)[kind];
}

// Measurement interpretation changes reset cycles. Delivery/EV display preferences do not.
export function stateIdentity(c: Config): string {
  return JSON.stringify([c.region, c.stationId, c.powerUnit, c.timestampMode,
    c.fullSoc, c.fullRearmSoc, c.dischargeWatts, c.dischargeRearmWatts,
    c.maxAgeSeconds, c.maxGapSeconds]);
}
