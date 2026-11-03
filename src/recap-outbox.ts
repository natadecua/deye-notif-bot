import type { BotState } from './bot-state.ts';
import type { Config, RecapAlert, State } from './types.ts';
import { advanceDailyRecap, dailyRecapSlotOpen, validDailyRecapSlot } from './daily-recap.ts';
import { renderBriefSnapshot } from './snapshot.ts';

const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999;
export function validRecapAlert(raw: unknown): boolean {
  const a = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  return !!a && Object.keys(a).length === 6 && Object.keys(a).every(k =>
    ['kind', 'slot', 'id', 'createdAt', 'attempts', 'nextAttemptAt'].includes(k)) &&
    a.kind === 'recap' && validDailyRecapSlot(a.slot) &&
    a.id === `recap:${a.slot.localDate}:${a.slot.dueAt}` && a.createdAt === a.slot.dueAt &&
    time(a.nextAttemptAt) && a.nextAttemptAt >= a.slot.dueAt &&
    typeof a.attempts === 'number' && Number.isInteger(a.attempts) && a.attempts >= 0 && a.attempts <= 3;
}
export function syncRecap(s: State, c: Config, now: number): string | undefined {
  const r = advanceDailyRecap(c, c.dailyRecap, s.dailyRecap, now);
  if (r.status === 'paused') return;
  if (r.status !== 'ok') {
    if (r.status === 'off') delete s.dailyRecap;
    s.pending = s.pending.filter(a => a.kind !== 'recap');
    return r.status === 'invalid' ? r.code : undefined;
  }
  s.dailyRecap = r.state;
  s.pending = s.pending.filter(a => a.kind !== 'recap' || (!r.resetPending && a.attempts < 3 &&
    a.nextAttemptAt < a.slot.expiresAt && dailyRecapSlotOpen(c, c.dailyRecap, r.state, a.slot, now)));
  // A consumed date is never retried for admission after capacity becomes free.
  if (r.candidate && s.pending.length < 2 && !s.pending.some(a => a.kind === 'recap')) {
    s.pending.push({ kind: 'recap', id: `recap:${r.candidate.localDate}:${r.candidate.dueAt}`, slot: r.candidate,
      createdAt: r.candidate.dueAt, attempts: 0, nextAttemptAt: now });
  }
  s.pending = [...s.pending.filter(a => a.kind !== 'recap'), ...s.pending.filter(a => a.kind === 'recap')];
}
export function recapMessage(s: State, c: Config, a: RecapAlert, now: number, bot?: BotState): string | undefined {
  if (a.attempts >= 3 || !c.dailyRecap?.enabled || !dailyRecapSlotOpen(c, c.dailyRecap, s.dailyRecap, a.slot, now)) return;
  return renderBriefSnapshot(s, c, now, bot, { kind: 'recap', timeZone: c.dailyRecap.timeZone });
}
