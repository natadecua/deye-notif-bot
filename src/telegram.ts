import { SafeError } from './errors.ts';
import { jsonPost, retryTime } from './http.ts';
import { defaults, type Dependencies, type Secrets } from './types.ts';

export function validateTelegramSecrets(s: Pick<Secrets, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>): void {
  if (!/^\d+:[a-zA-Z0-9_-]+$/.test(s.TELEGRAM_BOT_TOKEN ?? '') || !/^-?\d+$/.test(s.TELEGRAM_CHAT_ID ?? '')) {
    throw new SafeError('telegram_secrets_invalid');
  }
}
export async function sendTelegram(s: Pick<Secrets, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>,
  text: string, deps: Dependencies = defaults, replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] }): Promise<void> {
  validateTelegramSecrets(s);
  // One attempt here. Persistent outbox controls retries and honors Retry-After.
  const data = await jsonPost(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: s.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }, {}, deps, 'telegram', 1);
  if (data.ok !== true) {
    const parameters = data.parameters as { retry_after?: number } | undefined;
    const code = data.error_code;
    throw new SafeError(code === 429 ? 'telegram_rate_limited' : 'telegram_rejected',
      code === 429 || (typeof code === 'number' && code >= 500),
      retryTime(parameters?.retry_after, deps.now()));
  }
}
