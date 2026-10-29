import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTelegramCommand, settingsOverrides } from '../src/telegram-settings.ts';
import { config } from './helpers.ts';

test('settings command shows current battery rules and available controls', () => {
  const result = applyTelegramCommand(config(), '/settings');
  assert.equal(result.changed, false);
  assert.match(result.reply, /Battery full: on at 100%/);
  assert.match(result.reply, /Battery supplying power: on above 300 W/);
  assert.match(result.reply, /\/full on\|off/);
});

test('owner commands toggle only the requested notification', () => {
  const initial = config();
  const before = structuredClone(initial);
  const result = applyTelegramCommand(initial, '/full@deye_bot off');
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.notifications, { full: false, discharge: true });
  assert.deepEqual(initial, before);
  assert.match(result.reply, /saved/i);
});

test('threshold commands preserve re-arm invariants and reject invalid values', () => {
  const initial = config();
  const full = applyTelegramCommand(initial, '/full_soc 98');
  assert.equal(full.changed, true);
  assert.equal(full.config.fullSoc, 98);
  assert.equal(full.config.fullRearmSoc, 97);
  assert.match(full.reply, /saved/i);

  const invalid = applyTelegramCommand(initial, '/full_soc 95');
  assert.equal(invalid.changed, false);
  assert.match(invalid.reply, /re-arm threshold must be below/i);

  const valid = applyTelegramCommand(initial, '/discharge_watts 600');
  assert.equal(valid.changed, true);
  assert.equal(valid.config.dischargeWatts, 600);
  assert.equal(settingsOverrides(valid.config).dischargeWatts, 600);

  const invalidRearm = applyTelegramCommand(initial, '/discharge_rearm_watts 300');
  assert.equal(invalidRearm.changed, false);
  assert.equal(invalidRearm.config.dischargeRearmWatts, initial.dischargeRearmWatts);
  assert.match(invalidRearm.reply, /below the discharge threshold/i);
});

test('unknown and malformed commands do not change settings', () => {
  for (const command of ['/bogus', '/full maybe', '/full_soc NaN']) {
    const result = applyTelegramCommand(config(), command);
    assert.equal(result.changed, false);
    assert.match(result.reply, /commands/i);
  }
});
