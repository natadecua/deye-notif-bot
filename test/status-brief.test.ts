import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramRequest } from '../src/bot.ts';
import { decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import { initialState } from '../src/alerts.ts';
import { displayTime } from '../src/display-time.ts';
import { config, harness } from './helpers.ts';
import type { Config, Reading } from '../src/types.ts';

// Entirely synthetic owner/chat, token, configuration and cached readings.
const secret = 'synthetic-webhook-secret-1234567890';
function setup(extra: Partial<Config> = {}) {
  const c = config({ telegram: { enabled: true }, ...extra }), h = harness(c);
  const env = { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret };
  const reads: string[] = [], get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  const request = (command = '/status brief', owner = 789, header = secret) => new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': header },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: Math.floor(h.clock.time / 1000),
      from: { id: owner }, chat: { id: 456 }, text: command } }),
  });
  const seed = (reading?: Reading, retryAt = 0) => {
    const s = { ...initialState(c), fullArmed: false, dischargeArmed: false, apiRetryAt: retryAt,
      ...(reading ? { latestReading: reading, lastReadingAt: reading.at } : {}),
      dataHealth: { private: 'synthetic-sensitive-health' }, weather: { private: 'synthetic-sensitive-weather' } };
    const before = JSON.stringify(s); h.kv.data.set('monitor:v1', before); return before;
  };
  const send = (command?: string) => handleTelegramRequest(request(command), env, h.deps);
  return { ...h, c, env, reads, request, seed, send };
}
function unchangedIO(h: ReturnType<typeof setup>, before: string) {
  assert.equal(h.kv.data.get('monitor:v1'), before);
  assert.deepEqual(h.reads, ['telegram:v1', 'monitor:v1']);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']);
  assert.equal(h.calls.length, 1); assert(h.calls[0].url.endsWith('/sendMessage'));
  assert.equal(JSON.parse(String(h.calls[0].init?.body)).reply_markup, undefined);
  assert.doesNotMatch(h.sent[0], /synthetic-sensitive|stationId|https?:\/\/|reduce|pause charging/i);
  assert(h.sent[0].length <= 1000, 'Brief reply must fit within 1000 UTF-16 code units');
}
test('brief status is a readable cached measurement view with the same authenticated IO and no load attribution', async () => {
  const h = setup(), before = h.seed({ at: h.clock.time, soc: 82, dischargeWatts: 315 });
  assert.equal((await h.send()).status, 200);
  assert.match(h.sent[0], /Battery status · brief/);
  assert.match(h.sent[0], /Charge: 82%/); assert.match(h.sent[0], /Battery discharge: 315 W/);
  assert.match(h.sent[0], new RegExp(displayTime(h.clock.time, h.c)));
  assert.match(h.sent[0], /Data age: 0 s.*within freshness limit/);
  assert.match(h.sent[0], /Load breakdown: unknown/); assert.match(h.sent[0], /EV charging: unknown/);
  assert.match(h.sent[0], /Monitoring: enabled/); assert.match(h.sent[0], /Cached only.*cloud data may be delayed/);
  assert.match(h.sent[0], /\/status for details/);
  unchangedIO(h, before);
});
for (const [name, delta, expected] of [
  ['missing', undefined, /No cached reading/],
  ['just beyond the freshness boundary', -600_001, /stale — not current/],
  ['future source instant', 1, /future-dated — not current/],
] as const) test(`brief status labels ${name} without hiding it or polling`, async () => {
  const h = setup(), before = h.seed(delta === undefined ? undefined : { at: h.clock.time + delta, soc: 80, dischargeWatts: 800 });
  await h.send(); assert.match(h.sent[0], expected);
  if (delta !== undefined) assert.doesNotMatch(h.sent[0], /within freshness limit/);
  unchangedIO(h, before);
});
test('brief cooldown status preserves explicit local retry time and never diagnoses the cause', async () => {
  const h = setup({ daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } });
  const retry = h.clock.time + 60_000, before = h.seed({ at: h.clock.time, soc: 80, dischargeWatts: 0 }, retry);
  await h.send(); assert.match(h.sent[0], /Updates: cooldown/);
  assert(h.sent[0].includes(`Next attempt allowed after: ${displayTime(retry, h.c)}`));
  assert.match(h.sent[0], /Cause unknown/); assert.doesNotMatch(h.sent[0], /grid outage|recovered|connection healthy/i);
  unchangedIO(h, before);
});
test('brief status keeps elapsed retry eligibility distinct from recovery', async () => {
  const h = setup(), before = h.seed(undefined, h.clock.time - 1);
  await h.send(); assert.match(h.sent[0], /retry delay elapsed.*scheduled poll may try/i);
  assert.doesNotMatch(h.sent[0], /recovered|connection healthy/i); unchangedIO(h, before);
});
test('brief disabled monitoring suppresses old retry promises and labels configured health paused', async () => {
  const h = setup({ enabled: false, dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const before = h.seed(undefined, h.clock.time + 60_000);
  await h.send(); assert.match(h.sent[0], /Monitoring: disabled/); assert.match(h.sent[0], /Health notices: paused/);
  assert.doesNotMatch(h.sent[0], /Next attempt|Updates: cooldown/); unchangedIO(h, before);
});
test('brief status uses expiring manual EV evidence independently of battery freshness', async () => {
  for (const [status, age, active] of [
    ['charging', 1000, true], ['not_charging', 1000, true], ['charging', SESSION_MS, false], ['charging', -1, false],
  ] as const) {
    const h = setup(), before = h.seed({ at: h.clock.time - 700_000, soc: 55, dischargeWatts: 315 });
    const s = decodeBotState(null, h.c), at = h.clock.time - age;
    s.session = { status, source: 'manual', at, expiresAt: at + SESSION_MS };
    const sessionBefore = structuredClone(s.session); h.kv.data.set('telegram:v1', JSON.stringify(s));
    await h.send(); assert.match(h.sent[0], /stale — not current/);
    if (active) {
      assert.match(h.sent[0], status === 'charging' ? /you confirmed charging/ : /you confirmed not charging/);
      assert.match(h.sent[0], /Source: manual confirmation; expires/);
    } else assert.match(h.sent[0], /EV charging: unknown/);
    assert.deepEqual(JSON.parse(h.kv.data.get('telegram:v1')!).session, sessionBefore);
    unchangedIO(h, before);
  }
});
test('brief reply stays bounded with all profiles, weather and health while avoiding optional raw metadata', async () => {
  const h = setup({ ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 8,
    profiles: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, label: String(i).padStart(2, '0') + 'x'.repeat(38), type: 'amps', amps: 8 + i })) },
    daytimeDischarge: { timeZone: 'America/Argentina/ComodRivadavia', startHour: 6, endHour: 18, minimumMinutes: 15 },
    weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true },
    dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const before = h.seed({ at: h.clock.time, soc: 80, dischargeWatts: Number.MAX_VALUE }, 8.64e15);
  const s = decodeBotState(null, h.c);
  s.session = { status: 'charging', source: 'manual', at: h.clock.time, expiresAt: h.clock.time + SESSION_MS, profileId: 'p0' };
  h.kv.data.set('telegram:v1', JSON.stringify(s));
  await h.send(); assert.match(h.sent[0], /Health notices: on \(configured\).*\/settings/);
  assert.match(h.sent[0], /Weather:.*\/status/); assert.match(h.sent[0], /Reported profile:/);
  assert.doesNotMatch(h.sent[0], /Configured charging profiles|Open-Meteo forecast|Supported settings/);
  unchangedIO(h, before);
});
test('brief status handles an unrenderable cached retry threshold without dropping battery data', async () => {
  const h = setup(), before = h.seed({ at: h.clock.time, soc: 80, dischargeWatts: 315 }, 1e100);
  await h.send(); assert.match(h.sent[0], /Updates: cooldown/); assert.match(h.sent[0], /Retry time unavailable/);
  assert.match(h.sent[0], /Charge: 80%/); assert.doesNotMatch(h.sent[0], /1e\+100/); unchangedIO(h, before);
});
test('brief routing retains authorization before private IO and never expands supported arguments', async () => {
  const h = setup();
  for (const request of [h.request('/status brief', 999), h.request('/status brief', 789, 'synthetic-wrong')]) {
    assert.equal((await handleTelegramRequest(request, h.env, h.deps)).status, 403);
  }
  assert.deepEqual(h.reads, []); assert.equal(h.kv.puts.length, 0); assert.equal(h.calls.length, 0);
  await h.send('/status brief extra'); assert.doesNotMatch(h.sent[0], /Battery status/);
  assert.deepEqual(h.reads, ['telegram:v1']);
});
test('default status keeps the detailed view and help makes the optional brief form discoverable', async () => {
  const h = setup(), before = h.seed({ at: h.clock.time, soc: 82, dischargeWatts: 315 });
  await h.send('/status'); assert.match(h.sent[0], /📡 Cached update status/);
  assert.doesNotMatch(h.sent[0], /Battery status · brief/); unchangedIO(h, before);
  const help = setup(); await help.send('/help'); assert.match(help.sent[0], /\/status brief/);
});
test('detailed and brief views agree that one millisecond beyond freshness is stale', async () => {
  const h = setup(), before = h.seed({ at: h.clock.time - 600_001, soc: 82, dischargeWatts: 315 });
  await h.send('/status'); assert.match(h.sent[0], /stale — do not treat this as current/);
  unchangedIO(h, before);
});
