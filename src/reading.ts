import type { BatteryStatusReading, Config, Reading } from './types.ts';
import { SafeError } from './errors.ts';

export function parseTimestamp(value: unknown, mode: Config['timestampMode']): number {
  let at: number;
  if (mode === 'iso-offset') {
    // Require an explicit offset. Offset-less station times have no verified timezone.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new SafeError('timestamp_ambiguous');
    }
    // Date.parse normalizes Feb 30; reject invalid calendar components first.
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
        Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 ||
        Number(value.slice(17, 19)) > 59) throw new SafeError('timestamp_invalid');
    at = Date.parse(value);
  } else {
    // No magnitude guessing and no Number(null) => 0 coercion.
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new SafeError('timestamp_invalid');
    }
    at = value * (mode === 'unix-seconds' ? 1000 : 1);
  }
  if (!Number.isFinite(at) || at <= 0 || at > 8.64e15) throw new SafeError('timestamp_invalid');
  return at;
}

export function normalizeStatusReading(raw:unknown,c:Config,now:number):BatteryStatusReading {
  if(!raw||typeof raw!=='object')throw new SafeError('reading_invalid');
  const r=raw as Record<string,unknown>,at=parseTimestamp(r.lastUpdateTime,c.timestampMode);
  if(at>now)throw new SafeError('reading_future');
  if(now-at>c.maxAgeSeconds*1000)throw new SafeError('reading_stale');
  const out:BatteryStatusReading={version:1,at};
  if(typeof r.batterySOC==='number'&&Number.isFinite(r.batterySOC)&&r.batterySOC>=0&&r.batterySOC<=100)out.soc=r.batterySOC;
  if(typeof r.dischargePower==='number'&&Number.isFinite(r.dischargePower)&&r.dischargePower>=0){
    const watts=r.dischargePower*(c.powerUnit==='kW'?1000:1);
    if(Number.isFinite(watts))out.dischargeWatts=watts;
  }
  return out;
}
export function normalizeReading(raw: unknown, c: Config, now: number): Reading {
  const r=normalizeStatusReading(raw,c,now);
  if(r.soc===undefined||r.dischargeWatts===undefined)throw new SafeError('measurement_missing_or_invalid');
  return {at:r.at,soc:r.soc,dischargeWatts:r.dischargeWatts};
}
