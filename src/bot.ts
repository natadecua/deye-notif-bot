import { defaults, type Config, type Dependencies, type Env, type State } from './types.ts';
import { validateConfig } from './config.ts';
import { batteryLoadSummary, decodeState } from './alerts.ts';
import { BOT_KEY, chargingSummary, decodeBotState, SESSION_MS } from './bot-state.ts';
import { applyTelegramCommand, settingsOverrides } from './telegram-settings.ts';
import { sendTelegram } from './telegram.ts';
import { jsonPost } from './http.ts';
import { SafeError } from './errors.ts';
import { chargingProfileReference } from './profiles.ts';
import { weatherStatusText } from './weather.ts';
import { profileReports, PROFILE_REPORT_HELP } from './profile-reports.ts';
import { displayTime } from './display-time.ts';
import { healthPreferencesText } from './health-config.ts';

const help = '🔋 Deye battery bot\n\n/status — latest cached battery reading\n/charging [profile ID] — confirm you are charging\n/stopped — confirm you are not charging\n/settings — notification preferences\n/settings reset — restore deployment preferences\n/help — show these commands\n\nCharging reports are manual and expire after 6 hours. House battery discharge cannot identify EV charging. Up to 48 commands per UTC day; leave a few seconds between commands.';
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function secretMatches(actual: string | null, expected: string | undefined): boolean {
  if (!expected || !/^[a-zA-Z0-9_-]{32,256}$/.test(expected) || actual?.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
async function payload(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new SafeError('bot_payload_invalid');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new SafeError('bot_payload_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const result = record(JSON.parse(new TextDecoder().decode(bytes)));
  if (!result) throw new SafeError('bot_payload_invalid');
  return result;
}
function cachedUpdateStatus(state: State, c: Config, now: number): string {
  let text = `📡 Cached update status\nScheduled monitoring is ${c.enabled ? 'enabled' : 'disabled'}.`;
  if (c.enabled) {
    if (now < state.apiRetryAt) {
      let retry = 'Retry time is unavailable in this cache.';
      if (state.apiRetryAt <= 8.64e15) {
        try { retry = `Next attempt allowed after: ${displayTime(state.apiRetryAt, c)}.`; }
        catch { /* Optional display cannot hide battery data or echo an exception. */ }
      }
      text += `\nData updates: retry cooldown.\n${retry}\nReason is not recorded in this cache. A scheduled poll may try again when the delay allows it.`;
    } else if (state.apiRetryAt > 0) {
      text += '\nData updates: Retry delay has elapsed; a scheduled poll may try again.';
    } else {
      text += state.latestReading ? '\nData updates: No retry delay is recorded.' : '\nData updates: Waiting for a cached reading.';
    }
  }
  return text + '\nThis is cached status, not a live connection check; /status does not poll Deye.';
}
async function status(env: Env, c: Config, now: number): Promise<string> {
  const state = decodeState(await env.STATE.get('monitor:v1'), c);
  const r = state.latestReading;
  const weather = weatherStatusText(state.weather, c, now);
  const context = `\n\n${cachedUpdateStatus(state, c, now)}\n\n${healthPreferencesText(c)}` + (weather ? `\n\n${weather}` : '');
  if (!r) return '🔋 Battery status\n\nNo cached reading yet.' + context;
  const age = Math.floor((now - r.at) / 1000);
  const quality = age < 0 || age > c.maxAgeSeconds ? 'stale — do not treat this as current' : 'within the configured freshness limit';
  const profiles = chargingProfileReference(c.ev);
  return `🔋 Battery status\n\nCharge: ${r.soc}%\nBattery discharge: ${Math.round(r.dischargeWatts)} W\n${batteryLoadSummary(c)}${profiles ? `\n\n${profiles}` : ''}\n\nReading: ${displayTime(r.at, c)}\nData age: ${age} seconds (${quality})\nDeye Cloud data may be delayed.` + context;
}
export async function handleTelegramRequest(request: Request, env: Env, deps: Dependencies = defaults): Promise<Response> {
  const ok = () => new Response('OK');
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/telegram/webhook') {
    return new Response('Not found', { status: 404 });
  }
  let persisted = false;
  try {
    const base = validateConfig(env.MONITOR_CONFIG);
    if (!base.telegram?.enabled) return new Response('Not found', { status: 404 });
    if (!secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET) ||
        !/^[1-9]\d*$/.test(env.TELEGRAM_OWNER_ID ?? '')) return new Response('Forbidden', { status: 403 });
    let update: Record<string, unknown>;
    try { update = await payload(request); } catch (e) {
      return new Response('Invalid update', { status: e instanceof SafeError && e.code === 'bot_payload_too_large' ? 413 : 400 });
    }
    const callback = record(update.callback_query);
    const message = record(callback?.message ?? update.message);
    if (!message) return ok();
    const sender = record(callback?.from ?? message.from), chat = record(message.chat);
    if (!sender || !Number.isSafeInteger(sender.id) || String(sender.id) !== env.TELEGRAM_OWNER_ID || sender.is_bot === true ||
        !chat || !Number.isSafeInteger(chat.id) || String(chat.id) !== env.TELEGRAM_CHAT_ID) {
      return new Response('Forbidden', { status: 403 });
    }
    const now = deps.now();
    if (!Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) return new Response('Invalid update', { status: 400 });
    let command = typeof message.text === 'string' && message.text.length <= 128 ? message.text.trim() : '';
    if (!callback) {
      if (!command.startsWith('/') || typeof message.date !== 'number' || !Number.isSafeInteger(message.date) ||
          message.date * 1000 > now || now - message.date * 1000 > 15 * 60_000) return ok();
      const mention = /^\/[a-z_]+@([a-z0-9_]+)/i.exec(command);
      if (mention && mention[1].toLowerCase() !== env.TELEGRAM_BOT_USERNAME?.toLowerCase()) return ok();
      command = command.replace(/^\/(\w+)@[a-z0-9_]+/i, '/$1');
    } else if (typeof callback.id !== 'string' || callback.id.length > 256 || typeof callback.data !== 'string' || callback.data.length > 64) {
      return new Response('Invalid update', { status: 400 });
    }
    const state = decodeBotState(await env.STATE.get(BOT_KEY), base);
    // Telegram may randomize IDs after a week without updates; fresh message dates still apply.
    if ((update.update_id as number) <= state.lastUpdateId && now - state.lastHandledAt < 7 * 24 * 3600_000) return ok();
    if (now - state.lastHandledAt < 2000) return ok();
    const day = new Date(now).toISOString().slice(0, 10);
    if (state.day !== day) { state.day = day; state.used = 0; }
    if (state.used >= 48) return ok();
    const c = validateConfig({ ...base, ...state.overrides });
    let reply: string, offerProfiles = false;
    const reports = profileReports(c, state, now);
    const button = callback ? /^charging:(yes|no):(\d{1,16})$/.exec(callback.data as string) : null;
    const selectedProfile = callback && state.used < 47 ? await reports.selection(callback.data as string) : undefined;
    if (state.used === 47) {
      reply = 'Daily command limit reached. Try again after 00:00 UTC. Scheduled battery monitoring continues.';
    } else if (callback && ((!button && !selectedProfile) || (button && (now < Number(button[2]) || now - Number(button[2]) > 30 * 60_000)))) {
      reply = 'That confirmation has expired. Use /charging or /stopped to make a new manual report.';
    } else if (selectedProfile) {
      state.session!.profileId = selectedProfile;
      reply = chargingSummary(state, c, now);
      offerProfiles = true;
    } else if (button || /^\/(charging|stopped)(?:\s+\S+)?$/.test(command)) {
      const [verb, profileId] = command.slice(1).split(/\s+/);
      const charging = button ? button[1] === 'yes' : verb === 'charging';
      if (profileId && (!charging || !c.ev.profiles?.some(p => p.id === profileId))) {
        reply = `Unknown profile. Configured profile IDs: ${c.ev.profiles?.map(p => p.id).join(', ') || 'none'}. Use /charging without a profile if unsure.`;
      } else {
        state.session = { status: charging ? 'charging' : 'not_charging', source: 'manual', at: now, expiresAt: now + SESSION_MS,
          ...(profileId ? { profileId } : {}) };
        reply = chargingSummary(state, c, now) + '\nUse /stopped when you finish. Equipment changes remain manual.';
        offerProfiles = charging;
      }
    } else if (command === '/status') {
      reply = await status(env, c, now) + `\n\n${chargingSummary(state, c, now)}`;
    } else if (command === '/help' || command === '/start') {
      reply = help;
    } else if (command === '/settings reset') {
      delete state.overrides;
      reply = 'Deployment preferences restored. They apply on the next scheduled reading.';
    } else {
      const result = applyTelegramCommand(c, command);
      if (result.changed) state.overrides = settingsOverrides(result.config);
      reply = result.reply;
    }
    const replyMarkup = offerProfiles ? await reports.menu() : undefined;
    if (replyMarkup) reply += `\n\n${PROFILE_REPORT_HELP}`;
    state.lastUpdateId = update.update_id as number; state.lastHandledAt = now; state.used++;
    await env.STATE.put(BOT_KEY, JSON.stringify(state));
    persisted = true;
    // One bounded attempt per method. A crash/transport failure can lose a reply;
    // KV replay protection is best effort, never an exactly-once guarantee.
    if (callback) {
      try {
        await jsonPost(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
          { callback_query_id: callback.id, text: 'Report processed. Check the bot reply.' }, {}, deps, 'telegram', 1);
      } catch { /* Acknowledgement failure must not suppress the ordinary confirmation reply. */ }
    }
    await sendTelegram(env, reply, deps, replyMarkup);
    return ok();
  } catch {
    return persisted ? ok() : new Response('Temporarily unavailable', { status: 503 });
  }
}
