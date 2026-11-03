import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, decodeState } from '../src/alerts.ts';
import { advanceDataHealth, settleDataHealthNotice } from '../src/data-health.ts';
import { runMonitor } from '../src/monitor.ts';
import { config, harness, json, BASE_TIME } from './helpers.ts';

// Synthetic installation/state/services only. Never uses account credentials or real APIs.
const minute = 60_000, start = BASE_TIME;
const settings = () => config({ dataHealth: { enabled: true, warnAfterMinutes: 30,
  delivery: 'all-hours', allHoursConfirmed: true } });
function healthState(c = settings(), at = start - 30 * minute, due = false) {
  const first = advanceDataHealth(c, undefined, { kind: 'idle' }, at);
  assert.equal(first.status, 'ok');
  const result = due ? advanceDataHealth(c, first.state, { kind: 'idle' }, start) : first;
  assert.equal(result.status, 'ok');
  return result;
}
function pendingHealth(c = settings()) {
  const r = healthState(c, start - 30 * minute, true); assert(r.candidate);
  return { metadata: r.state, alert: { kind: 'health', notice: r.candidate,
    id: `health:${r.candidate.kind}:${r.candidate.episodeAt}:${r.candidate.qualifiedAt}`,
    createdAt: r.candidate.qualifiedAt, attempts: 1, nextAttemptAt: start + 5 * minute } };
}
function setup(c = settings()) {
  const h = harness(c), s = { ...initialState(c), dataHealth: healthState(c).state,
    apiRetryAt: start + 24 * 60 * minute };
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  return h;
}
const saved = (h: ReturnType<typeof harness>) => JSON.parse(h.kv.data.get('monitor:v1')!);
function battery(kind: 'full' | 'discharge', at = start) {
  return { kind, id: `${kind}:${at}`, reading: { at, soc: 100, dischargeWatts: 400 },
    createdAt: at, attempts: 1, nextAttemptAt: at };
}

test('health-only Deye cooldown sends safe informational text with two spaced checkpoints and no provider poll', async () => {
  const c = settings(); c.weather = { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true };
  const h = setup(c), before = saved(h), times: number[] = [];
  let reads = 0; const get = h.kv.get.bind(h.kv), put = h.kv.put.bind(h.kv);
  h.kv.get = async key => { reads++; return get(key); };
  h.kv.put = async (key, value) => { times.push(h.clock.time); return put(key, value); };
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /Battery updates delayed/);
  assert.match(h.sent[0], /No accepted battery reading since/);
  assert.match(h.sent[0], /cause is unknown/i);
  assert.doesNotMatch(h.sent[0], /Charge:|Battery discharge:|reduce|profile|Open-Meteo|https?:\/\//i);
  assert(h.calls.every(call => call.url.includes('/sendMessage')));
  assert.equal(reads, 1); assert.equal(h.kv.puts.length, 2);
  assert(times[1] - times[0] >= 1100);
  assert.equal(saved(h).apiRetryAt, before.apiRetryAt);
  assert.equal(saved(h).dataHealth.staleAcknowledged, true);
  assert.equal(saved(h).pending.length, 0);
});

test('a stale notice during cooldown never releases a queued battery recommendation', async () => {
  const h = setup(), s = saved(h), original = battery('full');
  s.fullArmed = false; s.pending = [original]; h.kv.data.set('monitor:v1', JSON.stringify(s));
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /updates delayed/);
  assert.deepEqual(saved(h).pending, [original]);
  assert.equal(saved(h).fullArmed, false);
});

test('a failed scheduled Deye request can report missing data while retaining stale battery advice and the write bound', async () => {
  const h = setup(), s = saved(h), full = battery('full');
  s.apiRetryAt = 0; s.fullArmed = false; s.pending = [full];
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  h.hook(url => url.includes('/station/latest') ? json({ privateBody: 'synthetic-private-upstream' }, 503) : undefined);
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /Battery updates delayed/);
  assert.doesNotMatch(h.sent[0], /synthetic-private|Charge:|reduce/);
  assert.deepEqual(saved(h).pending, [full]); assert(saved(h).apiRetryAt > h.clock.time);
  assert(h.kv.puts.length <= 3); assert(h.calls.length <= 9);
});

test('legacy cache begins fresh health grace without rearming existing battery cycles', async () => {
  const c = settings(), h = harness(c), s = initialState(c);
  s.fullArmed = false; s.dischargeArmed = false; s.apiRetryAt = start + 60 * minute;
  s.lastReadingAt = start - 24 * 60 * minute;
  s.latestReading = { at: s.lastReadingAt, soc: 80, dischargeWatts: 400 };
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(saved(h).dataHealth.activatedAt, start);
  assert.equal(saved(h).fullArmed, false); assert.equal(saved(h).dischargeArmed, false);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 1);
});

test('recorded stale acceptance permits one restored message only after two fresh distinct scheduled readings', async () => {
  const h = setup(); await runMonitor(h.env, h.deps);
  const s = saved(h); s.apiRetryAt = 0; h.kv.data.set('monitor:v1', JSON.stringify(s));
  h.advance(); h.reading(80, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
  const before = h.kv.puts.length;
  h.advance(); h.reading(80, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2); assert.match(h.sent[1], /New battery readings received/);
  assert.match(h.sent[1], /two distinct fresh/i);
  assert.doesNotMatch(h.sent[1], /EV is stopped|grid is back|charging current|reduce/i);
  assert(h.kv.puts.length - before <= 3);
  assert.equal(saved(h).dataHealth.phase, 'recovered');
});

test('persist-before-send failure leaves health unsent and crashes after API acceptance can still duplicate', async () => {
  const h = setup(), original = h.kv.data.get('monitor:v1');
  h.kv.failOnPut = () => true;
  await assert.rejects(runMonitor(h.env, h.deps)); assert.equal(h.calls.length, 0);
  assert.equal(h.kv.data.get('monitor:v1'), original);
  let writes = 0; h.kv.failOnPut = () => ++writes === 2;
  await assert.rejects(runMonitor(h.env, h.deps)); assert.equal(h.sent.length, 1);
  h.kv.failOnPut = undefined; h.advance(2000); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2); // Documented ambiguous-send/failed-checkpoint limit.
});

test('health retries keep their attempt count, wait for backoff and stop after three attempts without reminting', async () => {
  const h = setup(); h.hook(url => url.includes('/sendMessage') ? json({}, 503) : undefined);
  await runMonitor(h.env, h.deps); assert.equal(saved(h).pending[0]?.attempts, 1);
  h.advance(minute); await runMonitor(h.env, h.deps); assert.equal(h.calls.length, 1);
  h.advance(4 * minute); await runMonitor(h.env, h.deps); assert.equal(saved(h).pending[0]?.attempts, 2);
  h.advance(10 * minute); await runMonitor(h.env, h.deps);
  assert.equal(h.calls.length, 3); assert.equal(saved(h).pending.length, 0);
  h.advance(5 * minute); await runMonitor(h.env, h.deps); assert.equal(h.calls.length, 3);
});

test('health Retry-After beyond expiry abandons the candidate instead of resetting a new retry event', async () => {
  const h = setup(); h.hook(() => json({ ok: false, error_code: 429, parameters: { retry_after: 3600 } }));
  await runMonitor(h.env, h.deps);
  assert.equal(h.calls.length, 1); assert.equal(saved(h).pending.length, 0);
  h.advance(31 * minute); await runMonitor(h.env, h.deps); assert.equal(h.calls.length, 1);
});

test('battery admission evicts health before exceeding two total events and preserves battery priority', async () => {
  const c = settings(), h = harness(c), p = pendingHealth(c), s = initialState(c);
  const source = start - 5 * minute;
  s.lastReadingAt = source; s.latestReading = { at: source, soc: 99, dischargeWatts: 400 }; s.highCount = 1;
  h.kv.data.set('monitor:v1', JSON.stringify({ ...s, dataHealth: p.metadata, pending: [p.alert] }));
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0], /House battery full/); assert.match(h.sent[1], /House battery supplying/);
  for (const put of h.kv.puts.filter(p => p.key === 'monitor:v1')) assert(JSON.parse(put.value).pending.length <= 2);
  assert.equal(saved(h).fullArmed, false); assert.equal(saved(h).dischargeArmed, false);
});

test('a full battery outbox leaves no health slot and never renews an expired waiting candidate', async () => {
  const h = setup(), s = saved(h); s.pending = [battery('full'), battery('discharge')];
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  await runMonitor(h.env, h.deps); assert.equal(h.sent.length, 0);
  assert.equal(saved(h).pending.length, 2);
  h.advance(31 * minute); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(saved(h).pending.length, 0);
  h.advance(60 * minute); await runMonitor(h.env, h.deps); assert.equal(h.sent.length, 0);
});

test('turning health off during cooldown cancels only health state/events in one write; whole monitor off does no IO', async () => {
  const c = settings(), h = harness(c), p = pendingHealth(c), s = initialState(c), full = battery('full');
  s.fullArmed = false; s.apiRetryAt = start + 60 * minute;
  h.kv.data.set('monitor:v1', JSON.stringify({ ...s, dataHealth: p.metadata, pending: [full, p.alert] }));
  h.env.MONITOR_CONFIG = { ...c, dataHealth: { enabled: false } };
  await runMonitor(h.env, h.deps);
  assert.deepEqual(saved(h).pending, [full]); assert.equal(saved(h).dataHealth, undefined);
  assert.equal(saved(h).fullArmed, false); assert.equal(h.kv.puts.length, 1); assert.equal(h.calls.length, 0);
  h.env.MONITOR_CONFIG = { ...c, enabled: false };
  h.kv.get = async () => { throw new Error('Synthetic forbidden disabled read'); };
  await runMonitor(h.env, h.deps); assert.equal(h.kv.puts.length, 1);
});

test('daytime health candidates expire overnight with no morning catch-up or Deye request', async () => {
  const c = settings(); c.dataHealth = { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' };
  c.daytimeDischarge = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
  const h = setup(c); await runMonitor(h.env, h.deps); assert.equal(h.sent.length, 0);
  assert.equal(saved(h).dataHealth.phase, 'missing'); assert.equal(saved(h).pending.length, 1);
  h.advance(10 * 60 * minute); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(h.calls.length, 0); assert.equal(saved(h).pending.length, 0);
});

test('health delivery rechecks the daytime boundary after the initial checkpoint', async () => {
  const c = settings(); c.dataHealth = { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' };
  c.daytimeDischarge = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
  const h = harness(c), at = Date.parse('2026-10-21T09:59:59Z'); h.clock.time = at;
  h.kv.data.set('monitor:v1', JSON.stringify({ ...initialState(c), apiRetryAt: at + 3600_000,
    dataHealth: healthState(c, at - 30 * minute).state }));
  const put = h.kv.put.bind(h.kv);
  h.kv.put = async (key, value) => { await put(key, value); h.clock.time += 2000; };
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(h.kv.puts.length, 1);
  assert.equal(saved(h).pending.length, 1);
});

test('corrupt optional health metadata suppresses only health and never reflects private fixture fields', async () => {
  const c = settings(), h = harness(c), s = initialState(c), malformed = { upstreamBody: 'synthetic-private-body' };
  h.kv.data.set('monitor:v1', JSON.stringify({ ...s, dataHealth: malformed }));
  h.reading(100, 0); const events = await runMonitor(h.env, h.deps);
  assert(events.includes('data_health_state_invalid'));
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /House battery full/);
  assert.deepEqual(saved(h).dataHealth, malformed); assert.equal(saved(h).fullArmed, false);
  assert.doesNotMatch(JSON.stringify(events) + h.sent.join('\n'), /synthetic-private/);
});

test('health queue decoding accepts independent evidence and rejects fake readings, malformed candidates and duplicate slots', () => {
  const c = settings(), p = pendingHealth(c), s = { ...initialState(c), dataHealth: p.metadata, pending: [p.alert] };
  assert.deepEqual(decodeState(JSON.stringify(s), c).pending, [p.alert]);
  for (const pending of [[{ ...p.alert, reading: { at: start, soc: 100, dischargeWatts: 0 } }],
    [{ ...p.alert, notice: { ...p.alert.notice, kind: 'raw-provider-value' } }], [p.alert, p.alert]]) {
    assert.throws(() => decodeState(JSON.stringify({ ...s, pending }), c), /state_invalid/);
  }
});

test('a due battery alert is delivered before an older restored notice sharing the outbox', async () => {
  const c = settings(), h = harness(c);
  const first = healthState(c, start - 40 * minute);
  const missing = advanceDataHealth(c, first.state, { kind: 'idle' }, start - 10 * minute);
  assert.equal(missing.status, 'ok'); assert(missing.candidate);
  const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start - 10 * minute);
  assert.equal(ack.status, 'ok');
  const one = advanceDataHealth(c, ack.state, { kind: 'accepted', at: start - 5 * minute }, start - 5 * minute);
  assert.equal(one.status, 'ok');
  const two = advanceDataHealth(c, one.state, { kind: 'accepted', at: start }, start);
  assert.equal(two.status, 'ok'); assert(two.candidate);
  const n = two.candidate, s = initialState(c);
  s.lastReadingAt = start; s.latestReading = { at: start, soc: 80, dischargeWatts: 0 };
  h.kv.data.set('monitor:v1', JSON.stringify({ ...s, dataHealth: two.state, pending: [{ kind: 'health', notice: n,
    id: `health:${n.kind}:${n.episodeAt}:${n.qualifiedAt}`, createdAt: n.qualifiedAt, attempts: 0, nextAttemptAt: start }] }));
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2); assert.match(h.sent[0], /House battery full/);
  assert.match(h.sent[1], /New battery readings received/);
});
