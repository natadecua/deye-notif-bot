import type { Config } from '../src/types.ts';
import type { PreferencePrompts } from './preferences.ts';
import { validateConfig } from '../src/config.ts';
import { SafeError } from '../src/errors.ts';
import { healthPreferencesText } from '../src/health-config.ts';

export async function configureHealth(source: Config, p: PreferencePrompts): Promise<Config> {
  // Validate saved settings before any prompt; do not silently repair invalid consent.
  const c = structuredClone(validateConfig(source));
  p.print('Optional missing battery-update and recovery notices. A missing update does not establish a grid outage or EV charging. Notices cannot report a complete Worker/Telegram outage.');
  if (await p.confirm('Enable separate health notices?', false)) {
    const validMinutes = (n: number) => Number.isInteger(n) && n >= 15 && n <= 120 && n * 60 > c.maxAgeSeconds;
    const warnAfterMinutes = await p.number('Missing-update warning after how many minutes (15–120, longer than reading freshness)?',
      undefined, n => validMinutes(n) || `Enter whole minutes from 15 to 120, strictly longer than ${c.maxAgeSeconds / 60} minutes.`);
    if (!validMinutes(warnAfterMinutes)) throw new SafeError('data_health_config_invalid');
    const choices = [{ name: 'All hours, including at night (separate confirmation follows)', value: 'all-hours' }];
    if (c.daytimeDischarge) choices.unshift({ name: 'Only my existing daytime window', value: 'daytime' });
    const delivery = await p.choose('When may informational health notices be delivered?', choices);
    if (!['all-hours', 'daytime'].includes(delivery) || (delivery === 'daytime' && !c.daytimeDischarge)) {
      throw new SafeError('data_health_config_invalid');
    }
    if (delivery === 'all-hours' && !await p.confirm('I accept informational health notices including at night. This does not authorize overnight EV charging.', false)) {
      throw new SafeError('health_setup_not_confirmed');
    }
    c.dataHealth = { enabled: true, warnAfterMinutes, delivery: delivery as 'all-hours' | 'daytime',
      ...(delivery === 'all-hours' ? { allHoursConfirmed: true } : {}) };
    validateConfig(c);
    p.print('Activation or a changed health policy starts a full startup grace. Recovery needs two distinct fresh readings and recorded acceptance of the earlier delay notice.');
    if (delivery === 'daytime') p.print('Health shares the existing timezone/hour boundaries. Changing that window also changes discharge filtering; its discharge duration is separate. Expired overnight notices are not replayed in the morning.');
  } else {
    delete c.dataHealth;
    p.print('Health-only cleanup occurs on a scheduled run after deployment while monitoring is enabled. Keep the health-aware version until cleanup is verified before rolling back.');
  }
  p.print(healthPreferencesText(c));
  p.print('Local configuration does not verify deployment, scheduled operation or message receipt. Apply manually with npm run deploy; production CPU remains unmeasured. No health or reserve threshold has been selected for you.');
  if (!await p.confirm('Save these health preferences locally? Deployment remains manual.', false)) {
    throw new SafeError('health_setup_not_confirmed');
  }
  return c;
}
