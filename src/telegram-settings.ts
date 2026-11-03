import {reserveStatus} from './reserve.ts';
import type { Config } from './types.ts';
import { notificationPreferences, validateConfig } from './config.ts';
import { daytimeSummary } from './daytime.ts';
import { healthPreferencesText } from './health-config.ts';
import { recapPreferencesText } from './recap-config.ts';
import { quietPreferencesText } from './quiet-hours.ts';
import { SafeError } from './errors.ts';
import { kilowatts } from './power.ts';
import { gridStatus } from './grid-runtime.ts';

export type SettingsOverrides = Pick<Config, 'notifications' | 'fullSoc' | 'fullRearmSoc' |
  'dischargeWatts' | 'dischargeRearmWatts' | 'reserve'> & { dischargeMinutes?: number; gridWatts?:number; gridMinutes?:number;gridRecovery?:boolean };
const usage = 'Commands: /settings, /full on|off, /discharge on|off, /full_soc PERCENT, /discharge_kw KILOWATTS, /discharge_watts WATTS, /discharge_rearm_watts WATTS, /discharge_minutes MINUTES (1–120; existing daytime rule), /grid_kw KILOWATTS, /grid_minutes MINUTES, /grid_recovery on|off (verified grid setup), /reserve.';
export function resolveSettings(base: Config, overrides?: SettingsOverrides): Config {
  const { dischargeMinutes, gridWatts, gridMinutes, gridRecovery, ...rest } = overrides ?? {};
  if(gridRecovery!==undefined&&typeof gridRecovery!=='boolean')throw new SafeError('bot_state_invalid');
  if(gridWatts!==undefined&&(!Number.isFinite(gridWatts)||gridWatts<=0||gridWatts>1e9)||
    gridMinutes!==undefined&&(!Number.isInteger(gridMinutes)||gridMinutes<1||gridMinutes>120))throw new SafeError('bot_state_invalid');
  if (dischargeMinutes !== undefined && (!Number.isInteger(dischargeMinutes) ||
      dischargeMinutes < 1 || dischargeMinutes > 120)) throw new SafeError('bot_state_invalid');
  return { ...base, ...rest,...(base.gridImport?.enabled?{gridImport:{...base.gridImport,
    thresholdWatts:gridWatts??base.gridImport.thresholdWatts,minimumMinutes:gridMinutes??base.gridImport.minimumMinutes,...(gridRecovery===undefined?{}:{recovery:gridRecovery})}}:{}),
    ...(dischargeMinutes === undefined || !base.daytimeDischarge ? {} : {
    daytimeDischarge: { ...base.daytimeDischarge!, minimumMinutes: dischargeMinutes } }) };
}
export function settingsOverrides(c: Config): SettingsOverrides {
  return { ...(c.reserve===undefined?{}:{reserve:c.reserve}),notifications: notificationPreferences(c), fullSoc: c.fullSoc, fullRearmSoc: c.fullRearmSoc,
    dischargeWatts: c.dischargeWatts, dischargeRearmWatts: c.dischargeRearmWatts,
    ...(c.daytimeDischarge ? { dischargeMinutes: c.daytimeDischarge.minimumMinutes } : {}),
    ...(c.gridImport?.enabled?{gridWatts:c.gridImport.thresholdWatts,gridMinutes:c.gridImport.minimumMinutes,...(c.gridImport.recovery===undefined?{}:{gridRecovery:c.gridImport.recovery})}:{}) };
}
export function applyTelegramCommand(config: Config, text: string): { config: Config; changed: boolean; reply: string } {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+(\S+))?$/i.exec(text.trim());
  const [command, argument] = match ? [match[1].toLowerCase(), match[2]] : ['', undefined];
  const unchanged = (reply: string) => ({ config, changed: false, reply });
  if (command === 'settings' && !argument) {
    const p = notificationPreferences(config);
    return unchanged(`⚙️ Battery notifications\n\nBattery full: ${p.full ? 'on' : 'off'} at ${config.fullSoc}%\nBattery supplying power: ${p.discharge ? 'on' : 'off'} above ${kilowatts(config.dischargeWatts)}${config.daytimeDischarge ? `\nDaytime rule: ${daytimeSummary(config)}` : ''}${config.weather !== undefined ? `\nWeather context: ${config.weather.enabled ? 'on (Open-Meteo forecast)' : 'off'}` : ''}\n\n${healthPreferencesText(config)}\n\n${recapPreferencesText(config)}\n\n${quietPreferencesText(config)}\n\n${gridStatus(config,undefined,0)}\n\n${reserveStatus(config)}\n\n${usage}\n/settings reset restores deployment preferences.`);
  }
  const next = structuredClone(config);
  if (command === 'grid_kw'||command==='grid_minutes'||command==='grid_recovery') {
    if(!config.gridImport?.enabled)return unchanged('Grid alerts are off or unverified. Complete private device/source verification and explicit grid setup first.');
    let value:number;
    if(command==='grid_recovery'){
      if(argument!=='on'&&argument!=='off')return unchanged('Use /grid_recovery on|off after verified setup.');
      next.gridImport={...config.gridImport,recovery:argument==='on'};
    }else if(command==='grid_kw'){
      const m=/^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(argument??'');
      if(!m)return unchanged('Enter kW with up to three decimals, e.g. /grid_kw 1.');
      value=Number(m[1])*1000+Number((m[2]??'').padEnd(3,'0'));
      if(value<=config.gridImport.rearmWatts)return unchanged('Grid threshold must exceed its re-arm value.');
      next.gridImport={...config.gridImport,thresholdWatts:value};
    }else{
      if(!/^\d+$/.test(argument??'')||Number(argument)<1||Number(argument)>120)return unchanged('Enter whole grid minutes from 1 to 120.');
      next.gridImport={...config.gridImport,minimumMinutes:Number(argument)};
    }
  } else if (command === 'discharge_kw') {
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
  return { config: next, changed: true, reply: command==='grid_recovery'
    ? `Recovery notice: ${next.gridImport?.enabled&&next.gridImport.recovery?'on':'off'}. It follows an accepted grid warning and two fresh readings below your re-arm level spanning at least 5 minutes. Grid warning confirmation and battery rules are preserved.`
    : command === 'grid_kw'||command==='grid_minutes'
    ? `Grid preferences saved: above ${kilowatts(next.gridImport!.enabled?next.gridImport!.thresholdWatts:0)} for ${next.gridImport!.enabled?next.gridImport!.minimumMinutes:0} minutes, all hours. Changed values start fresh grid confirmation; battery rules are preserved.\nUse /settings to review, or /settings reset to restore deployment preferences.`
    : command === 'discharge_minutes'
    ? `Daytime discharge tolerance saved: ${next.daytimeDischarge!.minimumMinutes} minutes. The next scheduled run starts fresh discharge confirmation if the duration changed; full-charge cycles are preserved.\nUse /settings to review, or /settings reset to restore deployment preferences.`
    : `Preferences saved. They apply on the next scheduled reading.\nHouse battery threshold: ${kilowatts(next.dischargeWatts)}.\nUse /settings to review them.` };
}
