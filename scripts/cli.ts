import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { readFile, writeFile, chmod, access, mkdtemp, rm } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { DeyeClient, validateDeyeSecrets } from '../src/deye.ts';
import { validateConfig } from '../src/config.ts';
import { errorCode, SafeError } from '../src/errors.ts';
import { normalizeReading } from '../src/reading.ts';
import { sendTelegram, validateTelegramSecrets } from '../src/telegram.ts';
import { jsonPost } from '../src/http.ts';
import { defaults } from '../src/types.ts';
import type { Config, Secrets } from '../src/types.ts';
import { configurePreferences, type InputValidator, type PreferencePrompts } from './preferences.ts';
import { webhookRegistration } from './telegram-onboarding.ts';
import { configureDaytime } from './daytime-preferences.ts';
import { configureWeather } from './weather-preferences.ts';
import { runOwnerSetup, configureTelegramOwner } from './owner-setup.ts';
import { setupHint } from './setup-hints.ts';

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
  const result = await runOwnerSetup(w.vars.MONITOR_CONFIG, await secrets(false), {
    ...preferencePrompts, hidden: message => password({ message, mask: '*' }),
  }, {
    now: Date.now, deye: (c, s) => new DeyeClient(c, s), preview: previewFields,
    testTelegram: s => sendTelegram(s, 'Deye battery monitor: setup test. Notifications only; EV adjustments are manual.'),
  });
  w.vars.MONITOR_CONFIG = result.config;
  await saveSecrets(result.secrets);
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
    case 'weather-setup': {
      const w = await config();
      w.vars.MONITOR_CONFIG = await configureWeather(w.vars.MONITOR_CONFIG, preferencePrompts);
      await writeFile(configPath, JSON.stringify(w, null, 2) + '\n');
      console.log('Saved weather preferences in ignored wrangler.jsonc. No provider calls or deployment were made. Run npm run deploy to apply to an existing installation.');
      break;
    }
    case 'telegram-setup': {
      const w = await config();
      const s = await secrets(false);
      const result = await configureTelegramOwner(w.vars.MONITOR_CONFIG, s, preferencePrompts, {
        call: (method, body = {}) => jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/${method}`,
          body, {}, defaults, 'telegram', 1),
        newSecret: () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      });
      await saveSecrets(result.secrets);
      w.vars.MONITOR_CONFIG = result.config;
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
  const hint = setupHint(code);
  if (hint) console.error(hint);
  process.exitCode = 1;
}
