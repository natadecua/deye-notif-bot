import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureHealth } from '../scripts/health-preferences.ts';
import { preferencesSummary, type PreferencePrompts } from '../scripts/preferences.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';
import { config } from './helpers.ts';
import { setupHint } from '../scripts/setup-hints.ts';

// Synthetic settings and injected prompts only; no owner files, credentials or network.
function prompts(answers: unknown[]) {
  const remaining = [...answers], printed: string[] = [], questions: { message: string; initial: unknown }[] = [];
  const next = async (message: string, initial?: unknown) => {
    questions.push({ message, initial });
    assert(remaining.length > 0, 'Unexpected health preference prompt');
    return remaining.shift() as never;
  };
  const p: PreferencePrompts = { choose: next, text: next, number: next, confirm: next, checklist: next,
    print: text => printed.push(text) };
  return { p, remaining, printed, questions };
}
const daytime = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
const allHours = { enabled: true, warnAfterMinutes: 30, delivery: 'all-hours' as const, allHoursConfirmed: true };

test('health opt-in separately chooses duration and nighttime delivery, preserving battery-only settings', async () => {
  const source = config({ notifications: { full: false, discharge: false }, daytimeDischarge: daytime });
  const before = structuredClone(source), h = prompts([true, 30, 'all-hours', true, true]);
  const result = await configureHealth(source, h.p);
  assert.deepEqual(result.dataHealth, allHours);
  assert.deepEqual(source, before);
  assert.deepEqual({ ...result, dataHealth: undefined }, { ...source, dataHealth: undefined });
  assert.equal(h.remaining.length, 0);
  assert.equal(h.questions[0].initial, false);
  assert.equal(h.questions.find(q => q.message.includes('minutes'))?.initial, undefined);
  assert.equal(h.questions.filter(q => /night|Save/.test(q.message)).every(q => q.initial === false), true);
  const text = h.printed.join('\n');
  assert.match(text, /30 minutes/); assert.match(text, /including at night/);
  assert.match(text, /independent of battery notification switches/i);
  assert.match(text, /full startup grace/i); assert.match(text, /CPU.*unmeasured/i);
  assert.match(text, /does not verify.*receipt/i); assert.match(text, /npm run deploy/);
  assert.doesNotMatch(text, /stationId|123|latitude|longitude|credentials/i);
});
test('health daytime choice reuses only the existing window and never the discharge duration', async () => {
  const h = prompts([true, 45, 'daytime', true]);
  const result = await configureHealth(config({ daytimeDischarge: daytime }), h.p);
  assert.deepEqual(result.dataHealth, { enabled: true, warnAfterMinutes: 45, delivery: 'daytime' });
  assert.match(h.printed.join('\n'), /06:00–18:00 Asia\/Manila/);
  assert.match(h.printed.join('\n'), /45 minutes/);
  assert.doesNotMatch(h.printed.join('\n'), /15 minutes of sampled discharge/);
  assert.equal(h.remaining.length, 0);
});
test('health opt-out removes only health settings after explicit local save consent', async () => {
  const source = config({ dataHealth: allHours });
  const h = prompts([false, true]);
  const result = await configureHealth(source, h.p);
  assert.equal(result.dataHealth, undefined);
  assert.deepEqual(result, config()); assert.deepEqual(source.dataHealth, allHours);
  assert.match(h.printed.join('\n'), /health notices: off/i);
  assert.match(h.printed.join('\n'), /cleanup.*scheduled/i);
  assert.equal(h.remaining.length, 0);
});
test('health wizard refuses missing window, unsupported delivery and unconfirmed nighttime delivery', async () => {
  await assert.rejects(configureHealth(config(), prompts([true, 30, 'daytime']).p), /data_health_config_invalid/);
  await assert.rejects(configureHealth(config(), prompts([true, 30, 'synthetic-unsupported']).p), /data_health_config_invalid/);
  await assert.rejects(configureHealth(config(), prompts([true, 30, 'all-hours', false]).p), /health_setup_not_confirmed/);
});
test('health wizard refuses short, invalid and freshness-overlapping durations without returning settings', async () => {
  for (const minutes of [14, 121, 15.5, NaN, 60]) {
    await assert.rejects(configureHealth(config({ maxAgeSeconds: 3600 }),
      prompts([true, minutes]).p), /data_health_config_invalid/);
  }
});
test('health wizard rejects invalid saved settings before prompting and cancellation never returns changes', async () => {
  const h = prompts([]);
  await assert.rejects(configureHealth(config({ dataHealth: { ...allHours, warnAfterMinutes: 2 } }), h.p), /data_health_config_invalid/);
  assert.equal(h.questions.length, 0);
  await assert.rejects(configureHealth(config(), prompts([true, 30, 'all-hours', true, false]).p), /health_setup_not_confirmed/);
  await assert.rejects(configureHealth(config({ dataHealth: allHours }), prompts([false, false]).p), /health_setup_not_confirmed/);
});
test('existing summaries/settings distinguish muted battery alerts, health consent and paused monitoring', () => {
  const c = config({ notifications: { full: false, discharge: false }, dataHealth: allHours });
  for (const text of [preferencesSummary(c), applyTelegramCommand(c, '/settings').reply]) {
    assert.match(text, /Health notices: on.*30 minutes/);
    assert.match(text, /including at night/);
    assert.match(text, /independent of battery notification switches/i);
    assert.doesNotMatch(text, /stationId|123/);
  }
  assert.match(preferencesSummary(config()), /Health notices: off/);
  assert.match(preferencesSummary({ ...c, enabled: false }), /paused.*monitoring is disabled/i);
  const invalid = config({ dataHealth: { ...allHours, warnAfterMinutes: 2 } });
  assert.match(preferencesSummary(invalid), /Health notices: invalid.*not ready/i);
  assert.match(applyTelegramCommand(c, '/settings').reply, /health:setup/);
  assert.deepEqual(applyTelegramCommand(c, '/health on').config, c);
});
test('health setup recovery is fixed, offers a safe local opt-out and keeps cancellation separate', () => {
  assert.match(setupHint('data_health_config_invalid') ?? '', /wrangler\.jsonc.*dataHealth/);
  assert.match(setupHint('data_health_config_invalid') ?? '', /omit.*health:setup/i);
  assert.match(setupHint('health_setup_not_confirmed') ?? '', /not saved.*manual/);
  assert.equal(setupHint('synthetic-private-health-error'), undefined);
});
