import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, alertText, decodeState, resetAfterGap, expirePending } from '../src/alerts.ts';
import { config, BASE_TIME } from './helpers.ts';
import type { State } from '../src/types.ts';
const c = config();
function apply(s: State, soc: number, dischargeWatts: number, minutes = 0) {
  const at = BASE_TIME + minutes * 60_000;
  return transition(s, { at, soc, dischargeWatts }, c, at);
}
test('full charge latches, stays latched at 97, rearms strictly below 97', () => {
  const s = initialState(c);
  apply(s, 100, 0); apply(s, 100, 0, 5); apply(s, 97, 0, 10);
  assert.equal(s.pending.length, 1); assert.equal(s.fullArmed, false);
  apply(s, 96.9, 0, 15);
  assert.equal(s.fullArmed, true); assert.equal(s.pending.length, 0);
  apply(s, 100, 0, 20); assert.equal(s.pending.length, 1);
});
test('configurable full threshold and cold-start notification', () => {
  const other = config({ fullSoc: 95, fullRearmSoc: 92 });
  const s = initialState(other);
  transition(s, { at: BASE_TIME, soc: 95, dischargeWatts: 0 }, other, BASE_TIME);
  assert.equal(s.pending[0].kind, 'full');
});
test('discharge requires two distinct fresh high readings; duplicates never count', () => {
  const s = initialState(c);
  apply(s, 90, 400);
  for (let i = 0; i < 5; i++) assert.equal(apply(s, 90, 400), 'duplicate');
  assert.equal(s.highCount, 1); assert.equal(s.pending.length, 0);
  apply(s, 90, 500, 5);
  assert.equal(s.pending.length, 1); assert.equal(s.dischargeArmed, false);
  apply(s, 90, 500, 10); assert.equal(s.pending.length, 1);
});
test('confirmation breaks at threshold; discharge hysteresis is strict', () => {
  const s = initialState(c);
  apply(s, 90, 400); apply(s, 90, 300, 5); apply(s, 90, 400, 10);
  assert.equal(s.pending.length, 0);
  apply(s, 90, 400, 15); apply(s, 90, 100, 20);
  assert.equal(s.dischargeArmed, false);
  apply(s, 90, 99, 25); assert.equal(s.dischargeArmed, true);
  apply(s, 90, 400, 30); apply(s, 90, 400, 35); assert.equal(s.pending.length, 1);
});
test('out-of-order readings cannot rearm or advance confirmation', () => {
  const s = initialState(c);
  apply(s, 100, 400, 10);
  assert.equal(apply(s, 10, 0, 5), 'out_of_order');
  assert.equal(s.fullArmed, false); assert.equal(s.highCount, 1);
});
test('long sample gaps and wall-clock outages reset discharge confirmation', () => {
  const s = initialState(c);
  apply(s, 90, 400); apply(s, 90, 500, 13);
  assert.equal(s.highCount, 1); assert.equal(s.pending.length, 0);
  resetAfterGap(s, c, BASE_TIME + 26 * 60_000); assert.equal(s.highCount, 0);
});
test('persistent state survives restart; changed measurement config resets state', () => {
  const s = initialState(c); apply(s, 100, 400);
  const restored = decodeState(JSON.stringify(s), c);
  apply(restored, 100, 500, 5);
  assert.equal(restored.pending.length, 2);
  const changed = decodeState(JSON.stringify(s), config({ powerUnit: 'kW' }));
  assert.equal(changed.pending.length, 0); assert.equal(changed.fullArmed, true);
  assert.throws(() => decodeState('{broken', c), /state_invalid/);
  assert.throws(() => decodeState('{}', c), /state_invalid/);
});
test('both alerts may queue together, bounded at two until rearm', () => {
  const s = initialState(c); apply(s, 99, 400); apply(s, 100, 500, 5);
  assert.deepEqual(s.pending.map(a => a.kind), ['full', 'discharge']);
  apply(s, 100, 600, 10); assert.equal(s.pending.length, 2);
});
test('notification estimates use confirmed phases and voltage, never a target setting', () => {
  const s = initialState(c); apply(s, 90, 800); apply(s, 90, 800, 5);
  const a = s.pending[0];
  const one = alertText(a, config({ ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 6 } }));
  assert.match(one, /If the EV is charging/); assert.match(one, /reduction: 4 A/);
  assert.match(one, /at or above.*minimum of 6 A/); assert.match(one, /amperage is unknown/);
  const three = alertText(a, config({ ev: { enabled: true, confirmed: true, phases: 3, voltage: 230, minimumAmps: 6 } }));
  assert.match(three, /reduction: 2 A per phase/);
  assert.doesNotMatch(alertText(a, c), /Approximate reduction/);
});
test('outbox expires; expiry never rearms the cycle', () => {
  const s = initialState(c); apply(s, 100, 0);
  expirePending(s, BASE_TIME + 31 * 60_000);
  assert.equal(s.pending.length, 0); assert.equal(s.fullArmed, false);
});

test('full alert has a readable title, charge and UTC reading without redundant threshold jargon', () => {
  // Synthetic timestamp matching the reported formatting example.
  const at = Date.parse('2026-10-22T08:24:07.000Z');
  const s = initialState(c);
  transition(s, { at, soc: 100, dischargeWatts: 0 }, c, at);
  assert.equal(alertText(s.pending[0], c), [
    '🔋 House battery full', '', 'Charge: 100%', '',
    'Reading: 22 Oct 2026, 08:24:07 UTC', 'Deye Cloud data may be delayed.',
  ].join('\n'));
});

test('custom full thresholds say target reached rather than claiming a full battery', () => {
  const custom = config({ fullSoc: 95, fullRearmSoc: 92 });
  const s = initialState(custom);
  transition(s, { at: BASE_TIME, soc: 96.5, dischargeWatts: 0 }, custom, BASE_TIME);
  const text = alertText(s.pending[0], custom);
  assert.match(text, /^🔋 House battery charge target reached\n\nCharge: 96.5%\nAlert target: 95%\n\n/);
  assert.doesNotMatch(text, /battery full/);
});

test('discharge alert separates measured power, charge, confirmation and conditional advice', () => {
  const s = initialState(c);
  apply(s, 90, 800); apply(s, 90, 800, 5);
  assert.equal(alertText(s.pending[0], c), [
    '⚡ House battery supplying power', '', 'Discharge: 800 W', 'Charge: 90%',
    'Above 300 W in two distinct readings.', '',
    'If the EV is charging, consider reducing its charging current manually. Inverter telemetry cannot identify the EV as the cause.', '',
    'Reading: 21 Oct 2026, 12:05:00 UTC', 'Deye Cloud data may be delayed.',
  ].join('\n'));
});

test('reading display keeps the UTC date across a year boundary and drops ISO milliseconds', () => {
  const at = Date.parse('2027-01-01T00:00:01.123Z');
  const s = initialState(c);
  transition(s, { at, soc: 100, dischargeWatts: 0 }, c, at);
  assert.match(alertText(s.pending[0], c), /Reading: 1 Jan 2027, 00:00:01 UTC\n/);
});
