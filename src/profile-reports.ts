import type { Config } from './types.ts';
import { activeChargingSession, type BotState } from './bot-state.ts';
import { sha256 } from './deye.ts';
import type { sendTelegram } from './telegram.ts';

const MENU_MS = 30 * 60_000;
export const PROFILE_REPORT_HELP = 'Which setting are you using? Tap to make a manual report, not measured EV power. Buttons expire after 30 minutes and keep the original report expiry. Use /charging to renew or /stopped when finished. This does not change equipment or authorize overnight charging.';

// Context is a definition-change guard, not authentication. The webhook's owner,
// chat and secret checks authorize the report. Hash at most once per invocation;
// no new persisted field, KV operation, provider request or unbounded cache.
export function profileReports(c: Config, state: BotState, now: number) {
  let context: Promise<string> | undefined;
  const fingerprint = () => context ??= sha256(JSON.stringify(c.ev)).then(hash => hash.slice(0, 16));
  const session = () => {
    const current = activeChargingSession(state, now);
    return c.ev.enabled && c.ev.profiles?.length && current?.status === 'charging' && now - current.at <= MENU_MS ? current : undefined;
  };
  return {
    async selection(data: string): Promise<string | undefined> {
      const match = /^profile:(\d{1,16}):(\d{1,2}):([a-f0-9]{16})$/.exec(data), current = session();
      if (!match || !current || Number(match[1]) !== current.at || !c.ev.profiles?.[Number(match[2])] ||
          match[3] !== await fingerprint()) return undefined;
      return c.ev.profiles[Number(match[2])].id;
    },
    async menu(): Promise<Parameters<typeof sendTelegram>[3]> {
      const current = session();
      if (!current) return undefined;
      const hash = await fingerprint();
      return { inline_keyboard: c.ev.profiles!.map((p, index) => [
        { text: `I use ${p.label}`, callback_data: `profile:${current.at}:${index}:${hash}` },
      ]) };
    },
  };
}
