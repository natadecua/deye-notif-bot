import type {BatteryStatusReading,State} from './types.ts';
export function decodeBatteryStatus(raw:unknown):BatteryStatusReading|undefined {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const r=raw as Record<string,unknown>;
  const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(r.version!==1||!finite(r.at)||r.at<=0||r.at>8.64e15||
    r.soc!==undefined&&(!finite(r.soc)||r.soc>100)||r.dischargeWatts!==undefined&&!finite(r.dischargeWatts)||
    Object.keys(r).some(k=>!['version','at','soc','dischargeWatts'].includes(k)))return;
  return r as unknown as BatteryStatusReading;
}
// Complete legacy readings remain valid. Never mix old power with newer SOC.
export function cachedBatteryStatus(s:State):BatteryStatusReading|undefined {
  const r=decodeBatteryStatus(s.batteryStatus),old=s.latestReading;
  if(r&&(!old||r.at>=old.at))return r;
  return old?{version:1,...old}:undefined;
}
export function partialBatteryNote(s:State):string {
  const r=cachedBatteryStatus(s);if(!r||r.soc!==undefined&&r.dischargeWatts!==undefined)return '';
  const missing=r.soc===undefined?(r.dischargeWatts===undefined?'SOC and discharge power':'SOC'):'discharge power';
  return `Latest cached battery update is partial: ${missing} unavailable. Battery-triggered alerts require a complete fresh reading.`;
}
