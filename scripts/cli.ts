import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { readFile, writeFile, chmod, access, mkdtemp, rm } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { DeyeClient, sha256, validateDeyeSecrets } from '../src/deye.ts';
import { HOSTS, validateConfig } from '../src/config.ts';
import { errorCode, SafeError } from '../src/errors.ts';
import { normalizeReading, parseTimestamp } from '../src/reading.ts';
import { sendTelegram, validateTelegramSecrets } from '../src/telegram.ts';
import { jsonPost } from '../src/http.ts';
import { defaults } from '../src/types.ts';
import type { Config, Secrets } from '../src/types.ts';
import { configurePreferences, type InputValidator, type PreferencePrompts } from './preferences.ts';
import { ownerCandidates, telegramSetupHint, webhookRegistration } from './telegram-onboarding.ts';
import { configureDaytime } from './daytime-preferences.ts';

// Resolve against this repository, even if the command is launched elsewhere.
const root = fileURLToPath(new NodeURL('../', import.meta.url));
const configPath = join(root, 'wrangler.jsonc');
const secretsPath = join(root, '.dev.vars');
type LocalConfig = { kv_namespaces: { binding: string; id: string }[];
  vars: { MONITOR_CONFIG: Config }; [key: string]: unknown };
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function init(): Promise<void> {
  if (!await exists(configPath)) await writeFile(configPath, await readFile(join(root, 'wrangler.example.jsonc')));
}
async function config(): Promise<LocalConfig> {
  await init();
  try { return JSON.parse(await readFile(configPath, 'utf8')); } catch { throw new SafeError('local_config_invalid_json'); }
}
async function secrets(required = true): Promise<Secrets> {
  // Environment overrides the ignored file. No shell arguments contain secrets.
  const local = await exists(secretsPath) ? parseEnv(await readFile(secretsPath, 'utf8')) : {};
  const names = ['DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_ACCOUNT', 'DEYE_ACCOUNT_FIELD',
    'DEYE_PASSWORD_SHA256', 'DEYE_COMPANY_ID', 'DEYE_COUNTRY_CODE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
    'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_OWNER_ID', 'TELEGRAM_BOT_USERNAME'];
  const result = Object.fromEntries(names.map(k => [k, process.env[k] ?? local[k]])) as unknown as Secrets;
  if (required) { validateDeyeSecrets(result); validateTelegramSecrets(result); }
  return result;
}
async function saveSecrets(s: Secrets): Promise<void> {
  const content = Object.entries(s).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n';
  // Ensure the chosen .env encoding round-trips; never silently corrupt a secret.
  const decoded = parseEnv(content);
  if (Object.entries(s).some(([k, v]) => v !== undefined && decoded[k] !== v)) {
    throw new SafeError('secret_contains_unsupported_characters');
  }
  await writeFile(secretsPath, content, { mode: 0o600 });
  await chmod(secretsPath, 0o600);
}
async function numberInput(message: string, fallback?: number, extra?: InputValidator<number>): Promise<number> {
  return Number(await input({ message, default: fallback === undefined ? undefined : String(fallback),
    validate: v => v.trim() !== '' && Number.isFinite(Number(v)) ? extra?.(Number(v)) ?? true : 'Enter a finite number.' }));
}
const preferencePrompts: PreferencePrompts = {
  checklist: (message, choices) => checkbox({ message, choices }),
  choose: (message, choices, initial) => select({ message, choices, default: initial }),
  confirm: (message, initial) => confirm({ message, default: initial }),
  number: numberInput,
  text: (message, initial, validate) => input({ message, default: initial, validate }),
  print: message => console.log(message),
};
function previewFields(raw: Record<string, unknown>): void {
  // Deliberate allowlist: never print whole upstream bodies, locations or account details.
  console.log(JSON.stringify(Object.fromEntries(['batterySOC', 'dischargePower', 'chargePower',
    'batteryPower', 'generationPower', 'consumptionPower', 'lastUpdateTime']
    .map(k => [k, raw[k] ?? null])), null, 2));
}
async function setup(): Promise<void> {
  console.log('Setup makes live read-only Deye calls. Credentials stay in your ignored .dev.vars file until you upload them to your own Cloudflare account.');
  const w = await config();
  const c = w.vars.MONITOR_CONFIG;
  c.enabled = false;
  c.measurementsConfirmed = false;
  c.region = await select({ message: 'Choose the region containing your Deye account/station:',
    choices: [{ name: `EU / EMEA / APAC: ${HOSTS.eu}`, value: 'eu' as const },
      { name: `Americas: ${HOSTS.am}`, value: 'am' as const },
      { name: `India: ${HOSTS.india}`, value: 'india' as const }] });
  let s = await secrets(false);
  const reuse = !!s.DEYE_APP_ID && await confirm({ message: 'Reuse existing local Deye credentials?', default: true });
  if (!reuse) {
    s = { TELEGRAM_BOT_TOKEN: s.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: s.TELEGRAM_CHAT_ID } as Secrets;
    s.DEYE_APP_ID = await password({ message: 'Deye App ID (hidden):', mask: '*' });
    s.DEYE_APP_SECRET = await password({ message: 'Deye App Secret:', mask: '*' });
    s.DEYE_ACCOUNT_FIELD = await select({ message: 'Account login type:', choices: ['email', 'username', 'mobile'] });
    s.DEYE_ACCOUNT = await password({ message: `Deye ${s.DEYE_ACCOUNT_FIELD} (hidden):`, mask: '*' });
    if (s.DEYE_ACCOUNT_FIELD === 'mobile') s.DEYE_COUNTRY_CODE = await input({ message: 'Country calling code (digits only, no +):' });
    s.DEYE_PASSWORD_SHA256 = await sha256(await password({ message: 'Deye password (hashed locally; plaintext is not saved):', mask: '*' }));
    const company = await input({ message: 'Company ID (leave blank for personal account):' });
    if (company) s.DEYE_COMPANY_ID = company;
  }
  const client = new DeyeClient(c, s);
  const stations: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const result = await client.stations(page);
    stations.push(...result.stations);
    if (stations.length >= result.total || result.stations.length === 0) break;
    if (page >= 100) throw new SafeError('station_pagination_limit');
  }
  if (!stations.length) throw new SafeError('no_stations_in_selected_region_or_company');
  const selected = await select({ message: 'Deye access validated. Select your house battery station:',
    choices: stations.filter(st => Number.isSafeInteger(st.id) && Number(st.id) > 0).map(st => ({
      name: `${String(st.name ?? 'Station')} (ID ${st.id}; timezone ${String(st.regionTimezone ?? 'not provided')})`,
      value: st,
    })) });
  c.stationId = Number(selected.id);
  const raw = await client.latest();
  console.log('Live station preview; missing fields are displayed as null:');
  previewFields(raw);
  c.powerUnit = await select({ message: 'Compare dischargePower with the Deye app or device documentation. Which unit does THIS API value use? Do not guess.',
    choices: [{ name: 'Watts (e.g. 500 means 500 W)', value: 'W' as const },
      { name: 'Kilowatts (e.g. 0.5 means 500 W)', value: 'kW' as const }] });
  c.timestampMode = await select({ message: 'Confirm the timestamp format from the preview:',
    choices: [{ name: 'ISO 8601 with explicit Z or ±HH:MM offset', value: 'iso-offset' as const },
      { name: 'Numeric Unix seconds (absolute UTC)', value: 'unix-seconds' as const },
      { name: 'Numeric Unix milliseconds (absolute UTC)', value: 'unix-milliseconds' as const }] });
  const at = parseTimestamp(raw.lastUpdateTime, c.timestampMode);
  console.log(`Timestamp interpreted as ${new Date(at).toISOString()} (UTC). Station timezone metadata: ${String(selected.regionTimezone ?? 'not provided')}.`);
  const reading = normalizeReading(raw, c, Date.now());
  console.log(`Normalized: ${reading.soc}% SOC, ${reading.dischargeWatts} W discharge.`);
  if (!await confirm({ message: 'Have you verified the units, UTC reading time, SOC percentage, and that dischargePower is non-negative battery-to-load power? If uncertain, stop and consult docs/DEYE-API.md.', default: false })) {
    throw new SafeError('measurements_not_confirmed');
  }
  c.measurementsConfirmed = true;
  Object.assign(c, await configurePreferences(c, preferencePrompts));
  if (!s.TELEGRAM_BOT_TOKEN || !await confirm({ message: 'Reuse existing local Telegram settings?', default: true })) {
    s.TELEGRAM_BOT_TOKEN = await password({ message: 'Telegram bot token from @BotFather:', mask: '*' });
    s.TELEGRAM_CHAT_ID = await password({ message: 'Telegram chat ID (numeric, may start with -):', mask: '*' });
  }
  validateTelegramSecrets(s);
  if (await confirm({ message: 'Send a live Telegram test message now?', default: true })) {
    await sendTelegram(s, 'Deye battery monitor: setup test. Notifications only; EV adjustments are manual.');
    console.log('Telegram API accepted the test message. Check your chat.');
  }
  c.enabled = true;
  validateConfig(c);
  await saveSecrets(s);
  await writeFile(configPath, JSON.stringify(w, null, 2) + '\n');
  console.log('Saved ignored wrangler.jsonc and .dev.vars (mode 600). No cloud deployment was performed. Follow README.md to create KV, upload secrets, and deploy.');
}
async function preview(): Promise<void> {
  const w = await config();
  const c = validateConfig(w.vars.MONITOR_CONFIG);
  const s = await secrets(false);
  const raw = await new DeyeClient(c, s).latest();
  previewFields(raw);
  console.log('Normalized:', normalizeReading(raw, c, Date.now()));
}
async function validateDeploy(): Promise<void> {
  const w = await config();
  const c = validateConfig(w.vars.MONITOR_CONFIG);
  if (!c.enabled) throw new SafeError('monitor_disabled_run_setup_first');
  if (!w.kv_namespaces?.some(k => k.binding === 'STATE' && /^[a-f0-9]{32}$/.test(k.id))) {
    throw new SafeError('kv_namespace_id_missing');
  }
}
async function uploadSecrets(): Promise<void> {
  await validateDeploy();
  const s = await secrets();
  const w = await config();
  if (w.vars.MONITOR_CONFIG.telegram?.enabled && (!/^[1-9]\d*$/.test(s.TELEGRAM_OWNER_ID ?? '') ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(s.TELEGRAM_WEBHOOK_SECRET ?? ''))) throw new SafeError('telegram_owner_setup_required');
  const dir = await mkdtemp(join(tmpdir(), 'deye-secrets-'));
  try {
    const file = join(dir, 'secrets.json');
    await writeFile(file, JSON.stringify(s), { mode: 0o600 });
    const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'secret', 'bulk', file, '--config', configPath], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new SafeError('secret_upload_failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const command = process.argv[2];
try {
  switch (command) {
    case 'init': await init(); break;
    case 'setup': await setup(); break;
    case 'preview': await preview(); break;
    case 'preferences': {
      const w = await config();
      w.vars.MONITOR_CONFIG = await configurePreferences(w.vars.MONITOR_CONFIG, preferencePrompts);
      await writeFile(configPath, JSON.stringify(w, null, 2) + '\n');
      console.log('Saved preferences in ignored wrangler.jsonc. No Deye/Telegram calls or deployment were made. Run npm run deploy to apply them to your existing installation.');
      break;
    }
    case 'daytime-setup': {
      const w = await config();
      w.vars.MONITOR_CONFIG = await configureDaytime(w.vars.MONITOR_CONFIG, preferencePrompts);
      await writeFile(configPath, JSON.stringify(w, null, 2) + '\n');
      console.log('Saved daytime preferences in ignored wrangler.jsonc. No provider calls or deployment were made. Run npm run deploy to apply to an existing installation.');
      break;
    }
    case 'telegram-setup': {
      const w = await config();
      const c = validateConfig(w.vars.MONITOR_CONFIG);
      if (!c.enabled) throw new SafeError('monitor_disabled_run_setup_first');
      const s = await secrets(false); validateTelegramSecrets(s);
      const call = (method: string, body: unknown = {}) => jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/${method}`,
        body, {}, defaults, 'telegram', 1);
      console.log('Send /start to your own bot in the configured chat first. Setup reads Telegram updates to identify candidate owner IDs; message contents are not printed.');
      const info = await call('getWebhookInfo');
      if (info.ok !== true) throw new SafeError('telegram_webhook_info_rejected');
      const active = (info.result as { url?: string } | undefined)?.url;
      let candidates: string[] = [];
      if (!active) {
        const updates = await call('getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message'] });
        if (updates.ok !== true) throw new SafeError('telegram_updates_rejected');
        candidates = ownerCandidates(updates.result, s.TELEGRAM_CHAT_ID);
      }
      const owner = candidates.length ? await select({ message: 'Choose the one sender allowed to use bot commands:',
        choices: candidates.map(value => ({ name: `Telegram user ${value}`, value })) }) : await input({
        message: 'Owner Telegram user ID (a user ID, not a group chat ID):', default: s.TELEGRAM_OWNER_ID,
        validate: value => /^[1-9]\d*$/.test(value) || 'Enter a positive numeric Telegram user ID.',
      });
      const me = await call('getMe');
      const username = (me.result as { username?: string } | undefined)?.username;
      if (me.ok !== true || !username || !/^[a-zA-Z0-9_]{5,32}$/.test(username)) throw new SafeError('telegram_bot_identity_invalid');
      const webhookSecret = s.TELEGRAM_WEBHOOK_SECRET || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      await saveSecrets({ ...s, TELEGRAM_OWNER_ID: owner, TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_USERNAME: username });
      w.vars.MONITOR_CONFIG = { ...c, telegram: { enabled: true } };
      w.workers_dev = true;
      await writeFile(configPath, JSON.stringify(w, null, 2) + '\n');
      console.log('Saved local owner/webhook settings. Next: npm run secrets:upload, npm run deploy, then npm run telegram:webhook. No deployment or webhook registration was performed.');
      break;
    }
    case 'telegram-webhook': {
      const w = await config();
      if (!validateConfig(w.vars.MONITOR_CONFIG).telegram?.enabled) throw new SafeError('telegram_owner_setup_required');
      const s = await secrets(false); validateTelegramSecrets(s);
      if (!/^[1-9]\d*$/.test(s.TELEGRAM_OWNER_ID ?? '')) throw new SafeError('telegram_owner_setup_required');
      const url = await input({ message: 'Your deployed Worker HTTPS URL ending in /telegram/webhook:' });
      const info = await jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {}, {}, defaults, 'telegram', 1);
      if (info.ok !== true) throw new SafeError('telegram_webhook_info_rejected');
      const body = webhookRegistration(url, (info.result as { url?: string } | undefined)?.url || '', s.TELEGRAM_WEBHOOK_SECRET || '');
      const registered = await jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/setWebhook`, body, {}, defaults, 'telegram', 1);
      if (registered.ok !== true) throw new SafeError('telegram_webhook_rejected');
      console.log('Telegram accepted webhook registration. Verify /help and /status in the owner chat.');
      const menu = await jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/setMyCommands`, { commands: [
        { command: 'status', description: 'Latest cached battery reading and charging report' },
        { command: 'charging', description: 'Confirm you are charging an EV' },
        { command: 'stopped', description: 'Confirm you are not charging an EV' },
        { command: 'settings', description: 'View notification preferences' },
        { command: 'help', description: 'Show commands and manual-report limits' },
      ] }, {}, defaults, 'telegram', 1);
      if (menu.ok !== true) throw new SafeError('telegram_menu_rejected');
      console.log('Telegram accepted the command menu. Registration does not establish live command delivery.');
      break;
    }
    case 'validate-deploy': await validateDeploy(); break;
    case 'secrets-upload': await uploadSecrets(); break;
    case 'telegram-chats': {
      const s = await secrets(false);
      const token = s.TELEGRAM_BOT_TOKEN || await password({ message: 'Telegram bot token (hidden):', mask: '*' });
      validateTelegramSecrets({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '0' });
      const data = await jsonPost(`https://api.telegram.org/bot${token}/getUpdates`,
        { timeout: 0, limit: 100, allowed_updates: ['message'] }, {}, defaults, 'telegram', 1);
      if (data.ok !== true || !Array.isArray(data.result)) throw new SafeError('telegram_updates_rejected');
      const chats = new Map<string, string>();
      for (const update of data.result) {
        const chat = update?.message?.chat;
        if (chat && (typeof chat.id === 'number' || typeof chat.id === 'string')) {
          chats.set(String(chat.id), String(chat.type ?? 'unknown'));
        }
      }
      for (const [id, type] of chats) console.log(JSON.stringify({ chatId: id, type }));
      if (chats.size === 0) console.log('No message updates. Send /start to this bot, then run this command again.');
      break;
    }
    case 'telegram-test': {
      const s = await secrets(false);
      await sendTelegram(s, 'Deye battery monitor: Telegram test. If the EV is charging, any adjustment is manual.');
      console.log('Telegram API accepted the test message. Check your chat.');
      break;
    }
    default: throw new SafeError('unknown_command');
  }
} catch (error) {
  const code = errorCode(error);
  console.error(`Command failed: ${code}. See README.md troubleshooting. No upstream response or secret was logged.`);
  const hint = telegramSetupHint(code);
  if (hint) console.error(hint);
  process.exitCode = 1;
}
