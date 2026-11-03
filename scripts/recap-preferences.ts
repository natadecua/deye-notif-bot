import type { Config } from '../src/types.ts';
import type { PreferencePrompts } from './preferences.ts';
import { validateConfig } from '../src/config.ts';
import { validateDailyRecap, recapPreferencesText } from '../src/recap-config.ts';
import { SafeError } from '../src/errors.ts';

export async function configureRecap(source: Config, p: PreferencePrompts): Promise<Config> {
  // Reject invalid saved consent before prompting; cancellation never mutates source.
  const c = structuredClone(validateConfig(source));
  p.print('Optional daily cached battery snapshot. It can contain missing/stale data, is not an energy report or charging plan, and does not detect EV charging.');
  if (await p.confirm('Enable a separate daily recap?', false)) {
    if (c.daytimeDischarge) p.print('Enter the same explicit timezone as your daytime rule. Changing that rule also changes discharge filtering; recap setup does not change it.');
    const validZone = (timeZone: string) => {
      try {
        validateDailyRecap({ enabled: true, timeZone, hour: 0, minute: 0, scheduleConfirmed: true }, c.daytimeDischarge?.timeZone);
        return true;
      } catch { return false; }
    };
    const timeZone = await p.text('Installation timezone (IANA name, explicitly entered):', undefined,
      s => validZone(s) || 'Enter a valid timezone matching the existing daytime rule, if configured.');
    if (!validZone(timeZone)) throw new SafeError('daily_recap_config_invalid');
    const hour = await p.number('Local hour (0–23):', undefined,
      n => Number.isInteger(n) && n >= 0 && n <= 23 || 'Enter a whole hour from 0 to 23.');
    const minute = await p.number('Local minute (0–55, in five-minute steps):', undefined,
      n => Number.isInteger(n) && n >= 0 && n <= 55 && n % 5 === 0 || 'Enter 0, 5, 10, …, 55.');
    // Shared validation checks injected prompt results too; consent is requested next.
    const candidate = validateDailyRecap({ enabled: true, timeZone, hour, minute, scheduleConfirmed: true }, c.daytimeDischarge?.timeZone)!;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!await p.confirm(`I accept a daily cached recap at ${time} ${timeZone}, including at night if chosen. This does not authorize overnight EV charging.`, false)) {
      throw new SafeError('recap_setup_not_confirmed');
    }
    c.dailyRecap = candidate;
    p.print('Activation or schedule/measurement changes skip the current local date. The original 15-minute opportunity is not renewed by retries; missed or busy dates are skipped, without catch-up. API acceptance is not receipt.');
  } else {
    delete c.dailyRecap;
    p.print('Recap-only cleanup occurs on a scheduled run after deployment with monitoring enabled. Verify its cleanup checkpoint privately before rolling back to a version without recap support; preserve battery/health state.');
  }
  validateConfig(c);
  p.print(recapPreferencesText(c));
  p.print('Apply manually with npm run deploy, or update your private CI configuration snapshot before using the manual deployment workflow. No provider request or deployment occurs here; production CPU remains unmeasured.');
  if (!await p.confirm('Save these recap preferences locally? Deployment remains manual.', false)) {
    throw new SafeError('recap_setup_not_confirmed');
  }
  return c;
}
