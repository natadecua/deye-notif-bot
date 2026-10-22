import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeyeClient, sha256 } from '../src/deye.ts';
import { sendTelegram } from '../src/telegram.ts';
import { SafeError, errorCode } from '../src/errors.ts';
import { config, harness, json, syntheticSecrets, tokenFixture } from './helpers.ts';

test('password is hashed with SHA-256 locally; official known vector', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('auth request matches REST schema; Bearer is never duplicated', async () => {
  const h = harness();
  const s = { ...syntheticSecrets, DEYE_APP_ID: 'synthetic + app', DEYE_COMPANY_ID: '42' };
  await new DeyeClient(config(), s, h.kv, h.deps).latest();
  const tokenCall = h.calls.find(c => c.url.includes('/account/token'))!;
  assert.equal(new URL(tokenCall.url).searchParams.get('appId'), s.DEYE_APP_ID);
  assert.deepEqual(JSON.parse(String(tokenCall.init?.body)), { appSecret: s.DEYE_APP_SECRET,
    email: s.DEYE_ACCOUNT, password: s.DEYE_PASSWORD_SHA256, companyId: 42 });
  const latest = h.calls.find(c => c.url.includes('/station/latest'))!;
  assert.equal((latest.init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-token-not-valid');
  assert.equal(latest.init?.redirect, 'manual');
});
test('bare accessToken and numeric-string expiry are supported', async () => {
  const h = harness();
  h.hook(url => url.includes('/account/token') ? json({ ...tokenFixture, accessToken: 'synthetic-bare', expiresIn: '3600' }) : undefined);
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  assert.equal((h.calls.at(-1)!.init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-bare');
});
test('auth cached across invocations, refreshed before expiry; cache invalidated on credentials change', async () => {
  const h = harness();
  h.hook(url => url.includes('/account/token') ? json({ ...tokenFixture, expiresIn: 180 }) : undefined);
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  assert.equal(h.calls.filter(c => c.url.includes('/account/token')).length, 1);
  h.advance(121_000);
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  assert.equal(h.calls.filter(c => c.url.includes('/account/token')).length, 2);
  await new DeyeClient(config(), { ...syntheticSecrets, DEYE_APP_SECRET: 'synthetic-rotated' }, h.kv, h.deps).latest();
  assert.equal(h.calls.filter(c => c.url.includes('/account/token')).length, 3);
});
for (const failure of [() => json({}, 401), () => json({ success: false, code: 'undocumented' })]) {
  test('one cached-token renewal on unauthorized HTTP or unsuccessful JSON envelope', async () => {
    const h = harness();
    await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
    let rejects = 0;
    h.hook(url => url.includes('/station/latest') && rejects++ === 0 ? failure() : undefined);
    await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
    assert.equal(h.calls.filter(c => c.url.includes('/account/token')).length, 2);
    assert.equal(h.kv.puts.filter(c => c.key === 'auth:v1').length, 2);
  });
}
test('cold auth failure never enters a refresh loop', async () => {
  const h = harness();
  h.hook(url => url.includes('/station/latest') ? json({}, 401) : undefined);
  await assert.rejects(new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest(), /unauthorized/);
  assert.equal(h.calls.filter(c => c.url.includes('/account/token')).length, 1);
});
test('all regional endpoints and station listing match published REST fields', async () => {
  for (const [region, host] of [['eu', 'eu1'], ['am', 'us1'], ['india', 'india']] as const) {
    const h = harness(config({ region }));
    h.hook(url => url.includes('/station/list') ? json({ success: true, stationList: [{ id: 123, name: 'Synthetic station' }], total: 1 }) : undefined);
    const result = await new DeyeClient(config({ region }), syntheticSecrets, h.kv, h.deps).stations();
    assert.equal(result.stations[0].id, 123);
    assert(h.calls.every(c => new URL(c.url).hostname === `${host}-developer.deyecloud.com`));
    assert.deepEqual(JSON.parse(String(h.calls.at(-1)!.init?.body)), { page: 1, size: 100 });
  }
});
test('device discovery supported but control paths fail closed', async () => {
  const h = harness();
  const client = new DeyeClient(config(), syntheticSecrets, h.kv, h.deps);
  h.hook(url => url.includes('/device/measurePoints') ? json({ success: true, measurePoints: ['SOC'] }) : undefined);
  assert.deepEqual((await client.read('/device/measurePoints', { deviceSn: 'synthetic' })).measurePoints, ['SOC']);
  await assert.rejects(client.read('/order/control' as '/station/latest', {}), /path_not_allowed/);
});
test('transient Deye error retries twice at most with bounded backoff', async () => {
  const h = harness(); let failures = 0;
  h.hook(url => url.includes('/station/latest') && failures++ === 0 ? json({}, 503) : undefined);
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  assert.deepEqual(h.sleeps, [500]);
  assert.equal(h.calls.filter(c => c.url.includes('/station/latest')).length, 2);
});
test('Deye rate limit Retry-After is preserved without sleeping for minutes', async () => {
  const h = harness();
  h.hook(url => url.includes('/station/latest') ? json({}, 429, { 'Retry-After': '900' }) : undefined);
  await assert.rejects(new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest(), (e: SafeError) =>
    e.retryable && e.retryAt === h.clock.time + 900_000);
  assert.deepEqual(h.sleeps, []);
});
test('network errors are sanitized; sensitive URLs never appear in exposed errors', async () => {
  const h = harness();
  h.deps.fetch = async () => { throw new Error('Failed https://api.telegram.org/botSECRET/sendMessage'); };
  await assert.rejects(sendTelegram(syntheticSecrets, 'synthetic test', h.deps), (e: SafeError) => {
    assert.equal(errorCode(e), 'telegram_network_error'); assert.doesNotMatch(e.message, /SECRET|http/); return e.retryable;
  });
});
test('Telegram checks success envelope, sends plain text and no parse_mode', async () => {
  const h = harness();
  await sendTelegram(syntheticSecrets, 'If the EV is charging… <plain>', h.deps);
  const body = JSON.parse(String(h.calls[0].init?.body));
  assert.equal(body.chat_id, '456'); assert.equal(body.parse_mode, undefined);
  h.hook(() => json({ ok: false, error_code: 400, description: 'upstream sensitive text' }));
  await assert.rejects(sendTelegram(syntheticSecrets, 'test', h.deps), /telegram_rejected/);
});
for (const status of [200, 429]) {
  test(`Telegram retry_after honored in JSON (HTTP ${status})`, async () => {
    const h = harness();
    h.hook(() => json({ ok: false, error_code: 429, parameters: { retry_after: 1200 } }, status));
    await assert.rejects(sendTelegram(syntheticSecrets, 'synthetic', h.deps), (e: SafeError) =>
      e.retryable && e.retryAt === h.clock.time + 1200_000);
    assert.equal(h.calls.length, 1);
  });
}
test('malformed auth schemas and credentials are rejected', async () => {
  const h = harness();
  assert.throws(() => new DeyeClient(config(), { ...syntheticSecrets, DEYE_PASSWORD_SHA256: '' }), /secrets_invalid/);
  h.hook(() => json({ success: true, accessToken: 'synthetic', expiresIn: null }));
  await assert.rejects(new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest(), /auth_schema_invalid/);
});
test('redirect responses are rejected without following a secret-bearing request', async () => {
  const h = harness();
  h.hook(() => json({}, 302, { Location: 'https://synthetic-untrusted.invalid/' }));
  await assert.rejects(new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest(), /deye_http_rejected/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init?.redirect, 'manual');
});
test('Deye HTTP 408 timeout retries a read-only request with bounded backoff', async () => {
  const h = harness(); let timedOut = false;
  h.hook(url => {
    if (url.includes('/station/latest') && !timedOut) {
      timedOut = true;
      return json({}, 408);
    }
  });
  await new DeyeClient(config(), syntheticSecrets, h.kv, h.deps).latest();
  assert.equal(h.calls.filter(c => c.url.includes('/station/latest')).length, 2);
  assert.deepEqual(h.sleeps, [500]);
});
