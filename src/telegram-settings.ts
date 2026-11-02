import type { Config } from './types.ts';
import { notificationPreferences, validateConfig } from './config.ts';
import { daytimeSummary } from './daytime.ts';
import { healthPreferencesText } from './health-config.ts';
import { recapPreferencesText } from './recap-config.ts';
import { quietPreferencesText } from './quiet-hours.ts';
import { SafeError } from './errors.ts';
import { kilowatts } from './power.ts';

export type SettingsOverrides = Pick<Config, 'notifications' | 'fullSoc' | 'fullRearmSoc' |
  'dischargeWatts' | 'dischargeRearmWatts'> & { dischargeMinutes?: number };
const usage = 'Commands: /settings, /full on|off, /discharge on|off, /full_soc PERCENT, /discharge_kw KILOWATTS, /discharge_watts WATTS, /discharge_rearm_watts WATTS, /discharge_minutes MINUTES (1–120; existing daytime rule).';
export function resolveSettings(base: Config, overrides?: SettingsOverrides): Config {
  const { dischargeMinutes, ...rest } = overrides ?? {};
  if (dischargeMinutes !== undefined && (!Number.isInteger(dischargeMinutes) ||
      dischargeMinutes < 1 || dischargeMinutes > 120)) throw new SafeError('bot_state_invalid');
  return { ...base, ...rest, ...(dischargeMinutes === undefined || !base.daytimeDischarge ? {} : {
    daytimeDischarge: { ...base.daytimeDischarge!, minimumMinutes: dischargeMinutes } }) };
}
export function settingsOverrides(c: Config): SettingsOverrides {
  return { notifications: notificationPreferences(c), fullSoc: c.fullSoc, fullRearmSoc: c.fullRearmSoc,
    dischargeWatts: c.dischargeWatts, dischargeRearmWatts: c.dischargeRearmWatts,
    ...(c.daytimeDischarge ? { dischargeMinutes: c.daytimeDischarge.minimumMinutes } : {}) };
}
export function applyTelegramCommand(config: Config, text: string): { config: Config; changed: boolean; reply: string } {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+(\S+))?$/i.exec(text.trim());
  const [command, argument] = match ? [match[1].toLowerCase(), match[2]] : ['', undefined];
  const unchanged = (reply: string) => ({ config, changed: false, reply });
  if (command === 'settings' && !argument) {
    const p = notificationPreferences(config);
    return unchanged(`⚙️ Battery notifications\n\nBattery full: ${p.full ? 'on' : 'off'} at ${config.fullSoc}%\nBattery supplying power: ${p.discharge ? 'on' : 'off'} above ${kilowatts(config.dischargeWatts)}${config.daytimeDischarge ? `\nDaytime rule: ${daytimeSummary(config)}` : ''}${config.weather !== undefined ? `\nWeather context: ${config.weather.enabled ? 'on (Open-Meteo forecast)' : 'off'}` : ''}\n\n${healthPreferencesText(config)}\n\n${recapPreferencesText(config)}\n\n${quietPreferencesText(config)}\n\n${usage}\n/settings reset restores deployment preferences.`);
  }
  const next = structuredClone(config);
  if (command === 'discharge_kw') {
    const kw = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(argument ?? '');
    if (!kw) return unchanged('Enter kW with up to three decimal places, e.g. /discharge_kw 0.5.');
    const watts = Number(kw[1])*1000 + Number((kw[2]??'').padEnd(3,'0'));
    if(watts<=config.dischargeRearmWatts)return unchanged('The threshold must exceed the re-arm value. ' + usage);
    next.dischargeWatts=watts;
  } else if (command === 'discharge_minutes') {
    if (!config.daytimeDischarge) return unchanged('First configure an explicit daytime window locally with npm run daytime:setup and deploy it. ' + usage);
    if (!/^\d+$/.test(argument ?? '') || Number(argument) < 1 || Number(argument) > 120) {
      return unchanged('Enter whole minutes from 1 to 120. ' + usage);
    }
    next.daytimeDischarge = { ...config.daytimeDischarge, minimumMinutes: Number(argument) };
  } else if (['full', 'discharge'].includes(command) && ['on', 'off'].includes(argument ?? '')) {
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
  return { config: next, changed: true, reply: command === 'discharge_minutes'
    ? `Daytime discharge tolerance saved: ${next.daytimeDischarge!.minimumMinutes} minutes. The next scheduled run starts fresh discharge confirmation if the duration changed; full-charge cycles are preserved.\nUse /settings to review, or /settings reset to restore deployment preferences.`
    : `Preferences saved. They apply on the next scheduled reading.\nHouse battery threshold: ${kilowatts(next.dischargeWatts)}.\nUse /settings to review them.` };
}
