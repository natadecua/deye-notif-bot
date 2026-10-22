import type { Config } from './types.ts';
import { validateConfig } from './config.ts';
import { SafeError } from './errors.ts';
import type { SettingsOverrides } from './telegram-settings.ts';

export const BOT_KEY = 'telegram:v1';
export const SESSION_MS = 6 * 3600_000;
export interface BotState {
  version: 1; context: string; day: string; used: number; lastUpdateId: number; lastHandledAt: number;
  overrides?: SettingsOverrides;
  session?: { status: 'charging' | 'not_charging'; source: 'manual'; at: number; expiresAt: number; profileId?: string };
}
export function decodeBotState(raw: string | null, c: Config): BotState {
  const context = JSON.stringify([c.region, c.stationId]);
  if (raw === null) return { version: 1, context, day: '', used: 0, lastUpdateId: -1, lastHandledAt: 0 };
  let s: BotState;
  try { s = JSON.parse(raw); } catch { throw new SafeError('bot_state_invalid'); }
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!s || s.version !== 1 || typeof s.context !== 'string' || typeof s.day !== 'string' ||
      !Number.isSafeInteger(s.used) || s.used < 0 || s.used > 48 ||
      !Number.isSafeInteger(s.lastUpdateId) || s.lastUpdateId < -1 || !finite(s.lastHandledAt) ||
      (s.session && (!['charging', 'not_charging'].includes(s.session.status) || s.session.source !== 'manual' ||
        !finite(s.session.at) || !finite(s.session.expiresAt) || s.session.expiresAt - s.session.at !== SESSION_MS ||
        (s.session.profileId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(s.session.profileId))))) {
    throw new SafeError('bot_state_invalid');
  }
  if (s.context !== context) return decodeBotState(null, c);
  if (s.overrides !== undefined) {
    if (!s.overrides || typeof s.overrides !== 'object' || Array.isArray(s.overrides) ||
        Object.keys(s.overrides).some(k => !['notifications', 'fullSoc', 'fullRearmSoc', 'dischargeWatts', 'dischargeRearmWatts'].includes(k))) {
      throw new SafeError('bot_state_invalid');
    }
    try { validateConfig({ ...c, ...s.overrides }); } catch { throw new SafeError('bot_state_invalid'); }
  }
  return s;
}
export function chargingSummary(s: BotState | undefined, c: Config, now: number): string {
  if (!s?.session || now < s.session.at || now >= s.session.expiresAt) return 'EV charging: unknown';
  const profile = c.ev.profiles?.find(p => p.id === s.session!.profileId);
  return `EV charging: you confirmed ${s.session.status === 'charging' ? 'charging' : 'not charging'}\nSource: manual confirmation; expires ${new Date(s.session.expiresAt).toISOString().slice(0, 19).replace('T', ' ')} UTC${profile ? `\nReported profile: ${profile.label}` : ''}`;
}
