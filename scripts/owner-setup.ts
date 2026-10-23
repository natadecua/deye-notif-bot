import { HOSTS, validateConfig } from '../src/config.ts';
import { sha256 } from '../src/deye.ts';
import { SafeError } from '../src/errors.ts';
import { normalizeReading, parseTimestamp } from '../src/reading.ts';
import { validateTelegramSecrets } from '../src/telegram.ts';
import type { Config, Secrets } from '../src/types.ts';
import { configurePreferences, type PreferencePrompts } from './preferences.ts';
import { ownerCandidates } from './telegram-onboarding.ts';

export interface SetupPrompts extends PreferencePrompts { hidden(message: string): Promise<string> }
export interface SetupServices {
  now(): number;
  deye(c: Config, s: Secrets): {
    stations(page: number): Promise<{ stations: Record<string, unknown>[]; total: number }>;
    latest(): Promise<Record<string, unknown>>;
  };
  preview(raw: Record<string, unknown>): void;
  testTelegram(s: Secrets): Promise<void>;
}
// File access, prompts and live transports belong to the CLI adapter. This flow
// can also be exercised with synthetic services without reading owner files.
export async function runOwnerSetup(source: Config, existing: Secrets, p: SetupPrompts, io: SetupServices) {
  const c = structuredClone(source);
  c.enabled = false; c.measurementsConfirmed = false;
  c.region = await p.choose('Choose the region containing your Deye account/station:', [
    { name: `EU / EMEA / APAC: ${HOSTS.eu}`, value: 'eu' },
    { name: `Americas: ${HOSTS.am}`, value: 'am' }, { name: `India: ${HOSTS.india}`, value: 'india' },
  ]) as Config['region'];
  let s = { ...existing };
  const reuse = !!s.DEYE_APP_ID && await p.confirm('Reuse existing local Deye credentials?', true);
  if (!reuse) {
    s = { TELEGRAM_BOT_TOKEN: s.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: s.TELEGRAM_CHAT_ID,
      TELEGRAM_OWNER_ID: s.TELEGRAM_OWNER_ID, TELEGRAM_WEBHOOK_SECRET: s.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: s.TELEGRAM_BOT_USERNAME } as Secrets;
    s.DEYE_APP_ID = await p.hidden('Deye App ID (hidden):');
    s.DEYE_APP_SECRET = await p.hidden('Deye App Secret:');
    s.DEYE_ACCOUNT_FIELD = await p.choose('Account login type:', ['email', 'username', 'mobile'].map(value => ({ name: value, value })));
    s.DEYE_ACCOUNT = await p.hidden(`Deye ${s.DEYE_ACCOUNT_FIELD} (hidden):`);
    if (s.DEYE_ACCOUNT_FIELD === 'mobile') s.DEYE_COUNTRY_CODE = await p.text('Country calling code (digits only, no +):');
    s.DEYE_PASSWORD_SHA256 = await sha256(await p.hidden('Deye password (hashed locally; plaintext is not saved):'));
    const company = await p.text('Company ID (leave blank for personal account):');
    if (company) s.DEYE_COMPANY_ID = company;
  }
  const client = io.deye(c, s), stations: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const result = await client.stations(page);
    stations.push(...result.stations);
    if (stations.length >= result.total || result.stations.length === 0) break;
    if (page >= 100) throw new SafeError('station_pagination_limit');
  }
  const selectable = stations.filter(st => Number.isSafeInteger(st.id) && Number(st.id) > 0);
  if (!selectable.length) throw new SafeError('no_stations_in_selected_region_or_company');
  const selectedId = await p.choose('Deye access validated. Select your house battery station:', selectable.map(st => ({
    name: `${String(st.name ?? 'Station')} (ID ${st.id}; timezone ${String(st.regionTimezone ?? 'not provided')})`, value: String(st.id),
  })));
  const selected = selectable.find(st => String(st.id) === selectedId);
  if (!selected) throw new SafeError('no_stations_in_selected_region_or_company');
  c.stationId = Number(selected.id);
  const raw = await client.latest();
  p.print('Live station preview; missing fields are displayed as null:'); io.preview(raw);
  c.powerUnit = await p.choose('Compare dischargePower with the Deye app or device documentation. Which unit does THIS API value use? Do not guess.',
    [{ name: 'Watts (e.g. 500 means 500 W)', value: 'W' }, { name: 'Kilowatts (e.g. 0.5 means 500 W)', value: 'kW' }]) as Config['powerUnit'];
  c.timestampMode = await p.choose('Confirm the timestamp format from the preview:', [
    { name: 'ISO 8601 with explicit Z or ±HH:MM offset', value: 'iso-offset' },
    { name: 'Numeric Unix seconds (absolute UTC)', value: 'unix-seconds' },
    { name: 'Numeric Unix milliseconds (absolute UTC)', value: 'unix-milliseconds' },
  ]) as Config['timestampMode'];
  const at = parseTimestamp(raw.lastUpdateTime, c.timestampMode);
  p.print(`Timestamp interpreted as ${new Date(at).toISOString()} (UTC). Station timezone metadata: ${String(selected.regionTimezone ?? 'not provided')}.`);
  const reading = normalizeReading(raw, c, io.now());
  p.print(`Normalized: ${reading.soc}% SOC, ${reading.dischargeWatts} W discharge.`);
  if (!await p.confirm('Have you verified the units, UTC reading time, SOC percentage, and that dischargePower is non-negative battery-to-load power? If uncertain, stop and consult docs/DEYE-API.md.', false)) {
    throw new SafeError('measurements_not_confirmed');
  }
  c.measurementsConfirmed = true;
  Object.assign(c, await configurePreferences(c, p));
  if (!s.TELEGRAM_BOT_TOKEN || !await p.confirm('Reuse existing local Telegram settings?', true)) {
    s.TELEGRAM_BOT_TOKEN = await p.hidden('Telegram bot token from @BotFather:');
    s.TELEGRAM_CHAT_ID = await p.hidden('Telegram chat ID (numeric, may start with -):');
  }
  validateTelegramSecrets(s);
  if (s.TELEGRAM_BOT_TOKEN !== existing.TELEGRAM_BOT_TOKEN || s.TELEGRAM_CHAT_ID !== existing.TELEGRAM_CHAT_ID) {
    delete s.TELEGRAM_OWNER_ID; delete s.TELEGRAM_WEBHOOK_SECRET; delete s.TELEGRAM_BOT_USERNAME;
    c.telegram = { enabled: false };
    p.print('Commands are disabled for this bot and chat until you run npm run telegram:setup and complete the upload/deploy/webhook steps.');
  }
  if (await p.confirm('Send a live Telegram test message now?', true)) {
    await io.testTelegram(s); p.print('Telegram API accepted the test message. Check your chat.');
  }
  c.enabled = true; validateConfig(c);
  return { config: c, secrets: s };
}

export async function configureTelegramOwner(source: Config, existing: Secrets, p: PreferencePrompts,
  io: { call(method: string, body?: unknown): Promise<Record<string, unknown>>; newSecret(): string }) {
  const c = structuredClone(validateConfig(source)), s = { ...existing };
  if (!c.enabled) throw new SafeError('monitor_disabled_run_setup_first');
  validateTelegramSecrets(s);
  p.print('Send /start to your own bot in the configured chat first. Setup reads Telegram updates to identify candidate owner IDs; message contents are not printed.');
  const info = await io.call('getWebhookInfo');
  if (info.ok !== true) throw new SafeError('telegram_webhook_info_rejected');
  const active = (info.result as { url?: string } | undefined)?.url;
  let candidates: string[] = [];
  if (!active) {
    const updates = await io.call('getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message'] });
    if (updates.ok !== true) throw new SafeError('telegram_updates_rejected');
    candidates = ownerCandidates(updates.result, s.TELEGRAM_CHAT_ID);
  }
  const owner = candidates.length ? await p.choose('Choose the one sender allowed to use bot commands:',
    candidates.map(value => ({ name: `Telegram user ${value}`, value }))) : await p.text(
    'Owner Telegram user ID (a user ID, not a group chat ID):', s.TELEGRAM_OWNER_ID,
    value => /^[1-9]\d*$/.test(value) || 'Enter a positive numeric Telegram user ID.');
  if (!/^[1-9]\d*$/.test(owner) || (candidates.length && !candidates.includes(owner))) throw new SafeError('telegram_owner_setup_required');
  const me = await io.call('getMe'), username = (me.result as { username?: string } | undefined)?.username;
  if (me.ok !== true || !username || !/^[a-zA-Z0-9_]{5,32}$/.test(username)) throw new SafeError('telegram_bot_identity_invalid');
  const webhookSecret = s.TELEGRAM_WEBHOOK_SECRET || io.newSecret();
  return { config: { ...c, telegram: { enabled: true } },
    secrets: { ...s, TELEGRAM_OWNER_ID: owner, TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_USERNAME: username } };
}
