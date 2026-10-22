import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerCandidates, telegramSetupHint, webhookRegistration } from '../scripts/telegram-onboarding.ts';

// Synthetic sender/chat values and reserved-domain webhook, never a live installation.
const secret = 'synthetic-webhook-secret-1234567890';
test('pairing only offers human senders from the configured chat and deduplicates IDs', () => {
  const message = (id: number, chat = 456, bot = false) => ({ message: { from: { id, is_bot: bot }, chat: { id: chat } } });
  assert.deepEqual(ownerCandidates([message(789), message(789), message(123, 999), message(234, 456, true), {}], '456'), ['789']);
});
test('webhook registration uses the fixed authenticated path, serial callbacks and no dropped updates', () => {
  assert.deepEqual(webhookRegistration('https://monitor.synthetic.invalid/telegram/webhook', '', secret), {
    url: 'https://monitor.synthetic.invalid/telegram/webhook', secret_token: secret,
    allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false,
  });
});
test('webhook registration never takes over another existing integration', () => {
  assert.throws(() => webhookRegistration('https://monitor.synthetic.invalid/telegram/webhook', 'https://other.synthetic.invalid/webhook', secret), /telegram_webhook_already_configured/);
});
test('webhook registration rejects unsafe URLs, extra URL secrets and invalid header secrets', () => {
  for (const url of ['http://monitor.synthetic.invalid/telegram/webhook', 'https://monitor.synthetic.invalid/',
    'https://user:password@monitor.synthetic.invalid/telegram/webhook', 'https://monitor.synthetic.invalid/telegram/webhook?token=synthetic']) {
    assert.throws(() => webhookRegistration(url, '', secret), /telegram_webhook_url_invalid/);
  }
  assert.throws(() => webhookRegistration('https://monitor.synthetic.invalid/telegram/webhook', '', 'short'), /telegram_webhook_secret_invalid/);
});

test('existing webhook recovery explains a dedicated bot without removing another integration', () => {
  const hint = telegramSetupHint('telegram_webhook_already_configured');
  assert.match(hint ?? '', /dedicated bot/i);
  assert.match(hint ?? '', /do not remove/i);
});
test('setup recovery identifies the exact URL, pairing/upload steps and partial menu success', () => {
  const url = telegramSetupHint('telegram_webhook_url_invalid') ?? '';
  assert.match(url, /HTTPS/); assert.match(url, /\/telegram\/webhook/);
  const owner = telegramSetupHint('telegram_owner_setup_required') ?? '';
  assert.match(owner, /npm run telegram:setup/); assert.match(owner, /npm run secrets:upload/);
  const menu = telegramSetupHint('telegram_menu_rejected') ?? '';
  assert.match(menu, /already.*succeeded/i); assert.match(menu, /\/help/);
});
test('unknown setup codes never become reflected exception or URL hints', () => {
  for (const code of ['synthetic-unknown', '__proto__', 'https://synthetic.invalid/botSYNTHETIC_SECRET']) {
    assert.equal(telegramSetupHint(code), undefined);
  }
});
