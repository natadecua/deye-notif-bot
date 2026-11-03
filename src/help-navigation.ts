import type { sendTelegram } from './telegram.ts';

const MENU_MS = 30 * 60_000;
const commands = { brief: '/status brief', status: '/status', settings: '/settings' } as const;
export const NAVIGATION_HELP = 'Read-only buttons expire after 30 minutes. They show cached status or preferences and do not change a charging report. Use /help for a new menu.';
export const NAVIGATION_EXPIRED = 'This menu is expired or invalid. Use /help for a new menu.';

// A timestamp limits menu age; it is not authorization or proof of issuance.
// The webhook still checks owner/chat/secret before private IO. Targets can only
// open existing read-only views, with no new state, hash, provider call or key.
export function navigationCommand(data: string, now: number): typeof commands[keyof typeof commands] | undefined {
  const match = /^view:(brief|status|settings):(\d{1,16})$/.exec(data);
  if (!match || !Number.isSafeInteger(now) || now < 0 || now > 8.64e15) return undefined;
  const at = Number(match[2]);
  if (!Number.isSafeInteger(at) || String(at) !== match[2] || at > now || now - at >= MENU_MS) return undefined;
  return commands[match[1] as keyof typeof commands];
}
export function helpNavigation(now: number): Parameters<typeof sendTelegram>[3] {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) return undefined;
  return { inline_keyboard: [
    [{ text: 'Quick status', callback_data: `view:brief:${now}` }],
    [{ text: 'Detailed status', callback_data: `view:status:${now}` }],
    [{ text: 'Settings', callback_data: `view:settings:${now}` }],
  ] };
}
