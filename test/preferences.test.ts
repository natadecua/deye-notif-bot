import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText, decodeState, initialState, transition } from '../src/alerts.ts';
import { stateIdentity, validateConfig } from '../src/config.ts';
import { runMonitor } from '../src/monitor.ts';
import { BASE_TIME, config, harness, json } from './helpers.ts';
import type { Config, State } from '../src/types.ts';

const exampleEV = {
  enabled: true, confirmed: true, phases: 1 as const, voltage: 230, minimumAmps: 8,
  profiles: [
    { id: '8a', label: '8 A', type: 'amps', amps: 8 },
    { id: '13a', label: '13 A', type: 'amps', amps: 13 },
    { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000 },
  ],
};
function withPreferences(full: boolean, discharge: boolean): Config {
  return config({ notifications: { full, discharge } } as Partial<Config>);
}
function stored(h: ReturnType<typeof harness>): State {
  return JSON.parse(h.kv.data.get('monitor:v1')!);
}

test('full notifications can be disabled independently while discharge still works', async () => {
  const h = harness(withPreferences(false, true));
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /supplying sustained demand/);
  assert.equal(stored(h).fullArmed, false);
});
test('discharge notifications can be disabled independently while full still works', async () => {
  const h = harness(withPreferences(true, false));
  h.reading(99, 400); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /reached 100%/);
  assert.equal(stored(h).dischargeArmed, false);
});
test('muted cycles stay tracked and re-enabling does not send an old full event', async () => {
  const h = harness(withPreferences(false, false));
  h.reading(100, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0);
  h.env.MONITOR_CONFIG = withPreferences(true, true);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0);
  h.advance(); h.reading(96, 50); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
});
test('disabling a rule cancels its pending retry without resetting its latch', async () => {
  const h = harness();
  h.hook(url => url.includes('/sendMessage') ? json({}, 503) : undefined);
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(stored(h).pending.length, 1);
  h.env.MONITOR_CONFIG = withPreferences(false, true);
  h.hook(undefined); h.advance(); h.reading(100, 0);
  await runMonitor(h.env, h.deps);
  assert.equal(stored(h).pending.length, 0);
  assert.equal(stored(h).fullArmed, false);
  assert.equal(h.sent.length, 0);
});
test('disabled pending notifications are cancelled even during API cooldown', async () => {
  const h = harness();
  const s = initialState(config());
  transition(s, { at: BASE_TIME, soc: 100, dischargeWatts: 0 }, config(), BASE_TIME);
  s.apiRetryAt = BASE_TIME + 900_000;
  h.kv.data.set('monitor:v1', JSON.stringify(s));
  h.env.MONITOR_CONFIG = withPreferences(false, true);
  assert.deepEqual(await runMonitor(h.env, h.deps), ['api_backoff']);
  assert.equal(stored(h).pending.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kv.puts.length, 1);
});
test('missing notification preferences preserve both legacy alerts', async () => {
  const h = harness();
  const legacy = config() as Config & { notifications?: unknown };
  delete legacy.notifications;
  h.env.MONITOR_CONFIG = legacy;
  h.reading(99, 400); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2);
});
test('malformed notification preferences fail closed instead of silently enabling alerts', () => {
  for (const notifications of [null, [], {}, { full: 'false', discharge: true }, { full: true }]) {
    assert.throws(() => validateConfig({ ...config(), notifications }), /notification_preferences_invalid/);
  }
});
test('changing charging hints or profile labels preserves existing full/discharge cycles', () => {
  const old = config();
  const s = initialState(old);
  transition(s, { at: BASE_TIME, soc: 100, dischargeWatts: 400 }, old, BASE_TIME);
  const updated = config({ ev: exampleEV });
  const restored = decodeState(JSON.stringify(s), updated);
  assert.equal(restored.fullArmed, false);
  assert.equal(restored.highCount, 1);
  assert.equal(restored.lastReadingAt, BASE_TIME);
  assert.equal(restored.pending[0].id, s.pending[0].id);
});
test('legacy identities containing EV settings migrate without duplicate full alerts', () => {
  const old = config();
  const s = initialState(old);
  transition(s, { at: BASE_TIME, soc: 100, dischargeWatts: 0 }, old, BASE_TIME);
  const identity = JSON.parse(stateIdentity(old));
  // Initial implementation appended the EV object to the ten measurement fields.
  s.identity = JSON.stringify([...identity.slice(0, 10), old.ev]);
  const updated = config({ ev: exampleEV });
  const restored = decodeState(JSON.stringify(s), updated);
  assert.equal(restored.fullArmed, false);
  assert.equal(restored.identity, stateIdentity(updated));
});
test('profile-based messages show nominal options, not unsupported intermediate reductions', () => {
  const c = config({ ev: exampleEV });
  validateConfig(c);
  const s = initialState(c);
  transition(s, { at: BASE_TIME, soc: 90, dischargeWatts: 800 }, c, BASE_TIME);
  transition(s, { at: BASE_TIME + 300_000, soc: 90, dischargeWatts: 800 }, c, BASE_TIME + 300_000);
  const message = alertText(s.pending[0], c);
  assert.match(message, /If the EV is charging/);
  assert.match(message, /8 A.*1\.84 kW/);
  assert.match(message, /13 A.*2\.99 kW/);
  assert.match(message, /MAX.*7 kW/);
  assert.match(message, /nominal estimates/);
  assert.match(message, /amperage is unknown/);
  assert.doesNotMatch(message, /Approximate reduction|32 A|30\.4 A/);
});
test('balanced three-phase profile estimates use three times line-to-neutral voltage', () => {
  const c = config({ ev: { ...exampleEV, phases: 3,
    profiles: [{ id: 'low', label: 'Low', type: 'amps', amps: 8 }] } });
  validateConfig(c);
  const s = initialState(c);
  transition(s, { at: BASE_TIME, soc: 90, dischargeWatts: 800 }, c, BASE_TIME);
  transition(s, { at: BASE_TIME + 300_000, soc: 90, dischargeWatts: 800 }, c, BASE_TIME + 300_000);
  assert.match(alertText(s.pending[0], c), /5\.52 kW/);
});
for (const [name, profiles] of Object.entries({
  empty: [],
  belowMinimum: [{ id: 'low', label: 'Low', type: 'amps', amps: 6 }],
  belowMinimumPower: [{ id: 'low', label: 'Low', type: 'power', nominalWatts: 100 }],
  mixedFields: [{ id: 'max', label: 'MAX', type: 'power', nominalWatts: 7000, amps: 32 }],
  duplicateIds: [exampleEV.profiles[0], { ...exampleEV.profiles[1], id: '8a' }],
  unknownType: [{ id: 'low', label: 'Low', type: 'automatic', amps: 8 }],
  invalidLabel: [{ id: 'low', label: 'Low\nhttps://example.invalid', type: 'amps', amps: 8 }],
  tooMany: Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, label: `P${i}`, type: 'amps', amps: 8 })),
})) {
  test(`unsafe or ambiguous charging profiles are rejected: ${name}`, () => {
    assert.throws(() => validateConfig({ ...config(), ev: { ...exampleEV, profiles } }), /charging_profiles_invalid/);
  });
}
