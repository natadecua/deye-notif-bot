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
