import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefSnapshot } from '../src/snapshot.ts';
import { handleTelegramRequest } from '../src/bot.ts';
import { initialState } from '../src/alerts.ts';
import { decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import { config, harness, BASE_TIME } from './helpers.ts';
import type { State } from '../src/types.ts';

// Synthetic configuration, accounts, readings and reports only; no live services.
const c = config({ telegram: { enabled: true } }), now = BASE_TIME;
const seed = (context = c): State => ({ ...initialState(context), lastReadingAt: now,
  latestReading: { at: now, soc: 82, dischargeWatts: 315 } });
const report = (status: 'charging' | 'not_charging' = 'charging', at = now, context = c) => ({
  ...decodeBotState(null, context), session: { status, source: 'manual' as const, at, expiresAt: at + SESSION_MS },
});
const expected = '🔋 Battery status · brief\nCharge: 82% · Battery discharge: 315 W\n' +
  'Reading: 2026-10-21 12:00:00 UTC\nData age: 0 s (within freshness limit)\n' +
  'Load breakdown: unknown.\nMonitoring: enabled.\nUpdates: no retry delay recorded.\n' +
  'Health notices: off.\nCached only; cloud data may be delayed. /status for details.\n\nEV charging: unknown';
function bounded(text: string) {
  assert(text.length <= 1000, `snapshot length ${text.length}`);
  assert.doesNotMatch(text, /synthetic-private|stationId|https?:\/\/|reduce|pause charging|EV caused|estimated headroom/i);
}

test('shared brief snapshot preserves the current complete reply including manual-unknown evidence', () => {
  assert.equal(renderBriefSnapshot(seed(), c, now), expected);
});

test('recap rendering has a fixed cached-snapshot title without scheduling or charging advice', () => {
  const text = renderBriefSnapshot(seed(), c, now, undefined, { kind: 'recap' });
  assert.equal(text, expected.replace('🔋 Battery status · brief', '🔋 Battery snapshot · daily recap'));
  bounded(text);
});

test('command-disabled snapshots omit dead links and ignore supplied manual-report snapshots', () => {
  for (const telegram of [undefined, { enabled: false }]) {
    const context = config({ telegram, weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true },
      dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
    for (const kind of ['status', 'recap'] as const) {
      const text = renderBriefSnapshot(seed(context), context, now, report(), { kind });
      assert.match(text, /Charge: 82%/); assert.match(text, /Health notices: on \(configured\)\./);
      assert.match(text, /EV charging: unknown/); assert.doesNotMatch(text, /\/(?:status|settings)|you confirmed|Reported profile/);
      bounded(text);
    }
  }
});

test('enabled commands keep existing detail links without decoding optional weather or health metadata', () => {
  const context = config({ telegram: { enabled: true }, weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true },
    dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const state = seed(context);
  for (const key of ['weather', 'dataHealth']) Object.defineProperty(state, key, {
    get() { throw new Error('synthetic-private-metadata-must-not-be-read'); },
  });
  const text = renderBriefSnapshot(state, context, now);
  assert.match(text, /Health notices: on \(configured\); \/settings for policy/);
  assert.match(text, /Weather: \/status for cached forecast/); bounded(text);
});

test('exact source age is checked before display rounding for fresh, stale and future snapshots', () => {
  for (const [delta, quality] of [[0, 'within freshness limit'], [-600000, 'within freshness limit'],
    [-600001, 'stale — not current'], [1, 'future-dated — not current']] as const) {
    const state = seed(); state.latestReading!.at = now + delta; state.lastReadingAt = now + delta;
    const text = renderBriefSnapshot(state, c, now);
    assert(text.includes(quality)); assert.match(text, /Reading:/); bounded(text);
  }
});

test('missing cache retains update/health context and separately expiring manual evidence', () => {
  const state = initialState(c); state.apiRetryAt = now + 60000;
  const text = renderBriefSnapshot(state, c, now, report());
  assert.match(text, /No cached reading yet/); assert.match(text, /Updates: cooldown.*Cause unknown/);
  assert.match(text, /you confirmed charging/); assert.match(text, /Source: manual confirmation; expires/); bounded(text);
});

test('manual charging and stopped reports expire independently from stale battery data without renewal', () => {
  const state = seed(); state.latestReading!.at = state.lastReadingAt = now - 700000;
  for (const [status, at, active] of [['charging', now - 1000, true], ['not_charging', now - 1000, true],
    ['charging', now - SESSION_MS, false], ['charging', now + 1, false]] as const) {
    const bot = report(status, at), before = JSON.stringify(bot);
    const text = renderBriefSnapshot(state, c, now, bot);
    assert.match(text, /stale — not current/);
    if (active) {
      assert(text.includes(status === 'charging' ? 'you confirmed charging' : 'you confirmed not charging'));
      assert.match(text, /Source: manual confirmation; expires/);
    } else assert.match(text, /EV charging: unknown/);
    assert.equal(JSON.stringify(bot), before); bounded(text);
  }
});

test('recap display can use an explicit zone without adding a daytime policy or changing source instants', () => {
  const state = seed(), bot = report();
  state.apiRetryAt = now + 60000;
  const before = JSON.stringify({ state, c, bot });
  const text = renderBriefSnapshot(state, c, now, bot, { kind: 'recap', timeZone: 'Asia/Manila' });
  assert.match(text, /Reading: 2026-10-21 20:00:00 Asia\/Manila \(UTC\+08:00\)/);
  assert.match(text, /allowed after: 2026-10-21 20:01:00 Asia\/Manila/);
  assert.match(text, /expires 2026-10-22 02:00:00 Asia\/Manila/);
  assert.equal(JSON.stringify({ state, c, bot }), before); assert.equal(c.daytimeDischarge, undefined);
  assert.equal(renderBriefSnapshot(seed(), c, now, undefined, { timeZone: 'Asia/Manila' }), expected);
  bounded(text);
});

test('source and manual-expiry labels retain their different daylight-saving offsets', () => {
  const instant = Date.parse('2026-11-01T05:30:00Z'), state = seed();
  state.latestReading!.at = state.lastReadingAt = instant;
  const text = renderBriefSnapshot(state, c, instant, report('charging', instant), { kind: 'recap', timeZone: 'America/New_York' });
  assert.match(text, /Reading: 2026-11-01 01:30:00 America\/New_York \(UTC-04:00\)/);
  assert.match(text, /expires 2026-11-01 06:30:00 America\/New_York \(UTC-05:00\)/); bounded(text);
});

test('disabled monitoring suppresses retry promises and keeps configured health paused', () => {
  const context = config({ enabled: false, telegram: { enabled: true }, dataHealth: {
    enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const state = seed(context); state.apiRetryAt = now + 60000;
  const text = renderBriefSnapshot(state, context, now);
  assert.match(text, /Monitoring: disabled/); assert.match(text, /Health notices: paused \(configured on\)/);
  assert.doesNotMatch(text, /Next attempt|Updates: cooldown/); bounded(text);
});

test('unrenderable source, retry or manual-expiry times use fixed safe text without hiding evidence', () => {
  const state = seed(); state.latestReading!.at = state.lastReadingAt = 1e100; state.apiRetryAt = 1e100;
  let text = renderBriefSnapshot(state, c, now);
  assert.match(text, /Reading: time unavailable/); assert.match(text, /Retry time unavailable/);
  assert.match(text, /future-dated — not current/); bounded(text);
  const edge = 8.64e15 - 1000, bot = report('charging', edge - 1000);
  text = renderBriefSnapshot(seed(), c, edge, bot);
  assert.match(text, /Source: manual confirmation; expires time unavailable/);
  assert.match(text, /you confirmed charging/); bounded(text);
});

test('both view kinds stay within the complete 1000-unit bound with maximum valid optional context', () => {
  const context = config({ telegram: { enabled: true }, ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 8,
    profiles: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, label: String(i).padStart(2, '0') + 'x'.repeat(38), type: 'amps', amps: 8 + i })) },
    daytimeDischarge: { timeZone: 'America/Argentina/ComodRivadavia', startHour: 6, endHour: 18, minimumMinutes: 15 },
    weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true },
    dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const state = seed(context); state.latestReading!.dischargeWatts = Number.MAX_VALUE; state.apiRetryAt = 8.64e15;
  const bot = report('charging', now, context); Object.assign(bot.session, { profileId: 'p0' });
  const before = JSON.stringify({ state, context, bot });
  for (const kind of ['status', 'recap'] as const) {
    const text = renderBriefSnapshot(state, context, now, bot, { kind });
    assert.match(text, /Reported profile:/); assert.match(text, /Health notices: on \(configured\)/);
    assert.match(text, /Source: manual confirmation/); assert.match(text, /Load breakdown: unknown/); bounded(text);
  }
  assert.equal(JSON.stringify({ state, context, bot }), before);
});

const secret = 'synthetic-webhook-secret-1234567890';
function webhookSetup() {
  const h = harness(c), reads: string[] = [], get = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  const before = JSON.stringify(seed()); h.kv.data.set('monitor:v1', before);
  const request = (command = '/status brief', owner = 789) => new Request('https://synthetic.invalid/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 1, message: { date: Math.floor(now / 1000), from: { id: owner }, chat: { id: 456 }, text: command } }),
  });
  return { ...h, reads, before, request, env: { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret } };
}

test('existing brief webhook reply and IO are unchanged before and after extraction', async () => {
  const h = webhookSetup(); assert.equal((await handleTelegramRequest(h.request(), h.env, h.deps)).status, 200);
  assert.equal(h.sent[0], expected); assert.deepEqual(h.reads, ['telegram:v1', 'monitor:v1']);
  assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']); assert.equal(h.calls.length, 1);
  assert.equal(h.kv.data.get('monitor:v1'), h.before);
});

test('existing authorization and detailed status stay separate from pure rendering', async () => {
  const h = webhookSetup();
  assert.equal((await handleTelegramRequest(h.request('/status brief', 999), h.env, h.deps)).status, 403);
  assert.deepEqual(h.reads, []); assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
  await handleTelegramRequest(h.request('/status'), h.env, h.deps);
  assert.match(h.sent[0], /📡 Cached update status/); assert.match(h.sent[0], /EV charging: unknown/);
  assert.doesNotMatch(h.sent[0], /Battery status · brief|daily recap/);
  assert.equal(h.kv.data.get('monitor:v1'), h.before); assert.equal(h.calls.length, 1);
});
