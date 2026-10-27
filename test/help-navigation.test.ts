import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramRequest } from '../src/bot.ts';
import { decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import { initialState } from '../src/alerts.ts';
import { config, harness, json } from './helpers.ts';

// Synthetic installation, owner, chat, webhook secret and cached measurements only.
const secret = 'synthetic-webhook-secret-1234567890', MENU_MS = 30 * 60_000;
function setup() {
  const c = config({ telegram: { enabled: true } }), h = harness(c);
  const env = { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret };
  h.hook(url => url.endsWith('/answerCallbackQuery') ? json({ ok: true }) : undefined);
  const reads: string[] = [], get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  const bot = decodeBotState(null, c);
  bot.session = { status: 'charging', source: 'manual', at: h.clock.time, expiresAt: h.clock.time + SESSION_MS };
  bot.overrides = { notifications: { full: false, discharge: true }, fullSoc: 98, fullRearmSoc: 95, dischargeWatts: 300, dischargeRearmWatts: 100 };
  h.kv.data.set('telegram:v1', JSON.stringify(bot));
  const monitor = JSON.stringify({ ...initialState({ ...c, ...bot.overrides }), lastReadingAt: h.clock.time,
    latestReading: { at: h.clock.time, soc: 82, dischargeWatts: 315 }, dataHealth: { private: 'synthetic-sensitive-nav' } });
  h.kv.data.set('monitor:v1', monitor);
  const request = (body: unknown, header = secret) => new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': header }, body: JSON.stringify(body),
  });
  const message = (text: string, update = 1) => ({ update_id: update, message: { message_id: 1,
    date: Math.floor(h.clock.time / 1000), from: { id: 789 }, chat: { id: 456 }, text } });
  const callback = (data: string, update = 2) => ({ update_id: update, callback_query: { id: 'synthetic-nav-callback',
    from: { id: 789 }, data, message: { message_id: 1, chat: { id: 456 }, text: '/discharge off' } } });
  const send = (body: unknown) => handleTelegramRequest(request(body), env, h.deps);
  const clear = () => { h.sent.length = 0; h.calls.length = 0; h.kv.puts.length = 0; reads.length = 0; };
  const unchanged = () => {
    const current = JSON.parse(h.kv.data.get('telegram:v1')!);
    assert.deepEqual(current.session, bot.session); assert.deepEqual(current.overrides, bot.overrides);
    assert.equal(h.kv.data.get('monitor:v1'), monitor);
  };
  return { ...h, c, env, reads, bot, request, message, callback, send, clear, unchanged };
}
type Button = { text: string; callback_data: string };
function menu(h: ReturnType<typeof setup>): Button[] {
  const call = h.calls.find(c => c.url.endsWith('/sendMessage'));
  const body = JSON.parse(String(call?.init?.body));
  return body.reply_markup?.inline_keyboard?.flat() ?? [];
}
function callbackIO(h: ReturnType<typeof setup>, monitorRead: boolean) {
  assert.deepEqual(h.reads, monitorRead ? ['telegram:v1', 'monitor:v1'] : ['telegram:v1']);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
  assert.deepEqual(h.calls.map(c => c.url.slice(c.url.lastIndexOf('/'))), ['/answerCallbackQuery', '/sendMessage']);
  assert.equal(JSON.parse(String(h.calls[1].init?.body)).reply_markup, undefined);
  assert.match(JSON.parse(String(h.calls[0].init?.body)).text, /Menu request processed/);
  assert.doesNotMatch(h.sent[0], /synthetic-sensitive-nav|callback_data|stationId|synthetic-nav-callback/);
  h.unchanged();
}
for (const command of ['/help', '/start']) test(`${command} offers three bounded read-only navigation buttons without charging-menu text`, async () => {
  const h = setup(); await h.send(h.message(command));
  const buttons = menu(h);
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map(b => b.text), ['Quick status', 'Detailed status', 'Settings']);
  assert.deepEqual(buttons.map(b => b.callback_data), [`view:brief:${h.clock.time}`, `view:status:${h.clock.time}`, `view:settings:${h.clock.time}`]);
  assert(buttons.every(b => Buffer.byteLength(b.callback_data) <= 30));
  assert.match(h.sent[0], /Read-only buttons.*30 minutes/); assert.doesNotMatch(h.sent[0], /Which setting are you using/);
  assert.deepEqual(h.reads, ['telegram:v1']); assert.equal(h.calls.length, 1); h.unchanged();
});
for (const [target, expected] of [
  ['brief', /Battery status · brief/], ['status', /📡 Cached update status/], ['settings', /⚙️ Battery notifications/],
] as const) test(`help ${target} navigation reuses its read-only handler and preserves report/preferences/cache`, async () => {
  const h = setup(); await h.send(h.message('/help'));
  const data = menu(h).find(b => b.callback_data.startsWith(`view:${target}:`))?.callback_data;
  assert(data, 'Expected navigation button'); h.advance(2000); h.clear();
  assert.equal((await h.send(h.callback(data))).status, 200);
  assert.match(h.sent[0], expected);
  if (target === 'settings') assert.match(h.sent[0], /Battery full: off at 98%/);
  else { assert.match(h.sent[0], /Charge: 82%/); assert.match(h.sent[0], /you confirmed charging/); }
  callbackIO(h, target !== 'settings');
});
test('expired/future/malformed navigation is fixed guidance and never a charging/settings command', async () => {
  for (const makeData of [
    (now: number) => `view:brief:${now - MENU_MS}`,
    (now: number) => `view:brief:${now - MENU_MS - 1}`,
    (now: number) => `view:brief:${now + 1}`,
    (now: number) => `view:settings:0${now}`,
    (now: number) => `view:charging:${now}`,
    () => 'view:settings:NaN', () => 'view:settings:9999999999999999',
    () => 'view:/settings reset:synthetic-private-payload',
  ]) {
    const h = setup(); await h.send(h.callback(makeData(h.clock.time)));
    assert.match(h.sent[0], /menu.*expired or invalid.*\/help/i);
    assert.doesNotMatch(h.sent[0], /synthetic-private-payload|\/charging|Preferences saved|restored/i);
    callbackIO(h, false);
  }
});
test('navigation is valid just before its deadline and rechecks current battery freshness', async () => {
  const h = setup(), at = h.clock.time; h.advance(MENU_MS - 1);
  await h.send(h.callback(`view:brief:${at}`));
  assert.match(h.sent[0], /stale — not current/); assert.match(h.sent[0], /you confirmed charging/);
  callbackIO(h, true);
});
test('navigation never renews expired manual reports or creates a profile menu', async () => {
  const h = setup(); h.advance(SESSION_MS);
  await h.send(h.callback(`view:brief:${h.clock.time}`));
  assert.match(h.sent[0], /EV charging: unknown/); callbackIO(h, true);
});
test('navigation shares duplicate/rate limits without extra replies or session renewal', async () => {
  const h = setup(), payload = h.callback(`view:settings:${h.clock.time}`);
  await h.send(payload); assert.match(h.sent[0], /⚙️ Battery notifications/); h.clear();
  await h.send(payload);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0); h.clear();
  await h.send(h.callback(`view:settings:${h.clock.time}`, 3));
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0); h.unchanged();
});
test('navigation still replies if callback acknowledgement fails, with one bounded attempt per method', async () => {
  const h = setup(); h.hook(url => url.endsWith('/answerCallbackQuery') ? json({ ok: false }, 500) : undefined);
  await h.send(h.callback(`view:brief:${h.clock.time}`));
  assert.match(h.sent[0], /Battery status · brief/); callbackIO(h, true);
});
test('navigation authentication precedes all private reads and writes', async () => {
  const h = setup(), body = h.callback(`view:brief:${h.clock.time}`);
  assert.equal((await handleTelegramRequest(h.request(body, 'synthetic-wrong'), h.env, h.deps)).status, 403);
  body.callback_query.from.id = 999; assert.equal((await h.send(body)).status, 403);
  body.callback_query.from.id = 789; body.callback_query.message.chat.id = 999;
  assert.equal((await h.send(body)).status, 403);
  assert.deepEqual(h.reads, []); assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0); h.unchanged();
});
test('last command allowance cannot navigate or offer new buttons', async () => {
  const h = setup(), state = { ...h.bot, used: 47, day: new Date(h.clock.time).toISOString().slice(0, 10) };
  h.kv.data.set('telegram:v1', JSON.stringify(state));
  await h.send(h.callback(`view:brief:${h.clock.time}`));
  assert.match(h.sent[0], /Daily command limit/); assert.deepEqual(h.reads, ['telegram:v1']);
  assert.equal(JSON.parse(h.kv.data.get('telegram:v1')!).used, 48); h.unchanged();
  assert.equal(JSON.parse(String(h.calls.at(-1)?.init?.body)).reply_markup, undefined);
});
test('failed replay checkpoint prevents navigation acknowledgement and reply', async () => {
  const h = setup(); h.kv.failOnPut = () => true;
  assert.equal((await h.send(h.callback(`view:brief:${h.clock.time}`))).status, 503);
  assert.equal(h.calls.length, 0); h.unchanged();
});
