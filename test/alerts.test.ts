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
