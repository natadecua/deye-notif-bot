import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramRequest } from '../src/bot.ts';
import { runMonitor } from '../src/monitor.ts';
import { validateConfig } from '../src/config.ts';
import { BASE_TIME, config, harness, json } from './helpers.ts';
import { initialState } from '../src/alerts.ts';
import { sha256 } from '../src/deye.ts';

// Entirely synthetic installation, sender/chat identifiers, token and webhook secret.
const secret = 'synthetic-webhook-secret-1234567890';
function setup() {
  const h = harness(config({ telegram: { enabled: true } } as never));
  const env = { ...h.env, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' };
  h.hook(url => url.endsWith('/answerCallbackQuery') ? json({ ok: true }) : undefined);
  function message(text: string, id = 1) {
    return { update_id: id, message: { message_id: id, date: Math.floor(h.clock.time / 1000),
      from: { id: 789 }, chat: { id: 456 }, text } };
  }
  function request(body: unknown, header = secret, path = '/telegram/webhook') {
    return new Request(`https://synthetic.invalid${path}`, { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': header, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  const send = (body: unknown) => handleTelegramRequest(request(body), env, h.deps);
  return { ...h, env, message, request, send };
}
const botState = (h: ReturnType<typeof setup>) => JSON.parse(h.kv.data.get('telegram:v1')!);

test('authorized cached status/settings expose independent health preferences without advancing health or polling', async () => {
  for (const command of ['/status', '/settings']) {
    const h = setup();
    h.env.MONITOR_CONFIG = config({ telegram: { enabled: true }, notifications: { full: false, discharge: false },
      dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
    const state = { ...initialState(validateConfig(h.env.MONITOR_CONFIG)), dataHealth: { syntheticPrivate: 'synthetic-sensitive-state' },
      apiRetryAt: h.clock.time + 60_000 };
    const before = JSON.stringify(state); h.kv.data.set('monitor:v1', before);
    const reads: string[] = [], get = h.kv.get.bind(h.kv);
    h.kv.get = async key => { reads.push(key); return get(key); };
    assert.equal((await h.send(h.message(command))).status, 200);
    assert.match(h.sent[0], /Health notices: on.*30 minutes/);
    assert.match(h.sent[0], /including at night/);
    assert.match(h.sent[0], /independent of battery notification switches/i);
    assert.match(h.sent[0], /does not verify.*receipt/i);
    assert.doesNotMatch(h.sent[0], /synthetic-sensitive-state|staleAcknowledged|stationId/);
    assert.equal(h.kv.data.get('monitor:v1'), before);
    assert.deepEqual(reads, command === '/status' ? ['telegram:v1', 'monitor:v1'] : ['telegram:v1']);
    assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
    assert.equal(h.calls.length, 1); assert(h.calls[0].url.endsWith('/sendMessage'));
  }
});
test('cached health visibility reports off and paused configuration without live-readiness claims', async () => {
  for (const enabled of [true, false]) {
    const h = setup();
    if (!enabled) h.env.MONITOR_CONFIG = config({ enabled: false, telegram: { enabled: true },
      dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
    await h.send(h.message('/status'));
    assert.match(h.sent[0], enabled ? /Health notices: off/ : /paused.*monitoring is disabled/);
    assert.equal(h.kv.data.has('monitor:v1'), false);
  }
});

test('commands are opt-in and all unrelated HTTP routes remain unavailable', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(h.request(h.message('/status')), { ...h.env, MONITOR_CONFIG: config() }, h.deps)).status, 404);
  assert.equal((await handleTelegramRequest(h.request({}, secret, '/'), h.env, h.deps)).status, 404);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});
test('webhook authenticates secret, chat and sender before any API call or write', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(h.request(h.message('/status'), 'synthetic-wrong'), h.env, h.deps)).status, 403);
  for (const field of ['from', 'chat'] as const) {
    const update = h.message('/charging'); update.message[field].id = 999;
    assert.equal((await h.send(update)).status, 403);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});
test('/help and /start explain supported commands and manual charging evidence', async () => {
  for (const command of ['/help', '/start']) {
    const h = setup(); assert.equal((await h.send(h.message(command))).status, 200);
    assert.match(h.sent[0], /\/status/); assert.match(h.sent[0], /\/charging/);
    assert.match(h.sent[0], /\/stopped/); assert.match(h.sent[0], /manual/i);
  }
});
test('/status uses cached telemetry, labels its age and never polls Deye or changes battery latches', async () => {
  const h = setup(); h.reading(82, 800); await runMonitor(h.env, h.deps);
  const before = h.kv.data.get('monitor:v1'); h.calls.length = 0; h.sent.length = 0;
  assert.equal((await h.send(h.message('/status'))).status, 200);
  assert.match(h.sent[0], /82%/); assert.match(h.sent[0], /800 W/);
  assert.match(h.sent[0], /Reading:/); assert.match(h.sent[0], /age/i);
  assert.match(h.sent[0], /EV charging: unknown/i);
  assert.match(h.sent[0], /Battery discharge: 800 W/);
  assert.match(h.sent[0], /Load breakdown: unknown/);
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
});
test('/status explains absent and stale readings instead of presenting them as live', async () => {
  const missing = setup(); await missing.send(missing.message('/status'));
  assert.match(missing.sent[0], /No cached reading/i);
  const stale = setup(); stale.reading(80, 0); await runMonitor(stale.env, stale.deps);
  stale.advance(700_000); await stale.send(stale.message('/status'));
  assert.match(stale.sent[0], /stale/i);
});

// Synthetic monitor snapshots: status must describe these without running a poll.
async function healthStatus(options: { readingAge?: number; retryIn?: number; retryAt?: number; enabled?: boolean; local?: boolean } = {}) {
  const h = setup(), c = config({ telegram: { enabled: true }, enabled: options.enabled ?? true,
    ...(options.local ? { daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } } : {}) });
  h.env.MONITOR_CONFIG = c;
  const s = initialState(c);
  if (options.readingAge !== undefined) {
    s.lastReadingAt = h.clock.time - options.readingAge;
    s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 315 };
  }
  s.apiFailures = options.retryIn !== undefined || options.retryAt !== undefined ? 2 : 0;
  s.apiRetryAt = options.retryAt ?? (options.retryIn !== undefined ? h.clock.time + options.retryIn : 0);
  // Unknown raw fields must never become a health explanation or public text.
  const raw = JSON.stringify({ ...s, lastError: 'synthetic-private-exception',
    upstreamBody: 'synthetic-private-body', url: 'https://synthetic.invalid/?secret=synthetic-private-url' });
  h.kv.data.set('monitor:v1', raw);
  const reads: string[] = [], get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  const response = await h.send(h.message('/status'));
  assert.equal(response.status, 200);
  assert.deepEqual(reads, ['telegram:v1', 'monitor:v1']);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
  assert.equal(h.kv.data.get('monitor:v1'), raw);
  assert.equal(h.calls.length, 1); assert(h.calls[0].url.endsWith('/sendMessage'));
  assert.doesNotMatch(h.sent[0], /synthetic-private|synthetic\.invalid|apiFailures|apiRetryAt/);
  return h;
}

test('cached update status distinguishes waiting for a reading from a recorded cooldown', async () => {
  const waiting = await healthStatus();
  assert.match(waiting.sent[0], /Waiting for a cached reading/);
  assert.match(waiting.sent[0], /not a live connection check/);
  const delayed = await healthStatus({ retryIn: 300_000 });
  assert.match(delayed.sent[0], /No cached reading/);
  assert.match(delayed.sent[0], /Data updates: retry cooldown/);
  assert.match(delayed.sent[0], /Next attempt allowed after: 2026-10-21 12:05:00 UTC/);
  assert.match(delayed.sent[0], /Reason is not recorded/);
  assert.doesNotMatch(delayed.sent[0], /connected|healthy|credentials rejected|service down/i);
});

test('cached update status preserves fresh battery data while showing an independent retry delay', async () => {
  const h = await healthStatus({ readingAge: 60_000, retryIn: 300_000 });
  assert.match(h.sent[0], /Charge: 82%/); assert.match(h.sent[0], /Data age: 60 seconds/);
  assert.match(h.sent[0], /within the configured freshness limit/);
  assert.match(h.sent[0], /Data updates: retry cooldown/);
  assert.match(h.sent[0], /scheduled poll may try again/i);
});

test('an elapsed retry threshold remains cached history rather than proof of recovery', async () => {
  for (const retryIn of [-1, 0]) {
    const h = await healthStatus({ readingAge: 700_000, retryIn });
    assert.match(h.sent[0], /Retry delay has elapsed/);
    assert.match(h.sent[0], /stale — do not treat this as current/);
    assert.doesNotMatch(h.sent[0], /Next attempt allowed after|recovered|connected|healthy/i);
  }
});

test('a cached reading with no recorded retry delay does not claim a healthy live connection', async () => {
  const h = await healthStatus({ readingAge: 700_000 });
  assert.match(h.sent[0], /No retry delay is recorded/);
  assert.match(h.sent[0], /not a live connection check/);
  assert.match(h.sent[0], /stale — do not treat this as current/);
});

test('disabled monitoring takes precedence over old cooldowns even without a cached reading', async () => {
  for (const readingAge of [undefined, 60_000]) {
    const h = await healthStatus({ enabled: false, readingAge, retryIn: 300_000 });
    assert.match(h.sent[0], /Scheduled monitoring is disabled/);
    assert.doesNotMatch(h.sent[0], /Next attempt allowed after|scheduled poll may try again|Wait for a successful scheduled poll/i);
    if (readingAge !== undefined) assert.match(h.sent[0], /82%/);
  }
});

test('retry eligibility uses explicit local time without changing the actual retry threshold', async () => {
  const h = await healthStatus({ local: true, retryIn: 300_000 });
  assert.match(h.sent[0], /Next attempt allowed after: 2026-10-21 20:05:00 Asia\/Manila \(UTC\+08:00\)/);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).apiRetryAt, BASE_TIME + 300_000);
});

test('an unrenderable retry date never hides cached battery data or reflects its raw value', async () => {
  const h = await healthStatus({ readingAge: 60_000, retryAt: 1e100 });
  assert.match(h.sent[0], /Charge: 82%/); assert.match(h.sent[0], /Retry time is unavailable/);
  assert.doesNotMatch(h.sent[0], /1e\+100|Invalid Date/);
});

test('a later accepted scheduled reading clears the recorded cooldown without status doing so', async () => {
  const h = await healthStatus({ retryIn: 300_000 });
  h.advance(300_000); h.reading(81, 0); await runMonitor(h.env, h.deps);
  const stored = h.kv.data.get('monitor:v1'); h.calls.length = 0;
  h.advance(3000); await h.send(h.message('/status', 2));
  assert.match(h.sent.at(-1)!, /81%/); assert.match(h.sent.at(-1)!, /No retry delay is recorded/);
  assert.equal(h.kv.data.get('monitor:v1'), stored);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
});

test('authorized status and charging replies use configured local time without changing cache, age or expiry', async () => {
  const h = setup();
  const c = config({ telegram: { enabled: true }, daytimeDischarge: {
    timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15,
  } });
  h.env.MONITOR_CONFIG = c; h.clock.time = Date.parse('2026-10-22T16:00:01Z');
  const s = initialState(c); s.lastReadingAt = h.clock.time - 60_000;
  s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 315 };
  const before = JSON.stringify(s); h.kv.data.set('monitor:v1', before);
  await h.send(h.message('/charging'));
  assert.match(h.sent[0], /expires 2026-10-23 06:00:01 Asia\/Manila \(UTC\+08:00\)/);
  const expiry = botState(h).session.expiresAt; h.advance(3000); h.calls.length = 0;
  await h.send(h.message('/status', 2));
  assert.match(h.sent.at(-1)!, /Reading: 2026-10-22 23:59:01 Asia\/Manila \(UTC\+08:00\)/);
  assert.match(h.sent.at(-1)!, /Data age: 63 seconds/);
  assert.equal(botState(h).session.expiresAt, expiry); assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
  h.advance(700_000); await h.send(h.message('/status', 3));
  assert.match(h.sent.at(-1)!, /stale — do not treat this as current/);
  assert.equal(h.kv.data.get('monitor:v1'), before);
});

test('a local midnight does not reset the UTC command budget', async () => {
  const h = setup(); h.env.MONITOR_CONFIG = config({ telegram: { enabled: true }, daytimeDischarge: {
    timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15,
  } });
  h.clock.time = Date.parse('2026-10-22T15:59:58Z');
  await h.send(h.message('/charging'));
  const saved = botState(h); saved.used = 47; h.kv.data.set('telegram:v1', JSON.stringify(saved));
  h.advance(3000); await h.send(h.message('/help', 2));
  assert.match(h.sent.at(-1)!, /Daily command limit reached.*00:00 UTC/);
  assert.equal(botState(h).used, 48); assert.equal(botState(h).day, '2026-10-22');
});

// Synthetic coordinates and hourly forecast; no owner location or live provider calls.
function cachedWeather(h: ReturnType<typeof setup>, battery = true) {
  const c = config({ telegram: { enabled: true },
    weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
  h.env.MONITOR_CONFIG = c;
  const s = initialState(c), fetchedAt = h.clock.time - 150_000;
  if (battery) {
    s.lastReadingAt = h.clock.time - 60_000;
    s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 800 };
  }
  s.weather = { context: '[10,20]', attemptedAt: fetchedAt, fetchedAt, nextAttemptAt: fetchedAt + 3600_000,
    hours: Array.from({ length: 6 }, (_, i) => ({ at: BASE_TIME + (i + 1) * 3600_000, cloudCover: 40, radiation: 200 })) };
  return s;
}

test('/status shows independently aged cached weather without provider calls or extra KV operations', async () => {
  const h = setup(), s = cachedWeather(h);
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  const before = h.kv.data.get('monitor:v1'), reads: string[] = [];
  const get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  await h.send(h.message('/status'));
  const text = h.sent[0];
  assert.match(text, /82%/); assert.match(text, /Data age: 60 seconds/);
  assert.match(text, /Cached weather/); assert.match(text, /Forecast cache age: 150 seconds \(within the 1-hour freshness limit\)/);
  assert.match(text, /cloud 40%, radiation 200 W\/m²/);
  assert.match(text, /Retrieved: 2026-10-21 11:57 UTC/);
  assert.match(text, /Weather data: Open-Meteo/); assert.match(text, /CC BY 4\.0/);
  assert.match(text, /not measured PV or guaranteed charging power/);
  assert.match(text, /EV charging: unknown/);
  assert.doesNotMatch(text, /\[10,20\]|latitude|longitude|nextAttemptAt|attemptedAt/);
  assert.deepEqual(reads, ['telegram:v1', 'monitor:v1']);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert.equal(h.calls.length, 1); assert(h.calls[0].url.endsWith('/sendMessage'));
});

test('/status can show usable cached weather before the first battery reading', async () => {
  const h = setup(), s = cachedWeather(h, false);
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  await h.send(h.message('/status'));
  assert.match(h.sent[0], /No cached reading/);
  assert.match(h.sent[0], /cloud 40%, radiation 200 W\/m²/);
  assert.match(h.sent[0], /Forecast cache age: 150 seconds/);
});

for (const reason of ['missing', 'failed', 'stale', 'future', 'location', 'corrupt', 'coverage'] as const) {
  test(`/status labels ${reason} weather unavailable without hiding battery data or refreshing it`, async () => {
    const h = setup(), s = cachedWeather(h), cache = s.weather as {
      context: string; attemptedAt: number; fetchedAt?: number; nextAttemptAt: number;
      hours?: { at: number; cloudCover: number; radiation: number }[];
    };
    if (reason === 'missing') delete s.weather;
    if (reason === 'failed') { delete cache.fetchedAt; delete cache.hours; }
    if (reason === 'stale') { cache.fetchedAt = cache.attemptedAt = h.clock.time - 3600_000; cache.nextAttemptAt = h.clock.time; }
    if (reason === 'future') { cache.fetchedAt = cache.attemptedAt = h.clock.time + 1; cache.nextAttemptAt = h.clock.time + 3600_001; }
    if (reason === 'location') cache.context = '[30,40]';
    if (reason === 'corrupt') cache.hours![0].cloudCover = 101;
    if (reason === 'coverage') cache.hours!.forEach(hour => { hour.at -= 12 * 3600_000; });
    h.kv.data.set('monitor:v1', JSON.stringify(s)); const before = h.kv.data.get('monitor:v1');
    await h.send(h.message('/status'));
    assert.match(h.sent[0], /82%/);
    assert.match(h.sent[0], /Weather forecast unavailable/);
    assert.match(h.sent[0], /eligible scheduled discharge notification/);
    assert.doesNotMatch(h.sent[0], /cloud \d|radiation \d|Battery alert uses|\[30,40\]/);
    if (reason === 'stale') assert.match(h.sent[0], /Forecast cache age: 3600 seconds \(stale/);
    if (['missing', 'failed', 'future', 'location', 'corrupt'].includes(reason)) assert.match(h.sent[0], /Forecast cache freshness: unavailable/);
    assert.equal(h.kv.data.get('monitor:v1'), before);
    assert.equal(h.calls.length, 1); assert(h.calls[0].url.endsWith('/sendMessage'));
  });
}

test('/status omits stored forecast context when weather is disabled', async () => {
  const h = setup(), s = cachedWeather(h);
  h.env.MONITOR_CONFIG = { ...validateConfig(h.env.MONITOR_CONFIG), weather: { enabled: false } };
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  await h.send(h.message('/status'));
  assert.match(h.sent[0], /82%/); assert.doesNotMatch(h.sent[0], /weather|forecast|Open-Meteo/i);
});

test('unauthorized status cannot read the battery/weather cache or call any provider', async () => {
  const h = setup(); let reads = 0;
  h.kv.get = async () => { reads++; throw new Error('Synthetic unauthorized state access'); };
  assert.equal((await handleTelegramRequest(h.request(h.message('/status'), 'synthetic-wrong'), h.env, h.deps)).status, 403);
  for (const field of ['from', 'chat'] as const) {
    const update = h.message('/status'); update.message[field].id = 999;
    assert.equal((await h.send(update)).status, 403);
  }
  assert.equal(reads, 0); assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});

test('/status shows configured 8 A, 13 A and MAX reference levels without classifying a 315 W load as house-only', async () => {
  // Synthetic, explicitly confirmed 230 V single-phase profiles; MAX is owner-entered.
  const h = setup();
  const c = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
    phases: 1, voltage: 230, minimumAmps: 6, profiles: [
      { id: '8a', label: '8 A', type: 'amps', amps: 8 },
      { id: '13a', label: '13 A', type: 'amps', amps: 13 },
      { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
    ] } });
  h.env.MONITOR_CONFIG = c;
  h.reading(80, 315); await runMonitor(h.env, h.deps);
  const before = h.kv.data.get('monitor:v1'); h.calls.length = 0;
  await h.send(h.message('/status'));
  const text = h.sent[0];
  assert.match(text, /Your configured settings \(nominal estimates\):\n8 A \(~1\.84 kW\)\n13 A \(~2\.99 kW\)\nMAX: ~7 kW/);
  assert.match(text, /Battery discharge does not measure EV power; solar or grid may supply part of charging demand/);
  assert.match(text, /Battery discharge: 315 W/);
  assert.match(text, /EV charging: unknown/);
  assert.doesNotMatch(text, /normal house|house.only|EV detected|32 A|30\.4 A/);
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
  h.env.MONITOR_CONFIG = { ...c, ev: { ...c.ev, enabled: false } };
  h.advance(3000); await h.send(h.message('/status', 2));
  assert.doesNotMatch(h.sent.at(-1)!, /Your configured settings|1\.84 kW|7 kW/);
});
test('/charging records an expiring manual confirmation, not measured EV status', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  assert.equal(botState(h).session.status, 'charging');
  assert.equal(botState(h).session.source, 'manual');
  assert.equal(botState(h).session.expiresAt, BASE_TIME + 6 * 3600_000);
  assert.match(h.sent[0], /you confirmed/i); assert.doesNotMatch(h.sent[0], /detected/i);
  h.advance(6 * 3600_000); await h.send(h.message('/status', 2));
  assert.match(h.sent.at(-1)!, /EV charging: unknown/i);
});
test('/stopped records the user report and does not control equipment', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  h.advance(3000); await h.send(h.message('/stopped', 2));
  assert.equal(botState(h).session.status, 'not_charging');
  assert.match(h.sent.at(-1)!, /you confirmed/i);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
});
test('confirmation buttons record manual status and acknowledge the Telegram callback', async () => {
  const h = setup();
  const response = await h.send({ update_id: 1, callback_query: { id: 'synthetic-callback', from: { id: 789 },
    message: { date: BASE_TIME / 1000, chat: { id: 456 } }, data: `charging:yes:${BASE_TIME}` } });
  assert.equal(response.status, 200); assert.equal(botState(h).session.status, 'charging');
  assert(h.calls.some(c => c.url.endsWith('/answerCallbackQuery')));
  assert.match(h.sent[0], /you confirmed/i);
});
test('old confirmation buttons do not renew or start a charging session', async () => {
  const h = setup();
  await h.send({ update_id: 1, callback_query: { id: 'synthetic-old', from: { id: 789 },
    message: { date: BASE_TIME / 1000, chat: { id: 456 } }, data: `charging:yes:${BASE_TIME - 31 * 60_000}` } });
  assert.equal(botState(h).session, undefined);
  assert.match(h.sent[0], /expired/i);
});

// Synthetic profiles and opaque callback context; none represents live EV telemetry.
function profileSetup() {
  const h = setup();
  h.env.MONITOR_CONFIG = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
    phases: 1, voltage: 230, minimumAmps: 8, profiles: [
      { id: '8a', label: '8 A', type: 'amps', amps: 8 },
      { id: '13a', label: '13 A', type: 'amps', amps: 13 },
      { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
    ] } });
  return h;
}
const lastReply = (h: ReturnType<typeof setup>) => JSON.parse(String(h.calls.filter(c => c.url.endsWith('/sendMessage')).at(-1)!.init?.body));
const profileCallback = async (h: ReturnType<typeof setup>, index = 1, at = BASE_TIME) =>
  `profile:${at}:${index}:${(await sha256(JSON.stringify(validateConfig(h.env.MONITOR_CONFIG).ev))).slice(0, 16)}`;
const buttonUpdate = (h: ReturnType<typeof setup>, data: string, id = 2) => ({ update_id: id,
  callback_query: { id: 'synthetic-profile-button', from: { id: 789 },
    message: { date: Math.floor(h.clock.time / 1000), chat: { id: 456 }, text: '/stopped' }, data } });

test('charging reports offer only configured manual profile buttons with bounded callback data', async () => {
  const h = profileSetup(); await h.send(h.message('/charging'));
  const reply = lastReply(h), buttons = reply.reply_markup?.inline_keyboard.flat();
  assert.deepEqual(buttons?.map((b: { text: string }) => b.text), ['I use 8 A', 'I use 13 A', 'I use MAX']);
  assert(buttons.every((b: { callback_data: string }) => Buffer.byteLength(b.callback_data) <= 64));
  assert.equal(buttons[1].callback_data, await profileCallback(h));
  assert.match(reply.text, /manual report/i); assert.match(reply.text, /30 minutes/);
  assert.match(reply.text, /does not.*overnight/i); assert.match(reply.text, /\/charging.*renew/i);
  assert.doesNotMatch(reply.text, /EV detected|set your charger|32 A/);
});

test('profile selection records manual evidence, preserves expiry and never polls providers or writes monitor state', async () => {
  const h = profileSetup(); await h.send(h.message('/charging'));
  const before = structuredClone(botState(h).session); h.advance(3000);
  h.kv.puts.length = 0; h.calls.length = 0;
  const reads: string[] = [], get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  await h.send(buttonUpdate(h, await profileCallback(h)));
  assert.deepEqual(botState(h).session, { ...before, profileId: '13a' });
  assert.match(h.sent.at(-1)!, /Reported profile: 13 A/);
  assert.match(h.sent.at(-1)!, /Source: manual confirmation/);
  assert.match(h.sent.at(-1)!, /not measured EV power/i);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
  assert.deepEqual(reads, ['telegram:v1']);
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname.split('/').at(-1)), ['answerCallbackQuery', 'sendMessage']);
  const count = h.calls.length, saved = h.kv.data.get('telegram:v1');
  h.advance(3000); await h.send(buttonUpdate(h, await profileCallback(h)));
  assert.equal(h.calls.length, count); assert.equal(h.kv.data.get('telegram:v1'), saved);
});

test('Yes charging callbacks and explicit profile commands also offer the configured report menu', async () => {
  for (const via of ['yes', 'command']) {
    const h = profileSetup();
    await h.send(via === 'yes' ? buttonUpdate(h, `charging:yes:${BASE_TIME}`, 1) : h.message('/charging max'));
    assert.equal(lastReply(h).reply_markup?.inline_keyboard.flat().length, 3);
    if (via === 'command') assert.match(h.sent[0], /Reported profile: MAX/);
  }
});

test('profile menus support the maximum configured list and omit buttons for disabled hints, no profiles or stopped reports', async () => {
  const many = profileSetup(), c = validateConfig(many.env.MONITOR_CONFIG);
  many.env.MONITOR_CONFIG = { ...c, ev: { ...c.ev, profiles: Array.from({ length: 12 }, (_, i) => ({
    id: `profile-${i}`, label: `Setting ${i + 1}`, type: 'amps' as const, amps: 8 + i,
  })) } };
  await many.send(many.message('/charging'));
  const buttons = lastReply(many).reply_markup?.inline_keyboard.flat();
  assert.equal(buttons?.length, 12);
  assert(buttons.every((b: { callback_data: string }) => Buffer.byteLength(b.callback_data) <= 64));
  for (const reason of ['disabled', 'none', 'stopped']) {
    const h = profileSetup(), current = validateConfig(h.env.MONITOR_CONFIG);
    if (reason === 'disabled') h.env.MONITOR_CONFIG = { ...current, ev: { ...current.ev, enabled: false } };
    if (reason === 'none') h.env.MONITOR_CONFIG = { ...current, ev: { ...current.ev, profiles: undefined } };
    await h.send(h.message(reason === 'stopped' ? '/stopped' : '/charging'));
    assert.equal(lastReply(h).reply_markup, undefined);
  }
});

for (const reason of ['old', 'future', 'stopped', 'expired', 'superseded', 'changed', 'reordered', 'disabled', 'invalid', 'index'] as const) {
  test(`a ${reason} profile menu cannot alter or renew a charging session`, async () => {
    const h = profileSetup(); await h.send(h.message('/charging'));
    let data = await profileCallback(h); h.advance(3000);
    if (reason === 'old') h.advance(30 * 60_000);
    if (reason === 'future') data = await profileCallback(h, 1, h.clock.time + 1);
    if (reason === 'expired') h.advance(6 * 3600_000);
    if (reason === 'stopped' || reason === 'superseded') {
      await h.send(h.message(reason === 'stopped' ? '/stopped' : '/charging', 2)); h.advance(3000);
    }
    const c = validateConfig(h.env.MONITOR_CONFIG);
    if (reason === 'changed') c.ev.profiles![1] = { id: '13a', label: 'Different setting', type: 'amps', amps: 16 };
    if (reason === 'reordered') c.ev.profiles!.reverse();
    if (reason === 'disabled') c.ev.enabled = false;
    if (reason === 'invalid') data = data.slice(0, -16) + '0000000000000000';
    if (reason === 'index') data = await profileCallback(h, 12);
    const before = structuredClone(botState(h).session);
    await h.send(buttonUpdate(h, data, 3));
    assert.deepEqual(botState(h).session, before);
    assert.match(h.sent.at(-1)!, /expired|unavailable|new manual report/i);
    assert.equal(lastReply(h).reply_markup, undefined);
  });
}

test('profile callbacks retain pre-read authorization and the existing daily command budget', async () => {
  const h = profileSetup(), data = await profileCallback(h); let reads = 0;
  const get = h.kv.get.bind(h.kv); h.kv.get = async key => { reads++; return get(key); };
  for (const field of ['from', 'chat'] as const) {
    const update = buttonUpdate(h, data);
    if (field === 'from') update.callback_query.from.id = 999;
    else update.callback_query.message.chat.id = 999;
    assert.equal((await h.send(update)).status, 403);
  }
  assert.equal((await handleTelegramRequest(h.request(buttonUpdate(h, data), 'synthetic-wrong'), h.env, h.deps)).status, 403);
  assert.equal(reads, 0); assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
  await h.send(h.message('/charging'));
  const s = botState(h), before = structuredClone(s.session); s.used = 47;
  h.kv.data.set('telegram:v1', JSON.stringify(s)); h.advance(3000);
  await h.send(buttonUpdate(h, data));
  assert.deepEqual(botState(h).session, before); assert.match(h.sent.at(-1)!, /daily command limit/i);
  assert.equal(lastReply(h).reply_markup, undefined);
});
test('duplicate/out-of-order updates cannot repeat writes, replies or session confirmation', async () => {
  const h = setup(); const update = h.message('/charging', 4);
  await h.send(update); const stored = h.kv.data.get('telegram:v1');
  h.advance(3000); await h.send(update); await h.send(h.message('/stopped', 3));
  assert.equal(h.sent.length, 1); assert.equal(h.kv.puts.length, 1);
  assert.equal(h.kv.data.get('telegram:v1'), stored);
});
test('commands persist before sending, bound bursts and never write monitor state', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  await h.send(h.message('/stopped', 2));
  assert.equal(h.kv.puts.length, 1); assert.equal(h.sent.length, 1);
  assert(h.kv.puts.every(p => p.key === 'telegram:v1'));
  const failure = setup(); failure.kv.failOnPut = () => true;
  assert.equal((await failure.send(failure.message('/charging'))).status, 503);
  assert.equal(failure.calls.length, 0);
});
test('command transport failures are bounded after persistence rather than replaying mutations', async () => {
  const h = setup(); h.hook(url => url.endsWith('/sendMessage') ? json({}, 503) : undefined);
  const update = h.message('/charging'); await h.send(update); h.advance(3000); await h.send(update);
  assert.equal(h.calls.length, 1); assert.equal(botState(h).session.status, 'charging');
});
test('daily command budget includes a final notice and prevents further state writes', async () => {
  const h = setup();
  for (let id = 1; id <= 50; id++) { await h.send(h.message('/help', id)); h.advance(3000); }
  assert.equal(h.kv.puts.length, 48); assert.equal(h.sent.length, 48);
  assert.match(h.sent.at(-1)!, /daily command limit/i);
  h.advance(24 * 3600_000); await h.send(h.message('/help', 51));
  assert.equal(h.kv.puts.length, 49);
});
test('invalid/oversized payloads and stale messages cannot mutate settings', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: '{synthetic-bad',
  }), h.env, h.deps)).status, 400);
  assert.equal((await h.send({ padding: 'x'.repeat(9000) })).status, 413);
  const old = h.message('/charging'); old.message.date -= 3600;
  assert.equal((await h.send(old)).status, 200);
  assert.equal(h.kv.puts.length, 0); assert.equal(h.calls.length, 0);
});
test('in-chat preferences apply to subsequent Cron runs without restoring muted old alerts', async () => {
  const h = setup(); await h.send(h.message('/full off'));
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /saved/i);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).fullArmed, false);
  h.advance(3000); await h.send(h.message('/full on', 2));
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2);
});
test('enabled discharge prompts offer yes/no buttons without asserting an EV cause', async () => {
  const h = setup();
  h.env.MONITOR_CONFIG = config({ telegram: { enabled: true },
    ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 6 } } as never);
  h.reading(80, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, 600); await runMonitor(h.env, h.deps);
  const call = h.calls.find(c => c.url.endsWith('/sendMessage'))!;
  const payload = JSON.parse(String(call.init?.body));
  assert.match(payload.text, /If the EV is charging/);
  assert.match(payload.text, /Household \/ EV split: unknown/);
  assert.match(payload.text, /EV charging: unknown/);
  assert.equal(payload.text.match(/EV charging:/g).length, 1);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "Yes, I'm charging");
  assert.match(payload.reply_markup.inline_keyboard[0][0].callback_data, /^charging:yes:/);
});

for (const report of ['charging', 'not_charging', 'expired', 'future'] as const) {
  test(`discharge alert keeps ${report} manual evidence separate from the unknown household/EV split`, async () => {
    const h = setup();
    h.env.MONITOR_CONFIG = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
      phases: 1, voltage: 230, minimumAmps: 6,
      profiles: [{ id: 'low', label: 'Low', type: 'amps', amps: 8 }] } });
    await h.send(h.message(report === 'not_charging' ? '/stopped' : '/charging'));
    if (report === 'expired') h.advance(6 * 3600_000);
    if (report === 'future') h.advance(-60_000);
    h.sent.length = 0;
    h.reading(80, 315); await runMonitor(h.env, h.deps);
    h.advance(10_000); h.reading(80, 315); await runMonitor(h.env, h.deps);
    assert.equal(h.sent.length, 1);
    const text = h.sent[0];
    assert.match(text, /Battery discharge: 315 W/);
    assert.match(text, /Load breakdown: unknown/);
    assert.match(text, /Household \/ EV split: unknown/);
    assert.equal(text.match(/EV charging:/g)!.length, 1);
    if (report === 'charging' || report === 'not_charging') {
      assert.match(text, new RegExp(`you confirmed ${report === 'charging' ? 'charging' : 'not charging'}`));
      assert.match(text, /Source: manual confirmation; expires/);
    } else {
      assert.match(text, /EV charging: unknown/);
      assert.doesNotMatch(text, /you confirmed/);
    }
    if (report === 'not_charging') {
      assert.doesNotMatch(text, /consider reducing|Approximate reduction|Your configured settings|pause charging|check the car/);
      assert.match(text, /Update your charging report/);
    } else {
      assert.match(text, /If the EV is charging/);
      assert.match(text, /Your configured settings/);
    }
  });
}
test('Telegram opt-in configuration must be explicitly valid', () => {
  for (const telegram of [null, [], {}, { enabled: 'true' }]) {
    assert.throws(() => validateConfig({ ...config(), telegram }), /telegram_preferences_invalid/);
  }
});

test('commands addressed to another bot are ignored, while the configured username works', async () => {
  const h = setup(); h.env.TELEGRAM_BOT_USERNAME = 'synthetic_bot';
  await h.send(h.message('/charging@another_bot'));
  assert.equal(h.kv.puts.length, 0);
  await h.send(h.message('/charging@synthetic_bot', 2));
  assert.equal(botState(h).session.status, 'charging');
});
test('settings reset clears only chat preferences and unsupported profiles never start a session', async () => {
  const h = setup(); await h.send(h.message('/full off'));
  assert.equal(botState(h).overrides.notifications.full, false);
  h.advance(3000); await h.send(h.message('/settings reset', 2));
  assert.equal(botState(h).overrides, undefined);
  h.advance(3000); await h.send(h.message('/charging unsupported', 3));
  assert.equal(botState(h).session, undefined);
  assert.match(h.sent.at(-1)!, /Unknown profile/);
});
