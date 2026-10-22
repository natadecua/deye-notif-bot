import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureDaytime } from '../scripts/daytime-preferences.ts';
import { preferencesSummary, type PreferencePrompts } from '../scripts/preferences.ts';
import { config } from './helpers.ts';

// Synthetic injected prompts; no real account/configuration files are used.
function prompts(answers: unknown[]) {
  const remaining = [...answers], printed: string[] = [];
  const next = async () => {
    assert(remaining.length > 0, 'Unexpected daytime prompt');
    return remaining.shift() as never;
  };
  const p: PreferencePrompts = { choose: next, text: next, number: next, confirm: next, checklist: next,
    print: text => printed.push(text) };
  return { p, remaining, printed };
}
test('daytime wizard saves an explicitly chosen timezone/window/duration without changing other preferences', async () => {
  const source = config(), before = structuredClone(source);
  const h = prompts([true, 'Asia/Manila', 6, 18, 15, true]);
  const updated = await configureDaytime(source, h.p);
  assert.deepEqual(updated.daytimeDischarge, { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 });
  assert.deepEqual(source, before);
  assert.deepEqual({ ...updated, daytimeDischarge: undefined }, { ...source, daytimeDischarge: undefined });
  assert.match(h.printed.join('\n'), /06:00–18:00 Asia\/Manila/);
  assert.match(h.printed.join('\n'), /300 W/);
  assert.match(preferencesSummary(updated), /06:00–18:00 Asia\/Manila; 15 minutes/);
  assert.equal(h.remaining.length, 0);
});
test('daytime wizard can restore the all-day rule without altering the full notification setting', async () => {
  const source = { ...config({ notifications: { full: false, discharge: true } }),
    daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } };
  const updated = await configureDaytime(source, prompts([false]).p);
  assert.equal(updated.daytimeDischarge, undefined);
  assert.deepEqual(updated.notifications, source.notifications);
  assert(source.daytimeDischarge);
});
test('invalid timezone and cancelled confirmation never return settings to save', async () => {
  await assert.rejects(configureDaytime(config(), prompts([true, 'Invalid/Zone', 6, 18, 15]).p), /daytime_discharge_invalid/);
  await assert.rejects(configureDaytime(config(), prompts([true, 'Asia/Manila', 6, 18, 15, false]).p), /daytime_setup_not_confirmed/);
});
