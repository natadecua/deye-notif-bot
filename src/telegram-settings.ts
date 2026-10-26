import type { Config } from './types.ts';
import { notificationPreferences, validateConfig } from './config.ts';
import { daytimeSummary } from './daytime.ts';
import { healthPreferencesText } from './health-config.ts';

export type SettingsOverrides = Pick<Config, 'notifications' | 'fullSoc' | 'fullRearmSoc' |
  'dischargeWatts' | 'dischargeRearmWatts'>;
const usage = 'Commands: /settings, /full on|off, /discharge on|off, /full_soc PERCENT, /discharge_watts WATTS, /discharge_rearm_watts WATTS.';
export function settingsOverrides(c: Config): SettingsOverrides {
  return { notifications: notificationPreferences(c), fullSoc: c.fullSoc, fullRearmSoc: c.fullRearmSoc,
    dischargeWatts: c.dischargeWatts, dischargeRearmWatts: c.dischargeRearmWatts };
}
export function applyTelegramCommand(config: Config, text: string): { config: Config; changed: boolean; reply: string } {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+(\S+))?$/i.exec(text.trim());
  const [command, argument] = match ? [match[1].toLowerCase(), match[2]] : ['', undefined];
  const unchanged = (reply: string) => ({ config, changed: false, reply });
  if (command === 'settings' && !argument) {
    const p = notificationPreferences(config);
    return unchanged(`⚙️ Battery notifications\n\nBattery full: ${p.full ? 'on' : 'off'} at ${config.fullSoc}%\nBattery supplying power: ${p.discharge ? 'on' : 'off'} above ${config.dischargeWatts} W${config.daytimeDischarge ? `\nDaytime rule: ${daytimeSummary(config)}` : ''}${config.weather !== undefined ? `\nWeather context: ${config.weather.enabled ? 'on (Open-Meteo forecast)' : 'off'}` : ''}\n\n${healthPreferencesText(config)}\n\n${usage}\n/settings reset restores deployment preferences.`);
  }
  const next = structuredClone(config);
  if (['full', 'discharge'].includes(command) && ['on', 'off'].includes(argument ?? '')) {
    next.notifications = { ...notificationPreferences(config), [command]: argument === 'on' };
  } else if (['full_soc', 'discharge_watts', 'discharge_rearm_watts'].includes(command) &&
      /^\d+(?:\.\d+)?$/.test(argument ?? '')) {
    const value = Number(argument);
    if (command === 'full_soc') {
      if (value <= config.fullRearmSoc) return unchanged('The re-arm threshold must be below the full threshold. ' + usage);
      next.fullSoc = value;
    } else if (command === 'discharge_watts') {
      if (value <= config.dischargeRearmWatts) return unchanged('The re-arm threshold must be below the discharge threshold. ' + usage);
      next.dischargeWatts = value;
    } else {
      if (value >= config.dischargeWatts) return unchanged('The re-arm value must be below the discharge threshold. ' + usage);
      next.dischargeRearmWatts = value;
    }
  } else return unchanged(usage);
  try { validateConfig(next); } catch { return unchanged('Those values are invalid. ' + usage); }
  return { config: next, changed: true, reply: 'Preferences saved. They apply on the next scheduled reading.\nUse /settings to review them.' };
}
