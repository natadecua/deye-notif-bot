import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReading, parseTimestamp } from '../src/reading.ts';
import { validateConfig } from '../src/config.ts';
import { BASE_TIME, config, fixture } from './helpers.ts';

test('W and kW conversion use explicit units; signed batteryPower is ignored', () => {
  assert.equal(normalizeReading(fixture, config(), BASE_TIME).dischargeWatts, 420);
  assert.equal(normalizeReading({ ...fixture, dischargePower: 0.42 }, config({ powerUnit: 'kW' }), BASE_TIME).dischargeWatts, 420);
  assert.equal(normalizeReading({ ...fixture, dischargePower: 0, batteryPower: -999 }, config(), BASE_TIME).dischargeWatts, 0);
});
for (const value of [undefined, null, '', '0', '420', NaN, Infinity, -1, {}, true]) {
  test(`missing or invalid discharge is rejected (${String(value)})`, () => {
    assert.throws(() => normalizeReading({ ...fixture, dischargePower: value }, config(), BASE_TIME), /measurement_missing_or_invalid/);
  });
}
for (const value of [undefined, null, '', '100', NaN, -1, 101]) {
  test(`missing or invalid SOC is rejected (${String(value)})`, () => {
    assert.throws(() => normalizeReading({ ...fixture, batterySOC: value }, config(), BASE_TIME), /measurement_missing_or_invalid/);
  });
}
test('freshness limits reject stale and any future reading', () => {
  assert.doesNotThrow(() => normalizeReading(fixture, config(), BASE_TIME + 600_000));
  assert.throws(() => normalizeReading(fixture, config(), BASE_TIME + 600_001), /reading_stale/);
  assert.throws(() => normalizeReading(fixture, config(), BASE_TIME - 1), /reading_future/);
});
test('ISO offsets normalize to UTC; ambiguous and impossible dates are rejected', () => {
  assert.equal(parseTimestamp('2026-10-21T14:00:00+02:00', 'iso-offset'), BASE_TIME);
  for (const value of ['2026-10-21 12:00:00', '2026-10-21T12:00:00', '2026-02-30T12:00:00Z',
    '2026-13-01T12:00:00Z', '2026-10-21T24:00:00Z', 'garbage', null, 0]) {
    assert.throws(() => parseTimestamp(value, 'iso-offset'));
  }
});
test('epoch modes are explicit, never guessed or coerced', () => {
  assert.equal(parseTimestamp(BASE_TIME / 1000, 'unix-seconds'), BASE_TIME);
  assert.equal(parseTimestamp(BASE_TIME, 'unix-milliseconds'), BASE_TIME);
  assert.throws(() => parseTimestamp(String(BASE_TIME / 1000), 'unix-seconds'));
  assert.throws(() => parseTimestamp(null, 'unix-seconds'));
  assert.throws(() => normalizeReading({ ...fixture, lastUpdateTime: BASE_TIME }, config({ timestampMode: 'unix-seconds' }), BASE_TIME), /reading_future/);
});
test('configuration requires explicit measurement/EV confirmation and sensible hysteresis', () => {
  assert.doesNotThrow(() => validateConfig(config()));
  for (const bad of [config({ measurementsConfirmed: false }), config({ powerUnit: 'MW' as 'W' }),
    config({ fullRearmSoc: 100 }), config({ dischargeRearmWatts: 300 }), config({ stationId: 0 }),
    config({ ev: { enabled: true } }),
    config({ ev: { enabled: true, confirmed: true, phases: 3, voltage: 400, minimumAmps: 6 } }),
    config({ ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 0 } })]) {
    assert.throws(() => validateConfig(bad));
  }
});
