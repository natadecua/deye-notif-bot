import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramRequest } from '../src/bot.ts';
import { runMonitor } from '../src/monitor.ts';
import { validateConfig } from '../src/config.ts';
import { BASE_TIME, config, harness, json } from './helpers.ts';

// Entirely synthetic installation, sender/chat identifiers, token and webhook secret.
const secret = 'synthetic-webhook-secret-1234567890';
function setup() {
  const h = harness(config({ telegram: { enabled: true } } as never));
  const env = { ...h.env, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_ID: '789' };
  h.hook(url => url.endsWith('/answerCallbackQuery') ? json({ ok: true }) : undefined);
  function message(text: string, id = 1) {
    return { update_id: id, message: { message_id: id, date: Math.floor(h.clock.time / 1000),
      from: { id: 789 }, chat: { id: 456 }, text } };
  }
  function request(body: unknown, header = secret, path = '/telegram/webhook') {
    return new Request(`https://synthetic.invalid${path}`, { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': header, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  const send = (body: unknown) => handleTelegramRequest(request(body), env, h.deps);
  return { ...h, env, message, request, send };
}
const botState = (h: ReturnType<typeof setup>) => JSON.parse(h.kv.data.get('telegram:v1')!);

test('commands are opt-in and all unrelated HTTP routes remain unavailable', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(h.request(h.message('/status')), { ...h.env, MONITOR_CONFIG: config() }, h.deps)).status, 404);
  assert.equal((await handleTelegramRequest(h.request({}, secret, '/'), h.env, h.deps)).status, 404);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});
test('webhook authenticates secret, chat and sender before any API call or write', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(h.request(h.message('/status'), 'synthetic-wrong'), h.env, h.deps)).status, 403);
  for (const field of ['from', 'chat'] as const) {
    const update = h.message('/charging'); update.message[field].id = 999;
    assert.equal((await h.send(update)).status, 403);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});
test('/help and /start explain supported commands and manual charging evidence', async () => {
  for (const command of ['/help', '/start']) {
    const h = setup(); assert.equal((await h.send(h.message(command))).status, 200);
    assert.match(h.sent[0], /\/status/); assert.match(h.sent[0], /\/charging/);
    assert.match(h.sent[0], /\/stopped/); assert.match(h.sent[0], /manual/i);
  }
});
test('/status uses cached telemetry, labels its age and never polls Deye or changes battery latches', async () => {
  const h = setup(); h.reading(82, 800); await runMonitor(h.env, h.deps);
  const before = h.kv.data.get('monitor:v1'); h.calls.length = 0; h.sent.length = 0;
  assert.equal((await h.send(h.message('/status'))).status, 200);
  assert.match(h.sent[0], /82%/); assert.match(h.sent[0], /800 W/);
  assert.match(h.sent[0], /Reading:/); assert.match(h.sent[0], /age/i);
  assert.match(h.sent[0], /EV charging: unknown/i);
  assert.match(h.sent[0], /Battery discharge: 800 W/);
  assert.match(h.sent[0], /Load breakdown: unknown/);
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
});
test('/status explains absent and stale readings instead of presenting them as live', async () => {
  const missing = setup(); await missing.send(missing.message('/status'));
  assert.match(missing.sent[0], /No cached reading/i);
  const stale = setup(); stale.reading(80, 0); await runMonitor(stale.env, stale.deps);
  stale.advance(700_000); await stale.send(stale.message('/status'));
  assert.match(stale.sent[0], /stale/i);
});

test('/status shows configured 8 A, 13 A and MAX reference levels without classifying a 315 W load as house-only', async () => {
  // Synthetic, explicitly confirmed 230 V single-phase profiles; MAX is owner-entered.
  const h = setup();
  const c = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
    phases: 1, voltage: 230, minimumAmps: 6, profiles: [
      { id: '8a', label: '8 A', type: 'amps', amps: 8 },
      { id: '13a', label: '13 A', type: 'amps', amps: 13 },
      { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
    ] } });
  h.env.MONITOR_CONFIG = c;
  h.reading(80, 315); await runMonitor(h.env, h.deps);
  const before = h.kv.data.get('monitor:v1'); h.calls.length = 0;
  await h.send(h.message('/status'));
  const text = h.sent[0];
  assert.match(text, /Your configured settings \(nominal estimates\):\n8 A \(~1\.84 kW\)\n13 A \(~2\.99 kW\)\nMAX: ~7 kW/);
  assert.match(text, /Battery discharge does not measure EV power; solar or grid may supply part of charging demand/);
  assert.match(text, /Battery discharge: 315 W/);
  assert.match(text, /EV charging: unknown/);
  assert.doesNotMatch(text, /normal house|house.only|EV detected|32 A|30\.4 A/);
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
  h.env.MONITOR_CONFIG = { ...c, ev: { ...c.ev, enabled: false } };
  h.advance(3000); await h.send(h.message('/status', 2));
  assert.doesNotMatch(h.sent.at(-1)!, /Your configured settings|1\.84 kW|7 kW/);
});
test('/charging records an expiring manual confirmation, not measured EV status', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  assert.equal(botState(h).session.status, 'charging');
  assert.equal(botState(h).session.source, 'manual');
  assert.equal(botState(h).session.expiresAt, BASE_TIME + 6 * 3600_000);
  assert.match(h.sent[0], /you confirmed/i); assert.doesNotMatch(h.sent[0], /detected/i);
  h.advance(6 * 3600_000); await h.send(h.message('/status', 2));
  assert.match(h.sent.at(-1)!, /EV charging: unknown/i);
});
test('/stopped records the user report and does not control equipment', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  h.advance(3000); await h.send(h.message('/stopped', 2));
  assert.equal(botState(h).session.status, 'not_charging');
  assert.match(h.sent.at(-1)!, /you confirmed/i);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage')));
});
test('confirmation buttons record manual status and acknowledge the Telegram callback', async () => {
  const h = setup();
  const response = await h.send({ update_id: 1, callback_query: { id: 'synthetic-callback', from: { id: 789 },
    message: { date: BASE_TIME / 1000, chat: { id: 456 } }, data: `charging:yes:${BASE_TIME}` } });
  assert.equal(response.status, 200); assert.equal(botState(h).session.status, 'charging');
  assert(h.calls.some(c => c.url.endsWith('/answerCallbackQuery')));
  assert.match(h.sent[0], /you confirmed/i);
});
test('old confirmation buttons do not renew or start a charging session', async () => {
  const h = setup();
  await h.send({ update_id: 1, callback_query: { id: 'synthetic-old', from: { id: 789 },
    message: { date: BASE_TIME / 1000, chat: { id: 456 } }, data: `charging:yes:${BASE_TIME - 31 * 60_000}` } });
  assert.equal(botState(h).session, undefined);
  assert.match(h.sent[0], /expired/i);
});
test('duplicate/out-of-order updates cannot repeat writes, replies or session confirmation', async () => {
  const h = setup(); const update = h.message('/charging', 4);
  await h.send(update); const stored = h.kv.data.get('telegram:v1');
  h.advance(3000); await h.send(update); await h.send(h.message('/stopped', 3));
  assert.equal(h.sent.length, 1); assert.equal(h.kv.puts.length, 1);
  assert.equal(h.kv.data.get('telegram:v1'), stored);
});
test('commands persist before sending, bound bursts and never write monitor state', async () => {
  const h = setup(); await h.send(h.message('/charging'));
  await h.send(h.message('/stopped', 2));
  assert.equal(h.kv.puts.length, 1); assert.equal(h.sent.length, 1);
  assert(h.kv.puts.every(p => p.key === 'telegram:v1'));
  const failure = setup(); failure.kv.failOnPut = () => true;
  assert.equal((await failure.send(failure.message('/charging'))).status, 503);
  assert.equal(failure.calls.length, 0);
});
test('command transport failures are bounded after persistence rather than replaying mutations', async () => {
  const h = setup(); h.hook(url => url.endsWith('/sendMessage') ? json({}, 503) : undefined);
  const update = h.message('/charging'); await h.send(update); h.advance(3000); await h.send(update);
  assert.equal(h.calls.length, 1); assert.equal(botState(h).session.status, 'charging');
});
test('daily command budget includes a final notice and prevents further state writes', async () => {
  const h = setup();
  for (let id = 1; id <= 50; id++) { await h.send(h.message('/help', id)); h.advance(3000); }
  assert.equal(h.kv.puts.length, 48); assert.equal(h.sent.length, 48);
  assert.match(h.sent.at(-1)!, /daily command limit/i);
  h.advance(24 * 3600_000); await h.send(h.message('/help', 51));
  assert.equal(h.kv.puts.length, 49);
});
test('invalid/oversized payloads and stale messages cannot mutate settings', async () => {
  const h = setup();
  assert.equal((await handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: '{synthetic-bad',
  }), h.env, h.deps)).status, 400);
  assert.equal((await h.send({ padding: 'x'.repeat(9000) })).status, 413);
  const old = h.message('/charging'); old.message.date -= 3600;
  assert.equal((await h.send(old)).status, 200);
  assert.equal(h.kv.puts.length, 0); assert.equal(h.calls.length, 0);
});
test('in-chat preferences apply to subsequent Cron runs without restoring muted old alerts', async () => {
  const h = setup(); await h.send(h.message('/full off'));
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /saved/i);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).fullArmed, false);
  h.advance(3000); await h.send(h.message('/full on', 2));
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2);
});
test('enabled discharge prompts offer yes/no buttons without asserting an EV cause', async () => {
  const h = setup();
  h.env.MONITOR_CONFIG = config({ telegram: { enabled: true },
    ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 6 } } as never);
  h.reading(80, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, 600); await runMonitor(h.env, h.deps);
  const call = h.calls.find(c => c.url.endsWith('/sendMessage'))!;
  const payload = JSON.parse(String(call.init?.body));
  assert.match(payload.text, /If the EV is charging/);
  assert.match(payload.text, /Household \/ EV split: unknown/);
  assert.match(payload.text, /EV charging: unknown/);
  assert.equal(payload.text.match(/EV charging:/g).length, 1);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "Yes, I'm charging");
  assert.match(payload.reply_markup.inline_keyboard[0][0].callback_data, /^charging:yes:/);
});

for (const report of ['charging', 'not_charging', 'expired', 'future'] as const) {
  test(`discharge alert keeps ${report} manual evidence separate from the unknown household/EV split`, async () => {
    const h = setup();
    h.env.MONITOR_CONFIG = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true,
      phases: 1, voltage: 230, minimumAmps: 6,
      profiles: [{ id: 'low', label: 'Low', type: 'amps', amps: 8 }] } });
    await h.send(h.message(report === 'not_charging' ? '/stopped' : '/charging'));
    if (report === 'expired') h.advance(6 * 3600_000);
    if (report === 'future') h.advance(-60_000);
    h.sent.length = 0;
    h.reading(80, 315); await runMonitor(h.env, h.deps);
    h.advance(10_000); h.reading(80, 315); await runMonitor(h.env, h.deps);
    assert.equal(h.sent.length, 1);
    const text = h.sent[0];
    assert.match(text, /Battery discharge: 315 W/);
    assert.match(text, /Load breakdown: unknown/);
    assert.match(text, /Household \/ EV split: unknown/);
    assert.equal(text.match(/EV charging:/g)!.length, 1);
    if (report === 'charging' || report === 'not_charging') {
      assert.match(text, new RegExp(`you confirmed ${report === 'charging' ? 'charging' : 'not charging'}`));
      assert.match(text, /Source: manual confirmation; expires/);
    } else {
      assert.match(text, /EV charging: unknown/);
      assert.doesNotMatch(text, /you confirmed/);
    }
    if (report === 'not_charging') {
      assert.doesNotMatch(text, /consider reducing|Approximate reduction|Your configured settings|pause charging|check the car/);
      assert.match(text, /Update your charging report/);
    } else {
      assert.match(text, /If the EV is charging/);
      assert.match(text, /Your configured settings/);
    }
  });
}
test('Telegram opt-in configuration must be explicitly valid', () => {
  for (const telegram of [null, [], {}, { enabled: 'true' }]) {
    assert.throws(() => validateConfig({ ...config(), telegram }), /telegram_preferences_invalid/);
  }
});

test('commands addressed to another bot are ignored, while the configured username works', async () => {
  const h = setup(); h.env.TELEGRAM_BOT_USERNAME = 'synthetic_bot';
  await h.send(h.message('/charging@another_bot'));
  assert.equal(h.kv.puts.length, 0);
  await h.send(h.message('/charging@synthetic_bot', 2));
  assert.equal(botState(h).session.status, 'charging');
});
test('settings reset clears only chat preferences and unsupported profiles never start a session', async () => {
  const h = setup(); await h.send(h.message('/full off'));
  assert.equal(botState(h).overrides.notifications.full, false);
  h.advance(3000); await h.send(h.message('/settings reset', 2));
  assert.equal(botState(h).overrides, undefined);
  h.advance(3000); await h.send(h.message('/charging unsupported', 3));
  assert.equal(botState(h).session, undefined);
  assert.match(h.sent.at(-1)!, /Unknown profile/);
});
