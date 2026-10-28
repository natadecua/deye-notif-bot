import { alertText, decodeState, expirePending, isBatteryAlert, resetAfterGap, resetDischargeConfirmation, transition } from './alerts.ts';
import { notificationEnabled, validateConfig } from './config.ts';
import { DeyeClient } from './deye.ts';
import { errorCode, SafeError } from './errors.ts';
import { normalizeReading } from './reading.ts';
import { sendTelegram, validateTelegramSecrets } from './telegram.ts';
import { defaults, type Dependencies, type Env } from './types.ts';
import { BOT_KEY, activeChargingSession, decodeBotState } from './bot-state.ts';
import { dischargeWindowOpen } from './daytime.ts';
import { prepareWeather, fetchWeather, weatherText, type WeatherCache } from './weather.ts';
import { healthMessage, settleHealth, syncHealth } from './health-outbox.ts';
import type { HealthObservation } from './data-health.ts';
import { recapMessage, syncRecap } from './recap-outbox.ts';

export async function runMonitor(env: Env, deps: Dependencies = defaults): Promise<string[]> {
  const base = validateConfig(env.MONITOR_CONFIG);
  if (!base.enabled) return ['monitor_disabled'];
  const bot = base.telegram?.enabled ? decodeBotState(await env.STATE.get(BOT_KEY), base) : undefined;
  const c = validateConfig({ ...base, ...bot?.overrides });
  validateTelegramSecrets(env);
  const state = decodeState(await env.STATE.get('monitor:v1'), c);
  const now = deps.now();
  const events: string[] = [];
  const pendingBefore = state.pending.length;
  state.pending = state.pending.filter(a => !isBatteryAlert(a) || notificationEnabled(c, a.kind));
  const cancelledByPreference = state.pending.length !== pendingBefore;
  resetAfterGap(state, c, now);
  expirePending(state, now);
  const backoff = now < state.apiRetryAt;
  const healthWork = c.dataHealth?.enabled || state.dataHealth !== undefined || state.pending.some(a => a.kind === 'health');
  const recapWork = c.dailyRecap?.enabled || state.dailyRecap !== undefined || state.pending.some(a => a.kind === 'recap');
  if (backoff && !healthWork && !recapWork) {
    if (cancelledByPreference) await env.STATE.put('monitor:v1', JSON.stringify(state));
    return ['api_backoff'];
  }
  let eligibleToSend = false;
  let observation: HealthObservation = { kind: 'idle' };
  if (backoff) events.push('api_backoff');
  else try {
    const raw = await new DeyeClient(c, env, env.STATE, deps).latest();
    const reading = normalizeReading(raw, c, deps.now());
    const outcome = transition(state, reading, c, deps.now());
    observation = outcome === 'accepted' ? { kind: 'accepted', at: reading.at } : { kind: outcome };
    events.push(`reading_${outcome}`);
    // Don't send pending recommendations based on out-of-order/invalid/stale data.
    eligibleToSend = outcome !== 'out_of_order';
    // Drop delayed messages whose triggering condition no longer holds, even if
    // hysteresis hasn't rearmed yet. Do not send outdated amperage advice.
    if (eligibleToSend) {
      state.pending = state.pending.filter(a => !isBatteryAlert(a) || (a.kind === 'full' ? reading.soc >= c.fullSoc :
        reading.dischargeWatts > c.dischargeWatts && dischargeWindowOpen(c, reading.at, deps.now())));
      for (const a of state.pending) if (isBatteryAlert(a)) a.reading = reading;
    }
    state.apiFailures = 0;
    state.apiRetryAt = 0;
  } catch (error) {
    observation = { kind: 'failed' };
    resetDischargeConfirmation(state);
    state.apiFailures = Math.min(state.apiFailures + 1, 10);
    // Non-transient errors get a one-hour cooldown; transient failures 5/10/20/40/60m.
    const telemetryError = /^(reading_|timestamp_|measurement_)/.test(errorCode(error));
    const delay = telemetryError ? 300_000 : error instanceof SafeError && error.retryable ?
      Math.min(3600_000, 300_000 * 2 ** (state.apiFailures - 1)) : 3600_000;
    if (telemetryError) state.apiFailures = 0;
    state.apiRetryAt = Math.max(deps.now() + delay, error instanceof SafeError ? error.retryAt : 0);
    events.push(errorCode(error));
  }
  const healthError = healthWork ? syncHealth(state, c, observation, deps.now()) : undefined;
  if (healthError) events.push(healthError);
  const recapError = recapWork ? syncRecap(state, c, deps.now()) : undefined;
  if (recapError) events.push(recapError);
  // The optional hourly weather guard shares the existing first checkpoint.
  let refreshWeather = false;
  if (eligibleToSend && state.pending.some(a => a.kind === 'discharge' && a.nextAttemptAt <= deps.now() &&
      dischargeWindowOpen(c, a.reading.at, deps.now()))) {
    const prepared = prepareWeather(c, state.weather, deps.now());
    state.weather = prepared.cache;
    refreshWeather = prepared.refresh;
  } else if (!c.weather?.enabled) delete state.weather;
  // Persist latches and outbox BEFORE contacting Telegram. If this fails, no send.
  await env.STATE.put('monitor:v1', JSON.stringify(state));
  const checkpointAt = deps.now();
  let changed = false;
  for (const a of [...state.pending]) {
    if (a.nextAttemptAt > deps.now()) continue;
    let informationalText: string | undefined;
    if (a.kind === 'health') {
      informationalText = healthMessage(state, c, a, deps.now());
      if (!informationalText) continue;
    } else if (a.kind === 'recap') {
      informationalText = recapMessage(state, c, a, deps.now(), bot);
      if (!informationalText) {
        state.pending = state.pending.filter(p => p.id !== a.id);
        changed = true;
        continue;
      }
    } else if (!eligibleToSend) continue;
    if (a.kind === 'discharge' && !dischargeWindowOpen(c, a.reading.at, deps.now())) {
      state.pending = state.pending.filter(p => p.id !== a.id);
      changed = true;
      continue;
    }
    if (a.kind === 'discharge' && refreshWeather) {
      state.weather = await fetchWeather(state.weather as WeatherCache, c, deps);
      refreshWeather = false;
      if (!dischargeWindowOpen(c, a.reading.at, deps.now())) {
        state.pending = state.pending.filter(p => p.id !== a.id);
        changed = true;
        continue;
      }
    }
    // Increment in memory; checkpoint after delivery. Crash after a send can still
    // duplicate it. KV is not a transaction or global lock; exactly-once is impossible.
    a.attempts++;
    changed = true;
    try {
      const confirmCharging = c.telegram?.enabled && c.ev.enabled && a.kind === 'discharge';
      const sentAt = deps.now();
      const prompt = activeChargingSession(bot, sentAt) ? 'Update your charging report:' : 'Are you charging an EV?';
      const forecast = a.kind === 'discharge' ? weatherText(state.weather, c, sentAt) : '';
      const text = informationalText ?? (alertText(a, c, { bot, now: sentAt }) + (forecast ? `\n\n${forecast}` : '') +
        (confirmCharging ? `\n\n${prompt}` : ''));
      await sendTelegram(env, text, deps, confirmCharging && a.kind === 'discharge' ? { inline_keyboard: [[
        { text: "Yes, I'm charging", callback_data: `charging:yes:${a.reading.at}` },
        { text: "No, I'm not", callback_data: `charging:no:${a.reading.at}` },
      ]] } : undefined);
      if (a.kind === 'health') settleHealth(state, c, a, 'accepted', deps.now());
      state.pending = state.pending.filter(p => p.id !== a.id);
      events.push('telegram_sent');
    } catch (error) {
      events.push(errorCode(error));
      if (!(error instanceof SafeError) || !error.retryable || a.attempts >= 3) {
        if (a.kind === 'health') settleHealth(state, c, a, 'abandoned', deps.now());
        state.pending = state.pending.filter(p => p.id !== a.id);
        events.push('notification_abandoned');
      } else {
        a.nextAttemptAt = Math.max(deps.now() + 300_000 * 2 ** (a.attempts - 1) +
          Math.floor(deps.random() * 30_000), error.retryAt);
        if (a.kind === 'health' && a.nextAttemptAt > a.createdAt + 1800_000) {
          settleHealth(state, c, a, 'abandoned', deps.now());
          state.pending = state.pending.filter(p => p.id !== a.id);
          events.push('notification_abandoned');
        }
        if (a.kind === 'recap' && a.nextAttemptAt >= a.slot.expiresAt) {
          state.pending = state.pending.filter(p => p.id !== a.id);
          events.push('notification_abandoned');
        }
      }
    }
  }
  if (changed) {
    // KV permits at most one write per second to the same key. Space this
    // invocation's two checkpoints; this is not a cross-isolate lock.
    const spacing = 1100 - (deps.now() - checkpointAt);
    if (spacing > 0) await deps.sleep(spacing);
    await env.STATE.put('monitor:v1', JSON.stringify(state));
  }
  return events;
}
