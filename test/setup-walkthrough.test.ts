import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetupWalkthrough } from '../scripts/setup-walkthrough.ts';
import { setupHint } from '../scripts/setup-hints.ts';
import { config } from './helpers.ts';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('synthetic health rehearsal chooses separate daytime/all-hours policies then finishes off without changing the public defaults', async () => {
  const source = config({ enabled: false, measurementsConfirmed: false }), before = structuredClone(source);
  const output: string[] = [];
  const result = await runSetupWalkthrough(source, text => output.push(text));
  assert.deepEqual(result.healthRehearsal?.daytime, { enabled: true, warnAfterMinutes: 30, delivery: 'daytime' });
  assert.deepEqual(result.healthRehearsal?.allHours, {
    enabled: true, warnAfterMinutes: 45, delivery: 'all-hours', allHoursConfirmed: true,
  });
  assert.equal(result.config.dataHealth, undefined);
  assert.deepEqual(source, before);
  assert.equal(result.config.daytimeDischarge?.minimumMinutes, 15);
  assert.deepEqual(result.requests, { deye: 3, telegram: 4, weather: 0 });
  const text = output.join('\n');
  assert.match(text, /health:setup/);
  assert.match(text, /health.*30.*45.*illustrative|illustrative.*30.*45/i);
  assert.match(text, /I accept informational health notices including at night/);
  assert.match(text, /does not authorize overnight EV charging/);
  assert.match(text, /rehearsal.*finishes.*off/i);
});

test('health cancellation rehearses the real unsaved result and retains the last in-memory consent', async () => {
  const output: string[] = [], source = config({ enabled: false, measurementsConfirmed: false });
  const result = await runSetupWalkthrough(source, text => output.push(text));
  assert.deepEqual(result.healthRehearsal?.cancelledChange, {
    code: 'health_setup_not_confirmed', retained: {
      enabled: true, warnAfterMinutes: 45, delivery: 'all-hours', allHoursConfirmed: true,
    },
  });
  const text = output.join('\n');
  assert.match(text, /health_setup_not_confirmed.*not saved/);
  assert.match(text, /previous.*in-memory.*retained/i);
  assert.match(text, /data_health_config_invalid.*wrangler\.jsonc/);
});

test('health rehearsal forbids live access and explains private manual CI handoff without publishing a synthetic snapshot', async () => {
  const originalFetch = globalThis.fetch, output: string[] = [];
  globalThis.fetch = async () => { throw new Error('Live access forbidden in synthetic health rehearsal'); };
  try {
    const result = await runSetupWalkthrough(config({ enabled: false, measurementsConfirmed: false }), text => output.push(text));
    assert.equal(result.liveValidated, false);
    const text = output.join('\n');
    assert.match(text, /WORKER_CONFIG_JSON/);
    assert.match(text, /production environment/);
    assert.match(text, /manual.*main-only/i);
    assert.match(text, /do not copy.*synthetic.*snapshot/i);
    assert.match(text, /CI.*handoff.*not performed/i);
    assert.match(text, /receipt.*unverified/); assert.match(text, /CPU.*unverified/);
    assert.doesNotMatch(text, /synthetic-password|synthetic-app-secret|synthetic-bearer|789|123:synthetic-token|secret_token/);
    assert.deepEqual(result.requests, { deye: 3, telegram: 4, weather: 0 });
  } finally { globalThis.fetch = originalFetch; }
});

test('the complete synthetic prompt journey rehearses setup, daytime, weather and owner pairing with no live access', async () => {
  const source = config({ enabled: false, measurementsConfirmed: false }), before = structuredClone(source), output: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Live access forbidden in synthetic walkthrough'); };
  try {
    const result = await runSetupWalkthrough(source, text => output.push(text));
    assert.deepEqual(source, before); assert.equal(result.liveValidated, false);
    assert.equal(result.config.measurementsConfirmed, true); assert.equal(result.config.telegram?.enabled, true);
    assert.deepEqual(result.config.daytimeDischarge, { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 });
    assert.deepEqual(result.config.weather, { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true });
    assert.equal(result.requests.deye, 3); assert.equal(result.requests.telegram, 4); assert.equal(result.requests.weather, 0);
    const text = output.join('\n');
    assert.match(text, /SYNTHETIC/); assert.match(text, /scripted answers/i);
    assert.match(text, /city-level/); assert.match(text, /non-commercial/);
    assert.match(text, /House battery.*night|Nighttime.*house/i);
    assert.match(text, /deployment.*pending/i); assert.match(text, /receipt.*unverified/i);
    assert.match(text, /webhook.*pending/i); assert.match(text, /CPU.*unverified/i);
    assert.doesNotMatch(text, /synthetic-password|synthetic-app-secret|789|123:synthetic-token|\[10,20\]|secret_token/);
  } finally { globalThis.fetch = originalFetch; }
});

test('setup recovery gives fixed guidance for credential, region, measurement and weather failures', () => {
  for (const [code, expected] of [
    ['deye_auth_rejected', /credentials.*region/i],
    ['no_stations_in_selected_region_or_company', /region.*company/i],
    ['measurement_missing_or_invalid', /DEYE-API/],
    ['measurements_not_confirmed', /units.*direction/i],
    ['reading_stale', /fresh.*reading/i],
    ['weather_eligibility_not_confirmed', /weather:setup.*off/i],
    ['weather_config_invalid', /latitude.*longitude/i],
  ] as const) assert.match(setupHint(code) ?? '', expected);
  assert.match(setupHint('telegram_webhook_already_configured') ?? '', /dedicated bot/);
  assert.match(setupHint('telegram_owner_setup_required') ?? '', /telegram:setup/);
  for (const code of ['synthetic-secret-bearing exception', '__proto__', 'https://synthetic.invalid/?secret=private']) {
    assert.equal(setupHint(code), undefined);
  }
});

test('the standalone demo runs outside the checkout without using environment credentials or changing owner files', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'deye-setup-demo-'));
  const sentinel = 'synthetic-owner-file-do-not-use';
  try {
    for (const file of ['.dev.vars', 'wrangler.jsonc']) writeFileSync(join(sandbox, file), sentinel);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new NodeURL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new NodeURL('../scripts/setup-demo.ts', import.meta.url)),
    ], { cwd: sandbox, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, DEYE_APP_ID: sentinel, DEYE_APP_SECRET: sentinel, TELEGRAM_BOT_TOKEN: sentinel,
        WORKER_CONFIG_JSON: sentinel, CLOUDFLARE_API_TOKEN: sentinel } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SYNTHETIC rehearsal complete/);
    assert.match(result.stdout, /health:setup/);
    assert.match(result.stdout, /health_setup_not_confirmed.*not saved/);
    assert.match(result.stdout, /CI.*handoff.*not performed/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
    for (const file of ['.dev.vars', 'wrangler.jsonc']) assert.equal(readFileSync(join(sandbox, file), 'utf8'), sentinel);
  } finally {
    // Only remove this exact, freshly created temp child after checking its path.
    assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
    assert.match(sandbox.slice(sandbox.lastIndexOf('deye-setup-demo-')), /^deye-setup-demo-[^\\/]+$/);
    rmSync(sandbox, { recursive: true });
  }
});
