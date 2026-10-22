import { SafeError } from '../src/errors.ts';
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
