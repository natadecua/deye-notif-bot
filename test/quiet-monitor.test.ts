import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, harness, json, BASE_TIME } from './helpers.ts';
import { initialState } from '../src/alerts.ts';
import { validateConfig } from '../src/config.ts';
import { runMonitor } from '../src/monitor.ts';
import { advanceDataHealth, settleDataHealthNotice } from '../src/data-health.ts';
import { advanceDailyRecap } from '../src/daily-recap.ts';
import { handleTelegramRequest } from '../src/bot.ts';
import type { Config } from '../src/types.ts';
import type { QuietCategories } from '../src/quiet-hours.ts';

// Synthetic policies, records, accounts and intercepted services only.
const minute = 60000, start = BASE_TIME, none = { full: false, discharge: false, health: false, recap: false };
const quiet = (flags: Partial<QuietCategories> = { full: true }, first = 720, end = 780) => ({ enabled: true,
  timeZone: 'UTC', startMinute: first, endMinute: end, categories: { ...none, ...flags }, suppressionConfirmed: true });
const settings = (flags: Partial<QuietCategories> = { full: true }, extra: Partial<Config> = {}) =>
  config({ ...extra, quietHours: quiet(flags) } as never);
const saved = (h: ReturnType<typeof harness>) => JSON.parse(h.kv.data.get('monitor:v1')!);
function setup(c = settings(), at = start) {
  const h = harness(c), reads: string[] = [], times: number[] = []; h.clock.time = at;
  const get = h.kv.get.bind(h.kv), put = h.kv.put.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  h.kv.put = async (key, value) => { if (key === 'monitor:v1') times.push(h.clock.time); return put(key, value); };
  return { ...h, reads, times };
}
function seed(h: ReturnType<typeof harness>, extra: Record<string, unknown>) {
  h.kv.data.set('monitor:v1', JSON.stringify({ ...initialState(h.env.MONITOR_CONFIG as Config), ...extra }));
}
const sends = (h: ReturnType<typeof harness>) => h.calls.filter(v => v.url.endsWith('/sendMessage'));
function battery(kind: 'full' | 'discharge', at = start) {
  return { kind, id: `${kind}:${at}`, createdAt: at, attempts: 0, nextAttemptAt: at,
    reading: { at, soc: 100, dischargeWatts: 400 } };
}
function information(flags: Partial<QuietCategories>, end = 780) {
  const c = settings(flags, { dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true },
    dailyRecap: { enabled: true, timeZone: 'UTC', hour: 12, minute: 0, scheduleConfirmed: true } });
  Object.assign(c, { quietHours: quiet(flags, 720, end) });
  const h = setup(c), first = advanceDataHealth(c, undefined, { kind: 'idle' }, start - 31 * minute);
  assert(first.status === 'ok');
  const recap = advanceDailyRecap(c, c.dailyRecap, undefined, start - 86400_000); assert(recap.status === 'ok');
  seed(h, { apiRetryAt: start + 2 * 3600_000, dataHealth: first.state, dailyRecap: recap.state });
  return { h, c };
}

test('runtime quiet policy validation rejects invalid consent/fields/zones before KV or providers', async () => {
  for (const quietHours of [{ ...quiet(), suppressionConfirmed: false }, { ...quiet(), startMinute: 1 },
    { ...quiet(), categories: { full: true } }, { ...quiet(), token: 'synthetic-private-value' }, { enabled: false, timeZone: 'UTC' }]) {
    const h = setup(); h.env.MONITOR_CONFIG = { ...settings(), quietHours };
    await assert.rejects(runMonitor(h.env, h.deps), /^SafeError: quiet_hours_config_invalid$/);
    assert.deepEqual(h.reads, []); assert.equal(h.calls.length, 0);
  }
  assert.throws(() => validateConfig({ ...settings(), daytimeDischarge: {
    timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } }), /quiet_hours_config_invalid/);
});
test('selected full alert tracks fresh readings and latches while keeping its original unsent event', async () => {
  const h = setup(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); const first = saved(h);
  assert.equal(first.fullArmed, false); assert.equal(first.pending[0].attempts, 0);
  assert.deepEqual(first.quietHours, { version: 1, lastObservedAt: start });
  h.advance(5 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  const next = saved(h); assert.equal(next.lastReadingAt, h.clock.time); assert.equal(sends(h).length, 0);
  assert.equal(next.pending[0].id, first.pending[0].id); assert.equal(next.pending[0].createdAt, start);
  assert.equal(next.pending[0].nextAttemptAt, start); assert.equal(next.pending[0].attempts, 0);
  assert.equal(h.times.length, 2); assert(h.calls.some(v => v.url.endsWith('/station/latest')));
});
test('quiet discharge still counts only distinct high samples and never prepares or requests weather', async () => {
  const h = setup(settings({ discharge: true }, { weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } }));
  h.reading(80, 400); await runMonitor(h.env, h.deps);
  h.advance(5 * minute); await runMonitor(h.env, h.deps); assert.equal(saved(h).pending.length, 0);
  h.advance(5 * minute); h.reading(80, 400); await runMonitor(h.env, h.deps);
  const s = saved(h); assert.equal(s.dischargeArmed, false); assert.equal(s.pending[0].kind, 'discharge');
  assert.equal(s.pending[0].attempts, 0); assert.equal(sends(h).length, 0); assert.equal(s.weather, undefined);
  assert(!h.calls.some(v => v.url.includes('open-meteo')));
});
test('quiet end permits only a still-current original event without rearming it', async () => {
  const c = settings(); Object.assign(c, { quietHours: quiet({ full: true }, 720, 725) });
  const h = setup(c); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); h.advance(5 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.equal(saved(h).fullArmed, false); assert.equal(saved(h).pending.length, 0);
});
test('expired quiet battery alerts do not get a new lifetime or catch-up event at opening', async () => {
  const h = setup(); h.reading(100, 0); await runMonitor(h.env, h.deps); assert.equal(sends(h).length, 0);
  h.advance(31 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(saved(h).pending.length, 0); h.advance(29 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).fullArmed, false);
});
test('an unselected discharge can send after a quiet full event within the shared budget', async () => {
  const h = setup(); seed(h, { fullArmed: false, dischargeArmed: false, pending: [battery('full'), battery('discharge')] });
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.match(h.sent[0], /House battery supplying power/);
  assert.equal(saved(h).pending[0].kind, 'full'); assert.equal(saved(h).pending[0].attempts, 0);
  assert.equal(h.times.length, 2); assert(h.times[1] - h.times[0] >= 1100); assert(h.kv.puts.length <= 3);
});
test('quiet recap resolves its date while unselected health sends during cooldown without providers', async () => {
  const { h } = information({ recap: true }); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.match(h.sent[0], /Battery updates delayed/);
  assert.deepEqual(h.reads, ['monitor:v1']); assert.equal(h.calls.length, 1); assert.equal(h.times.length, 2);
  const s = saved(h); assert.equal(s.pending[0].kind, 'recap'); assert.equal(s.pending[0].attempts, 0);
  assert.equal(s.dailyRecap.resolvedDay, '2026-10-21');
  h.advance(16 * minute); await runMonitor(h.env, h.deps); assert.equal(saved(h).pending.length, 0);
  assert.equal(sends(h).length, 1);
});
test('quiet stale health is never acknowledged and cannot generate an unsolicited recovery', async () => {
  const { h } = information({ health: true }); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.match(h.sent[0], /daily recap/);
  assert.equal(saved(h).dataHealth.staleAcknowledged, false); assert.equal(saved(h).pending[0].kind, 'health');
  const s = saved(h); s.apiRetryAt = 0; h.kv.data.set('monitor:v1', JSON.stringify(s));
  for (let i = 0; i < 2; i++) { h.advance(5 * minute); h.reading(70, 0); await runMonitor(h.env, h.deps); }
  assert.equal(sends(h).length, 1); assert.equal(saved(h).pending.length, 0);
});
test('fully quiet informational opportunities expire and never replay at quiet end', async () => {
  const { h } = information({ health: true, recap: true }); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending.length, 2);
  h.advance(61 * minute); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending.length, 0);
  assert.equal(saved(h).dataHealth.notice.consumed, true); assert.equal(h.calls.length, 0);
});
test('previously acknowledged fresh recovery can wait quietly without resetting its original proof', async () => {
  const c = settings({ health: true }, { dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  Object.assign(c, { quietHours: quiet({ health: true }, 720, 725) });
  let r = advanceDataHealth(c, undefined, { kind: 'idle' }, start - 60 * minute); assert(r.status === 'ok');
  r = advanceDataHealth(c, r.state, { kind: 'idle' }, start - 30 * minute); assert(r.status === 'ok' && r.candidate);
  r = settleDataHealthNotice(c, r.state, r.candidate, 'accepted', start - 30 * minute); assert(r.status === 'ok');
  r = advanceDataHealth(c, r.state, { kind: 'accepted', at: start - 5 * minute }, start - 5 * minute); assert(r.status === 'ok');
  r = advanceDataHealth(c, r.state, { kind: 'accepted', at: start }, start); assert(r.status === 'ok' && r.candidate);
  const h = setup(c); seed(h, { apiRetryAt: start + 3600_000, dataHealth: r.state, lastReadingAt: start,
    latestReading: { at: start, soc: 70, dischargeWatts: 0 } });
  await runMonitor(h.env, h.deps); assert.equal(sends(h).length, 0);
  assert.equal(saved(h).pending[0].createdAt, start); h.advance(5 * minute); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.match(h.sent[0], /New battery readings received/);
});
test('quiet battery events keep capacity and admission priority over recap and health', async () => {
  const { h, c } = information({ full: true, health: true, recap: true });
  // First admit the two informational candidates, both quiet.
  await runMonitor(h.env, h.deps); assert.equal(sends(h).length, 0);
  const before = saved(h); before.apiRetryAt = 0; h.kv.data.set('monitor:v1', JSON.stringify(before));
  h.advance(5 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert(saved(h).pending.some((a: { kind: string }) => a.kind === 'full'));
  assert(!saved(h).pending.some((a: { kind: string }) => a.kind === 'recap'));
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21'); assert.equal(saved(h).fullArmed, false);
  assert(sends(h).length === 0); assert(saved(h).pending.length <= 2); assert.equal(c.enabled, true);
});
test('quiet suppression never increments attempts or changes an existing Retry-After', async () => {
  const c = settings(); Object.assign(c, { quietHours: quiet({ full: true }, 725, 780) });
  const h = setup(c); h.hook(url => url.endsWith('/sendMessage') ? json({ ok: false }, 429, { 'Retry-After': '900' }) : undefined);
  h.reading(100, 0); await runMonitor(h.env, h.deps); const original = saved(h).pending[0];
  assert.equal(original.attempts, 1); assert.equal(sends(h).length, 1);
  h.advance(16 * minute); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.equal(saved(h).pending[0].attempts, 1);
  assert.equal(saved(h).pending[0].nextAttemptAt, original.nextAttemptAt); assert.equal(saved(h).pending[0].createdAt, start);
});
test('corrupt guard is retained with a fixed diagnostic and only selected delivery is suppressed', async () => {
  const h = setup(), bad = { version: 1, lastObservedAt: 'synthetic-private-state' };
  seed(h, { quietHours: bad, fullArmed: false, dischargeArmed: false, pending: [battery('full'), battery('discharge')] });
  h.reading(100, 400); const events = await runMonitor(h.env, h.deps);
  assert(events.includes('quiet_hours_state_invalid')); assert.equal(sends(h).length, 1);
  assert.deepEqual(saved(h).quietHours, bad); assert.equal(saved(h).pending[0].kind, 'full');
  assert.doesNotMatch(JSON.stringify(events) + h.sent.join('\n'), /synthetic-private/);
});
test('rollback preserves the guard and mutes selected recap until the clock catches up', async () => {
  const { h } = information({ recap: true });
  const c = h.env.MONITOR_CONFIG as Config; Object.assign(c, { quietHours: quiet({ recap: true }, 0, 5) });
  const s = saved(h); s.quietHours = { version: 1, lastObservedAt: start + minute };
  // Keep only recap enabled for this rollback journey.
  delete c.dataHealth; delete s.dataHealth; h.kv.data.set('monitor:v1', JSON.stringify(s));
  await runMonitor(h.env, h.deps); assert.equal(sends(h).length, 0);
  assert.equal(saved(h).quietHours.lastObservedAt, start + minute);
  h.advance(2 * minute); await runMonitor(h.env, h.deps); assert.equal(sends(h).length, 1);
});
test('opting off during cooldown removes only quiet metadata in one checkpoint', async () => {
  const c = config(), h = setup(c), pending = battery('full');
  seed(h, { quietHours: { version: 1, lastObservedAt: start }, fullArmed: false, pending: [pending], apiRetryAt: start + 3600_000 });
  await runMonitor(h.env, h.deps); assert.equal(saved(h).quietHours, undefined);
  assert.deepEqual(saved(h).pending, [pending]); assert.equal(saved(h).fullArmed, false);
  assert.equal(h.calls.length, 0); assert.equal(h.times.length, 1);
});
test('the first checkpoint contains guard and latches, and failure cannot release delivery', async () => {
  const h = setup(); let attempted: Record<string, unknown> | undefined;
  h.kv.failOnPut = (key, value) => { if (key !== 'monitor:v1') return false; attempted = JSON.parse(value); return true; };
  h.reading(100, 0); await assert.rejects(runMonitor(h.env, h.deps), /Synthetic KV failure/);
  assert.deepEqual(attempted?.quietHours, { version: 1, lastObservedAt: start });
  assert.equal(attempted?.fullArmed, false); assert.equal(sends(h).length, 0); assert.equal(h.kv.data.has('monitor:v1'), false);
});
test('a failed result checkpoint retains the documented possible duplicate for an unselected send', async () => {
  const h = setup(); seed(h, { fullArmed: false, dischargeArmed: false, pending: [battery('full'), battery('discharge')] });
  let count = 0; h.kv.failOnPut = key => key === 'monitor:v1' && ++count === 2;
  h.reading(100, 400); await assert.rejects(runMonitor(h.env, h.deps), /Synthetic KV failure/);
  assert.equal(sends(h).length, 1); assert.equal(saved(h).pending.length, 2);
  h.kv.failOnPut = undefined; h.advance(5 * minute); h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 2); assert.equal(saved(h).pending[0].kind, 'full');
});
test('a first-checkpoint wait crossing quiet start suppresses send and checkpoints the new observation', async () => {
  const c = settings(); Object.assign(c, { quietHours: quiet({ full: true }, 725, 780) });
  const h = setup(c, start + 5 * minute - 1000), put = h.kv.put.bind(h.kv); let first = true;
  h.kv.put = async (key, value) => { await put(key, value); if (key === 'monitor:v1' && first) { first = false; h.clock.time += 2000; } };
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending[0].attempts, 0); assert.equal(h.times.length, 2);
  assert(saved(h).quietHours.lastObservedAt >= start + 5 * minute); assert(h.times[1] - h.times[0] >= 1100);
});
test('weather crossing quiet start cannot send, and weather/clock results share the final checkpoint', async () => {
  const c = settings({ discharge: true }, { weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
  Object.assign(c, { quietHours: quiet({ discharge: true }, 725, 780) });
  const h = setup(c, start + 5 * minute - 1000); seed(h, { dischargeArmed: false, pending: [battery('discharge', h.clock.time)] });
  h.hook(url => { if (!url.includes('open-meteo')) return; h.clock.time += 2000; return json({}, 503); });
  h.reading(80, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending[0].attempts, 0);
  assert.equal(h.times.length, 2); assert(saved(h).quietHours.lastObservedAt >= start + 5 * minute);
  assert.equal(h.calls.filter(v => v.url.includes('open-meteo')).length, 1);
});
test('quiet boundary is rechecked before the second event after an unselected send', async () => {
  const c = settings({ discharge: true }); Object.assign(c, { quietHours: quiet({ discharge: true }, 725, 780) });
  const h = setup(c, start + 5 * minute - 1000); seed(h, { fullArmed: false, dischargeArmed: false,
    pending: [battery('full', h.clock.time), battery('discharge', h.clock.time)] });
  h.hook(url => { if (!url.endsWith('/sendMessage')) return; h.clock.time += 2000; return json({ ok: true }); });
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 1); assert.equal(saved(h).pending[0].kind, 'discharge'); assert.equal(saved(h).pending[0].attempts, 0);
});
test('a weather wait cannot extend an original battery deadline even when quiet window is open', async () => {
  const c = settings({ discharge: true }, { weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
  Object.assign(c, { quietHours: quiet({ discharge: true }, 0, 5) });
  const h = setup(c); seed(h, { dischargeArmed: false, pending: [battery('discharge')] });
  h.hook(url => { if (!url.includes('open-meteo')) return; h.clock.time += 31 * minute; return json({}, 503); });
  h.reading(80, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending.length, 0); assert.equal(saved(h).dischargeArmed, false);
  assert.equal(h.times.length, 2);
});
test('a weather wait cannot release battery advice after its source freshness expires', async () => {
  const c = settings({ discharge: true }, { weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } });
  Object.assign(c, { quietHours: quiet({ discharge: true }, 0, 5) });
  const h = setup(c); seed(h, { dischargeArmed: false, pending: [battery('discharge')] });
  h.hook(url => { if (!url.includes('open-meteo')) return; h.clock.time += 11 * minute; return json({}, 503); });
  h.reading(80, 400); await runMonitor(h.env, h.deps);
  assert.equal(sends(h).length, 0); assert.equal(saved(h).pending[0].attempts, 0);
  assert.equal(saved(h).pending[0].createdAt, start); assert.equal(h.times.length, 2);
});
test('invalid quiet clock at invocation start cannot create guard, core state or provider work', async () => {
  const h = setup(); seed(h, { fullArmed: false, pending: [battery('full')] });
  const before = h.kv.data.get('monitor:v1'); h.clock.time = -1;
  const events = await runMonitor(h.env, h.deps);
  assert(events.includes('quiet_hours_clock_invalid')); assert.equal(h.kv.data.get('monitor:v1'), before);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
});
test('omitted quiet policy retains legacy cooldown IO and whole-monitor off remains zero IO', async () => {
  const h = setup(config()); seed(h, { apiRetryAt: start + 3600_000 }); const before = h.kv.data.get('monitor:v1');
  await runMonitor(h.env, h.deps); assert.equal(h.kv.data.get('monitor:v1'), before); assert.equal(h.times.length, 0); assert.equal(h.calls.length, 0);
  const paused = setup({ ...settings(), enabled: false }); paused.kv.get = async () => { throw new Error('Synthetic forbidden disabled read'); };
  assert.deepEqual(await runMonitor(paused.env, paused.deps), ['monitor_disabled']); assert.equal(paused.calls.length, 0);
});
test('authorized requested status ignores quiet hours and never advances its guard', async () => {
  const c = settings({ full: true, discharge: true, health: true, recap: true }, { telegram: { enabled: true } }), h = setup(c);
  seed(h, { quietHours: { version: 1, lastObservedAt: start - minute } }); const before = h.kv.data.get('monitor:v1');
  const secret = 'synthetic-webhook-secret-1234567890';
  const req = new Request('https://synthetic.invalid/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 1, message: { date: Math.floor(start / 1000), from: { id: 789 }, chat: { id: 456 }, text: '/status' } }) });
  assert.equal((await handleTelegramRequest(req, { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret }, h.deps)).status, 200);
  assert.equal(sends(h).length, 1); assert.equal(h.kv.data.get('monitor:v1'), before);
  assert(h.kv.puts.every(v => v.key === 'telegram:v1')); assert.equal(h.calls.length, 1);
});
