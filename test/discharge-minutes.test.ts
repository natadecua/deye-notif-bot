import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTelegramCommand, settingsOverrides, resolveSettings } from '../src/telegram-settings.ts';
import { decodeBotState } from '../src/bot-state.ts';
import { handleTelegramRequest } from '../src/bot.ts';
import { runMonitor } from '../src/monitor.ts';
import { config, harness } from './helpers.ts';

// Synthetic installation, credentials, UTC window and intercepted services only.
const daytime = { timeZone: 'UTC', startHour: 6, endHour: 18, minimumMinutes: 15 };
test('owner tolerance command changes only duration, preserves window and explains reset/reconfirmation', () => {
  const c = config({ daytimeDischarge: daytime }), before = structuredClone(c);
  const result = applyTelegramCommand(c, '/discharge_minutes 10');
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.daytimeDischarge, { ...daytime, minimumMinutes: 10 });
  assert.deepEqual(c, before);
  assert.equal((settingsOverrides(result.config) as { dischargeMinutes?: number }).dischargeMinutes, 10);
  assert.match(result.reply, /10 minutes/); assert.match(result.reply, /fresh.*confirmation/i);
  assert.match(result.reply, /\/settings reset/);
  assert.match(applyTelegramCommand(result.config, '/settings').reply, /\/discharge_minutes/);
});
test('tolerance cannot implicitly create a daytime rule or accept invalid/coerced values', () => {
  assert.equal(applyTelegramCommand(config(), '/discharge_minutes 10').changed, false);
  assert.match(applyTelegramCommand(config(), '/discharge_minutes 10').reply, /daytime:setup/);
  for (const value of ['0','121','1.5','-1','NaN','1e1','10 extra']) {
    assert.equal(applyTelegramCommand(config({ daytimeDischarge: daytime }), '/discharge_minutes '+value).changed, false);
  }
});
test('restart accepts only a bounded scalar override without saving zone/window or new categories', () => {
  const c = config({ daytimeDischarge: daytime }), s = decodeBotState(null, c);
  const raw = (value: unknown) => JSON.stringify({ ...s, overrides: { dischargeMinutes: value } });
  const decoded = decodeBotState(raw(10), c);
  assert.equal((decoded.overrides as { dischargeMinutes?: number }).dischargeMinutes, 10);
  for (const value of [0,121,'10',1.5,null]) assert.throws(() => decodeBotState(raw(value), c), /bot_state_invalid/);
  assert.throws(() => decodeBotState(JSON.stringify({ ...s, overrides: { daytimeDischarge: daytime } }), c), /bot_state_invalid/);
});
test('removing the deployed daytime rule does not strand valid preferences or recreate a window', () => {
  const c = config(), s = decodeBotState(null,c);
  const decoded = decodeBotState(JSON.stringify({ ...s, overrides: { dischargeMinutes: 10 } }),c);
  assert.equal((decoded.overrides as { dischargeMinutes?: number }).dischargeMinutes,10);
  assert.equal(resolveSettings(c,decoded.overrides).daytimeDischarge,undefined);
  assert.equal(applyTelegramCommand(c,'/discharge_minutes 10').changed,false);
});
test('authorized command persists once, status reflects it, monitor applies it and reset restores deployment', async () => {
  const c = config({ daytimeDischarge: daytime, telegram: { enabled: true } }), h = harness(c);
  const secret = 'synthetic-webhook-secret-1234567890';
  const env = { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret };
  let id = 1;
  const send = (text: string, owner = 789) => handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: id++,
      message: { date: Math.floor(h.clock.time / 1000), from: { id: owner }, chat: { id: 456 }, text } }) }), env, h.deps);
  assert.equal((await send('/discharge_minutes 10',999)).status,403); assert.equal(h.kv.puts.length,0);
  await send('/discharge_minutes 10'); assert.match(h.sent[0],/10 minutes/);
  assert.deepEqual(h.kv.puts.map(x=>x.key),['telegram:v1']); assert.equal(h.calls.length,1);
  h.advance(3000); await send('/settings'); assert.match(h.sent.at(-1)!,/10 minutes of sampled discharge/);
  h.reading(80,500); await runMonitor(env,h.deps);
  h.advance();h.reading(80,500);await runMonitor(env,h.deps);
  h.advance();h.reading(80,500);await runMonitor(env,h.deps);
  assert(h.sent.some(x=>/10 minutes/.test(x)&&/Battery/.test(x)),'Expected measured alert after ten-minute confirmation');
  h.advance(3000);await send('/settings reset');
  h.advance(3000);await send('/settings');assert.match(h.sent.at(-1)!,/15 minutes of sampled discharge/);
  assert.equal(JSON.parse(h.kv.data.get('telegram:v1')!).overrides,undefined);
});
