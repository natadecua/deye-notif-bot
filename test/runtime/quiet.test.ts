import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, Log, LogLevel } from 'miniflare';
import { BASE_TIME, config, syntheticSecrets } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';
import { advanceDataHealth } from '../../src/data-health.ts';
import { advanceDailyRecap } from '../../src/daily-recap.ts';

test('workerd quiet recap retains its opportunity while unselected health sends during cooldown', async () => {
  // Fixed synthetic clock avoids build/midnight races; production clock is unchanged.
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    banner: { js: `Date.now = () => ${BASE_TIME};` } });
  const c = config({ dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true },
    dailyRecap: { enabled: true, timeZone: 'UTC', hour: 12, minute: 0, scheduleConfirmed: true },
    quietHours: { enabled: true, timeZone: 'UTC', startMinute: 720, endMinute: 780,
      categories: { full: false, discharge: false, health: false, recap: true }, suppressionConfirmed: true } } as never);
  const health = advanceDataHealth(c, undefined, { kind: 'idle' }, BASE_TIME - 31 * 60000); assert(health.status === 'ok');
  const recap = advanceDailyRecap(c, c.dailyRecap, undefined, BASE_TIME - 86400_000); assert(recap.status === 'ok');
  const messages: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c }, outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push((await request.json() as { text: string }).text);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const kv = await runtime.getKVNamespace('STATE');
    await kv.put('monitor:v1', JSON.stringify({ ...initialState(c), apiRetryAt: BASE_TIME + 3600_000,
      fullArmed: false, dischargeArmed: false, dataHealth: health.state, dailyRecap: recap.state }));
    await new Promise(resolve => setTimeout(resolve, 1100));
    await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: new Date(BASE_TIME) });
    assert.equal(messages.length, 1); assert.match(messages[0], /Battery updates delayed/);
    const s = await kv.get('monitor:v1', 'json') as { pending: { kind: string; attempts: number }[];
      quietHours: { version: number; lastObservedAt: number }; apiRetryAt: number; fullArmed: boolean };
    assert.deepEqual(s.quietHours, { version: 1, lastObservedAt: BASE_TIME });
    assert.equal(s.pending.length, 1); assert.equal(s.pending[0].kind, 'recap'); assert.equal(s.pending[0].attempts, 0);
    assert.equal(s.apiRetryAt, BASE_TIME + 3600_000); assert.equal(s.fullArmed, false);
  } finally { await runtime.dispose(); }
});
