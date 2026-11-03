import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargingSummary, decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import { decodeState, initialState, transition } from '../src/alerts.ts';
import { BASE_TIME, config } from './helpers.ts';

test('a future-dated manual report is unknown rather than confirmation of present charging', () => {
  const c = config(), s = decodeBotState(null, c);
  s.session = { status: 'charging', source: 'manual', at: BASE_TIME + 60_000, expiresAt: BASE_TIME + 60_000 + SESSION_MS };
  assert.equal(chargingSummary(s, c, BASE_TIME), 'EV charging: unknown');
});
test('status cache only changes on accepted distinct readings and legacy states remain readable', () => {
  const c = config(), s = initialState(c);
  transition(s, { at: BASE_TIME, soc: 80, dischargeWatts: 500 }, c, BASE_TIME);
  transition(s, { at: BASE_TIME, soc: 20, dischargeWatts: 9999 }, c, BASE_TIME);
  transition(s, { at: BASE_TIME - 1000, soc: 10, dischargeWatts: 9999 }, c, BASE_TIME);
  assert.deepEqual(s.latestReading, { at: BASE_TIME, soc: 80, dischargeWatts: 500 });
  const legacy = { ...s }; delete legacy.latestReading;
  assert.equal(decodeState(JSON.stringify(legacy), c).lastReadingAt, BASE_TIME);
  assert.throws(() => decodeState(JSON.stringify({ ...s, latestReading: { ...s.latestReading, soc: 101 } }), c), /state_invalid/);
});
test('corrupt bot state or unsupported preferences fail closed without resetting cycles', () => {
  const c = config(), s = decodeBotState(null, c);
  assert.throws(() => decodeBotState('{synthetic-broken', c), /bot_state_invalid/);
  assert.throws(() => decodeBotState(JSON.stringify({ ...s, overrides: { stationId: 999 } }), c), /bot_state_invalid/);
  assert.throws(() => decodeBotState(JSON.stringify({ ...s, used: 49 }), c), /bot_state_invalid/);
});
