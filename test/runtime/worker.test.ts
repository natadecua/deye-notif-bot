import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type Request as LocalRequest, Log, LogLevel } from 'miniflare';
import { config, fixture, syntheticSecrets, tokenFixture } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';
import { daytimePeriod } from '../../src/daytime.ts';
import { advanceDataHealth } from '../../src/data-health.ts';

test('workerd help navigation opens cached status and rejects expired menus without changing reports', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const secret = 'synthetic-webhook-secret-1234567890';
  const messages: { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
  const methods: string[] = [], c = config({ telegram: { enabled: true } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
    outboundService: async (request: LocalRequest) => {
      const url = new URL(request.url); assert.equal(url.hostname, 'api.telegram.org');
      const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      assert(['sendMessage', 'answerCallbackQuery'].includes(method)); methods.push(method);
      if (method === 'sendMessage') messages.push(await request.json() as typeof messages[number]);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    // Entirely synthetic cache and current owner report; no actual account/services.
    const kv = await runtime.getKVNamespace('STATE'), now = Date.now(), at = now - 700_000;
    const monitor = JSON.stringify({ ...initialState(c), lastReadingAt: at, latestReading: { at, soc: 55, dischargeWatts: 315 } });
    await kv.put('monitor:v1', monitor);
    const session = { status: 'charging', source: 'manual', at: now - 1000, expiresAt: now - 1000 + 6 * 3600_000 };
    await kv.put('telegram:v1', JSON.stringify({ version: 1, context: JSON.stringify([c.region, c.stationId]),
      day: '', used: 0, lastUpdateId: -1, lastHandledAt: 0, session }));
    const send = (body: unknown) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body),
    });
    const callback = (data: string, id: number, owner = 789) => ({ update_id: id, callback_query: {
      id: 'synthetic-nav-runtime', from: { id: owner }, data, message: { message_id: 1, chat: { id: 456 }, text: '/stopped' },
    } });
    assert.equal((await send(callback(`view:brief:${now}`, 1, 999))).status, 403); assert.equal(methods.length, 0);
    await send({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
      from: { id: 789 }, chat: { id: 456 }, text: '/help' } });
    const buttons = messages[0].reply_markup?.inline_keyboard.flat() ?? [];
    assert.equal(buttons.length, 3); assert.match(messages[0].text, /Read-only buttons.*30 minutes/);
    await new Promise(resolve => setTimeout(resolve, 2100));
    await send(callback(buttons[0].callback_data, 2));
    assert.match(messages[1].text, /Battery status · brief/); assert.match(messages[1].text, /stale — not current/);
    assert.match(messages[1].text, /you confirmed charging/); assert.equal(messages[1].reply_markup, undefined);
    await new Promise(resolve => setTimeout(resolve, 2100));
    await send(callback(`view:brief:${now - 30 * 60_000}`, 3));
    assert.match(messages[2].text, /menu.*expired or invalid.*\/help/i);
    assert.deepEqual(methods, ['sendMessage', 'answerCallbackQuery', 'sendMessage', 'answerCallbackQuery', 'sendMessage']);
    assert.equal(await kv.get('monitor:v1'), monitor);
    assert.deepEqual((await kv.get('telegram:v1', 'json') as { session: unknown }).session, session);
  } finally { await runtime.dispose(); }
});

test('workerd brief status preserves stale/manual/cooldown evidence with only an authorized Telegram reply', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
  const c = config({ telegram: { enabled: true }, daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      const body = await request.json() as { text: string; reply_markup?: unknown };
      assert.equal(body.reply_markup, undefined); messages.push(body.text);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    // Synthetic old cache and current manual report; no actual installation/services.
    const kv = await runtime.getKVNamespace('STATE'), now = Date.now(), at = now - 700_000;
    const before = JSON.stringify({ ...initialState(c), lastReadingAt: at, latestReading: { at, soc: 55, dischargeWatts: 315 },
      apiRetryAt: now + 3600_000, dataHealth: { private: 'synthetic-sensitive-brief' } });
    await kv.put('monitor:v1', before);
    const session = { status: 'charging', source: 'manual', at: now - 1000, expiresAt: now - 1000 + 6 * 3600_000 };
    await kv.put('telegram:v1', JSON.stringify({ version: 1, context: JSON.stringify([c.region, c.stationId]),
      day: '', used: 0, lastUpdateId: -1, lastHandledAt: 0, session }));
    const send = (owner: number) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
        from: { id: owner }, chat: { id: 456 }, text: '/status brief' } }),
    });
    assert.equal((await send(999)).status, 403); assert.equal(messages.length, 0);
    assert.equal((await send(789)).status, 200); assert.equal(messages.length, 1);
    assert.match(messages[0], /Battery status · brief/); assert.match(messages[0], /Charge: 55%/);
    assert.match(messages[0], /stale — not current/); assert.match(messages[0], /Updates: cooldown/);
    assert.match(messages[0], /Asia\/Manila \(UTC\+08:00\)/);
    assert.match(messages[0], /you confirmed charging/); assert.match(messages[0], /Source: manual confirmation/);
    assert.match(messages[0], /Load breakdown: unknown/); assert(messages[0].length <= 1000);
    assert.doesNotMatch(messages[0], /synthetic-sensitive|reduce|grid outage|recovered/);
    assert.equal(await kv.get('monitor:v1'), before);
    assert.deepEqual((await kv.get('telegram:v1', 'json') as { session: unknown }).session, session);
  } finally { await runtime.dispose(); }
});

test('workerd owner status shows health consent without reading health metadata as readiness or polling providers', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
  const c = config({ telegram: { enabled: true }, notifications: { full: false, discharge: false },
    dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' },
    daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push((await request.json() as { text: string }).text);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const kv = await runtime.getKVNamespace('STATE');
    const before = JSON.stringify({ ...initialState(c), dataHealth: { private: 'synthetic-sensitive-health' } });
    await kv.put('monitor:v1', before);
    const send = (owner: number) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
        from: { id: owner }, chat: { id: 456 }, text: '/status' } }),
    });
    assert.equal((await send(999)).status, 403); assert.equal(messages.length, 0);
    assert.equal((await send(789)).status, 200); assert.equal(messages.length, 1);
    assert.match(messages[0], /Health notices: on.*30 minutes/);
    assert.match(messages[0], /06:00–18:00 Asia\/Manila/);
    assert.match(messages[0], /does not verify.*receipt/);
    assert.doesNotMatch(messages[0], /synthetic-sensitive-health|15 minutes of sampled discharge/);
    assert.equal(await kv.get('monitor:v1'), before);
  } finally { await runtime.dispose(); }
});

test('workerd sends a health-only cooldown notice without releasing stale battery advice or polling providers', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const c = config({ dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const messages: { text: string; reply_markup?: unknown }[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push(await request.json() as { text: string });
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    // Synthetic missing-update episode and queued battery event; no actual account/service.
    const kv = await runtime.getKVNamespace('STATE'), now = Date.now(), s = initialState(c);
    const health = advanceDataHealth(c, undefined, { kind: 'idle' }, now - 31 * 60_000);
    assert.equal(health.status, 'ok');
    s.fullArmed = false; s.apiRetryAt = now + 3600_000;
    const battery = { kind: 'full', id: 'full:synthetic-runtime', createdAt: now, attempts: 1, nextAttemptAt: now,
      reading: { at: now - 35 * 60_000, soc: 100, dischargeWatts: 400 } };
    await kv.put('monitor:v1', JSON.stringify({ ...s, dataHealth: health.state, pending: [battery] }));
    await new Promise(resolve => setTimeout(resolve, 1200));
    await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(messages.length, 1); assert.match(messages[0].text, /Battery updates delayed/);
    assert.equal(messages[0].reply_markup, undefined);
    assert.doesNotMatch(messages[0].text, /Charge:|Battery discharge:|synthetic-runtime|https?:\/\//);
    const record = await kv.get('monitor:v1', 'json') as { dataHealth: { staleAcknowledged: boolean }; pending: unknown[]; apiRetryAt: number };
    assert.equal(record.dataHealth.staleAcknowledged, true);
    assert.deepEqual(record.pending, [battery]); assert.equal(record.apiRetryAt, s.apiRetryAt);
  } finally { await runtime.dispose(); }
});

test('real workerd scheduled handler with local KV and entirely synthetic outbound services', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  let telegramCalls = 0, deyeTokenCalls = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text,
    cf: false,
    compatibilityDate: '2026-10-01',
    kvNamespaces: ['STATE'],
    bindings: { MONITOR_CONFIG: config(), ...syntheticSecrets },
    log: new Log(LogLevel.NONE),
    outboundService: async (request: LocalRequest) => {
      const path = new URL(request.url).pathname;
      let body: unknown;
      if (path.endsWith('/account/token')) { deyeTokenCalls++; body = tokenFixture; }
      else if (path.endsWith('/station/latest')) {
        body = { ...fixture, batterySOC: 100, dischargePower: 0,
          lastUpdateTime: new Date(Date.now() - 1000).toISOString() };
      } else if (path.endsWith('/sendMessage')) { telegramCalls++; body = { ok: true }; }
      else throw new Error('Unexpected request in synthetic runtime test');
      return new LocalResponse(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(telegramCalls, 1);
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(telegramCalls, 1); assert.equal(deyeTokenCalls, 1);
    const kv = await runtime.getKVNamespace('STATE');
    const stored = await kv.get('monitor:v1', 'json') as { fullArmed: boolean; pending: unknown[] };
    assert.equal(stored.fullArmed, false); assert.deepEqual(stored.pending, []);
    const response = await runtime.dispatchFetch('https://synthetic.invalid/');
    assert.equal(response.status, 404);
  } finally { await runtime.dispose(); }
});

test('workerd honors a muted full alert and renders generic charging profiles from JSON bindings', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const base = Date.now() - 60_000;
  let latestCalls = 0;
  const messages: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: config({
      notifications: { full: false, discharge: true },
      ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 8,
        profiles: [
          { id: 'low', label: 'Low', type: 'amps', amps: 8 },
          { id: 'medium', label: 'Medium', type: 'amps', amps: 13 },
          { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
        ] },
    }) },
    outboundService: async (request: LocalRequest) => {
      const path = new URL(request.url).pathname;
      let body: unknown;
      if (path.endsWith('/account/token')) body = tokenFixture;
      else if (path.endsWith('/station/latest')) {
        latestCalls++;
        body = { ...fixture, batterySOC: 100, dischargePower: 800,
          lastUpdateTime: new Date(base + latestCalls * 1000).toISOString() };
      } else if (path.endsWith('/sendMessage')) {
        messages.push((await request.json() as { text: string }).text); body = { ok: true };
      } else throw new Error('Unexpected synthetic outbound request');
      return new LocalResponse(JSON.stringify(body));
    },
  }));
  try {
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(messages.length, 0);
    // Wait for local KV's one-write-per-second limit between manual invocations.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Medium: 13 A.*2\.99 kW/);
    assert.match(messages[0], /MAX: ~7 kW/);
    assert.match(messages[0], /nominal estimates/);
    assert.doesNotMatch(messages[0], /Approximate reduction|32 A/);
  } finally { await runtime.dispose(); }
});

test('workerd authenticates webhook status and charging buttons using local KV and synthetic Telegram', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const messages: { text: string; reply_markup?: unknown }[] = [];
  const secret = 'synthetic-webhook-secret-1234567890';
  let latestCalls = 0, acknowledgements = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789',
      MONITOR_CONFIG: config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
        phases: 1, voltage: 230, minimumAmps: 6 } }) },
    outboundService: async (request: LocalRequest) => {
      const path = new URL(request.url).pathname;
      let body: unknown = { ok: true };
      if (path.endsWith('/account/token')) body = tokenFixture;
      else if (path.endsWith('/station/latest')) {
        latestCalls++;
        body = { ...fixture, batterySOC: 80, dischargePower: 500, lastUpdateTime: new Date(Date.now() - 1000).toISOString() };
      } else if (path.endsWith('/sendMessage')) messages.push(await request.json() as { text: string });
      else if (path.endsWith('/answerCallbackQuery')) acknowledgements++;
      else throw new Error('Unexpected synthetic runtime method');
      return new LocalResponse(JSON.stringify(body));
    },
  }));
  try {
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    const post = (body: unknown, header = secret) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': header }, body: JSON.stringify(body),
    });
    const statusUpdate = { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
      from: { id: 789 }, chat: { id: 456 }, text: '/status' } };
    assert.equal((await post(statusUpdate, 'synthetic-wrong')).status, 403);
    assert.equal((await post(statusUpdate)).status, 200);
    assert.match(messages[0].text, /80%/); assert.match(messages[0].text, /EV charging: unknown/);
    assert.match(messages[0].text, /Battery discharge: 500 W/);
    assert.match(messages[0].text, /Household \/ EV split: unknown/);
    assert.equal(latestCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await post({ update_id: 2, callback_query: { id: 'synthetic-runtime-button', from: { id: 789 },
      message: { date: Math.floor(Date.now() / 1000), chat: { id: 456 } }, data: `charging:yes:${Date.now() - 1000}` } })).status, 200);
    assert.equal(acknowledgements, 1); assert.match(messages[1].text, /you confirmed charging/);
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(latestCalls, 2); assert.equal(messages.length, 3);
    assert.match(messages[2].text, /you confirmed charging/); assert(messages[2].reply_markup);
    assert.match(messages[2].text, /Source: manual confirmation; expires/);
    assert.match(messages[2].text, /Household \/ EV split: unknown/);
    assert.equal(messages[2].text.match(/EV charging:/g)!.length, 1);
    const kv = await runtime.getKVNamespace('STATE');
    const stored = await kv.get('telegram:v1', 'json') as { session: { source: string } };
    assert.equal(stored.session.source, 'manual');
    assert.equal((await runtime.dispatchFetch('https://synthetic.invalid/')).status, 404);
  } finally { await runtime.dispose(); }
});

test('workerd renders fresh/stale weather from authorized status cache with only a Telegram reply', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  for (const stale of [false, true]) {
    const c = config({ telegram: { enabled: true },
      weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
    const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
    let outboundCalls = 0;
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundled.outputFiles[0].text, cf: false,
      compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
      bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
      outboundService: async (request: LocalRequest) => {
        outboundCalls++;
        assert.equal(new URL(request.url).hostname, 'api.telegram.org');
        assert(new URL(request.url).pathname.endsWith('/sendMessage'));
        messages.push((await request.json() as { text: string }).text);
        return new LocalResponse(JSON.stringify({ ok: true }));
      },
    }));
    try {
      const now = Date.now(), s = initialState(c), fetchedAt = now - (stale ? 3600_000 : 150_000);
      s.lastReadingAt = now - 60_000; s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 800 };
      s.weather = { context: '[10,20]', attemptedAt: fetchedAt, fetchedAt, nextAttemptAt: fetchedAt + 3600_000,
        hours: Array.from({ length: 6 }, (_, i) => ({ at: Math.floor(now / 3600_000) * 3600_000 + (i + 1) * 3600_000,
          cloudCover: 40, radiation: 200 })) };
      const kv = await runtime.getKVNamespace('STATE'), before = JSON.stringify(s);
      await kv.put('monitor:v1', before);
      const post = (header: string) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
        method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': header },
        body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
          from: { id: 789 }, chat: { id: 456 }, text: '/status' } }),
      });
      assert.equal((await post('synthetic-wrong')).status, 403); assert.equal(outboundCalls, 0);
      assert.equal((await post(secret)).status, 200); assert.equal(outboundCalls, 1);
      assert.match(messages[0], /Charge: 82%/); assert.match(messages[0], /Cached weather/);
      if (stale) {
        assert.match(messages[0], /stale — do not treat this as current/);
        assert.match(messages[0], /Weather forecast unavailable/);
        assert.doesNotMatch(messages[0], /cloud 40%/);
      } else {
        assert.match(messages[0], /Forecast cache age: \d+ seconds \(within the 1-hour freshness limit\)/);
        assert.match(messages[0], /cloud 40%, radiation 200 W\/m²/);
        assert.match(messages[0], /Weather data: Open-Meteo/);
      }
      assert.equal(await kv.get('monitor:v1'), before);
    } finally { await runtime.dispose(); }
  }
});

test('workerd records configured profile buttons as expiring manual reports and rejects them after stopped', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const secret = 'synthetic-webhook-secret-1234567890';
  const messages: { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
  const methods: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789',
      MONITOR_CONFIG: config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
        phases: 1, voltage: 230, minimumAmps: 8, profiles: [
          { id: 'low', label: '8 A', type: 'amps', amps: 8 },
          { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
        ] } }) },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      const method = new URL(request.url).pathname.split('/').at(-1)!;
      assert(['sendMessage', 'answerCallbackQuery'].includes(method)); methods.push(method);
      if (method === 'sendMessage') messages.push(await request.json() as typeof messages[number]);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const post = (body: unknown, header = secret) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': header }, body: JSON.stringify(body),
    });
    const command = (text: string, id: number) => ({ update_id: id, message: { date: Math.floor(Date.now() / 1000),
      from: { id: 789 }, chat: { id: 456 }, text } });
    assert.equal((await post(command('/charging', 1))).status, 200);
    const buttons = messages[0].reply_markup!.inline_keyboard.flat();
    assert.deepEqual(buttons.map(b => b.text), ['I use 8 A', 'I use MAX']);
    const kv = await runtime.getKVNamespace('STATE');
    const before = await kv.get('telegram:v1', 'json') as { session: { at: number; expiresAt: number } };
    const selection = (id: number) => ({ update_id: id, callback_query: { id: 'synthetic-runtime-profile', from: { id: 789 },
      message: { date: Math.floor(Date.now() / 1000), chat: { id: 456 }, text: '/stopped' }, data: buttons[1].callback_data } });
    assert.equal((await post(selection(2), 'synthetic-wrong')).status, 403); assert.equal(methods.length, 1);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await post(selection(2))).status, 200);
    const selected = await kv.get('telegram:v1', 'json') as { session: { profileId: string; source: string; at: number; expiresAt: number } };
    assert.equal(selected.session.profileId, 'max'); assert.equal(selected.session.source, 'manual');
    assert.equal(selected.session.at, before.session.at); assert.equal(selected.session.expiresAt, before.session.expiresAt);
    assert.match(messages[1].text, /Reported profile: MAX/); assert.match(messages[1].text, /not measured EV power/);
    assert.doesNotMatch(messages[1].text, /32 A|EV detected/);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await post(command('/stopped', 3))).status, 200); assert.equal(messages[2].reply_markup, undefined);
    const stopped = await kv.get('telegram:v1', 'json') as { session: unknown };
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await post(selection(4))).status, 200);
    const rejected = await kv.get('telegram:v1', 'json') as { session: unknown };
    assert.deepEqual(rejected.session, stopped.session); assert.match(messages[3].text, /expired/);
    assert.equal(await kv.get('monitor:v1'), null);
    assert.deepEqual(methods, ['sendMessage', 'answerCallbackQuery', 'sendMessage', 'sendMessage', 'answerCallbackQuery', 'sendMessage']);
  } finally { await runtime.dispose(); }
});

test('workerd displays configured local reading/expiry times while retaining absolute cache and session values', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
  const c = config({ telegram: { enabled: true }, daytimeDischarge: {
    timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15,
  } });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push((await request.json() as { text: string }).text);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const kv = await runtime.getKVNamespace('STATE'), s = initialState(c);
    s.lastReadingAt = Date.parse('2025-12-31T16:00:01Z');
    s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 315 };
    const before = JSON.stringify(s); await kv.put('monitor:v1', before);
    const post = (text: string, id: number) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: id,
        message: { date: Math.floor(Date.now() / 1000), from: { id: 789 }, chat: { id: 456 }, text } }),
    });
    assert.equal((await post('/charging', 1)).status, 200);
    const bot = await kv.get('telegram:v1', 'json') as { session: { at: number; expiresAt: number } };
    assert.equal(bot.session.expiresAt - bot.session.at, 6 * 3600_000);
    // Fixed UTC+08 test expectation for this explicitly synthetic Manila installation.
    const expiry = new Date(bot.session.expiresAt + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    assert(messages[0].includes(`expires ${expiry} Asia/Manila (UTC+08:00)`));
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await post('/status', 2)).status, 200);
    assert.match(messages[1], /Reading: 2026-01-01 00:00:01 Asia\/Manila \(UTC\+08:00\)/);
    assert.match(messages[1], /stale — do not treat this as current/);
    assert.equal(await kv.get('monitor:v1'), before);
    const after = await kv.get('telegram:v1', 'json') as { session: unknown };
    assert.deepEqual(after.session, bot.session); assert.equal(messages.length, 2);
  } finally { await runtime.dispose(); }
});

test('workerd describes cached cooldown, missing/stale data and disabled polling without contacting Deye', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  for (const scenario of ['missing', 'stale', 'disabled', 'elapsed']) {
    const c = config({ enabled: scenario !== 'disabled', telegram: { enabled: true }, daytimeDischarge: {
      timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15,
    } });
    const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundled.outputFiles[0].text, cf: false,
      compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
      bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
      outboundService: async (request: LocalRequest) => {
        assert.equal(new URL(request.url).hostname, 'api.telegram.org');
        assert(new URL(request.url).pathname.endsWith('/sendMessage'));
        messages.push((await request.json() as { text: string }).text);
        return new LocalResponse(JSON.stringify({ ok: true }));
      },
    }));
    try {
      const kv = await runtime.getKVNamespace('STATE'), s = initialState(c), now = Date.now();
      if (scenario === 'stale' || scenario === 'elapsed') {
        s.lastReadingAt = now - 700_000; s.latestReading = { at: s.lastReadingAt, soc: 82, dischargeWatts: 315 };
      }
      s.apiFailures = 1; s.apiRetryAt = now + (scenario === 'elapsed' ? -1000 : 300_000);
      const before = JSON.stringify({ ...s, upstreamBody: 'synthetic-private-body', lastError: 'synthetic-private-exception' });
      await kv.put('monitor:v1', before);
      const post = (header: string) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', {
        method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': header }, body: JSON.stringify({ update_id: 1,
          message: { date: Math.floor(Date.now() / 1000), from: { id: 789 }, chat: { id: 456 }, text: '/status' } }),
      });
      assert.equal((await post('synthetic-wrong')).status, 403); assert.equal(messages.length, 0);
      assert.equal((await post(secret)).status, 200); assert.equal(messages.length, 1);
      assert.match(messages[0], /not a live connection check/); assert.doesNotMatch(messages[0], /synthetic-private/);
      if (scenario === 'disabled') {
        assert.match(messages[0], /Scheduled monitoring is disabled/);
        assert.doesNotMatch(messages[0], /Next attempt allowed after|scheduled poll may try again/);
      } else if (scenario === 'elapsed') {
        assert.match(messages[0], /Retry delay has elapsed/); assert.match(messages[0], /stale — do not treat this as current/);
      } else {
        assert.match(messages[0], /Data updates: retry cooldown/);
        assert.match(messages[0], /Next attempt allowed after: .*Asia\/Manila \(UTC\+08:00\)/);
        assert.match(messages[0], /Reason is not recorded/);
        assert.match(messages[0], scenario === 'stale' ? /stale — do not treat this as current/ : /No cached reading/);
      }
      assert.equal(await kv.get('monitor:v1'), before);
    } finally { await runtime.dispose(); }
  }
});

test('workerd resumes a synthetic daytime confirmation and sends the duration-aware alert', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  // Avoid a local-date rollover in this test regardless of the runner's clock hour.
  const manilaHour = (new Date().getUTCHours() + 8) % 24;
  const timeZone = [0, 23].includes(manilaHour) ? 'UTC' : 'Asia/Manila';
  const c = config({ daytimeDischarge: { timeZone, startHour: 0, endHour: 24, minimumMinutes: 15 } });
  const messages: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c },
    outboundService: async (request: LocalRequest) => {
      const path = new URL(request.url).pathname;
      let body: unknown;
      if (path.endsWith('/account/token')) body = tokenFixture;
      else if (path.endsWith('/station/latest')) body = { ...fixture, batterySOC: 80, dischargePower: 500,
        lastUpdateTime: new Date(Date.now() - 1000).toISOString() };
      else if (path.endsWith('/sendMessage')) { messages.push((await request.json() as { text: string }).text); body = { ok: true }; }
      else throw new Error('Unexpected synthetic daytime request');
      return new LocalResponse(JSON.stringify(body));
    },
  }));
  try {
    const now = Date.now(), s = initialState(c);
    s.lastReadingAt = now - 300_000;
    s.latestReading = { at: s.lastReadingAt, soc: 80, dischargeWatts: 500 };
    s.highCount = 2; s.highStartedAt = now - 905_000;
    s.dischargeDay = daytimePeriod(now, c.daytimeDischarge!);
    const kv = await runtime.getKVNamespace('STATE');
    await kv.put('monitor:v1', JSON.stringify(s));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Daytime battery use/);
    assert.match(messages[0], /spanning at least 15 minutes/);
    assert.doesNotMatch(messages[0], /EV|forecast|weather/i);
  } finally { await runtime.dispose(); }
});

test('workerd adds optional cached forecast context and still delivers during a weather outage', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  for (const outage of [false, true]) {
    const manilaHour = (new Date().getUTCHours() + 8) % 24;
    const c = config({ daytimeDischarge: { timeZone: [0, 23].includes(manilaHour) ? 'UTC' : 'Asia/Manila',
      startHour: 0, endHour: 24, minimumMinutes: 15 },
      weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
    let weatherCalls = 0;
    const messages: string[] = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundled.outputFiles[0].text, cf: false,
      compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
      bindings: { ...syntheticSecrets, MONITOR_CONFIG: c },
      outboundService: async (request: LocalRequest) => {
        const url = new URL(request.url);
        let body: unknown;
        if (url.hostname === 'api.open-meteo.com') {
          weatherCalls++; assert.equal(request.method, 'GET');
          if (outage) return new LocalResponse('Synthetic provider outage', { status: 503 });
          const start = Math.floor(Date.now() / 3600_000) * 3600;
          body = { hourly_units: { time: 'unixtime', cloud_cover: '%', shortwave_radiation: 'W/m²' },
            hourly: { time: Array.from({ length: 6 }, (_, i) => start + i * 3600),
              cloud_cover: [50, 40, 30, 20, 10, 0], shortwave_radiation: [100, 200, 300, 400, 500, 600] } };
        } else if (url.pathname.endsWith('/account/token')) body = tokenFixture;
        else if (url.pathname.endsWith('/station/latest')) body = { ...fixture, batterySOC: 80, dischargePower: 500,
          lastUpdateTime: new Date(Date.now() - 1000).toISOString() };
        else if (url.pathname.endsWith('/sendMessage')) { messages.push((await request.json() as { text: string }).text); body = { ok: true }; }
        else throw new Error('Unexpected synthetic forecast request');
        return new LocalResponse(JSON.stringify(body));
      },
    }));
    try {
      const now = Date.now(), s = initialState(c);
      s.lastReadingAt = now - 300_000;
      s.latestReading = { at: s.lastReadingAt, soc: 80, dischargeWatts: 500 };
      s.highCount = 2; s.highStartedAt = now - 905_000;
      s.dischargeDay = daytimePeriod(now, c.daytimeDischarge!);
      const kv = await runtime.getKVNamespace('STATE');
      await kv.put('monitor:v1', JSON.stringify(s));
      await new Promise(resolve => setTimeout(resolve, 1100));
      const worker = await runtime.getWorker();
      await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
      assert.equal(messages.length, 1); assert.equal(weatherCalls, 1);
      assert.match(messages[0], /Daytime battery use/);
      assert.match(messages[0], outage ? /Weather forecast unavailable/ : /Weather data: Open-Meteo/);
      const stored = await kv.get('monitor:v1', 'json') as { weather: { nextAttemptAt: number }; apiRetryAt: number; pending: unknown[] };
      assert(stored.weather.nextAttemptAt >= now + 3599_000);
      assert.equal(stored.apiRetryAt, 0); assert.equal(stored.pending.length, 0);
    } finally { await runtime.dispose(); }
  }
});
