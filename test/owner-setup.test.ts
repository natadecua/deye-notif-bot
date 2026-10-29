import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwnerSetup, configureTelegramOwner, type SetupPrompts, type SetupServices } from '../scripts/owner-setup.ts';
import { SafeError } from '../src/errors.ts';
import { BASE_TIME, config, syntheticSecrets } from './helpers.ts';

// Every credential, account/station/owner identifier and service result is synthetic.
function prompts(answers: unknown[]) {
  const remaining = [...answers], printed: string[] = [], asked: string[] = [];
  const next = async (message: string) => {
    asked.push(message); assert(remaining.length > 0, `Unexpected prompt: ${message}`);
    return remaining.shift() as never;
  };
  const p: SetupPrompts = { hidden: next, checklist: next, choose: next, confirm: next, number: next, text: next,
    print: text => printed.push(text) };
  return { p, remaining, printed, asked };
}
function services(raw: Record<string, unknown> = { batterySOC: 80, dischargePower: 500, lastUpdateTime: new Date(BASE_TIME).toISOString() }) {
  let messages = 0;
  const io: SetupServices = { now: () => BASE_TIME,
    deye: () => ({ stations: async () => ({ total: 1, stations: [{ id: 123, name: 'Synthetic station' }] }), latest: async () => raw }),
    preview: () => {}, testTelegram: async () => { messages++; } };
  return { io, messages: () => messages };
}
const finish = ['123', 'W', 'iso-offset', true, ['full', 'discharge'], false, false, true, false];

test('replacing Deye credentials preserves the Telegram owner binding and removes obsolete Deye login context', async () => {
  const original = config({ telegram: { enabled: true } });
  const existing = { ...syntheticSecrets, DEYE_ACCOUNT_FIELD: 'mobile', DEYE_COUNTRY_CODE: '63', DEYE_COMPANY_ID: '99',
    TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret-1234567890', TELEGRAM_BOT_USERNAME: 'synthetic_bot' };
  const before = structuredClone(existing);
  const h = prompts(['eu', false, 'synthetic-new-app', 'synthetic-new-secret', 'email', 'new@example.invalid', 'synthetic-password', '', ...finish]);
  const result = await runOwnerSetup(original, existing, h.p, services().io);
  for (const key of ['TELEGRAM_OWNER_ID', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME'] as const) {
    assert.equal(result.secrets[key], existing[key]);
  }
  assert.equal(result.secrets.DEYE_ACCOUNT_FIELD, 'email');
  assert.equal(result.secrets.DEYE_COMPANY_ID, undefined); assert.equal(result.secrets.DEYE_COUNTRY_CODE, undefined);
  assert.equal(result.secrets.DEYE_APP_ID, 'synthetic-new-app');
  assert.match(result.secrets.DEYE_PASSWORD_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(existing, before); assert.equal(h.remaining.length, 0);
});

test('setup returns confirmed choices without mutating inputs and separates a Telegram acknowledgement from deployment', async () => {
  const source = config({ enabled: false, measurementsConfirmed: false }), before = structuredClone(source);
  const h = prompts(['eu', true, ...finish.slice(0, -1), true]), s = services();
  const result = await runOwnerSetup(source, syntheticSecrets, h.p, s.io);
  assert.equal(result.config.enabled, true); assert.equal(result.config.measurementsConfirmed, true);
  assert.deepEqual(source, before); assert.equal(s.messages(), 1);
  assert.match(h.printed.join('\n'), /API accepted/); assert.doesNotMatch(h.printed.join('\n'), /deployment completed|receipt confirmed/i);
  assert.equal(h.remaining.length, 0);
});

test('the full setup journey supports explicitly confirmed kW measurements and nominal EV profiles', async () => {
  const source = config({ enabled: false, measurementsConfirmed: false });
  const h = prompts(['eu', true, '123', 'kW', 'iso-offset', true, ['full', 'discharge'], false,
    true, '1', 230, 8, '8-13-max', 7000, true, true, false]);
  const result = await runOwnerSetup(source, syntheticSecrets, h.p, services({ batterySOC: 80,
    dischargePower: 0.5, lastUpdateTime: new Date(BASE_TIME).toISOString() }).io);
  assert.equal(result.config.powerUnit, 'kW'); assert.equal(result.config.ev.profiles?.length, 3);
  assert.match(h.printed.join('\n'), /500 W discharge/);
  assert.match(h.printed.join('\n'), /nominal estimate/);
  assert.equal(source.ev.enabled, false); assert.equal(h.remaining.length, 0);
});

test('changing the Telegram bot or chat requires a new owner pairing instead of reusing another binding', async () => {
  for (const change of ['bot', 'chat']) {
    const source = config({ telegram: { enabled: true } });
    const existing = { ...syntheticSecrets, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret-1234567890',
      TELEGRAM_BOT_USERNAME: 'synthetic_bot' };
    const h = prompts(['eu', true, ...finish.slice(0, -2), false,
      change === 'bot' ? '999:synthetic-new-token' : syntheticSecrets.TELEGRAM_BOT_TOKEN,
      change === 'chat' ? '999' : syntheticSecrets.TELEGRAM_CHAT_ID, false]);
    const result = await runOwnerSetup(source, existing, h.p, services().io);
    assert.equal(result.config.telegram?.enabled, false);
    assert.equal(result.secrets.TELEGRAM_OWNER_ID, undefined);
    assert.equal(result.secrets.TELEGRAM_WEBHOOK_SECRET, undefined);
    assert.equal(result.secrets.TELEGRAM_BOT_USERNAME, undefined);
    assert.match(h.printed.join('\n'), /telegram:setup/);
  }
});

for (const [reason, raw, expected] of [
  ['missing measurement', { batterySOC: 80, lastUpdateTime: new Date(BASE_TIME).toISOString() }, 'measurement_missing_or_invalid'],
  ['ambiguous timestamp', { batterySOC: 80, dischargePower: 500, lastUpdateTime: '2026-10-21 12:00:00' }, 'timestamp_ambiguous'],
  ['stale reading', { batterySOC: 80, dischargePower: 500, lastUpdateTime: new Date(BASE_TIME - 700_000).toISOString() }, 'reading_stale'],
] as const) {
  test(`setup stops on ${reason} before preferences, Telegram or persistence`, async () => {
    const source = config({ enabled: false }), before = structuredClone(source), s = services(raw);
    const h = prompts(['eu', true, '123', 'W', 'iso-offset']);
    await assert.rejects(runOwnerSetup(source, syntheticSecrets, h.p, s.io), new RegExp(expected));
    assert.deepEqual(source, before); assert.equal(s.messages(), 0); assert.equal(h.remaining.length, 0);
  });
}

test('unconfirmed units cannot enable setup or send a Telegram test', async () => {
  const source = config({ enabled: false }), s = services(), h = prompts(['eu', true, '123', 'W', 'iso-offset', false]);
  await assert.rejects(runOwnerSetup(source, syntheticSecrets, h.p, s.io), /measurements_not_confirmed/);
  assert.equal(source.enabled, false); assert.equal(s.messages(), 0);
});

test('wrong-region empty stations and rejected credentials leave local settings untouched', async () => {
  for (const reason of ['region', 'credentials']) {
    const source = config({ enabled: false }), before = structuredClone(source), s = services();
    s.io.deye = () => ({ stations: async () => {
      if (reason === 'credentials') throw new SafeError('deye_auth_rejected');
      return { total: 0, stations: [] };
    }, latest: async () => { throw new Error('Unexpected synthetic latest request'); } });
    await assert.rejects(runOwnerSetup(source, syntheticSecrets, prompts(['eu', true]).p, s.io),
      new RegExp(reason === 'region' ? 'no_stations_in_selected_region_or_company' : 'deye_auth_rejected'));
    assert.deepEqual(source, before); assert.equal(s.messages(), 0);
  }
});

test('owner setup preserves another webhook, avoids getUpdates and rejects missing sender authorization', async () => {
  const methods: string[] = [], source = config(), h = prompts(['']);
  await assert.rejects(configureTelegramOwner(source, syntheticSecrets, h.p, {
    call: async method => { methods.push(method); return { ok: true, result: { url: 'https://other.synthetic.invalid/webhook' } }; },
    newSecret: () => { throw new Error('Unexpected synthetic secret generation'); },
  }), /telegram_owner_setup_required/);
  assert.deepEqual(methods, ['getWebhookInfo']); assert.equal(source.telegram?.enabled, false);
});
