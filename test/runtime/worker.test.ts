import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type Request as LocalRequest, Log, LogLevel } from 'miniflare';
import { config, fixture, syntheticSecrets, tokenFixture } from '../helpers.ts';

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
