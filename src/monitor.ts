import { alertText, decodeState, expirePending, resetAfterGap, transition } from './alerts.ts';
import { notificationEnabled, validateConfig } from './config.ts';
import { DeyeClient } from './deye.ts';
import { errorCode, SafeError } from './errors.ts';
import { normalizeReading } from './reading.ts';
import { sendTelegram, validateTelegramSecrets } from './telegram.ts';
import { defaults, type Dependencies, type Env } from './types.ts';

export async function runMonitor(env: Env, deps: Dependencies = defaults): Promise<string[]> {
  const c = validateConfig(env.MONITOR_CONFIG);
  if (!c.enabled) return ['monitor_disabled'];
  validateTelegramSecrets(env);
  const state = decodeState(await env.STATE.get('monitor:v1'), c);
  const now = deps.now();
  const events: string[] = [];
  const pendingBefore = state.pending.length;
  state.pending = state.pending.filter(a => notificationEnabled(c, a.kind));
  const cancelledByPreference = state.pending.length !== pendingBefore;
  resetAfterGap(state, c, now);
  expirePending(state, now);
  if (now < state.apiRetryAt) {
    if (cancelledByPreference) await env.STATE.put('monitor:v1', JSON.stringify(state));
    return ['api_backoff'];
  }
  let eligibleToSend = false;
  try {
    const raw = await new DeyeClient(c, env, env.STATE, deps).latest();
    const reading = normalizeReading(raw, c, deps.now());
    const outcome = transition(state, reading, c, deps.now());
    events.push(`reading_${outcome}`);
    // Don't send pending recommendations based on out-of-order/invalid/stale data.
    eligibleToSend = outcome !== 'out_of_order';
    // Drop delayed messages whose triggering condition no longer holds, even if
    // hysteresis hasn't rearmed yet. Do not send outdated amperage advice.
    if (eligibleToSend) {
      state.pending = state.pending.filter(a => a.kind === 'full' ? reading.soc >= c.fullSoc :
        reading.dischargeWatts > c.dischargeWatts);
      for (const a of state.pending) a.reading = reading;
    }
    state.apiFailures = 0;
    state.apiRetryAt = 0;
  } catch (error) {
    state.highCount = 0;
    state.apiFailures = Math.min(state.apiFailures + 1, 10);
    // Non-transient errors get a one-hour cooldown; transient failures 5/10/20/40/60m.
    const telemetryError = /^(reading_|timestamp_|measurement_)/.test(errorCode(error));
    const delay = telemetryError ? 300_000 : error instanceof SafeError && error.retryable ?
      Math.min(3600_000, 300_000 * 2 ** (state.apiFailures - 1)) : 3600_000;
    if (telemetryError) state.apiFailures = 0;
    state.apiRetryAt = Math.max(deps.now() + delay, error instanceof SafeError ? error.retryAt : 0);
    events.push(errorCode(error));
  }
  // Persist latches and outbox BEFORE contacting Telegram. If this fails, no send.
  await env.STATE.put('monitor:v1', JSON.stringify(state));
  const checkpointAt = deps.now();
  if (!eligibleToSend) return events;

  let changed = false;
  for (const a of [...state.pending]) {
    if (a.nextAttemptAt > deps.now()) continue;
    // Increment in memory; checkpoint after delivery. Crash after a send can still
    // duplicate it. KV is not a transaction or global lock; exactly-once is impossible.
    a.attempts++;
    changed = true;
    try {
      await sendTelegram(env, alertText(a, c), deps);
      state.pending = state.pending.filter(p => p.id !== a.id);
      events.push('telegram_sent');
    } catch (error) {
      events.push(errorCode(error));
      if (!(error instanceof SafeError) || !error.retryable || a.attempts >= 3) {
        state.pending = state.pending.filter(p => p.id !== a.id);
        events.push('notification_abandoned');
      } else {
        a.nextAttemptAt = Math.max(deps.now() + 300_000 * 2 ** (a.attempts - 1) +
          Math.floor(deps.random() * 30_000), error.retryAt);
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
