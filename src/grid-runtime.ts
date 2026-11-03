import type {Config,Dependencies,Env,GridAlert,State} from './types.ts';
import {advanceGridImport,type GridReading,type GridState,decodeGridReading} from './grid-import.ts';
import {validateGridConfig} from './grid-config.ts';
import {DeyeClient,sha256} from './deye.ts';
import {SafeError} from './errors.ts';
import {admitAlert} from './delivery-priority.ts';
import type {PendingAlert} from './types.ts';
const isGrid=(a:PendingAlert):a is GridAlert=>a.kind==='grid'||a.kind==='grid_recovered';
interface Recovery {episodeAt:number;lastAt:number;lowCount:number;lowSince?:number;queued?:true}
import {kilowatts} from './power.ts';
import {displayTime} from './display-time.ts';
import {chargingSummary,type BotState} from './bot-state.ts';

interface GridRecord {version:1;sourceKey:string;policyKey:string;tracker?:GridState;latest?:GridReading;
  available:boolean;retryAt:number;failures:number;recovery?:Recovery}
const object=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
const reading=(v:unknown):v is GridReading=>!!object(v)&&time((v as GridReading).at)&&
  typeof (v as GridReading).importWatts==='number'&&Number.isFinite((v as GridReading).importWatts)&&(v as GridReading).importWatts>=0;
function record(v:unknown):GridRecord|undefined {
  const r=object(v);
  const shape=r&&r.version===1&&typeof r.sourceKey==='string'&&/^[a-f0-9]{64}$/.test(r.sourceKey)&&
    typeof r.policyKey==='string'&&r.policyKey.length<=512&&typeof r.available==='boolean'&&time(r.retryAt)&&
    Number.isInteger(r.failures)&&(r.failures as number)>=0&&(r.failures as number)<=10&&
    (r.latest===undefined||reading(r.latest))&&Object.keys(r).every(k=>
      ['version','sourceKey','policyKey','tracker','latest','available','retryAt','failures','recovery'].includes(k));
  if(!shape)return;
  try{
    const p=JSON.parse(r.policyKey as string);
    if(!Array.isArray(p)||p.length!==5||JSON.stringify(p)!==r.policyKey)return;
    const config=validateGridConfig({enabled:true,thresholdWatts:p[0],rearmWatts:p[1],minimumMinutes:p[2],
      point:p[3],importSign:p[4],referenceConfirmed:true,allHoursConfirmed:true});
    const tracker=object(r.tracker);
    if(!config||!tracker||tracker.identity!==JSON.stringify([r.sourceKey,p[0],p[1],p[2]])||
      advanceGridImport(config,r.sourceKey as string,tracker,undefined,tracker.lastObservedAt as number,
        {maxAgeSeconds:600,maxGapSeconds:900}).status!=='ok'||
      r.latest!==undefined&&(r.latest as GridReading).at!==tracker.lastSampleAt||r.available&&!r.latest)return;
    const q=object(r.recovery);
    if(r.recovery!==undefined&&(!q||!time(q.episodeAt)||!time(q.lastAt)||q.episodeAt>q.lastAt||q.lastAt>(tracker.lastSampleAt as number)||
      ![0,1,2].includes(q.lowCount as number)||(q.lowCount===0?q.lowSince!==undefined:!time(q.lowSince)||q.lowSince>q.lastAt)||
      q.queued!==undefined&&q.queued!==true||Object.keys(q).some(k=>!['episodeAt','lastAt','lowCount','lowSince','queued'].includes(k))))return;
    return r as unknown as GridRecord;
  }catch{return;}
}
const policyKey=(c:Config)=>c.gridImport?.enabled?JSON.stringify([c.gridImport.thresholdWatts,c.gridImport.rearmWatts,
  c.gridImport.minimumMinutes,c.gridImport.point,c.gridImport.importSign]):'';
export async function gridSourceKey(c:Config,env:Env):Promise<string|undefined>{
  const p=validateGridConfig(c.gridImport);
  if(!p||!/^[A-Za-z0-9_-]{1,64}$/.test(env.GRID_DEVICE_SN??''))return;
  return sha256(JSON.stringify([c.region,c.stationId,env.GRID_DEVICE_SN,p.point,p.importSign,'v1']));
}
export function validGridAlert(v:unknown):v is GridAlert {
  const a=object(v);
  return !!a&&Object.keys(a).length===10&&(a.kind==='grid'||a.kind==='grid_recovered')&&time(a.qualifiedAt)&&a.id===`${a.kind}:${a.qualifiedAt}`&&
    time(a.createdAt)&&time(a.expiresAt)&&a.expiresAt===a.createdAt+600000&&time(a.nextAttemptAt)&&
    Number.isInteger(a.attempts)&&(a.attempts as number)>=0&&(a.attempts as number)<=3&&reading(a.reading)&&
    typeof a.sourceKey==='string'&&/^[a-f0-9]{64}$/.test(a.sourceKey)&&typeof a.policyKey==='string'&&a.policyKey.length<=512;
}
export async function syncGrid(s:State,c:Config,env:Env,client:DeyeClient|undefined,allowFetch:boolean,deps:Dependencies):Promise<string|undefined>{
  const p=validateGridConfig(c.gridImport),now=deps.now();
  if(!p){delete s.gridImport;s.pending=s.pending.filter(a=>!isGrid(a));return;}
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(env.GRID_DEVICE_SN??'')){
    s.pending=s.pending.filter(a=>!isGrid(a));return 'grid_device_required';
  }
  const sourceKey=(await gridSourceKey(c,env))!;
  let r=record(s.gridImport);
  if(s.gridImport!==undefined&&!r){s.pending=s.pending.filter(a=>!isGrid(a));return 'grid_state_invalid';}
  const limits={maxAgeSeconds:c.maxAgeSeconds,maxGapSeconds:c.maxGapSeconds};
  const check=advanceGridImport(p,sourceKey,r?.tracker,undefined,now,limits);
  if(check.status==='invalid'){s.pending=s.pending.filter(a=>!isGrid(a));return check.code;}
  if(r?.tracker&&now<r.tracker.lastObservedAt){
    r.available=false;s.gridImport=r;s.pending=s.pending.filter(a=>!isGrid(a));return 'grid_clock_rollback';
  }
  if(!r||r.sourceKey!==sourceKey||r.policyKey!==policyKey(c))r={version:1,sourceKey,policyKey:policyKey(c),available:false,retryAt:0,failures:0};
  let current:GridReading|undefined,code:string|undefined;
  if(allowFetch&&client&&now>=r.retryAt){
    try{
      const data=await client.read('/device/latest',{deviceList:[env.GRID_DEVICE_SN]},1);
      const devices=Array.isArray(data.deviceDataList)?data.deviceDataList.filter(v=>object(v)?.deviceSn===env.GRID_DEVICE_SN):[];
      const decoded=decodeGridReading(devices.length===1?devices[0]:undefined,
        {point:p.point,importSign:p.importSign,referenceConfirmed:p.referenceConfirmed},deps.now(),c.maxAgeSeconds);
      if(decoded.status==='available')current=decoded.reading;
      else code=decoded.code;
      r.failures=0;r.retryAt=0;
    }catch(error){
      r.failures=Math.min(10,r.failures+1);
      r.retryAt=Math.max(deps.now()+Math.min(3600000,300000*2**(r.failures-1)),error instanceof SafeError?error.retryAt:0);
      code='grid_update_unavailable';
    }
  }
  const next=advanceGridImport(p,sourceKey,r.tracker,current,deps.now(),limits);
  if(next.status==='invalid'){s.pending=s.pending.filter(a=>!isGrid(a));return next.code;}
  r.tracker=next.state;r.available=!!current&&current.at===r.tracker.lastSampleAt&&deps.now()>=r.tracker.lastObservedAt;
  if(current&&r.available)r.latest={...current};
  s.gridImport=r;
  if(!p.recovery)delete r.recovery;
  s.pending=s.pending.filter(a=>!isGrid(a)||(a.sourceKey===sourceKey&&a.policyKey===r.policyKey&&
    a.attempts<3&&deps.now()<a.expiresAt&&a.nextAttemptAt<a.expiresAt&&
    (a.kind!=='grid_recovered'||p.recovery===true&&!!r.recovery?.queued)&&
    (!current||(a.kind==='grid'?current.importWatts>p.thresholdWatts:current.importWatts<p.rearmWatts))));
  if(current&&r.available)for(const a of s.pending)if(isGrid(a))a.reading={...current};
  const q=r.recovery;
  if(q&&!q.queued){
    if(!current||!r.available||current.importWatts>=p.rearmWatts||current.at-q.lastAt>c.maxGapSeconds*1000){q.lowCount=0;delete q.lowSince;}
    if(current&&r.available&&current.at>q.lastAt){
      q.lastAt=current.at;
      if(current.importWatts<p.rearmWatts){q.lowSince??=current.at;q.lowCount=Math.min(2,q.lowCount+1);
        if(q.lowCount>=2&&current.at-q.lowSince>=300000){q.queued=true;
          admitAlert(s,c,{kind:'grid_recovered',id:`grid_recovered:${current.at}`,qualifiedAt:current.at,createdAt:deps.now(),expiresAt:deps.now()+600000,
            reading:{...current},sourceKey,policyKey:r.policyKey,attempts:0,nextAttemptAt:deps.now()},deps.now());
        }
      }
    }
  }
  if(next.event){
    s.pending=s.pending.filter(a=>a.kind!=='grid');
    admitAlert(s,c,{kind:'grid',id:next.event.id,qualifiedAt:next.event.at,createdAt:next.event.createdAt,
      expiresAt:next.event.expiresAt,reading:{at:next.event.at,importWatts:next.event.importWatts},
      sourceKey,policyKey:r.policyKey,attempts:0,nextAttemptAt:deps.now()},deps.now());
  }
  return code;
}
export function gridMessage(s:State,c:Config,a:GridAlert,now:number,bot?:BotState):string|undefined {
  const p=validateGridConfig(c.gridImport),r=record(s.gridImport);
  if(!p||!r?.available||!r.latest||!r.tracker||now<r.tracker.lastObservedAt||now>=a.expiresAt||a.attempts>=3||
    a.sourceKey!==r.sourceKey||a.policyKey!==policyKey(c)||a.reading.at>now||now-a.reading.at>c.maxAgeSeconds*1000||
    r.latest.at!==a.reading.at)return;
  if(a.kind==='grid_recovered'){
    if(!p.recovery||!r.recovery?.queued||r.latest.importWatts>=p.rearmWatts)return;
    return `✅ Grid import back below your re-arm level\n\nMeasured import: ${kilowatts(a.reading.importWatts)}\nBelow ${kilowatts(p.rearmWatts)} in two distinct readings spanning at least 5 minutes.\nReading: ${displayTime(a.reading.at,c)}\nDeye Cloud data may be delayed. This does not establish zero import, a grid outage or an EV charging state.`;
  }
  if(r.latest.importWatts<=p.thresholdWatts)return;
  return `⚡ Grid electricity use\n\nMeasured import: ${kilowatts(a.reading.importWatts)}\nAbove ${kilowatts(p.thresholdWatts)} across readings spanning ${p.minimumMinutes} minutes.\nReading: ${displayTime(a.reading.at,c)}\nCloud data may be delayed.\n\n${chargingSummary(bot,c,now)}\nAggregate grid import does not identify which load caused it. Equipment changes remain manual.`;
}
export function gridStatus(c:Config,raw:unknown,now:number,expectedSource?:string):string {
  const p=validateGridConfig(c.gridImport);
  if(!p)return 'Grid-import alerts: off; verified device mapping and explicit setup are required.';
  const r=record(raw);
  const policy=`Grid-import alerts: ${c.enabled?'on':'paused'} (configured), above ${kilowatts(p.thresholdWatts)} for ${p.minimumMinutes} minutes, all hours.`;
  return policy+`\nRecovery notice: ${p.recovery?'on':'off'}.`+(!r?.available||!r.latest||r.policyKey!==policyKey(c)||r.sourceKey!==expectedSource||
    !r.tracker||now<r.tracker.lastObservedAt||r.latest.at>now||now-r.latest.at>c.maxAgeSeconds*1000?
    '\nGrid reading: unavailable or stale; no current import claim.':
    `\nCached grid import: ${kilowatts(r.latest.importWatts)}. Reading: ${displayTime(r.latest.at,c)}.`)+
    '\nConfiguration does not verify message receipt. Grid import and battery discharge are separate rules.';
}

export function settleGrid(s:State,c:Config,a:GridAlert):void {
 const p=validateGridConfig(c.gridImport),r=record(s.gridImport);
 if(!p?.recovery||!r||r.sourceKey!==a.sourceKey||r.policyKey!==a.policyKey)return;
 if(a.kind==='grid')r.recovery={episodeAt:a.qualifiedAt,lastAt:a.reading.at,lowCount:0};
 else delete r.recovery;
 s.gridImport=r;
}
