import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceDataHealth, settleDataHealthNotice as settleNotice, type HealthObservation } from '../src/data-health.ts';
import { validateConfig, stateIdentity } from '../src/config.ts';
import { decodeState, initialState, transition } from '../src/alerts.ts';
import { runMonitor } from '../src/monitor.ts';
import { config, harness, BASE_TIME } from './helpers.ts';

// All settings, observations and persisted records here are synthetic; no live services.
const minute = 60_000, start = BASE_TIME;
const enabled = () => ({ ...config(), dataHealth: {
  enabled: true, warnAfterMinutes: 30, delivery: 'all-hours' as const, allHoursConfirmed: true,
} });
const idle = { kind: 'idle' as const };
const sample = (at: number) => ({ kind: 'accepted' as const, at });
function step(c: ReturnType<typeof enabled>, raw: unknown, now: number, observation: HealthObservation = idle) {
  const result = advanceDataHealth(c, raw, observation, now);
  assert.equal(result.status, 'ok');
  return result;
}
function episode() {
  const c = enabled(), first = step(c, undefined, start);
  const missing = step(c, first.state, start + 30 * minute);
  assert(missing.candidate);
  return { c, first, missing: { ...missing, candidate: missing.candidate } };
}
function settleDataHealthNotice(...args: Parameters<typeof settleNotice>) {
  const result = settleNotice(...args);
  assert.equal(result.status, 'ok');
  return result;
}

test('health configuration requires independent explicit duration and delivery consent', () => {
  for (const dataHealth of [null, [], { enabled: 'yes' }, { enabled: true },
    { enabled: true, warnAfterMinutes: 15, delivery: 'all-hours' },
    { enabled: true, warnAfterMinutes: 15.5, delivery: 'all-hours', allHoursConfirmed: true },
    { enabled: true, warnAfterMinutes: 121, delivery: 'all-hours', allHoursConfirmed: true },
    { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' }]) {
    assert.throws(() => validateConfig({ ...config(), dataHealth }), /data_health_config_invalid/);
  }
  assert.throws(() => validateConfig({ ...enabled(), maxAgeSeconds: 1800 }), /data_health_config_invalid/);
  const daytime = { ...enabled(), dataHealth: { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' },
    daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } };
  assert.equal(validateConfig(daytime), daytime);
  assert.equal(validateConfig(enabled()).ev.enabled, false);
});

test('omitted/off health stays off and a disabled monitor does not advance health', () => {
  assert.equal(advanceDataHealth(config(), undefined, idle, start).status, 'off');
  assert.equal(advanceDataHealth({ ...enabled(), dataHealth: { enabled: false } }, { malformed: true }, idle, start).status, 'off');
  assert.equal(advanceDataHealth({ ...enabled(), enabled: false }, undefined, idle, start).status, 'paused');
});

test('fresh, ancient or absent legacy cache gets a full activation grace without changing battery latches', () => {
  for (const at of [undefined, start - 5 * minute, start - 24 * 60 * minute]) {
    const c = enabled(), original = initialState(c);
    original.fullArmed = false; original.dischargeArmed = false;
    if (at !== undefined) { original.lastReadingAt = at; original.latestReading = { at, soc: 80, dischargeWatts: 400 }; }
    const decoded = decodeState(JSON.stringify(original), c), before = JSON.stringify(decoded);
    const first = step(c, undefined, start);
    assert.equal(first.candidate, undefined);
    assert.equal(step(c, first.state, start + 30 * minute - 1).candidate, undefined);
    const due = step(c, first.state, start + 30 * minute);
    assert.equal(due.candidate?.kind, 'stale');
    assert.equal(due.candidate?.qualifiedAt, start + 30 * minute);
    assert.equal(JSON.stringify(decoded), before);
  }
});

test('health uses accepted source age rather than poll time and never counts duplicate data as new evidence', () => {
  const c = enabled(), initial = step(c, undefined, start);
  const accepted = step(c, initial.state, start + 20 * minute, sample(start + 15 * minute));
  const duplicate = step(c, accepted.state, start + 30 * minute, { kind: 'duplicate' });
  assert.equal(duplicate.state.latestAt, start + 15 * minute);
  assert.equal(step(c, duplicate.state, start + 45 * minute - 1).candidate, undefined);
  assert.equal(step(c, duplicate.state, start + 45 * minute).candidate?.kind, 'stale');
});

test('stale qualification and expiry survive restart without renewed reminders or mutating inputs', () => {
  const { c, missing } = episode(), before = JSON.stringify(missing.state);
  const repeated = step(c, JSON.parse(before), start + 40 * minute);
  assert.deepEqual(repeated.candidate, missing.candidate);
  assert.equal(JSON.stringify(missing.state), before);
  assert.equal(step(c, repeated.state, start + 60 * minute).candidate?.kind, 'stale');
  const expired = step(c, repeated.state, start + 60 * minute + 1);
  assert.equal(expired.candidate, undefined);
  assert.equal(step(c, expired.state, start + 24 * 60 * minute).candidate, undefined);
});

test('first resumed sample consumes unsent stale notice; two fresh samples recover silently without acknowledgement', () => {
  const { c, missing } = episode();
  const first = step(c, missing.state, start + 35 * minute, sample(start + 35 * minute));
  assert.equal(first.candidate, undefined);
  const second = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  assert.equal(second.state.phase, 'recovered');
  assert.equal(second.candidate, undefined);
  const lostAgain = step(c, first.state, start + 50 * minute, { kind: 'failed' });
  assert.equal(lostAgain.candidate, undefined);
  assert.equal(lostAgain.state.phase, 'missing');
});

test('recovery notice requires recorded stale API acceptance and two increasing fresh samples', () => {
  const { c, missing } = episode();
  const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start + 30 * minute);
  assert.equal(ack.status, 'ok'); assert.equal(ack.state.staleAcknowledged, true);
  const first = step(c, ack.state, start + 35 * minute, sample(start + 35 * minute));
  assert.equal(first.candidate, undefined);
  const second = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  assert.equal(second.candidate?.kind, 'restored');
  assert.equal(second.candidate?.episodeAt, missing.candidate.episodeAt);
  assert.equal(second.candidate?.qualifiedAt, start + 40 * minute);
  const settled = settleDataHealthNotice(c, second.state, second.candidate, 'accepted', start + 40 * minute);
  assert.equal(settled.candidate, undefined);
});

test('bad, duplicate, out-of-order, stale and long-gap recovery evidence cannot report restoration', () => {
  const observations: HealthObservation[] = [{ kind: 'failed' }, { kind: 'duplicate' }, { kind: 'out_of_order' },
    sample(start + 35 * minute), sample(start + 50 * minute), sample(start)];
  for (const observation of observations) {
    const { c, missing } = episode();
    const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start + 30 * minute);
    const first = step(c, ack.state, start + 35 * minute, sample(start + 35 * minute));
    const interrupted = step(c, first.state, start + 40 * minute, observation);
    assert.equal(interrupted.candidate, undefined);
    assert.notEqual(interrupted.state.phase, 'recovered');
    assert.equal(step(c, interrupted.state, start + 45 * minute, sample(start + 45 * minute)).candidate, undefined);
  }
  const { c, missing } = episode();
  const first = step(c, missing.state, start + 35 * minute, sample(start + 35 * minute));
  const afterGap = step(c, first.state, start + 50 * minute, sample(start + 50 * minute));
  assert.equal(afterGap.state.phase, 'missing');
  assert.equal(afterGap.candidate, undefined);
});

test('idle cooldowns do not count as recovery and pending recovery is consumed when evidence fails', () => {
  const { c, missing } = episode();
  const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start + 30 * minute);
  const first = step(c, ack.state, start + 35 * minute, sample(start + 35 * minute));
  assert.equal(step(c, first.state, start + 36 * minute).state.phase, 'missing');
  const second = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  assert.equal(step(c, second.state, start + 41 * minute, { kind: 'failed' }).candidate, undefined);
  assert.equal(step(c, second.state, start + 51 * minute).candidate, undefined);
});

test('a recovered episode rearms only after its 60-minute cooldown, without a historical catch-up notice', () => {
  const { c, missing } = episode();
  const first = step(c, missing.state, start + 35 * minute, sample(start + 35 * minute));
  const second = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  assert.equal(step(c, second.state, start + 89 * minute).candidate, undefined);
  const newEpisode = step(c, second.state, start + 90 * minute);
  assert.equal(newEpisode.candidate?.kind, 'stale');
  assert.equal(newEpisode.candidate?.qualifiedAt, start + 90 * minute);
  assert.notEqual(newEpisode.candidate?.episodeAt, missing.candidate.episodeAt);
});

test('health policy changes restart only health grace, while optional display/EV changes preserve its episode', () => {
  const { c, missing } = episode();
  const changed = { ...c, dataHealth: { ...c.dataHealth, warnAfterMinutes: 45 } };
  assert.equal(stateIdentity(c), stateIdentity(changed));
  const restarted = step(changed, missing.state, start + 40 * minute);
  assert.equal(restarted.state.activatedAt, start + 40 * minute);
  assert.equal(restarted.candidate, undefined);
  const unrelated = { ...c, telegram: { enabled: true }, notifications: { full: false, discharge: false } };
  assert.deepEqual(step(unrelated, missing.state, start + 40 * minute).candidate, missing.candidate);
  const newStation = { ...c, stationId: 456 }; // Synthetic second installation.
  assert.equal(step(newStation, missing.state, start + 40 * minute).candidate, undefined);
});

test('invalid optional health data and clock rollback never reset a valid battery cycle or reflect unknown metadata', () => {
  const { c, missing } = episode();
  for (const raw of [null, [], {}, { ...missing.state, activatedAt: 'secret-synthetic' },
    { ...missing.state, latestAt: Number.NaN }, { ...missing.state, phase: 'upstream-body' },
    { ...missing.state, notice: { ...missing.state.notice, qualifiedAt: start - 1 } }]) {
    const before = structuredClone(raw);
    const result = advanceDataHealth(c, raw, idle, start + 40 * minute);
    assert.deepEqual(result, { status: 'invalid', code: 'data_health_state_invalid' });
    assert.deepEqual(raw, before);
  }
  assert.equal(advanceDataHealth(c, missing.state, idle, start + 20 * minute).status, 'paused');
  const clean = step(c, { ...missing.state, unknownSecret: 'synthetic-private-value' }, start + 40 * minute);
  assert.doesNotMatch(JSON.stringify(clean), /synthetic-private-value|unknownSecret/);
  assert(Buffer.byteLength(JSON.stringify(clean.state)) < 1024);
});

test('stale outcomes cannot acknowledge another episode or changed policy and abandonment consumes a candidate', () => {
  const { c, missing } = episode();
  const wrong = { ...missing.candidate, episodeAt: start };
  const unchanged = settleDataHealthNotice(c, missing.state, wrong, 'accepted', start + 31 * minute);
  assert.equal(unchanged.state.staleAcknowledged, false);
  assert.deepEqual(unchanged.candidate, missing.candidate);
  const changedPolicy = { ...c, dataHealth: { ...c.dataHealth, warnAfterMinutes: 45 } };
  const oldAck = settleDataHealthNotice(changedPolicy, missing.state, missing.candidate, 'accepted', start + 31 * minute);
  assert.equal(oldAck.state.staleAcknowledged, false);
  assert.equal(oldAck.candidate, undefined);
  const abandoned = settleDataHealthNotice(c, missing.state, missing.candidate, 'abandoned', start + 31 * minute);
  assert.equal(abandoned.candidate, undefined);
  assert.equal(abandoned.state.staleAcknowledged, false);
});

test('legacy full/discharge records and health-off monitor IO remain unchanged', async () => {
  const c = enabled(), s = initialState(c);
  transition(s, { at: start, soc: 100, dischargeWatts: 400 }, c, start);
  transition(s, { at: start + 5 * minute, soc: 100, dischargeWatts: 400 }, c, start + 5 * minute);
  const raw = JSON.stringify(s), decoded = decodeState(raw, c);
  assert.equal(JSON.stringify(decoded), raw);
  step(c, undefined, start + 6 * minute);
  assert.equal(JSON.stringify(decoded), raw);
  const h = harness({ ...c, dataHealth: { enabled: false } }); h.reading(80, 0);
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0);
  assert.equal(h.kv.puts.filter(p => p.key === 'monitor:v1').length, 1);
  assert.equal(JSON.parse((await h.kv.get('monitor:v1'))!).dataHealth, undefined);
});

test('JSON objects in phase/kind fields fail closed without coercion or leaking a thrown value', () => {
  const { c, missing } = episode();
  for (const raw of [{ ...missing.state, phase: { toString: null } },
    { ...missing.state, notice: { ...missing.state.notice, kind: { toString: null } } }]) {
    assert.deepEqual(advanceDataHealth(c, raw, idle, start + 40 * minute),
      { status: 'invalid', code: 'data_health_state_invalid' });
  }
});

test('a restored candidate without two distinct recorded source instants is corrupt, not recovery proof', () => {
  const { c, missing } = episode();
  const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start + 30 * minute);
  const first = step(c, ack.state, start + 35 * minute, sample(start + 35 * minute));
  const recovered = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  for (const recoveryFirstAt of [undefined, recovered.state.latestAt]) {
    const raw = { ...recovered.state, recoveryFirstAt };
    assert.deepEqual(advanceDataHealth(c, raw, idle, start + 41 * minute),
      { status: 'invalid', code: 'data_health_state_invalid' });
  }
});

test('restored evidence must also retain the configured source-gap bound after decoding', () => {
  const c = { ...enabled(), maxGapSeconds: 300 };
  const initialized = step(c, undefined, start), missing = step(c, initialized.state, start + 30 * minute);
  const ack = settleDataHealthNotice(c, missing.state, missing.candidate, 'accepted', start + 30 * minute);
  const first = step(c, ack.state, start + 35 * minute, sample(start + 35 * minute));
  const recovered = step(c, first.state, start + 40 * minute, sample(start + 40 * minute));
  const outsideGap = { ...recovered.state, recoveryFirstAt: start + 34 * minute };
  assert.equal(step(c, outsideGap, start + 41 * minute).candidate, undefined);
});
