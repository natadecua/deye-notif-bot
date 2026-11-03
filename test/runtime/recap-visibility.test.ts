import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, Log, LogLevel } from 'miniflare';
import { config, syntheticSecrets } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';

test('workerd authorized recap status displays configuration without advancing lifecycle or contacting providers', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  // Entirely synthetic configuration, identifiers, cache and transport.
  const c = config({ telegram: { enabled: true }, enabled: false,
    dailyRecap: { enabled: true, timeZone: 'Asia/Manila', hour: 17, minute: 35, scheduleConfirmed: true } });
  const secret = 'synthetic-webhook-secret-1234567890', messages: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', kvNamespaces: ['STATE'], log: new Log(LogLevel.NONE),
    bindings: { ...syntheticSecrets, MONITOR_CONFIG: c, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert(new URL(request.url).pathname.endsWith('/sendMessage'));
      messages.push((await request.json() as { text: string }).text);
      return new LocalResponse(JSON.stringify({ ok: true }));
    },
  }));
  try {
    const kv = await runtime.getKVNamespace('STATE');
    const before = JSON.stringify({ ...initialState(c), dailyRecap: { raw: 'synthetic-private-lifecycle' } });
    await kv.put('monitor:v1', before);
    const send = (owner: number) => runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook', { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: 1,
        message: { date: Math.floor(Date.now() / 1000), from: { id: owner }, chat: { id: 456 }, text: '/status' } }) });
    assert.equal((await send(999)).status, 403); assert.equal(messages.length, 0);
    assert.equal((await send(789)).status, 200); assert.equal(messages.length, 1);
    assert.match(messages[0], /Recap: on.*17:35 Asia\/Manila/);
    assert.match(messages[0], /Recap delivery paused.*monitoring is disabled/);
    assert.match(messages[0], /does not verify.*receipt/);
    assert.doesNotMatch(messages[0], /synthetic-private|resolvedDay|observedAt/);
    assert.equal(await kv.get('monitor:v1'), before);
  } finally { await runtime.dispose(); }
});
