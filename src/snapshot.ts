import type { Config, State } from './types.ts';
import { chargingSummary, type BotState } from './bot-state.ts';
import { displayTimeInZone } from './display-time.ts';
import { recapPreferencesText } from './recap-config.ts';

// Pure cached views: callers supply validated configuration/decoded records and
// their clock. Never fetch, decode optional metadata, advance a lifecycle or write.
export function cachedUpdateStatus(state: State, c: Config, now: number, brief = false,
  timeZone = c.daytimeDischarge?.timeZone): string {
  let text = brief ? `Monitoring: ${c.enabled ? 'enabled' : 'disabled'}.` :
    `📡 Cached update status\nScheduled monitoring is ${c.enabled ? 'enabled' : 'disabled'}.`;
  if (c.enabled) {
    if (now < state.apiRetryAt) {
      let retry = brief ? 'Retry time unavailable.' : 'Retry time is unavailable in this cache.';
      if (state.apiRetryAt <= 8.64e15) {
        try { retry = `Next attempt allowed after: ${displayTimeInZone(state.apiRetryAt, timeZone)}.`; }
        catch { /* Optional display cannot hide battery data or echo an exception. */ }
      }
      text += brief ? `\nUpdates: cooldown. ${retry} Cause unknown.` :
        `\nData updates: retry cooldown.\n${retry}\nReason is not recorded in this cache. A scheduled poll may try again when the delay allows it.`;
    } else if (state.apiRetryAt > 0) {
      text += brief ? '\nUpdates: retry delay elapsed; a scheduled poll may try again.' :
        '\nData updates: Retry delay has elapsed; a scheduled poll may try again.';
    } else if (state.latestReading) {
      text += brief ? '\nUpdates: no retry delay recorded.' : '\nData updates: No retry delay is recorded.';
    } else {
      text += brief ? '\nUpdates: waiting for a cached reading.' : '\nData updates: Waiting for a cached reading.';
    }
  }
  return brief ? text : text + '\nThis is cached status, not a live connection check; /status does not poll Deye.';
}
export function renderBriefSnapshot(state: State, c: Config, now: number, bot?: BotState,
  options: { kind?: 'status' | 'recap'; timeZone?: string } = {}): string {
  const commands = c.telegram?.enabled === true;
  const zone = options.kind === 'recap' ? options.timeZone ?? c.daytimeDischarge?.timeZone : c.daytimeDischarge?.timeZone;
  const formatTime = (at: number) => {
    try { return displayTimeInZone(at, zone); } catch { return 'time unavailable'; }
  };
  const r = state.latestReading;
  const lines = [options.kind === 'recap' ? '🔋 Battery snapshot · daily recap' : '🔋 Battery status · brief'];
  if (r) {
    const age = now - r.at;
    const quality = age < 0 ? 'future-dated — not current' : age > c.maxAgeSeconds * 1000 ?
      'stale — not current' : 'within freshness limit';
    lines.push(`Charge: ${r.soc}% · Battery discharge: ${Math.round(r.dischargeWatts)} W`,
      `Reading: ${formatTime(r.at)}`, `Data age: ${Math.floor(age / 1000)} s (${quality})`);
  } else lines.push('No cached reading yet.');
  lines.push('Load breakdown: unknown.', cachedUpdateStatus(state, c, now, true, zone));
  const policyLink = commands ? '; /settings for policy.' : '.';
  lines.push(c.dataHealth?.enabled ? (c.enabled ? 'Health notices: on (configured)' :
    'Health notices: paused (configured on)') + policyLink : 'Health notices: off.');
  lines.push(recapPreferencesText(c, true));
  if (commands && c.weather?.enabled) lines.push('Weather: /status for cached forecast.');
  lines.push('Cached only; cloud data may be delayed.' + (commands ? ' /status for details.' : ''));
  return lines.join('\n') + `\n\n${chargingSummary(commands ? bot : undefined, c, now, formatTime)}`;
}
