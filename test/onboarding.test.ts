import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureNotifications, configureChargingProfiles, configurePreferences, preferencesSummary,
  type PreferencePrompts } from '../scripts/preferences.ts';
import { config } from './helpers.ts';

function prompts(answers: unknown[]) {
  const remaining = [...answers];
  const printed: string[] = [], asked: string[] = [];
  const next = async (message: string) => {
    asked.push(message);
    assert(remaining.length > 0, `Unexpected prompt: ${message}`);
    return remaining.shift() as never;
  };
  const p: PreferencePrompts = {
    checklist: next, choose: next, confirm: next, number: next, text: next,
    print: message => printed.push(message),
  };
  return { p, printed, asked, remaining };
}
const electrical = { enabled: true, confirmed: true, phases: 1 as const, voltage: 230, minimumAmps: 8 };

test('notification onboarding supports full-only, discharge-only and no notifications', async () => {
  for (const selected of [['full'], ['discharge'], []]) {
    const { p, remaining } = prompts([selected]);
    assert.deepEqual(await configureNotifications(undefined, p), {
      full: selected.includes('full'), discharge: selected.includes('discharge'),
    });
    assert.equal(remaining.length, 0);
  }
});
test('notification onboarding rejects unknown categories rather than enabling them', async () => {
  await assert.rejects(configureNotifications(undefined, prompts([['control-charger']]).p), /notification_preferences_invalid/);
});
test('8/13/MAX preset asks for MAX nominal power and keeps amperage unspecified', async () => {
  const h = prompts(['8-13-max', 7200]);
  const profiles = await configureChargingProfiles(electrical, h.p);
  assert.deepEqual(profiles, [
    { id: '8a', label: '8 A', type: 'amps', amps: 8 },
    { id: '13a', label: '13 A', type: 'amps', amps: 13 },
    { id: 'max', label: 'MAX', type: 'power', nominalWatts: 7200 },
  ]);
  assert.equal(h.remaining.length, 0);
  assert(h.printed.join('\n').includes('1.84 kW'));
});
test('custom profiles support another charger without brand-specific assumptions', async () => {
  const h = prompts(['custom', 2, 'Eco', 'amps', 10, 'Fast', 'power', 6600]);
  const profiles = await configureChargingProfiles({ ...electrical, minimumAmps: 6 }, h.p);
  assert.deepEqual(profiles, [
    { id: 'profile-1', label: 'Eco', type: 'amps', amps: 10 },
    { id: 'profile-2', label: 'Fast', type: 'power', nominalWatts: 6600 },
  ]);
  assert.equal(h.remaining.length, 0);
});
test('a user without an EV only sees notification choices and no electrical questions', async () => {
  const original = config();
  const h = prompts([['full'], false, false]);
  const updated = await configurePreferences(original, h.p);
  assert.deepEqual(updated.notifications, { full: true, discharge: false });
  assert.deepEqual(updated.ev, { enabled: false });
  assert.equal(h.remaining.length, 0);
  assert.equal(original.ev.enabled, false);
  assert(h.printed.join('\n').includes('Battery supplying power: off'));
  assert.match(h.printed.join('\n'), /Battery notifications do not require EV hints, weather or Telegram commands/);
  assert.match(h.printed.join('\n'), /npm run deploy/);
});
test('electrical/profile confirmation is required and cancellation leaves the source config unchanged', async () => {
  const original = config();
  const before = structuredClone(original);
  const h = prompts([['full', 'discharge'], false, true, '1', 230, 8, '8-13-max', 7000, false]);
  await assert.rejects(configurePreferences(original, h.p), /ev_config_unconfirmed/);
  assert.deepEqual(original, before);
});
test('confirmed electrical settings and profiles can be reused when changing notifications', async () => {
  const original = config({ ev: { ...electrical,
    profiles: [{ id: 'low', label: 'Low', type: 'amps', amps: 8 }] } });
  const h = prompts([['discharge'], false, true, true, 'keep', true]);
  const updated = await configurePreferences(original, h.p);
  assert.deepEqual(updated.notifications, { full: false, discharge: true });
  assert.deepEqual(updated.ev.profiles, original.ev.profiles);
  assert.equal(h.remaining.length, 0);
});
test('unsafe preset and custom inputs fail before configuration can be saved', async () => {
  await assert.rejects(configureChargingProfiles({ ...electrical, minimumAmps: 10 }, prompts(['8-13-max', 7000]).p), /charging_profiles_invalid/);
  await assert.rejects(configureChargingProfiles(electrical, prompts(['custom', 13]).p), /charging_profiles_invalid/);
  await assert.rejects(configureChargingProfiles(electrical, prompts(['custom', 1, 'Unsafe', 'amps', 6]).p), /charging_profiles_invalid/);
});
test('MAX in the 8/13/MAX preset cannot be rated below its 13 A setting', async () => {
  await assert.rejects(configureChargingProfiles(electrical, prompts(['8-13-max', 2500]).p), /charging_profiles_invalid/);
  await assert.rejects(configureChargingProfiles({ ...electrical, phases: 3 }, prompts(['8-13-max', 7000]).p), /charging_profiles_invalid/);
});
test('complete new-EV onboarding saves only explicitly confirmed profiles and preferences', async () => {
  const original = config();
  const h = prompts([['full', 'discharge'], false, true, '1', 230, 8, '8-13-max', 7000, true]);
  const updated = await configurePreferences(original, h.p);
  assert.deepEqual(updated.notifications, { full: true, discharge: true });
  assert.equal(updated.ev.confirmed, true);
  assert.equal(updated.ev.profiles?.length, 3);
  assert.equal(h.remaining.length, 0);
  assert.notEqual(updated, original);
});
test('MAX power must be entered explicitly instead of assuming a rating for another installation', async () => {
  const h = prompts(['8-13-max']);
  let initialValue: number | undefined = 123;
  h.p.number = async (_message, initial) => { initialValue = initial; return 7000; };
  await configureChargingProfiles(electrical, h.p);
  assert.equal(initialValue, undefined);
});
test('turning EV hints off preserves confirmed electrical settings and custom profiles for later reuse', async () => {
  const original = config({ ev: { ...electrical,
    profiles: [{ id: 'eco', label: 'Eco', type: 'amps', amps: 8 }] } });
  const h = prompts([['full'], false, false]);
  const updated = await configurePreferences(original, h.p);
  assert.equal(updated.ev.enabled, false);
  assert.equal(updated.ev.confirmed, true);
  assert.deepEqual(updated.ev.profiles, original.ev.profiles);
  assert.equal(updated.ev.voltage, 230);
});
test('offline preferences can edit alert thresholds and freshness limits without credentials', async () => {
  const h = prompts([['full', 'discharge'], true, 95, 92, 500, 150, 600, 720, false]);
  const updated = await configurePreferences(config(), h.p);
  assert.equal(updated.fullSoc, 95);
  assert.equal(updated.fullRearmSoc, 92);
  assert.equal(updated.dischargeWatts, 500);
  assert.equal(updated.dischargeRearmWatts, 150);
  assert.equal(h.remaining.length, 0);
});

test('enabled command summary describes local configuration and pending manual activation, not live readiness', () => {
  const source = config({ telegram: { enabled: true } }), before = structuredClone(source);
  const text = preferencesSummary(source);
  assert.match(text, /Telegram commands: enabled in local configuration/);
  for (const command of ['/help', '/status', '/settings', 'npm run telegram:setup', 'npm run secrets:upload',
    'npm run deploy', 'npm run telegram:webhook']) assert(text.includes(command), `Missing next step: ${command}`);
  assert.match(text, /does not verify owner pairing, secret upload, deployment, webhook registration or message receipt/);
  assert.match(text, /confirm.*\/status.*owner chat/i);
  assert.doesNotMatch(text, /settings menus are not active|commands are ready|webhook is registered/i);
  assert.deepEqual(source, before);
});

for (const telegram of [undefined, { enabled: false }]) {
  test(`commands ${telegram ? 'disabled' : 'omitted'} keep battery notifications usable without pairing`, () => {
    const text = preferencesSummary(config({ telegram }));
    assert.match(text, /Telegram commands: off in local configuration/);
    assert.match(text, /optional.*npm run telegram:setup/i);
    assert.match(text, /Battery notifications do not require EV hints, weather or Telegram commands/);
    assert.match(text, /npm run deploy/);
    assert.doesNotMatch(text, /npm run telegram:webhook|confirm.*\/status|settings menus are not active/i);
  });
}

test('summary separates configured forecasts from future planning and omits synthetic installation identifiers', () => {
  // Synthetic identifiers/location, never actual owner configuration or credentials.
  const source = config({ stationId: 987654321, telegram: { enabled: true }, weather: {
    enabled: true, latitude: 10.1234, longitude: 20.4567, nonCommercialConfirmed: true,
  } });
  const before = structuredClone(source), text = preferencesSummary(source);
  assert.match(text, /Weather context: on.*Open-Meteo/);
  assert.match(text, /Forecast charging plans and overnight EV exceptions are not implemented/);
  assert.match(text, /Manual EV hints: off/);
  assert.doesNotMatch(text, /987654321|10\.1234|20\.4567/);
  assert.deepEqual(source, before);
});
