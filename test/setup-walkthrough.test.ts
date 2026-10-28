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

// All policies, accounts, transports and temporary owner-file sentinels are synthetic.
test('recap rehearsal explicitly chooses illustrative schedules through the real helper and finishes off', async () => {
  const source = config({ enabled: false, measurementsConfirmed: false }), before = structuredClone(source), output: string[] = [];
  const result = await runSetupWalkthrough(source, text => output.push(text));
  assert('recapRehearsal' in result, 'Expected the recap setup journey');
  const recap = result.recapRehearsal as { daytime: unknown; nighttime: unknown };
  assert.deepEqual(recap.daytime, { enabled: true, timeZone: 'Asia/Manila', hour: 7, minute: 10, scheduleConfirmed: true });
  assert.deepEqual(recap.nighttime, { enabled: true, timeZone: 'Asia/Manila', hour: 19, minute: 25, scheduleConfirmed: true });
  assert.equal(result.config.dailyRecap, undefined); assert.equal(result.config.dataHealth, undefined);
  assert.deepEqual(source, before); assert.deepEqual(result.requests, { deye: 3, telegram: 4, weather: 0 });
  const text = output.join('\n');
  assert.match(text, /recap:setup.*illustrative/i);
  assert.match(text, /I accept a daily cached recap at 07:10 Asia\/Manila/);
  assert.match(text, /I accept a daily cached recap at 19:25 Asia\/Manila.*including at night.*does not authorize overnight EV charging/);
  assert.equal((text.match(/\[SYNTHETIC prompt\] Save these recap preferences locally/g) ?? []).length, 4);
  assert.match(text, /skip the current local date/); assert.match(text, /15-minute opportunity/);
  assert.match(text, /Recap rehearsal finishes off.*no personal.*schedule/i);
});

test('recap rehearsal cancels both schedule consent and final save, retaining the last in-memory policy', async () => {
  const output: string[] = [];
  const result = await runSetupWalkthrough(config({ enabled: false, measurementsConfirmed: false }), text => output.push(text));
  assert('recapRehearsal' in result, 'Expected recap cancellation evidence');
  const recap = result.recapRehearsal as { declinedSchedule: unknown; cancelledChange: unknown };
  const retained = { enabled: true, timeZone: 'Asia/Manila', hour: 19, minute: 25, scheduleConfirmed: true };
  assert.deepEqual(recap.declinedSchedule, { code: 'recap_setup_not_confirmed', retained });
  assert.deepEqual(recap.cancelledChange, { code: 'recap_setup_not_confirmed', retained });
  const text = output.join('\n');
  assert.match(text, /decline.*schedule consent/i); assert.match(text, /decline saving.*recap/i);
  assert.equal((text.match(/recap_setup_not_confirmed:.*not saved/g) ?? []).length, 2);
  assert.equal((text.match(/Previous in-memory recap preference retained/g) ?? []).length, 2);
});

test('recap rehearsal exercises invalid saved consent before prompts and fixed recovery without live access', async () => {
  const originalFetch = globalThis.fetch, output: string[] = [];
  globalThis.fetch = async () => { throw new Error('Live access forbidden in synthetic recap rehearsal'); };
  try {
    const result = await runSetupWalkthrough(config({ enabled: false, measurementsConfirmed: false }), text => output.push(text));
    assert('recapRehearsal' in result, 'Expected invalid recap setting rehearsal');
    const recap = result.recapRehearsal as { invalidSaved: unknown };
    assert.deepEqual(recap.invalidSaved, { code: 'daily_recap_config_invalid', prompted: false });
    const text = output.join('\n');
    assert.match(text, /daily_recap_config_invalid:.*wrangler\.jsonc.*dailyRecap/);
    assert.match(text, /Invalid saved recap consent rejected before prompts/);
    assert.match(text, /WORKER_CONFIG_JSON/); assert.match(text, /manual.*main-only/);
    assert.match(text, /do not copy.*synthetic.*snapshot/i);
    assert.match(text, /receipt.*unverified/); assert.match(text, /CPU.*unverified/);
    assert.doesNotMatch(text, /synthetic-password|synthetic-app-secret|synthetic-bearer|789|123:synthetic-token|secret_token|"stationId"/);
    assert.deepEqual(result.requests, { deye: 3, telegram: 4, weather: 0 }); assert.equal(result.liveValidated, false);
  } finally { globalThis.fetch = originalFetch; }
});

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
    assert.match(result.stdout, /recap:setup/);
    assert.match(result.stdout, /recap_setup_not_confirmed.*not saved/);
    assert.match(result.stdout, /Recap rehearsal finishes off/);
    assert.match(result.stdout, /Invalid saved recap consent rejected before prompts/);
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
