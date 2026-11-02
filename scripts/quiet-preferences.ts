import type { Config } from '../src/types.ts';
import type { PreferencePrompts } from './preferences.ts';
import { validateConfig } from '../src/config.ts';
import { validateQuietHours, quietPreferencesText, type QuietCategories } from '../src/quiet-hours.ts';
import { SafeError } from '../src/errors.ts';

const clockMinute = (s: string): number => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5][05]$/.test(s)
  ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN;

export async function configureQuiet(source: Config, p: PreferencePrompts): Promise<Config> {
  // Validate saved consent before prompts; never mutate the previous local policy.
  const c = structuredClone(validateConfig(source));
  p.print('Optional quiet hours suppress only your selected proactive notifications. Observations, battery cycles and health/recap tracking continue. Requested replies remain unaffected.');
  if (await p.confirm('Enable separate quiet hours?', false)) {
    p.print('Enter a timezone matching any configured daytime rule and enabled recap. This setup does not change either policy.');
    const validZone = (timeZone: string) => {
      try {
        validateQuietHours({ enabled: true, timeZone, startMinute: 0, endMinute: 5,
          categories: { full: true, discharge: false, health: false, recap: false }, suppressionConfirmed: true }, c);
        return true;
      } catch { return false; }
    };
    const timeZone = await p.text('Installation timezone (IANA name, explicitly entered):', undefined,
      s => validZone(s) || 'Enter a valid timezone matching existing daytime/recap settings.');
    if (!validZone(timeZone)) throw new SafeError('quiet_hours_config_invalid');
    const start = await p.text('Quiet start (HH:MM, five-minute steps):', undefined,
      s => Number.isFinite(clockMinute(s)) || 'Enter 00:00–23:55 in five-minute steps.');
    const end = await p.text('Quiet end (HH:MM, five-minute steps; different from start):', undefined,
      s => Number.isFinite(clockMinute(s)) && s !== start || 'Enter a different five-minute time, 00:00–23:55.');
    const categories = {} as QuietCategories;
    for (const key of ['full', 'discharge', 'health', 'recap'] as const) {
      const choice = await p.text(`Type mute or keep for ${key} notifications during quiet hours:`, undefined,
        s => ['mute', 'keep'].includes(s) || 'Explicitly type mute or keep.');
      if (!['mute', 'keep'].includes(choice)) throw new SafeError('quiet_hours_config_invalid');
      categories[key] = choice === 'mute';
    }
    const candidate = validateQuietHours({ enabled: true, timeZone, startMinute: clockMinute(start),
      endMinute: clockMinute(end), categories, suppressionConfirmed: true }, c)!;
    p.print(quietPreferencesText({ ...c, quietHours: candidate }));
    if (!await p.confirm('I accept suppression of the displayed categories and window: original events may expire without catch-up. This does not authorize overnight EV charging.', false)) {
      throw new SafeError('quiet_setup_not_confirmed');
    }
    c.quietHours = candidate;
  } else {
    delete c.quietHours;
    p.print('Quiet-only cleanup occurs on a scheduled run after deployment with monitoring enabled. Verify its cleanup checkpoint privately before rollback to code without quiet support; suppression ends, while battery/health/recap state is preserved.');
    p.print(quietPreferencesText(c));
  }
  validateConfig(c);
  p.print('Apply manually with npm run deploy, or update your private CI configuration snapshot before using the manual deployment workflow. No provider request or deployment occurs here; production CPU remains unmeasured.');
  if (!await p.confirm('Save these quiet-hours preferences locally? Deployment remains manual.', false)) {
    throw new SafeError('quiet_setup_not_confirmed');
  }
  return c;
}
