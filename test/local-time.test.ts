import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText } from '../src/alerts.ts';
import { chargingSummary, decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import type { Alert } from '../src/types.ts';
import { config } from './helpers.ts';

// Synthetic absolute instants and installations, never inferred station metadata.
const at = Date.parse('2026-10-22T08:24:07Z');
const configured = (timeZone: string) => config({ daytimeDischarge: { timeZone, startHour: 6, endHour: 18, minimumMinutes: 15 } });
const event = (timestamp: number, kind: Alert['kind'] = 'full'): Alert => ({ id: `synthetic-${kind}`, kind,
  reading: { at: timestamp, soc: 100, dischargeWatts: 500 }, createdAt: timestamp, attempts: 0, nextAttemptAt: timestamp });

test('configured local time labels full and discharge readings without changing source instants', () => {
  const c = configured('Asia/Manila');
  for (const kind of ['full', 'discharge'] as const) {
    const a = event(at, kind), before = structuredClone(a);
    assert.match(alertText(a, c), /Reading: 22 Oct 2026, 16:24:07 Asia\/Manila \(UTC\+08:00\)/);
    assert.deepEqual(a, before);
  }
});

test('local reading display rolls over the date/year and uses midnight 00 rather than 24', () => {
  const a = event(Date.parse('2026-12-31T16:00:01.999Z'));
  const text = alertText(a, configured('Asia/Manila'));
  assert.match(text, /Reading: 1 Jan 2027, 00:00:01 Asia\/Manila \(UTC\+08:00\)/);
  assert.doesNotMatch(text, /24:00|\.999/);
});

test('repeated daylight-saving hours include their actual offsets', () => {
  const c = configured('America/New_York');
  assert.match(alertText(event(Date.parse('2026-11-01T05:30:00Z')), c), /1 Nov 2026, 01:30:00 America\/New_York \(UTC-04:00\)/);
  assert.match(alertText(event(Date.parse('2026-11-01T06:30:00Z')), c), /1 Nov 2026, 01:30:00 America\/New_York \(UTC-05:00\)/);
});

test('fractional offsets are displayed accurately without rounding to an hour', () => {
  assert.match(alertText(event(at), configured('Asia/Kathmandu')), /22 Oct 2026, 14:09:07 Asia\/Kathmandu \(UTC\+05:45\)/);
});

test('manual expiry uses local civil time while its six-hour duration and unknown boundary stay absolute', () => {
  const c = configured('America/New_York'), s = decodeBotState(null, c);
  const start = Date.parse('2026-03-08T05:00:00Z');
  s.session = { status: 'charging', source: 'manual', at: start, expiresAt: start + SESSION_MS };
  const before = structuredClone(s);
  assert.match(chargingSummary(s, c, start), /expires 2026-03-08 07:00:00 America\/New_York \(UTC-04:00\)/);
  assert.deepEqual(s, before);
  assert.equal(chargingSummary(s, c, start + SESSION_MS), 'EV charging: unknown');
});

test('a formatter switch between installations never reuses a different zone label or wall time', () => {
  for (const [zone, expected] of [
    ['Asia/Manila', '16:24:07 Asia/Manila (UTC+08:00)'],
    ['America/New_York', '04:24:07 America/New_York (UTC-04:00)'],
    ['Asia/Kathmandu', '14:09:07 Asia/Kathmandu (UTC+05:45)'],
    ['Asia/Manila', '16:24:07 Asia/Manila (UTC+08:00)'],
  ]) assert(alertText(event(at), configured(zone)).includes(expected));
});

test('no installation timezone keeps legacy UTC strings and never infers a zone from weather coordinates', () => {
  const c = config({ weather: { enabled: false, latitude: 13.75, longitude: 121.05 } });
  assert.match(alertText(event(at), c), /Reading: 22 Oct 2026, 08:24:07 UTC\n/);
  const s = decodeBotState(null, c);
  s.session = { status: 'not_charging', source: 'manual', at, expiresAt: at + SESSION_MS };
  assert.match(chargingSummary(s, c, at), /expires 2026-10-22 14:24:07 UTC$/);
});
