import type { Config, Secrets } from '../src/types.ts';
import { validateTelegramSecrets } from '../src/telegram.ts';
export async function telegramDoctor(c: Config, s: Secrets,
  call: (method: 'getMe' | 'getWebhookInfo') => Promise<Record<string, unknown>>): Promise<string> {
  validateTelegramSecrets(s);
  const paired = /^[1-9]\d*$/.test(s.TELEGRAM_OWNER_ID ?? '') &&
    /^[a-zA-Z0-9_-]{32,256}$/.test(s.TELEGRAM_WEBHOOK_SECRET ?? '');
  const lines = [`Local commands: ${c.telegram?.enabled ? 'on' : 'off'}.`,
    `Local owner/header: ${paired ? 'configured' : 'missing'}.`];
  try {
    const me = await call('getMe');
    lines.push(`Bot token: ${me.ok === true ? 'accepted' : 'rejected'}.`);
  } catch { lines.push('Bot token: unavailable. Check connectivity and credentials privately.'); }
  try {
    const info = await call('getWebhookInfo');
    const r = info.result;
    if (info.ok !== true || !r || typeof r !== 'object' || Array.isArray(r) ||
        typeof (r as Record<string, unknown>).url !== 'string') {
      lines.push('Webhook: unavailable. Check bot access privately.');
    } else {
      const v = r as Record<string, unknown>;
      lines.push(`Webhook: ${v.url ? 'registered' : 'absent'}.`);
      if (Number.isSafeInteger(v.pending_update_count) && (v.pending_update_count as number) >= 0) {
        lines.push(`Pending updates: ${v.pending_update_count}.`);
      }
      if (typeof v.last_error_message === 'string' && v.last_error_message.length > 0) {
        lines.push('Delivery error: recorded. Review the deployed route, header secret and owner pairing privately.');
      }
    }
  } catch { lines.push('Webhook: unavailable. Check connectivity and bot access privately.'); }
  lines.push('For commands: npm run telegram:setup, npm run secrets:upload, manual npm run deploy, then npm run telegram:webhook.',
    'This check does not verify deployed configuration or message receipt. Confirm /help and /status in the owner chat.',
    'Read-only checks only: no message sent, updates consumed, webhook changed, secret uploaded or deployment performed.');
  return lines.join('\n');
}
