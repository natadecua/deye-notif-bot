import type { Config } from './types.ts';
import { zonedDateParts } from './daytime.ts';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display only: timestamps, freshness, sessions and command-day boundaries remain
// absolute. Reuse the explicit daytime timezone and its single bounded formatter.
export function displayTime(at: number, c: Config, style: 'iso' | 'readable' = 'iso'): string {
  return displayTimeInZone(at, c.daytimeDischarge?.timeZone, style);
}
// Explicit display context only; never creates/changes an installation window.
export function displayTimeInZone(at: number, zone?: string, style: 'iso' | 'readable' = 'iso'): string {
  const date = new Date(at);
  if (!zone || zone === 'UTC') {
    return style === 'readable' ?
      `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${date.toISOString().slice(11, 19)} UTC` :
      `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }
  const parts = zonedDateParts(at, zone);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  const day = part('day'), month = part('month'), year = part('year');
  const localDate = style === 'readable' ? `${Number(day)} ${months[Number(month) - 1]} ${year},` : `${year}-${month}-${day}`;
  const offset = part('timeZoneName').replace(/^GMT/, 'UTC');
  return `${localDate} ${part('hour')}:${part('minute')}:${part('second')} ${zone} (${offset === 'UTC' ? 'UTC+00:00' : offset})`;
}
