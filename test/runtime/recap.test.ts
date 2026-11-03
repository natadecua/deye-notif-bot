import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type Request as LocalRequest, Log, LogLevel } from 'miniflare';
import { BASE_TIME, config, syntheticSecrets } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';
import { advanceDailyRecap } from '../../src/daily-recap.ts';

test('workerd scheduled recap shares cooldown state without Deye/weather calls or stale battery advice', async () => {
  // Synthetic schedule, credentials, cache and services only; not a live receipt/CPU test.
  const now = BASE_TIME;
  const p = { enabled: true as const, timeZone: 'UTC', hour: 12, minute: 0, scheduleConfirmed: true as const };
  const c = { ...config(), dailyRecap: p }, messages: { text: string; reply_markup?: unknown }[] = [];
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    banner: { js: `Date.now = () => ${now};` } }); // Test-only clock; avoids midnight/build-time races.
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c },
    outboundService: async (request: LocalRequest) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push(await request.json() as { text: string }); return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const kv = await runtime.getKVNamespace('STATE'), r = advanceDailyRecap(c, p, undefined, now - 86400000);
    assert.equal(r.status, 'ok');
    const battery = { kind: 'full', id: 'full:synthetic-recap-runtime', createdAt: now, attempts: 1, nextAttemptAt: now,
      reading: { at: now - 700000, soc: 100, dischargeWatts: 400 } };
    const s = { ...initialState(c), fullArmed: false, dischargeArmed: false, dailyRecap: r.state,
      apiRetryAt: now + 3600000, lastReadingAt: now - 700000,
      latestReading: { at: now - 700000, soc: 55, dischargeWatts: 315 }, pending: [battery] };
    await kv.put('monitor:v1', JSON.stringify(s)); await new Promise(resolve => setTimeout(resolve, 1200));
    await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(messages.length, 1); assert.match(messages[0].text, /Battery snapshot · daily recap/);
    assert.match(messages[0].text, /stale — not current/); assert.match(messages[0].text, /EV charging: unknown/);
    assert.doesNotMatch(messages[0].text, /House battery full|synthetic-recap-runtime|reduce|\/(?:status|settings)/);
    assert.equal(messages[0].reply_markup, undefined); assert(messages[0].text.length <= 1000);
    const saved = await kv.get('monitor:v1', 'json') as typeof s;
    assert.deepEqual(saved.pending, [battery]); assert.equal(saved.fullArmed, false);
    assert.equal(saved.apiRetryAt, s.apiRetryAt); assert.notEqual(saved.dailyRecap.resolvedDay, r.state.resolvedDay);
  } finally { await runtime.dispose(); }
});
