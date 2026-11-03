import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWeather, fetchWeather, weatherText } from '../src/weather.ts';
import { validateConfig } from '../src/config.ts';
import { runMonitor } from '../src/monitor.ts';
import { config, harness, json } from './helpers.ts';

// Entirely synthetic location, timestamps, provider forecasts and services.
const now = Date.parse('2026-10-22T02:15:00Z');
const weather = { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true };
const configured = () => ({ ...config(), weather: { ...weather } });
function forecast() {
  const start = Math.floor(now / 3600_000) * 3600;
  return { hourly_units: { time: 'unixtime', cloud_cover: '%', shortwave_radiation: 'W/m²' },
    hourly: { time: Array.from({ length: 6 }, (_, n) => start + n * 3600),
      cloud_cover: [50, 40, 30, 20, 10, 0], shortwave_radiation: [100, 200, 300, 400, 500, 600] } };
}
function services() {
  const h = harness(configured()); h.clock.time = now;
  h.hook(url => url.startsWith('https://api.open-meteo.com/') ? json(forecast()) : undefined);
  return h;
}
function dueAlert(h: ReturnType<typeof services>, kind: 'full' | 'discharge' = 'discharge') {
  h.reading(kind === 'full' ? 100 : 80, 500); return runMonitor(h.env, h.deps);
}

test('weather config requires explicit valid coordinates and free-tier eligibility', () => {
  validateConfig(configured());
  for (const value of [null, [], {}, { enabled: 'true' }, { ...weather, latitude: null },
    { ...weather, latitude: 91 }, { ...weather, longitude: -181 }, { ...weather, latitude: NaN },
    { ...weather, nonCommercialConfirmed: false }, { enabled: true }]) {
    assert.throws(() => validateConfig({ ...config(), weather: value }), /weather_config_invalid/);
  }
});

test('weather prepares a persisted one-hour attempt guard before any optional request', () => {
  const p = prepareWeather(configured(), undefined, now);
  assert.equal(p.refresh, true);
  assert.equal(p.cache!.attemptedAt, now); assert.equal(p.cache!.nextAttemptAt, now + 3600_000);
  assert.equal(prepareWeather(configured(), p.cache, now + 300_000).refresh, false);
  assert.equal(prepareWeather(configured(), p.cache, now + 3600_000).refresh, true);
  assert.equal(prepareWeather(config(), undefined, now).refresh, false);
});

test('weather fetch is one bounded fixed-host GET with UTC epochs and verified units', async () => {
  const h = services(), c = configured(), p = prepareWeather(c, undefined, now);
  const cached = await fetchWeather(p.cache!, c, h.deps);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0], url = new URL(call.url);
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('hourly'), 'cloud_cover,shortwave_radiation');
  assert.equal(url.searchParams.get('forecast_hours'), '6');
  assert.equal(call.init?.redirect, 'manual'); assert.equal(call.init?.method, 'GET');
  assert(call.init?.signal); assert.equal(cached.fetchedAt, now);
  const text = weatherText(cached, c, now);
  assert.match(text, /Weather forecast/); assert.match(text, /Open-Meteo/);
  assert.match(text, /2026-10-22 03:00 UTC: cloud 40%, radiation 200 W\/m²/);
  assert.match(text, /previous-hour average/); assert.match(text, /not measured PV/i);
  assert.match(text, /https:\/\/open-meteo.com\//);
  assert.match(text, /https:\/\/creativecommons.org\/licenses\/by\/4.0\//);
  assert.match(text, /Rounded forecasts/);
  assert.doesNotMatch(text, /latitude|longitude|EV detected|charge at|clear in/i);
});

test('stale, future-dated and wrong-location cached weather is never presented as current', async () => {
  const h = services(), c = configured();
  const cached = await fetchWeather(prepareWeather(c, undefined, now).cache!, c, h.deps);
  for (const time of [now - 1, now + 3600_000]) assert.match(weatherText(cached, c, time), /unavailable/i);
  const changed = { ...c, weather: { ...weather, longitude: 21 } };
  assert.match(weatherText(cached, changed, now), /unavailable/i);
  assert.equal(prepareWeather(changed, cached, now).refresh, true);
  assert.match(weatherText({ context: 'synthetic-bad', hours: 'invalid' }, c, now), /unavailable/i);
});

test('malformed units, missing values, duplicate times and invalid ranges reject the whole optional forecast', async () => {
  for (const change of [
    (f: ReturnType<typeof forecast>) => { f.hourly_units.shortwave_radiation = 'kW'; },
    (f: ReturnType<typeof forecast>) => { f.hourly.cloud_cover[1] = 101; },
    (f: ReturnType<typeof forecast>) => { f.hourly.shortwave_radiation[1] = -1; },
    (f: ReturnType<typeof forecast>) => { f.hourly.time[1] = f.hourly.time[0]; },
    (f: ReturnType<typeof forecast>) => { f.hourly.cloud_cover.pop(); },
  ]) {
    const h = services(), c = configured(), f = forecast(); change(f);
    h.hook(url => url.startsWith('https://api.open-meteo.com/') ? json(f) : undefined);
    const cached = await fetchWeather(prepareWeather(c, undefined, now).cache!, c, h.deps);
    assert.equal(h.calls.length, 1); assert.equal(cached.fetchedAt, undefined);
    assert.match(weatherText(cached, c, now), /unavailable/i);
  }
});

test('weather failures, oversized bodies and redirects do not escape or trigger immediate retries', async () => {
  for (const response of [new Response('synthetic upstream private text', { status: 503 }),
    new Response('x'.repeat(20_000)), new Response('', { status: 302, headers: { Location: 'https://synthetic.invalid/' } })]) {
    const h = services(), c = configured();
    h.hook(url => url.startsWith('https://api.open-meteo.com/') ? response : undefined);
    const cached = await fetchWeather(prepareWeather(c, undefined, now).cache!, c, h.deps);
    assert.equal(h.calls.length, 1); assert.equal(cached.fetchedAt, undefined);
    assert.equal(prepareWeather(c, cached, now + 300_000).refresh, false);
    assert.match(weatherText(cached, c, now), /unavailable/i);
    assert.doesNotMatch(weatherText(cached, c, now), /synthetic upstream|synthetic.invalid/);
  }
});

test('weather Retry-After is honored by later attempts instead of bounded immediate retry', async () => {
  const h = services(), c = configured();
  h.hook(url => url.startsWith('https://api.open-meteo.com/') ? json({}, 429, { 'Retry-After': '7200' }) : undefined);
  const cached = await fetchWeather(prepareWeather(c, undefined, now).cache!, c, h.deps);
  assert.equal(cached.nextAttemptAt, now + 7200_000);
  assert.equal(prepareWeather(c, cached, now + 3600_000).refresh, false);
});

test('measured alerts persist the weather guard first and share their existing result checkpoint', async () => {
  const h = services(); let guarded = false;
  h.hook(url => {
    if (!url.startsWith('https://api.open-meteo.com/')) return undefined;
    const s = JSON.parse(h.kv.data.get('monitor:v1')!);
    guarded = s.weather?.nextAttemptAt >= h.clock.time + 3599_000;
    return json(forecast());
  });
  await dueAlert(h); h.advance(); await dueAlert(h);
  assert.equal(guarded, true); assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Weather forecast/);
  assert.equal(h.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 1);
  assert(h.kv.puts.every(p => p.key !== 'weather:v1'));
  assert.equal(h.kv.puts.filter(p => p.key === 'monitor:v1').length, 3);
  const s = JSON.parse(h.kv.data.get('monitor:v1')!);
  assert(s.weather.fetchedAt); assert.equal(s.pending.length, 0);
});

test('weather remains optional when unavailable or throwing and never changes Deye backoff', async () => {
  for (const throws of [false, true]) {
    const h = services();
    h.hook(url => {
      if (!url.startsWith('https://api.open-meteo.com/')) return undefined;
      if (throws) throw new Error('Synthetic private fetch exception');
      return json({}, 503);
    });
    await dueAlert(h); h.advance(); await dueAlert(h);
    assert.equal(h.sent.length, 1); assert.match(h.sent[0], /Weather forecast unavailable/);
    assert.doesNotMatch(h.sent[0], /Synthetic private/);
    assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).apiRetryAt, 0);
  }
});

test('weather is never requested when the shared first checkpoint fails', async () => {
  const h = services(); await dueAlert(h); h.advance();
  h.kv.failOnPut = key => key === 'monitor:v1';
  await assert.rejects(dueAlert(h));
  assert.equal(h.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 0);
  assert.equal(h.sent.length, 0);
});

test('a second discharge cycle reuses weather while corrupt optional cache cannot stop battery alerts', async () => {
  const h = services(); await dueAlert(h); h.advance(); await dueAlert(h);
  h.advance(); h.reading(80, 0); await runMonitor(h.env, h.deps);
  h.advance(); await dueAlert(h); h.advance(); await dueAlert(h);
  assert.equal(h.sent.length, 2);
  assert.equal(h.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 1);
  const s = JSON.parse(h.kv.data.get('monitor:v1')!); s.weather = 'synthetic corrupt optional cache';
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  h.advance(); h.reading(80, 0); await runMonitor(h.env, h.deps);
  h.advance(); await dueAlert(h); h.advance(); await dueAlert(h);
  assert.equal(h.sent.length, 3);
});

test('a weather wait crossing the daytime boundary cannot send an after-hours alert', async () => {
  const h = services();
  h.env.MONITOR_CONFIG = { ...configured(),
    daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } };
  h.clock.time = Date.parse('2026-10-22T09:44:00Z');
  h.hook(url => {
    if (!url.startsWith('https://api.open-meteo.com/')) return undefined;
    h.advance(60_000); return json({}, 503);
  });
  for (let i = 0; i < 4; i++) { await dueAlert(h); h.advance(); }
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).pending.length, 0);
});

test('full, muted and nighttime-ineligible alerts add no weather request', async () => {
  const full = services(); await dueAlert(full, 'full');
  assert.equal(full.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 0);
  const muted = services(); muted.env.MONITOR_CONFIG = { ...configured(), notifications: { full: true, discharge: false } };
  await dueAlert(muted); muted.advance(); await dueAlert(muted);
  assert.equal(muted.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 0);
  const night = services(); night.env.MONITOR_CONFIG = { ...configured(),
    daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } };
  night.clock.time = Date.parse('2026-10-22T12:00:00Z');
  for (let n = 0; n < 4; n++) { await dueAlert(night); night.advance(); }
  assert.equal(night.calls.filter(c => c.url.startsWith('https://api.open-meteo.com/')).length, 0);
});
