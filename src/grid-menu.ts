import type {Config} from './types.ts';import {sha256} from './deye.ts';import {kilowatts} from './power.ts';
const values={k:[300,500,1000,2000,3000],m:[5,10,15,30,60],r:[0,1]};
export function gridMenu(c:Config,now:number,source=''){
 let digest:Promise<string>|undefined;
 const context=()=>digest??=sha256(JSON.stringify([c.region,c.stationId,c.gridImport,source])).then(x=>x.slice(0,12));
 const data=async(action:string,key:string,value:number,at=now)=>`grid:${action}:${key}:${value}:${at}:${await context()}`;
 const validClock=()=>Number.isSafeInteger(now)&&now>=0&&now<=253402300199999;
 return {
 async entry(){return c.gridImport?.enabled&&validClock()?{text:'⚡ Grid alert settings',callback_data:await data('open','k',0)}:undefined;},
 async menu(){if(!c.gridImport?.enabled||!validClock())return;
 const p=c.gridImport;return {inline_keyboard:await Promise.all((['k','m','r']as const).flatMap(key=>values[key].filter(v=>key!=='k'||v>p.rearmWatts).map(async value=>[
 {text:key==='k'?`Grid ${kilowatts(value)}`:key==='m'?`${value} min`:`Recovery ${value?'on':'off'}`,callback_data:await data('pick',key,value)}])))};},
 async action(raw:string){const m=/^grid:(open|pick|save|cancel):([kmr]):(\d{1,4}):(\d{1,16}):([a-f0-9]{12})$/.exec(raw);
 if(!m||!c.gridImport?.enabled||!validClock())return {kind:'invalid'} as const;
 const at=Number(m[4]),value=Number(m[3]),key=m[2]as keyof typeof values;
 if(String(at)!==m[4]||String(value)!==m[3]||at>now||now-at>=1800000||m[5]!==await context()||
 (m[1]==='open'?key!=='k'||value!==0:!values[key].includes(value)||key==='k'&&value<=c.gridImport.rearmWatts))return {kind:'invalid'} as const;
 const command=key==='k'?`/grid_kw ${value/1000}`:key==='m'?`/grid_minutes ${value}`:`/grid_recovery ${value?'on':'off'}`;
 return {kind:m[1] as 'open'|'pick'|'save'|'cancel',command,key,value,
 markup:{inline_keyboard:[[{text:'Confirm grid change',callback_data:await data('save',key,value,at)}],[{text:'Cancel',callback_data:await data('cancel',key,value,at)}]]}};
 }
 };
}
