import type { Config } from '../src/types.ts';
import type { PreferencePrompts } from './preferences.ts';
import { SafeError } from '../src/errors.ts';
import { validateConfig } from '../src/config.ts';
import { daytimeSummary } from '../src/daytime.ts';

export async function configureDaytime(source: Config, p: PreferencePrompts): Promise<Config> {
  const c = structuredClone(validateConfig(source));
  if (!await p.confirm('Limit battery-discharge notifications to a daytime window?', !!c.daytimeDischarge)) {
    delete c.daytimeDischarge;
    p.print('Restored the all-day, two-distinct-reading discharge rule. Other preferences are unchanged.');
    return c;
  }
  const previous = c.daytimeDischarge;
  const timeZone = await p.text('Installation IANA timezone (e.g. Asia/Manila for Batangas City):', previous?.timeZone);
  const startHour = await p.number('Daytime starts at local hour (0–23):', previous?.startHour ?? 6,
    n => Number.isInteger(n) && n >= 0 && n <= 23 || 'Enter a whole hour from 0 to 23.');
  const endHour = await p.number('Daytime ends at local hour (exclusive, 1–24):', previous?.endHour ?? 18,
    n => Number.isInteger(n) && n > startHour && n <= 24 || 'End must be after start, within the same local day.');
  const minimumMinutes = await p.number('High discharge must span at least this many minutes (1–120):', previous?.minimumMinutes ?? 15,
    n => Number.isInteger(n) && n >= 1 && n <= 120 || 'Enter whole minutes from 1 to 120.');
  c.daytimeDischarge = { timeZone, startHour, endHour, minimumMinutes };
  validateConfig(c);
  p.print(`Daytime battery-use rule: ${daytimeSummary(c)}; above ${c.dischargeWatts} W.\nThis is a fixed local-time window, not a weather forecast. Full-charge alerts keep their existing rule.`);
  if (c.notifications?.discharge === false) p.print('Discharge notifications are currently off. Use npm run preferences to enable them when ready.');
  if (!await p.confirm('Save this rule locally? Applying it to your Worker still requires manual deployment.', false)) {
    throw new SafeError('daytime_setup_not_confirmed');
  }
  return c;
}
