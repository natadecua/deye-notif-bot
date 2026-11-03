import type {Config} from './types.ts';import {sha256} from './deye.ts';import {validateReserve,reserveStatus,type ReservePolicy} from './reserve.ts';
export function reserveMenu(c:Config,now:number){
 let digest:Promise<string>|undefined;const context=()=>digest??=sha256(JSON.stringify([c.region,c.stationId,c.reserve,c.enabled])).then(x=>x.slice(0,12));
 const data=async(action:string,p:ReservePolicy,at=now)=>`rs:${action}:${p.warnSoc}:${p.rearmSoc}:${p.minimumMinutes}:${at}:${await context()}`;
 const summary=(p:ReservePolicy)=>`Set house reserve warning at or below ${p.warnSoc}% for ${p.minimumMinutes} minutes, re-arm at ${p.rearmSoc}%?\nConfirm accepts notices at all hours, including night. This is a low-charge warning; it does not predict morning SOC, verify grid import or grant overnight EV permission.`;
 const clock=()=>Number.isSafeInteger(now)&&now>=0&&now<=253402300199999;
 return {
 async preview(command:string){const m=/^\/reserve_set (\d{1,2}) (\d{1,3}) (\d{1,3})$/.exec(command);if(!m||!clock())return;
 try{const p=validateReserve({enabled:true,warnSoc:Number(m[1]),rearmSoc:Number(m[2]),minimumMinutes:Number(m[3]),allHoursConfirmed:true})!;
 return {reply:summary(p),markup:{inline_keyboard:[[{text:'Confirm reserve warning',callback_data:await data('save',p)}],[{text:'Cancel',callback_data:await data('cancel',p)}]]}};}catch{return;}
 },
 async action(raw:string){const m=/^rs:(save|cancel):(\d{1,2}):(\d{1,3}):(\d{1,3}):(\d{1,16}):([a-f0-9]{12})$/.exec(raw);if(!m||!clock())return;
 const at=Number(m[5]);if(String(at)!==m[5]||at>now||now-at>=1800000||m[6]!==await context())return;
 try{const p=validateReserve({enabled:true,warnSoc:Number(m[2]),rearmSoc:Number(m[3]),minimumMinutes:Number(m[4]),allHoursConfirmed:true})!;
 if([p.warnSoc,p.rearmSoc,p.minimumMinutes].some((n,i)=>String(n)!==m[i+2]))return;
 return {kind:m[1]as 'save'|'cancel',policy:p,reply:reserveStatus({...c,reserve:p})};}catch{return;}
 }
 };
}
