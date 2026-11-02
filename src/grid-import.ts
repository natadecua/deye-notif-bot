export type GridReading = { at: number; importWatts: number };
export type GridMapping = { point: 'TotalGridPower' | 'ExternalCTPowerL1L2'; importSign: 'positive' | 'negative'; referenceConfirmed: true };
export type GridPolicy = { thresholdWatts: number; rearmWatts: number; minimumMinutes: number };
export type GridState = { version: 1; identity: string; armed: boolean; lastObservedAt: number;
  lastSampleAt?: number; highSince?: number; highCount: number };
const obj=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const instant=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
const nonnegative=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function decodeGridReading(raw: unknown,mapping:unknown,now:number,maxAgeSeconds:number):
  {status:'available';reading:GridReading}|{status:'unavailable';code:string} {
  const unavailable=()=>({status:'unavailable' as const,code:'grid_measurement_unavailable'});
  const m=obj(mapping),r=obj(raw);
  if(!m||Object.keys(m).length!==3||m.referenceConfirmed!==true||
    !['TotalGridPower','ExternalCTPowerL1L2'].includes(m.point as string)||!['positive','negative'].includes(m.importSign as string))
    return {status:'unavailable',code:'grid_unverified'};
  if(!r||!instant(now)||!Number.isFinite(maxAgeSeconds)||maxAgeSeconds<60||maxAgeSeconds>3600||
    typeof r.collectionTime!=='number'||!Number.isFinite(r.collectionTime)||r.collectionTime<=0||
    !instant(r.collectionTime*1000)||!Array.isArray(r.dataList))return unavailable();
  const at=r.collectionTime*1000;
  if(at>now||now-at>maxAgeSeconds*1000)return unavailable();
  const points=r.dataList.filter(p=>obj(p)?.key===m.point);
  if(points.length!==1)return unavailable();
  const p=obj(points[0])!;
  if(p.unit!=='W')return unavailable();
  const value=typeof p.value==='number'?p.value:typeof p.value==='string'&&/^-?\d+(?:\.\d+)?$/.test(p.value)?Number(p.value):NaN;
  if(!Number.isFinite(value))return unavailable();
  return {status:'available',reading:{at,importWatts:Math.max(0,m.importSign==='positive'?value:-value)}};
}
export function advanceGridImport(policy:GridPolicy,source:string,raw:unknown,reading:GridReading|undefined,
  now:number,limits:{maxAgeSeconds:number;maxGapSeconds:number}):
  {status:'invalid';code:string}|{status:'ok';state:GridState;event?:{id:string;at:number;importWatts:number;createdAt:number;expiresAt:number}} {
  const invalid=(code:string)=>({status:'invalid' as const,code});
  if(!policy||!nonnegative(policy.thresholdWatts)||policy.thresholdWatts<=0||policy.thresholdWatts>1e9||
    !nonnegative(policy.rearmWatts)||policy.rearmWatts>=policy.thresholdWatts||!Number.isInteger(policy.minimumMinutes)||
    policy.minimumMinutes<1||policy.minimumMinutes>120||typeof source!=='string'||source.length<1||source.length>64||
    !limits||!Number.isFinite(limits.maxAgeSeconds)||limits.maxAgeSeconds<60||limits.maxAgeSeconds>3600||
    !Number.isFinite(limits.maxGapSeconds)||limits.maxGapSeconds<300||limits.maxGapSeconds>3600)return invalid('grid_policy_invalid');
  if(!instant(now))return invalid('grid_clock_invalid');
  const identity=JSON.stringify([source,policy.thresholdWatts,policy.rearmWatts,policy.minimumMinutes]);
  const previous=obj(raw);
  if(raw!==undefined&&(!previous||previous.version!==1||typeof previous.identity!=='string'||previous.identity.length>256||
    typeof previous.armed!=='boolean'||!instant(previous.lastObservedAt)||![0,1,2].includes(previous.highCount as number)||
    Object.keys(previous).some(k=>!['version','identity','armed','lastObservedAt','lastSampleAt','highSince','highCount'].includes(k))||
    previous.lastSampleAt!==undefined&&(!instant(previous.lastSampleAt)||previous.lastSampleAt>previous.lastObservedAt)||
    previous.highCount===0&&previous.highSince!==undefined||previous.highCount!==0&&
      (!instant(previous.highSince)||!instant(previous.lastSampleAt)||previous.highSince>previous.lastSampleAt)))return invalid('grid_state_invalid');
  // Retain the original high-water mark during rollback, even across policy edits.
  if(previous&&now<(previous.lastObservedAt as number))return {status:'ok',state:{...previous} as GridState};
  const state:GridState=previous?.identity===identity?{...previous,lastObservedAt:now} as GridState:
    {version:1,identity,armed:true,lastObservedAt:now,highCount:0};
  const reset=()=>{state.highCount=0;delete state.highSince;};
  if(!reading||!instant(reading.at)||!nonnegative(reading.importWatts)||reading.at>now||now-reading.at>limits.maxAgeSeconds*1000){
    reset();return {status:'ok',state};
  }
  if(state.lastSampleAt!==undefined&&reading.at<=state.lastSampleAt)return {status:'ok',state};
  if(state.lastSampleAt!==undefined&&reading.at-state.lastSampleAt>limits.maxGapSeconds*1000)reset();
  state.lastSampleAt=reading.at;
  if(reading.importWatts<policy.rearmWatts)state.armed=true;
  if(reading.importWatts<=policy.thresholdWatts||!state.armed){reset();return {status:'ok',state};}
  if(state.highSince===undefined)state.highSince=reading.at;
  state.highCount=Math.min(2,state.highCount+1);
  if(state.highCount<2||reading.at-state.highSince<policy.minimumMinutes*60000)return {status:'ok',state};
  state.armed=false;reset();
  return {status:'ok',state,event:{id:`grid:${reading.at}`,at:reading.at,importWatts:reading.importWatts,
    createdAt:now,expiresAt:now+600000}};
}
