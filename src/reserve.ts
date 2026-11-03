import type {Config,Reading,ReserveAlert,State} from './types.ts';
import {SafeError} from './errors.ts';import {displayTime} from './display-time.ts';import {admitAlert} from './delivery-priority.ts';
export type ReservePolicy={enabled:true;warnSoc:number;rearmSoc:number;minimumMinutes:number;allHoursConfirmed:true};
const obj=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const time=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=253402300199999;
export function validateReserve(v:unknown):ReservePolicy|undefined {
 if(v===undefined)return;const p=obj(v);
 if(p?.enabled===false&&Object.keys(p).length===1)return;
 if(!p||p.enabled!==true||p.allHoursConfirmed!==true||Object.keys(p).length!==5||
  ![p.warnSoc,p.rearmSoc,p.minimumMinutes].every(n=>typeof n==='number'&&Number.isInteger(n))||
  (p.warnSoc as number)<=0||(p.warnSoc as number)>=100||(p.rearmSoc as number)<=(p.warnSoc as number)||(p.rearmSoc as number)>100||
  (p.minimumMinutes as number)<1||(p.minimumMinutes as number)>120)throw new SafeError('reserve_config_invalid');
 return {...p} as unknown as ReservePolicy;
}
interface Guard {version:1;policyKey:string;armed:boolean;lastObservedAt:number;lastAt?:number;lowSince?:number;lowCount:number}
const key=(p:ReservePolicy)=>JSON.stringify([p.warnSoc,p.rearmSoc,p.minimumMinutes]);
function guard(raw:unknown):Guard|undefined {
 const r=obj(raw);if(!r||r.version!==1||typeof r.policyKey!=='string'||r.policyKey.length>64||typeof r.armed!=='boolean'||!time(r.lastObservedAt)||
 ![0,1,2].includes(r.lowCount as number)||Object.keys(r).some(k=>!['version','policyKey','armed','lastObservedAt','lastAt','lowSince','lowCount'].includes(k))||
 r.lastAt!==undefined&&(!time(r.lastAt)||r.lastAt>r.lastObservedAt)||
 (r.lowCount===0?r.lowSince!==undefined:!r.armed||!time(r.lowSince)||!time(r.lastAt)||r.lowSince>r.lastAt))return;
 try{const a=JSON.parse(r.policyKey);if(!Array.isArray(a)||a.length!==3||JSON.stringify(a)!==r.policyKey)return;
 validateReserve({enabled:true,warnSoc:a[0],rearmSoc:a[1],minimumMinutes:a[2],allHoursConfirmed:true});}catch{return;}
 return r as unknown as Guard;
}
export function validReserveAlert(raw:unknown):raw is ReserveAlert {
 const a=obj(raw),r=obj(a?.reading);return !!a&&Object.keys(a).length===9&&a.kind==='reserve'&&time(a.createdAt)&&time(a.expiresAt)&&a.expiresAt===a.createdAt+600000&&
 time(a.nextAttemptAt)&&Number.isInteger(a.attempts)&&(a.attempts as number)>=0&&(a.attempts as number)<=3&&typeof a.policyKey==='string'&&a.policyKey.length<=64&&
 !!r&&time(r.at)&&time(a.qualifiedAt)&&a.id===`reserve:${a.qualifiedAt}`&&typeof r.soc==='number'&&Number.isFinite(r.soc)&&r.soc>=0&&r.soc<=100&&
 typeof r.dischargeWatts==='number'&&Number.isFinite(r.dischargeWatts)&&r.dischargeWatts>=0;
}
export function syncReserve(s:State,c:Config,current:Reading|undefined,now:number):string|undefined {
 const p=validateReserve(c.reserve);if(!p){delete s.reserve;s.pending=s.pending.filter(a=>a.kind!=='reserve');return;}
 let r=guard(s.reserve);if(s.reserve!==undefined&&!r||!time(now)){
 s.pending=s.pending.filter(a=>a.kind!=='reserve');return 'reserve_state_invalid';}
 if(r&&now<r.lastObservedAt){s.pending=s.pending.filter(a=>a.kind!=='reserve');return 'reserve_clock_rollback';}
 if(!r||r.policyKey!==key(p))r={version:1,policyKey:key(p),armed:true,lastObservedAt:now,lowCount:0};
 r.lastObservedAt=now;
 s.pending=s.pending.filter(a=>a.kind!=='reserve'||a.policyKey===r!.policyKey&&now<a.expiresAt&&a.attempts<3&&a.nextAttemptAt<a.expiresAt);
 const reset=()=>{r!.lowCount=0;delete r!.lowSince;};
 if(!current||current.at>now||now-current.at>c.maxAgeSeconds*1000){reset();s.reserve=r;return;}
 const outOfOrder=r.lastAt!==undefined&&current.at<r.lastAt;
 if(outOfOrder){s.reserve=r;return;}
 for(const a of s.pending)if(a.kind==='reserve')a.reading={...current};
 if(current.soc>p.warnSoc)s.pending=s.pending.filter(a=>a.kind!=='reserve');
 if(r.lastAt!==undefined&&current.at<=r.lastAt){s.reserve=r;return;}
 if(r.lastAt!==undefined&&current.at-r.lastAt>c.maxGapSeconds*1000)reset();
 r.lastAt=current.at;
 if(current.soc>=p.rearmSoc)r.armed=true;
 if(current.soc>p.warnSoc||!r.armed)reset();
 else{r.lowSince??=current.at;r.lowCount=Math.min(2,r.lowCount+1);
 if(r.lowCount>=2&&current.at-r.lowSince>=p.minimumMinutes*60000){r.armed=false;reset();
 admitAlert(s,c,{kind:'reserve',id:`reserve:${current.at}`,qualifiedAt:current.at,createdAt:now,expiresAt:now+600000,policyKey:r.policyKey,reading:{...current},attempts:0,nextAttemptAt:now},now);}}
 s.reserve=r;
}
export function reserveMessage(s:State,c:Config,a:ReserveAlert,now:number):string|undefined {
 const p=validateReserve(c.reserve),r=guard(s.reserve);
 if(!p||!r||r.armed||r.policyKey!==a.policyKey||key(p)!==a.policyKey||now<r.lastObservedAt||now>=a.expiresAt||a.attempts>=3||
 a.reading.at>now||now-a.reading.at>c.maxAgeSeconds*1000||a.reading.at!==r.lastAt||a.reading.soc>p.warnSoc)return;
 return `🔋 House battery reserve low\n\nCharge: ${a.reading.soc}%\nAt or below your ${p.warnSoc}% warning point across readings spanning ${p.minimumMinutes} minutes.\nReading: ${displayTime(a.reading.at,c)}\nDeye Cloud data may be delayed.\n\nThis is a measured low-charge warning, not an overnight energy forecast or proof of grid import. Nighttime battery use is for the house by default. Equipment changes remain manual.`;
}
export function reserveStatus(c:Config):string {
 const p=validateReserve(c.reserve);return p?`House reserve warning: ${c.enabled?'on (configured)':'paused'}, at or below ${p.warnSoc}% for ${p.minimumMinutes} minutes; re-arm at ${p.rearmSoc}%, all hours. This is not an overnight forecast.`:
 'House reserve warning: off; choose warning/re-arm SOC and duration with /reserve_set WARN REARM MINUTES, then confirm.';
}
