import { SafeError } from '../src/errors.ts';
import type { Config, Dependencies, Secrets } from '../src/types.ts';
import { DeyeClient } from '../src/deye.ts';
import { jsonPost } from '../src/http.ts';
import { sendTelegram } from '../src/telegram.ts';
import { runOwnerSetup, configureTelegramOwner, type SetupPrompts } from './owner-setup.ts';
import { configureDaytime } from './daytime-preferences.ts';
import { configureWeather } from './weather-preferences.ts';
import { configureHealth } from './health-preferences.ts';
import { configureRecap } from './recap-preferences.ts';
import { webhookRegistration } from './telegram-onboarding.ts';
import { setupHint } from './setup-hints.ts';

// Every answer, identifier, credential and upstream response below is synthetic.
// There is no filesystem, environment, subprocess or live-fetch capability here.
export async function runSetupWalkthrough(source: Config, print: (text: string) => void) {
  print('SYNTHETIC OWNER WALKTHROUGH — scripted answers, intercepted services, in-memory settings only.');
  print('This rehearses the current separate setup commands. It does not configure your installation.');
  const now = Date.parse('2026-10-23T02:00:00Z'), requests = { deye: 0, telegram: 0, weather: 0 };
  const answers: unknown[] = [
    'eu', 'synthetic-app', 'synthetic-app-secret', 'email', 'synthetic@example.invalid', 'synthetic-password', '',
    '123', 'W', 'iso-offset', true, ['full', 'discharge'], false, false, '123:synthetic-token', '456', true,
    true, 'Asia/Manila', 6, 18, 15, true,
    true, true, 10, 20, true, '789',
    true, 30, 'daytime', true,
    true, 45, 'all-hours', true, true,
    true, 60, 'daytime', false,
    false, true,
    true, 'Asia/Manila', 7, 10, true, true,
    true, 'Asia/Manila', 19, 25, true, true,
    true, 'Asia/Manila', 20, 0, false,
    true, 'Asia/Manila', 21, 5, true, false,
    false, true,
  ];
  let promptCount = 0;
  const next = async (message: string) => {
    if (!answers.length) throw new SafeError('synthetic_setup_answers_invalid');
    promptCount++;
    print(`[SYNTHETIC prompt] ${message} [scripted answer]`);
    return answers.shift() as never;
  };
  const p: SetupPrompts = {
    hidden: next, checklist: next, confirm: next,
    choose: async (message, choices) => {
      const value = await next(message);
      if (!choices.some(c => c.value === value)) throw new SafeError('synthetic_setup_answers_invalid');
      return value;
    },
    number: async (message, _initial, validate) => {
      const value = await next(message);
      if (typeof value !== 'number' || (validate && validate(value) !== true)) throw new SafeError('synthetic_setup_answers_invalid');
      return value;
    },
    text: async (message, _initial, validate) => {
      const value = await next(message);
      if (typeof value !== 'string' || (validate && validate(value) !== true)) throw new SafeError('synthetic_setup_answers_invalid');
      return value;
    },
    print: text => print(`[SYNTHETIC result] ${text}`),
  };
  const deps: Dependencies = {
    now: () => now, random: () => 0, sleep: async () => {},
    fetch: (async resource => {
      const url = new URL(String(resource));
      let body: unknown;
      if (url.hostname === 'eu1-developer.deyecloud.com') {
        requests.deye++;
        if (url.pathname.endsWith('/account/token')) body = { success: true, accessToken: 'synthetic-bearer', expiresIn: 3600 };
        else if (url.pathname.endsWith('/station/list')) body = { success: true, total: 1,
          stationList: [{ id: 123, name: 'Synthetic station', regionTimezone: 'Asia/Manila' }] };
        else if (url.pathname.endsWith('/station/latest')) body = { success: true, batterySOC: 80, dischargePower: 500,
          lastUpdateTime: new Date(now).toISOString() };
      } else if (url.hostname === 'api.telegram.org') {
        requests.telegram++;
        if (url.pathname.endsWith('/sendMessage')) body = { ok: true };
        else if (url.pathname.endsWith('/getWebhookInfo')) body = { ok: true, result: { url: '' } };
        else if (url.pathname.endsWith('/getUpdates')) body = { ok: true, result: [
          { message: { from: { id: 789 }, chat: { id: 456 }, text: '/start' } },
        ] };
        else if (url.pathname.endsWith('/getMe')) body = { ok: true, result: { username: 'synthetic_bot' } };
      }
      if (!body) throw new SafeError('synthetic_setup_request_not_allowed');
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  };
  print('1. Rehearse npm run setup: synthetic Deye reading, notification choices and Telegram test acknowledgement.');
  const setup = await runOwnerSetup(source, {} as Secrets, p, {
    now: deps.now, deye: (c, s) => new DeyeClient(c, s, undefined, deps),
    preview: () => print('[SYNTHETIC preview] Battery fields only; compare units and UTC time before confirming.'),
    testTelegram: s => sendTelegram(s, 'Synthetic setup test; no live recipient.', deps),
  });
  print('2. Rehearse npm run daytime:setup: illustrative Asia/Manila, 06:00–18:00, 15-minute tolerance.');
  const daytime = await configureDaytime(setup.config, p);
  print('3. Rehearse npm run weather:setup: city-level synthetic coordinates, eligibility and explicit local-save confirmation. No forecast is fetched.');
  const weather = await configureWeather(daytime, p);
  print('4. Rehearse npm run telegram:setup: select an authorized owner and prepare a private webhook secret.');
  const paired = await configureTelegramOwner(weather, setup.secrets, p, {
    call: (method, body = {}) => jsonPost(`https://api.telegram.org/bot${setup.secrets.TELEGRAM_BOT_TOKEN}/${method}`,
      body, {}, deps, 'telegram', 1),
    newSecret: () => 'synthetic-webhook-secret-1234567890',
  });
  webhookRegistration('https://monitor.synthetic.invalid/telegram/webhook', '', paired.secrets.TELEGRAM_WEBHOOK_SECRET!);
  print('5. Rehearse npm run health:setup: health durations 30 and 45 minutes are illustrative, separate from the 15-minute discharge tolerance.');
  const daytimeHealth = await configureHealth(paired.config, p);
  const allHoursHealth = await configureHealth(daytimeHealth, p);
  print('[SYNTHETIC cancellation] Decline saving a 60-minute daytime change; the previous in-memory choice must be retained.');
  const beforeCancellation = JSON.stringify(allHoursHealth);
  try {
    await configureHealth(allHoursHealth, p);
    throw new SafeError('synthetic_health_cancellation_expected');
  } catch (error) {
    if (!(error instanceof SafeError) || error.code !== 'health_setup_not_confirmed') throw error;
    if (JSON.stringify(allHoursHealth) !== beforeCancellation) throw new SafeError('synthetic_health_cancellation_changed_settings');
    print(`[SYNTHETIC result] health_setup_not_confirmed: ${setupHint('health_setup_not_confirmed')}`);
    print('[SYNTHETIC result] Previous in-memory health preference retained; no settings returned to save.');
  }
  const cancelledChange = { code: 'health_setup_not_confirmed' as const, retained: structuredClone(allHoursHealth.dataHealth) };
  const healthOff = await configureHealth(allHoursHealth, p);
  print('[SYNTHETIC result] Health rehearsal finishes off. The public default remains off and no personal health threshold was chosen.');
  print('6. Rehearse npm run recap:setup: illustrative 07:10 and 19:25 Asia/Manila schedules, explicitly entered with separate schedule and save consent. These are not personal defaults.');
  const daytimeRecap = await configureRecap(healthOff, p);
  const nighttimeRecap = await configureRecap(daytimeRecap, p);
  const cancelRecap = async () => {
    const before = JSON.stringify(nighttimeRecap);
    try {
      await configureRecap(nighttimeRecap, p);
      throw new SafeError('synthetic_recap_cancellation_expected');
    } catch (error) {
      if (!(error instanceof SafeError) || error.code !== 'recap_setup_not_confirmed') throw error;
      if (JSON.stringify(nighttimeRecap) !== before) throw new SafeError('synthetic_recap_cancellation_changed_settings');
      print(`[SYNTHETIC result] recap_setup_not_confirmed: ${setupHint('recap_setup_not_confirmed')}`);
      print('[SYNTHETIC result] Previous in-memory recap preference retained; no settings returned to save.');
    }
    return { code: 'recap_setup_not_confirmed' as const, retained: structuredClone(nighttimeRecap.dailyRecap) };
  };
  print('[SYNTHETIC cancellation] Decline the 20:00 schedule consent; retain the previous recap policy.');
  const declinedSchedule = await cancelRecap();
  print('[SYNTHETIC cancellation] Decline saving a 21:05 recap change; retain the previous recap policy.');
  const cancelledRecap = await cancelRecap();
  const beforeInvalid = promptCount;
  try {
    await configureRecap({ ...nighttimeRecap,
      dailyRecap: { ...nighttimeRecap.dailyRecap, scheduleConfirmed: false } as never }, p);
    throw new SafeError('synthetic_recap_invalid_settings_expected');
  } catch (error) {
    if (!(error instanceof SafeError) || error.code !== 'daily_recap_config_invalid') throw error;
    if (promptCount !== beforeInvalid) throw new SafeError('synthetic_recap_invalid_settings_prompted');
    print(`[SYNTHETIC result] daily_recap_config_invalid: ${setupHint('daily_recap_config_invalid')}`);
    print('[SYNTHETIC result] Invalid saved recap consent rejected before prompts. Correct or omit only the recap block privately; no automatic repair or personal schedule was chosen.');
  }
  const recapOff = await configureRecap(nighttimeRecap, p);
  if (answers.length) throw new SafeError('synthetic_setup_answers_invalid');
  print('[SYNTHETIC result] Recap rehearsal finishes off. The public default remains off and no personal recap schedule was chosen.');
  print('7. Owner actions: Cloudflare account/KV setup, secret upload and deployment pending; webhook/menu registration pending.');
  print('Private CI handoff not performed: prepare your own WORKER_CONFIG_JSON in the production environment after real setup. Do not copy this synthetic configuration snapshot. Use the existing manual, main-only delivery workflow only after release checks; no snapshot, secret or deployment is uploaded by this rehearsal. See docs/CI-CD.md.');
  print('Live validation: Deye access unverified; Telegram receipt unverified; Cron cycles unverified; CPU/quotas unverified.');
  print('Nighttime battery use remains for the house. A forecast or charging report grants no overnight EV exception.');
  for (const code of ['deye_auth_rejected', 'no_stations_in_selected_region_or_company', 'measurement_missing_or_invalid',
    'telegram_webhook_already_configured', 'telegram_owner_setup_required', 'weather_eligibility_not_confirmed',
    'data_health_config_invalid']) {
    print(`Recovery example — ${code}: ${setupHint(code)}`);
  }
  print('SYNTHETIC rehearsal complete. No owner files read or saved, no live provider call, secret upload, registration or deployment.');
  return { config: recapOff, requests, liveValidated: false as const,
    recapRehearsal: { daytime: daytimeRecap.dailyRecap, nighttime: nighttimeRecap.dailyRecap,
      declinedSchedule, cancelledChange: cancelledRecap, invalidSaved: { code: 'daily_recap_config_invalid' as const, prompted: false as const } },
    healthRehearsal: { daytime: daytimeHealth.dataHealth, allHours: allHoursHealth.dataHealth, cancelledChange } };
}
