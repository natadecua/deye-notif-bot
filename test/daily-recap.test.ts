import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceDailyRecap, dailyRecapSlotOpen, validateDailyRecap,
  type DailyRecapPolicy } from '../src/daily-recap.ts';
import { config, harness } from './helpers.ts';
import { initialState } from '../src/alerts.ts';
import { runMonitor } from '../src/monitor.ts';

// Synthetic policies, local dates and monitor records only; no owner schedule or live services.
const minute = 60_000, c = config();
const at = (s: string) => Date.parse(s);
const policy = (extra: Partial<DailyRecapPolicy> = {}): DailyRecapPolicy => ({ enabled: true,
  timeZone: 'Asia/Manila', hour: 9, minute: 0, scheduleConfirmed: true, ...extra });
const start = at('2026-10-26T00:00:00Z'), due = at('2026-10-27T01:00:00Z');
function step(raw: unknown, now: number, p: unknown = policy(), context = c) {
  const r = advanceDailyRecap(context, p, raw, now);
  assert.equal(r.status, 'ok');
  return r;
}
function ready(p = policy(), now = start) { return step(undefined, now, p); }
function slot(p = policy(), now = due) {
  const r = step(ready(p).state, now, p); assert(r.candidate); return { ...r, candidate: r.candidate };
}

test('recap omitted and canonical off stay off without decoding metadata', () => {
  assert.equal(validateDailyRecap(undefined), undefined);
  assert.equal(validateDailyRecap({ enabled: false }), undefined);
  for (const p of [undefined, { enabled: false }]) {
    assert.deepEqual(advanceDailyRecap(c, p, { malformed: true }, due), { status: 'off' });
  }
});

test('recap policy requires explicit valid zone/time/consent and copies only the contract', () => {
  const p = policy(); assert.deepEqual(validateDailyRecap(p), p);
  assert.notEqual(validateDailyRecap(p), p);
  for (const raw of [null, [], true, {}, { enabled: 'true' }, { ...p, enabled: undefined },
    { ...p, scheduleConfirmed: false }, { ...p, scheduleConfirmed: undefined },
    { ...p, hour: undefined }, { ...p, hour: '9' }, { ...p, hour: -1 }, { ...p, hour: 24 },
    { ...p, hour: 9.5 }, { ...p, minute: undefined }, { ...p, minute: 1 }, { ...p, minute: 60 },
    { ...p, minute: -5 }, { ...p, timeZone: '' }, { ...p, timeZone: '+08:00' },
    { ...p, timeZone: ' Asia/Manila' }, { ...p, timeZone: 'Synthetic/Invalid' }, { ...p, timeZone: 'x'.repeat(65) },
    { ...p, timeZone: undefined }, { enabled: false, hour: 9 }]) {
    assert.throws(() => validateDailyRecap(raw), /^SafeError: daily_recap_config_invalid$/);
  }
  assert.equal(validateDailyRecap(policy({ hour: 0, minute: 0, timeZone: 'UTC' }))?.hour, 0);
  assert.equal(validateDailyRecap(policy({ hour: 23, minute: 55 }))?.minute, 55);
});

test('recap rejects unknown policy fields with fixed text, including synthetic private values', () => {
  for (const key of ['token', 'url', 'stationId', 'history']) {
    assert.throws(() => validateDailyRecap({ ...policy(), [key]: 'synthetic-private-sentinel' }),
      /^SafeError: daily_recap_config_invalid$/);
  }
});

test('recap independently confirms the installation zone without changing daytime preferences', () => {
  const context = config({ daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } });
  const before = JSON.stringify(context);
  assert.deepEqual(validateDailyRecap(policy(), context.daytimeDischarge!.timeZone), policy());
  assert.throws(() => validateDailyRecap(policy({ timeZone: 'UTC' }), context.daytimeDischarge!.timeZone), /daily_recap_config_invalid/);
  assert.throws(() => advanceDailyRecap(context, policy({ timeZone: 'UTC' }), undefined, start), /daily_recap_config_invalid/);
  assert.equal(JSON.stringify(context), before);
});

test('first activation skips the whole current local date before, during and after its slot', () => {
  for (const now of [due - minute, due, due + 30 * minute]) {
    const r = step(undefined, now); assert.equal(r.candidate, undefined); assert.equal(r.resetPending, true);
    assert.equal(r.state.resolvedDay, '2026-10-27'); assert.equal(r.state.observedAt, now);
    assert.equal(step(r.state, due + 40 * minute).candidate, undefined);
  }
});

test('only the next eligible local date resolves once, using the original due instant', () => {
  const first = ready(), before = step(first.state, due - 1);
  assert.equal(before.candidate, undefined); assert.equal(before.state.resolvedDay, '2026-10-26');
  const r = step(before.state, due + 3210); assert(r.candidate);
  assert.deepEqual(r.candidate, { policy: r.state.policy, localDate: '2026-10-27', dueAt: due, expiresAt: due + 15 * minute });
  assert.equal(r.resetPending, false); assert.equal(r.state.resolvedDay, '2026-10-27');
  assert.equal(step(r.state, due + 5 * minute).candidate, undefined);
});

test('last millisecond inside the opportunity is eligible but exact expiry consumes a missed date', () => {
  const r = step(ready().state, due + 15 * minute - 1); assert(r.candidate);
  assert.equal(r.candidate.dueAt, due); assert.equal(r.candidate.expiresAt, due + 15 * minute);
  const missed = step(ready().state, due + 15 * minute);
  assert.equal(missed.candidate, undefined); assert.equal(missed.state.resolvedDay, '2026-10-27');
  assert.equal(step(missed.state, due + 30 * minute).candidate, undefined);
});

test('serialized restart never remints a consumed date or renews the original slot expiry', () => {
  const r = slot(), serialized = JSON.stringify(r), restored = JSON.parse(serialized);
  const next = step(restored.state, due + 10 * minute);
  assert.equal(next.candidate, undefined);
  assert.equal(dailyRecapSlotOpen(c, policy(), next.state, restored.candidate, due + 15 * minute - 1), true);
  assert.equal(dailyRecapSlotOpen(c, policy(), next.state, restored.candidate, due + 15 * minute), false);
  assert.equal(JSON.stringify(r), serialized);
});

test('forward jumps consider only the current date and never replay missed days', () => {
  const now = at('2026-11-05T01:05:00Z'), r = step(ready().state, now); assert(r.candidate);
  assert.equal(r.candidate.localDate, '2026-11-05');
  const missed = step(ready().state, now + 60 * minute);
  assert.equal(missed.candidate, undefined); assert.equal(missed.state.resolvedDay, '2026-11-05');
  assert.equal(step(missed.state, now + 24 * 60 * minute).candidate?.localDate, '2026-11-06');
});

test('time/zone changes and off/on activation suppress today without mutating earlier metadata', () => {
  const r = slot(), original = JSON.stringify(r.state);
  for (const p of [policy({ minute: 5 }), policy({ timeZone: 'UTC', hour: 1 })]) {
    const changed = step(r.state, due + 5 * minute, p);
    assert.equal(changed.candidate, undefined); assert.equal(changed.resetPending, true);
    assert.equal(changed.state.resolvedDay, '2026-10-27'); assert.notEqual(changed.state.policy, r.state.policy);
    assert.equal(dailyRecapSlotOpen(c, p, changed.state, r.candidate, due + 5 * minute), false);
  }
  assert.deepEqual(advanceDailyRecap(c, { enabled: false }, r.state, due), { status: 'off' });
  assert.equal(step(undefined, due + minute).candidate, undefined);
  assert.equal(JSON.stringify(r.state), original);
});

test('measurement identity changes activate anew while EV and notification preferences preserve the date', () => {
  const r = ready(), changed = step(r.state, due, policy(), config({ fullSoc: 99 }));
  assert.equal(changed.resetPending, true); assert.equal(changed.candidate, undefined);
  const preferences = config({ notifications: { full: false, discharge: false },
    ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 6 } });
  assert(step(r.state, due, policy(), preferences).candidate);
});

test('corrupt optional recap metadata is rejected with fixed diagnostics rather than reinitialized', () => {
  const state = ready().state;
  for (const raw of [null, [], 1, {}, { ...state, version: 2 }, { ...state, policy: 1 },
    { ...state, policy: 'x'.repeat(513) }, { ...state, resolvedDay: '2026-02-30' },
    { ...state, resolvedDay: '2026-1-01' }, { ...state, resolvedDay: 'synthetic-private-sentinel' },
    { ...state, observedAt: -1 }, { ...state, observedAt: 0.1 }, { ...state, observedAt: Infinity }]) {
    assert.deepEqual(advanceDailyRecap(c, policy(), raw, due), { status: 'invalid', code: 'daily_recap_state_invalid' });
  }
});

test('metadata is copied from bounded fields and does not accumulate history or change battery/health state', () => {
  const monitor = { ...initialState(c), fullArmed: false, dischargeArmed: false,
    dataHealth: { synthetic: 'health-sentinel' } }, original = JSON.stringify(monitor);
  const input = { ...ready().state, upstream: 'synthetic-private-sentinel', history: Array(100).fill('synthetic') };
  let r = step(input, due);
  assert(!JSON.stringify(r).includes('synthetic-private-sentinel'));
  for (let day = 1; day <= 128; day++) {
    r = step(JSON.parse(JSON.stringify(r.state)), due + day * 24 * 60 * minute);
    assert(Buffer.byteLength(JSON.stringify(r.state)) < 1024);
    assert.deepEqual(Object.keys(r.state).sort(), ['observedAt', 'policy', 'resolvedDay', 'version']);
  }
  assert.equal(JSON.stringify(monitor), original);
});

test('malformed policy identity in optional metadata fails closed even during clock rollback', () => {
  const state = ready().state;
  for (const policy of ['synthetic-private-sentinel', '[]', '[1,2,3,4]',
    JSON.stringify(['synthetic-private-sentinel', 'Asia/Manila', 9, 0])]) {
    assert.deepEqual(advanceDailyRecap(c, { enabled: true, timeZone: 'Asia/Manila', hour: 9, minute: 0,
      scheduleConfirmed: true }, { ...state, policy }, start - minute),
    { status: 'invalid', code: 'daily_recap_state_invalid' });
  }
});

test('absolute clock rollback cancels pending work and retains both high-water marks', () => {
  const r = slot(), later = step(r.state, due + 5 * minute), original = JSON.stringify(later.state);
  const back = step(later.state, due + minute);
  assert.equal(back.resetPending, true); assert.equal(back.candidate, undefined);
  assert.equal(JSON.stringify(back.state), original);
  assert.equal(dailyRecapSlotOpen(c, policy(), back.state, r.candidate, due + minute), false);
  const caught = step(back.state, due + 5 * minute);
  assert.equal(caught.candidate, undefined); assert.equal(caught.resetPending, false);
});

test('invalid/unrenderable clocks suppress recap and never echo their inputs', () => {
  for (const now of [NaN, Infinity, -1, due + 0.1, 253402300800000, 8.64e15]) {
    assert.deepEqual(advanceDailyRecap(c, policy(), undefined, now), { status: 'invalid', code: 'daily_recap_clock_invalid' });
    assert.equal(dailyRecapSlotOpen(c, policy(), ready().state, {}, now), false);
  }
});

test('spring-forward skipped local time fails the due-time round trip and is not caught up', () => {
  const p = policy({ timeZone: 'America/New_York', hour: 2, minute: 55 });
  const first = ready(p, at('2026-03-07T17:00:00Z'));
  const skipped = step(first.state, at('2026-03-08T07:05:00Z'), p);
  assert.equal(skipped.candidate, undefined); assert.equal(skipped.state.resolvedDay, '2026-03-08');
  assert.equal(step(skipped.state, at('2026-03-08T07:10:00Z'), p).candidate, undefined);
  assert.equal(step(skipped.state, at('2026-03-09T06:55:00Z'), p).candidate?.dueAt, at('2026-03-09T06:55:00Z'));
});

test('fall-back repeats cannot remint resolved dates or renew the first slot', () => {
  const p = policy({ timeZone: 'America/New_York', hour: 1, minute: 30 });
  const first = ready(p, at('2026-10-31T16:00:00Z'));
  const one = step(first.state, at('2026-11-01T05:30:00Z'), p); assert(one.candidate);
  const two = step(one.state, at('2026-11-01T06:30:00Z'), p);
  assert.equal(two.candidate, undefined);
  assert.equal(dailyRecapSlotOpen(c, p, two.state, one.candidate, at('2026-11-01T06:30:00Z')), false);
  const missed = step(first.state, at('2026-11-01T05:50:00Z'), p);
  assert.equal(step(missed.state, at('2026-11-01T06:30:00Z'), p).candidate, undefined);
  const unobserved = step(first.state, at('2026-11-01T06:30:00Z'), p); assert(unobserved.candidate);
  assert.equal(unobserved.candidate.dueAt, at('2026-11-01T06:30:00Z'));
});

test('fractional-offset zones use the chosen local minute and original millisecond boundary', () => {
  const p = policy({ timeZone: 'Asia/Kathmandu', hour: 9, minute: 5 });
  const r = step(ready(p).state, at('2026-10-27T03:20:02.123Z'), p); assert(r.candidate);
  assert.equal(r.candidate.dueAt, at('2026-10-27T03:20:00Z'));
  assert.equal(r.candidate.localDate, '2026-10-27');
});

test('local midnight truncates an original opportunity even before its absolute expiry', () => {
  const p = policy({ hour: 23, minute: 55 }), now = at('2026-10-27T15:55:00Z');
  const r = slot(p, now);
  assert.equal(dailyRecapSlotOpen(c, p, r.state, r.candidate, at('2026-10-27T15:59:59.999Z')), true);
  assert.equal(dailyRecapSlotOpen(c, p, r.state, r.candidate, at('2026-10-27T16:00:00Z')), false);
  assert.equal(step(r.state, at('2026-10-27T16:00:00Z'), p).candidate, undefined);
});

test('slot rechecks reject forged/noncanonical/future/policy-mismatched evidence with no mutation', () => {
  const r = slot(), before = JSON.stringify(r);
  for (const raw of [null, {}, { ...r.candidate, policy: 'synthetic-mismatch' },
    { ...r.candidate, localDate: '2026-02-30' }, { ...r.candidate, expiresAt: due + 30 * minute },
    { ...r.candidate, dueAt: due + 1 }, { ...r.candidate, dueAt: due + minute, expiresAt: due + 16 * minute },
    { ...r.candidate, localDate: '2026-10-28' }]) {
    assert.equal(dailyRecapSlotOpen(c, policy(), r.state, raw, due + 5 * minute), false);
  }
  assert.equal(dailyRecapSlotOpen(c, policy(), r.state, r.candidate, due - 1), false);
  assert.equal(dailyRecapSlotOpen(c, { enabled: false }, r.state, r.candidate, due), false);
  assert.equal(dailyRecapSlotOpen({ ...c, enabled: false }, policy(), r.state, r.candidate, due), false);
  assert.equal(dailyRecapSlotOpen(c, policy(), { malformed: true }, r.candidate, due), false);
  assert.equal(dailyRecapSlotOpen(c, policy(), r.state, r.candidate, due), true);
  assert.equal(JSON.stringify(r), before);
});

test('disabled monitoring pauses pure preparation before any work', () => {
  assert.deepEqual(advanceDailyRecap({ ...c, enabled: false }, policy(), undefined, due), { status: 'paused' });
});

test('slot preparation uses constant formatter work, without scanning missing days', () => {
  const state = ready().state, original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { calls++; return original.apply(this, args); };
  try {
    const r = step(state, at('2029-10-27T01:10:00Z')); assert(r.candidate);
    assert(calls <= 3, `bounded format calls: ${calls}`);
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});

test('recap-off monitor retains no recap field/event/extra IO and disabled mode stays idle', async () => {
  const h = harness(c); h.reading(80, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(h.kv.puts.filter(p => p.key === 'monitor:v1').length, 1);
  assert(!h.kv.data.get('monitor:v1')!.includes('recap'));
  const paused = harness(config({ enabled: false }));
  assert.deepEqual(await runMonitor(paused.env, paused.deps), ['monitor_disabled']);
  assert.equal(paused.calls.length, 0); assert.equal(paused.kv.puts.length, 0);
});
