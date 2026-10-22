import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureWeather } from '../scripts/weather-preferences.ts';
import { preferencesSummary, type PreferencePrompts } from '../scripts/preferences.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';
import { config } from './helpers.ts';

// Synthetic offline prompts/location. No private files or real services are used.
function prompts(answers: unknown[]) {
  const remaining = [...answers], printed: string[] = [];
  const next = async () => { assert(remaining.length > 0, 'Unexpected weather prompt'); return remaining.shift() as never; };
  const p: PreferencePrompts = { choose: next, text: next, number: next, confirm: next, checklist: next,
    print: text => printed.push(text) };
  return { p, remaining, printed };
}
test('weather setup requires eligibility and coordinates while preserving other owner preferences', async () => {
  const source = config(), before = structuredClone(source), h = prompts([true, true, 10, 20, true]);
  const c = await configureWeather(source, h.p);
  assert.deepEqual(c.weather, { enabled: true, nonCommercialConfirmed: true, latitude: 10, longitude: 20 });
  assert.deepEqual(source, before);
  assert.deepEqual({ ...c, weather: undefined }, { ...source, weather: undefined });
  assert.match(h.printed.join('\n'), /Open-Meteo/); assert.match(h.printed.join('\n'), /hour/i);
  assert.equal(h.remaining.length, 0);
});
test('declined eligibility or final confirmation never returns weather settings to save', async () => {
  await assert.rejects(configureWeather(config(), prompts([true, false]).p), /weather_eligibility_not_confirmed/);
  await assert.rejects(configureWeather(config(), prompts([true, true, 10, 20, false]).p), /weather_setup_not_confirmed/);
});
test('invalid coordinates fail and disabling weather preserves the saved location for reuse', async () => {
  await assert.rejects(configureWeather(config(), prompts([true, true, 91, 20]).p), /weather_config_invalid/);
  const source = { ...config(), weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } };
  const c = await configureWeather(source, prompts([false]).p);
  assert.deepEqual(c.weather, { ...source.weather, enabled: false });
  assert.equal(source.weather.enabled, true);
});
test('settings and offline summaries expose weather eligibility without printing location coordinates', () => {
  const c = { ...config(), weather: { enabled: true, latitude: 10.1234, longitude: 20.4567, nonCommercialConfirmed: true } };
  for (const text of [applyTelegramCommand(c, '/settings').reply, preferencesSummary(c)]) {
    assert.match(text, /Weather context: on/);
    assert.doesNotMatch(text, /10\.1234|20\.4567/);
  }
});
