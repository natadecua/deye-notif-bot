import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramDoctor } from '../scripts/telegram-doctor.ts';
import { config, syntheticSecrets } from './helpers.ts';

// Synthetic credentials, API results and reserved-domain URLs only.
test('doctor identifies notification-only setup and missing webhook without claiming a live bot fix', async () => {
  const calls: string[] = [];
  const text = await telegramDoctor(config(), syntheticSecrets, async method => {
    calls.push(method); return method === 'getMe' ? { ok: true, result: { id: 789, username: 'synthetic-private' } } :
      { ok: true, result: { url: '', pending_update_count: 0 } };
  });
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  assert.match(text, /Local commands: off/); assert.match(text, /Bot token: accepted/);
  assert.match(text, /Webhook: absent/); assert.match(text, /telegram:setup.*secrets:upload.*deploy.*telegram:webhook/s);
  assert.match(text, /does not verify.*deployed.*receipt/); assert.doesNotMatch(text, /789|synthetic-private/);
});
test('doctor separates local owner/header readiness from registration and sanitizes provider fields', async () => {
  const text = await telegramDoctor(config({ telegram: { enabled: true } }),
    { ...syntheticSecrets, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: 'synthetic-header-secret-1234567890' },
    async method => method === 'getMe' ? { ok: true } : { ok: true, result: {
      url: 'https://synthetic-private.invalid/telegram/webhook?token=private', pending_update_count: 12,
      last_error_message: 'secret-bearing upstream exception', last_error_date: 100 } });
  assert.match(text, /Local commands: on/); assert.match(text, /Local owner\/header: configured/);
  assert.match(text, /Webhook: registered/); assert.match(text, /Pending updates: 12/);
  assert.match(text, /Delivery error: recorded/); assert.match(text, /does not verify.*receipt/);
  assert.doesNotMatch(text, /synthetic-private|https:|secret-bearing|789|100/);
});
test('doctor reports missing local pairing even when a webhook is registered', async () => {
  const text = await telegramDoctor(config({ telegram: { enabled: true } }), syntheticSecrets,
    async method => method === 'getMe' ? { ok: true } : { ok: true, result: { url: 'https://synthetic.invalid/telegram/webhook' } });
  assert.match(text, /Local owner\/header: missing/); assert.match(text, /telegram:setup/);
  assert.doesNotMatch(text, /ready|healthy|receipt verified/i);
});
test('doctor contains network exceptions and malformed error fields without retrying or echoing', async () => {
  let count = 0;
  const text = await telegramDoctor(config(), syntheticSecrets, async () => {
    count++; throw new Error('https://synthetic.invalid/botPRIVATE');
  });
  assert.equal(count, 2); assert.match(text, /Bot token: unavailable/); assert.match(text, /Webhook: unavailable/);
  assert.doesNotMatch(text, /PRIVATE|https:/);
  const malformed = await telegramDoctor(config(), syntheticSecrets, async () => ({ ok: true, result: {
    url: 123, pending_update_count: 'synthetic-private-upstream', last_error_message: { privateValue: true } } }));
  assert.match(malformed, /Webhook: unavailable/); assert.doesNotMatch(malformed, /123|synthetic-private-upstream|privateValue/);
});
test('doctor rejects invalid credentials before any provider call', async () => {
  let calls = 0;
  await assert.rejects(telegramDoctor(config(), { ...syntheticSecrets, TELEGRAM_BOT_TOKEN: 'private' }, async () => {
    calls++; return {};
  }), /^SafeError: telegram_secrets_invalid$/);
  assert.equal(calls, 0);
});
