import { SafeError } from '../src/errors.ts';
import { parseTimestamp } from '../src/reading.ts';
import type { Config } from '../src/types.ts';

type TimestampMode = Config['timestampMode'];
type TimestampChoice = { name: string; value: TimestampMode };

export function setupTimestampChoices(value: unknown): TimestampChoice[] {
  if (typeof value === 'number') {
    const modes: TimestampMode[] = ['unix-seconds', 'unix-milliseconds'];
    const choices = modes.flatMap(mode => {
      try {
        const at = parseTimestamp(value, mode);
        return [{ name: `${mode === 'unix-seconds' ? 'Unix seconds' : 'Unix milliseconds'} → ${new Date(at).toISOString()} (UTC)`, value: mode }];
      } catch {
        return [];
      }
    });
    if (choices.length) return choices;
    throw new SafeError('timestamp_invalid');
  }
  if (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const at = parseTimestamp(value, 'iso-offset');
    return [{ name: `ISO 8601 with explicit offset → ${new Date(at).toISOString()} (UTC)`, value: 'iso-offset' }];
  }
  throw new SafeError('timestamp_ambiguous');
}

export function validateSetupMeasurements(raw: Record<string, unknown>): void {
  if (typeof raw.batterySOC !== 'number' || !Number.isFinite(raw.batterySOC) || raw.batterySOC < 0 || raw.batterySOC > 100 ||
      typeof raw.dischargePower !== 'number' || !Number.isFinite(raw.dischargePower) || raw.dischargePower < 0) {
    throw new SafeError('setup_measurement_unavailable');
  }
}
