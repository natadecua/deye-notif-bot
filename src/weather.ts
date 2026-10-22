import type { Config, Dependencies } from './types.ts';
import { SafeError } from './errors.ts';
import { retryTime } from './http.ts';

const HOUR = 3600_000;
const unavailable = 'Weather forecast unavailable. Battery alert uses measured readings.';
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const time = (n: unknown): n is number => finite(n) && n >= 0 && n <= 8.64e15;

export interface WeatherHour { at: number; cloudCover: number; radiation: number }
export interface WeatherCache {
  context: string; attemptedAt: number; nextAttemptAt: number;
  fetchedAt?: number; hours?: WeatherHour[];
}
export function validateWeather(value: unknown): void {
  if (value === undefined) return;
  const p = object(value);
  if (!p || typeof p.enabled !== 'boolean' ||
      (p.latitude !== undefined && (!finite(p.latitude) || p.latitude < -90 || p.latitude > 90)) ||
      (p.longitude !== undefined && (!finite(p.longitude) || p.longitude < -180 || p.longitude > 180)) ||
      (p.nonCommercialConfirmed !== undefined && typeof p.nonCommercialConfirmed !== 'boolean') ||
      (p.enabled && (p.latitude === undefined || p.longitude === undefined || p.nonCommercialConfirmed !== true))) {
    throw new SafeError('weather_config_invalid');
  }
}
function context(c: Config): string { return JSON.stringify([c.weather?.latitude, c.weather?.longitude]); }
function validHours(value: unknown): value is WeatherHour[] {
  return Array.isArray(value) && value.length >= 3 && value.length <= 6 && value.every((raw: unknown, i: number) => {
    const h = object(raw);
    return !!h && time(h.at) && h.at % HOUR === 0 && finite(h.cloudCover) && h.cloudCover >= 0 && h.cloudCover <= 100 &&
      finite(h.radiation) && h.radiation >= 0 && h.radiation <= 2000 &&
      (i === 0 || h.at === value[i - 1].at + HOUR);
  });
}
function decodeCache(raw: unknown, c: Config): WeatherCache | undefined {
  const v = object(raw);
  if (!v || v.context !== context(c) || !time(v.attemptedAt) || !time(v.nextAttemptAt) ||
      v.nextAttemptAt < v.attemptedAt + HOUR) return undefined;
  const cache: WeatherCache = { context: v.context as string, attemptedAt: v.attemptedAt, nextAttemptAt: v.nextAttemptAt };
  if (time(v.fetchedAt) && v.fetchedAt >= v.attemptedAt && validHours(v.hours)) {
    cache.fetchedAt = v.fetchedAt; cache.hours = v.hours;
  }
  return cache;
}
export function prepareWeather(c: Config, raw: unknown, now: number): { cache?: WeatherCache; refresh: boolean } {
  if (!c.weather?.enabled) return { refresh: false };
  const cached = decodeCache(raw, c);
  if (cached && now < cached.nextAttemptAt) return { cache: cached, refresh: false };
  return { cache: { context: context(c), attemptedAt: now, nextAttemptAt: now + HOUR }, refresh: true };
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SafeError('weather_response_invalid');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new SafeError('weather_response_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function fetchWeather(cache: WeatherCache, c: Config, deps: Dependencies): Promise<WeatherCache> {
  if (!c.weather?.enabled) return cache;
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(c.weather.latitude), longitude: String(c.weather.longitude),
      hourly: 'cloud_cover,shortwave_radiation', forecast_hours: '6', timeformat: 'unixtime', timezone: 'UTC' }).toString();
    const response = await deps.fetch(url.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      const retryAt = retryTime(response.headers.get('Retry-After'), deps.now());
      await response.body?.cancel();
      return { ...cache, nextAttemptAt: time(retryAt) ? Math.max(cache.nextAttemptAt, retryAt) : cache.nextAttemptAt };
    }
    const raw = object(await boundedJson(response)), units = object(raw?.hourly_units), hourly = object(raw?.hourly);
    const times = hourly?.time, clouds = hourly?.cloud_cover, radiation = hourly?.shortwave_radiation;
    if (units?.time !== 'unixtime' || units.cloud_cover !== '%' || units.shortwave_radiation !== 'W/m²' ||
        !Array.isArray(times) || !Array.isArray(clouds) || !Array.isArray(radiation) ||
        times.length !== clouds.length || times.length !== radiation.length) return cache;
    const hours = times.map((at: unknown, i: number) => ({ at: typeof at === 'number' ? at * 1000 : NaN,
      cloudCover: clouds[i], radiation: radiation[i] }));
    if (!validHours(hours)) return cache;
    return { ...cache, fetchedAt: deps.now(), hours };
  } catch {
    // Optional-provider errors, request URLs and raw bodies never escape to logs.
    return cache;
  }
}
function forecastText(cache: WeatherCache | undefined, now: number, fallback: string): string {
  if (!cache?.hours || cache.fetchedAt === undefined || now < cache.fetchedAt || now - cache.fetchedAt >= HOUR) return fallback;
  const future = cache.hours.filter(h => h.at > now && h.at <= now + 3 * HOUR).slice(0, 3);
  if (future.length !== 3) return fallback;
  const utc = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return 'Weather forecast — next 3 hourly times:\n' +
    future.map(h => `${utc(h.at)}: cloud ${Math.round(h.cloudCover)}%, radiation ${Math.round(h.radiation)} W/m²`).join('\n') +
    `\nRounded forecasts; radiation is a previous-hour average, not measured PV or guaranteed charging power.\nRetrieved: ${utc(cache.fetchedAt)}\nWeather data: Open-Meteo — https://open-meteo.com/\nCC BY 4.0: https://creativecommons.org/licenses/by/4.0/`;
}
export function weatherText(raw: unknown, c: Config, now: number): string {
  return c.weather?.enabled ? forecastText(decodeCache(raw, c), now, unavailable) : '';
}
export function weatherStatusText(raw: unknown, c: Config, now: number): string {
  if (!c.weather?.enabled) return '';
  const cache = decodeCache(raw, c);
  const age = cache?.fetchedAt !== undefined && now >= cache.fetchedAt ? now - cache.fetchedAt : undefined;
  const freshness = age === undefined ? 'Forecast cache freshness: unavailable.' :
    `Forecast cache age: ${Math.floor(age / 1000)} seconds (${age < HOUR ? 'within the 1-hour freshness limit' : 'stale — do not treat this as current'}).`;
  return `🌤 Cached weather\n${freshness}\n` + forecastText(cache, now,
    'Weather forecast unavailable. An eligible scheduled discharge notification can refresh it; /status never requests weather.');
}
