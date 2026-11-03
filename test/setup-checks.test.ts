import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTimestampChoices, validateSetupMeasurements } from '../scripts/setup-checks.ts';

// Synthetic timestamp/measurement fixtures; no owner files or live services.
test('setup timestamp choices follow the preview type and show UTC interpretations', () => {
  assert.deepEqual(setupTimestampChoices(1792652707), [
    { name: 'Unix seconds → 2026-10-22T07:05:07.000Z (UTC)', value: 'unix-seconds' },
    { name: 'Unix milliseconds → 1970-01-21T17:57:32.707Z (UTC)', value: 'unix-milliseconds' },
  ]);
  assert.deepEqual(setupTimestampChoices('2026-10-22T07:05:07Z'), [
    { name: 'ISO 8601 with explicit offset → 2026-10-22T07:05:07.000Z (UTC)', value: 'iso-offset' },
  ]);
});

test('setup rejects timestamp strings without an explicit offset', () => {
  assert.throws(() => setupTimestampChoices('2026-10-22T07:05:07'), /timestamp_ambiguous/);
});

test('setup rejects a null dischargePower before asking for its unit', () => {
  assert.throws(() => validateSetupMeasurements({ batterySOC: 100, dischargePower: null }), /setup_measurement_unavailable/);
  assert.doesNotThrow(() => validateSetupMeasurements({ batterySOC: 100, dischargePower: 0 }));
});
