import type { Config } from '../src/types.ts';
import type { PreferencePrompts } from './preferences.ts';
import { SafeError } from '../src/errors.ts';
import { validateConfig } from '../src/config.ts';

export async function configureWeather(source: Config, p: PreferencePrompts): Promise<Config> {
  const c = structuredClone(validateConfig(source));
  if (!await p.confirm('Add optional Open-Meteo forecast context to discharge alerts?', c.weather?.enabled ?? false)) {
    c.weather = { ...c.weather, enabled: false };
    p.print('Weather context is off. Battery alert rules are unchanged.');
    return c;
  }
  p.print('Open-Meteo free access is for eligible non-commercial uses, including personal home automation: https://open-meteo.com/en/terms\nThe forecast uses your approximate location and includes Open-Meteo attribution.');
  if (!await p.confirm('This installation qualifies for the free non-commercial API?', c.weather?.nonCommercialConfirmed ?? false)) {
    throw new SafeError('weather_eligibility_not_confirmed');
  }
  const latitude = await p.number('Approximate installation latitude (-90 to 90; city-level is sufficient):', c.weather?.latitude,
    n => Number.isFinite(n) && n >= -90 && n <= 90 || 'Enter a finite latitude from -90 to 90.');
  const longitude = await p.number('Approximate installation longitude (-180 to 180):', c.weather?.longitude,
    n => Number.isFinite(n) && n >= -180 && n <= 180 || 'Enter a finite longitude from -180 to 180.');
  c.weather = { enabled: true, nonCommercialConfirmed: true, latitude, longitude };
  validateConfig(c);
  p.print('Open-Meteo context: three future hourly cloud/radiation forecasts; refresh at most hourly when a discharge alert needs it.\nForecast failures do not stop measured battery alerts. This does not detect EV charging or plan an overnight exception.');
  if (!await p.confirm('Save weather preferences locally? Deployment remains a separate manual step.', false)) {
    throw new SafeError('weather_setup_not_confirmed');
  }
  return c;
}
