import { SafeError } from '../src/errors.ts';
export function telegramSetupHint(code: string): string | undefined {
  switch (code) {
    case 'telegram_webhook_already_configured':
      return "Use a dedicated bot for this monitor. Do not remove or replace another integration's webhook.";
    case 'telegram_webhook_url_invalid':
      return 'Use your deployed Worker HTTPS URL ending in /telegram/webhook, with no URL credentials, query or fragment.';
    case 'telegram_owner_setup_required':
      return 'Run npm run telegram:setup, then npm run secrets:upload, deploy, and npm run telegram:webhook. Select the allowed sender user ID, not a group chat ID.';
    case 'telegram_webhook_secret_invalid':
      return 'Remove the invalid local TELEGRAM_WEBHOOK_SECRET, rerun npm run telegram:setup to generate it, upload secrets and register the webhook again. Keep secret values private.';
    case 'telegram_menu_rejected':
      return 'Webhook registration may already have succeeded. Check /help in the owner chat, then rerun npm run telegram:webhook with the same URL to retry the menu.';
    case 'telegram_webhook_info_rejected':
    case 'telegram_webhook_rejected':
    case 'telegram_bot_identity_invalid':
      return 'Check the bot token and access in your private local setup, then retry the Telegram setup step. Do not share raw API responses or request URLs.';
    default:
      return undefined;
  }
}
export function ownerCandidates(updates: unknown, chat: string): string[] {
  if (!Array.isArray(updates)) return [];
  const owners = new Set<string>();
  for (const update of updates.slice(0, 100)) {
    const message = update?.message;
    if (message?.from?.is_bot !== true && Number.isSafeInteger(message?.from?.id) && message.from.id > 0 &&
        Number.isSafeInteger(message?.chat?.id) && String(message.chat.id) === chat) owners.add(String(message.from.id));
  }
  return [...owners];
}
export function webhookRegistration(url: string, existing: string, secret: string): Record<string, unknown> {
  let target: URL;
  try { target = new URL(url); } catch { throw new SafeError('telegram_webhook_url_invalid'); }
  if (target.protocol !== 'https:' || target.pathname !== '/telegram/webhook' ||
      target.username || target.password || target.search || target.hash || (target.port && target.port !== '443')) {
    throw new SafeError('telegram_webhook_url_invalid');
  }
  if (existing && existing !== target.href) throw new SafeError('telegram_webhook_already_configured');
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret)) throw new SafeError('telegram_webhook_secret_invalid');
  return { url: target.href, secret_token: secret, allowed_updates: ['message', 'callback_query'],
    max_connections: 1, drop_pending_updates: false };
}
