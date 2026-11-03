import type {Config,Dependencies,Env,KVStore,Secrets} from '../src/types.ts';
import {SafeError} from '../src/errors.ts';
import {configureGrid} from './grid-preferences.ts';
import type {PreferencePrompts} from './preferences.ts';
import {setupHint} from './setup-hints.ts';
import {handleTelegramRequest} from '../src/bot.ts';
import {decodeBotState} from '../src/bot-state.ts';
import {runMonitor} from '../src/monitor.ts';

// Synthetic prerequisites/answers/transports only. No filesystem, environment,
// subprocess, global fetch or live owner-account capability exists in this flow.
export async function runAlertRehearsal(source:Config,print:(s:string)=>void){
  const ensure=(ok:unknown)=>{if(!ok)throw new SafeError('synthetic_alert_rehearsal_failed');};
  const original=JSON.stringify(source);
  print('SYNTHETIC ALERT RELEASE REHEARSAL — invented source, scripted consent, in-memory settings and intercepted services only.');
  print('Synthetic reference flags are not installation evidence. Zero alone cannot verify import direction.');
  let c:Config={...structuredClone(source),enabled:true,measurementsConfirmed:true,region:'eu',stationId:123,
    powerUnit:'W',timestampMode:'iso-offset',telegram:{enabled:true},ev:{enabled:false},notifications:{full:false,discharge:false}};
  for(const key of ['gridImport','reserve','dataHealth','dailyRecap','quietHours','weather','daytimeDischarge']as const)delete c[key];
  const prompts=(values:unknown[])=>{
    const remaining=[...values];let count=0;
    const next=async(message:string)=>{ensure(remaining.length>0);count++;print(`[SYNTHETIC prompt] ${message} [scripted answer]`);return remaining.shift() as never;};
    const p:PreferencePrompts={confirm:next,checklist:next,choose:next,
      text:async(message,_default,validate)=>{const v=await next(message);ensure(typeof v==='string'&&(!validate||validate(v)===true));return v;},
      number:async(message,_default,validate)=>{const v=await next(message);ensure(typeof v==='number'&&(!validate||validate(v)===true));return v;},
      print:s=>print(`[SYNTHETIC setup] ${s}`)};
    return {p,remaining,count:()=>count};
  };
  print('1. Reuse real offline grid:setup with illustrative 1 kW / 0.1 kW re-arm / 10 minutes and separate reference/all-hours/save consent.');
  const accepted=[true,'TotalGridPower','positive',true,1,0.1,10,true,true];
  const preparation=prompts(accepted);c=await configureGrid(c,preparation.p);ensure(preparation.remaining.length===0);
  for(const values of [[true,'TotalGridPower','positive',false],accepted.slice(0,7).concat(false),accepted.slice(0,8).concat(false)]){
    const before=JSON.stringify(c),p=prompts(values);let cancelled=false;
    try{await configureGrid(c,p.p);}catch(error){
      ensure(error instanceof SafeError&&error.code==='grid_setup_not_confirmed');cancelled=true;
      print(`grid_setup_not_confirmed: ${setupHint('grid_setup_not_confirmed')}`);
    }
    ensure(cancelled&&JSON.stringify(c)===before);print('Previous in-memory grid policy retained.');
  }
  const invalidPrompts=prompts([]);let invalid=false;
  try{await configureGrid({...c,gridImport:{...c.gridImport,referenceConfirmed:false}} as unknown as Config,invalidPrompts.p);}
  catch(error){ensure(error instanceof SafeError&&error.code==='grid_config_invalid');invalid=true;print(`grid_config_invalid: ${setupHint('grid_config_invalid')}`);}
  ensure(invalid&&invalidPrompts.count()===0);
  print(`grid_device_required: ${setupHint('grid_device_required')}`);
  let now=Date.parse('2026-11-04T02:00:00Z'),update=0,commands=0,callbacks=0,lastText='';
  let markup:{text:string;callback_data:string}[][]=[];
  const requests={auth:0,station:0,device:0,telegram:0,weather:0};
  const monitorWrites:{value:string}[]=[];const values=new Map<string,string>();
  const kv:KVStore={get:async key=>values.get(key)??null,put:async(key,value)=>{
    values.set(key,value);if(key==='monitor:v1')monitorWrites.push({value});
  }};
  const token='123:synthetic-token',secret='synthetic-webhook-secret-1234567890';
  const credentials:Secrets={DEYE_APP_ID:'synthetic-app',DEYE_APP_SECRET:'synthetic-app-secret',DEYE_ACCOUNT:'synthetic@example.invalid',
    DEYE_PASSWORD_SHA256:'a'.repeat(64),TELEGRAM_BOT_TOKEN:token,TELEGRAM_CHAT_ID:'456',TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret,
    GRID_DEVICE_SN:'synthetic-device'};
  const noticeTexts:string[]=[];
  const deps:Dependencies={now:()=>now,random:()=>0,sleep:async ms=>{now+=ms;},fetch:(async(resource,init)=>{
    const u=new URL(String(resource));let body:unknown;
    if(u.hostname==='eu1-developer.deyecloud.com'){
      if(u.pathname.endsWith('/account/token')){requests.auth++;body={success:true,accessToken:'synthetic-bearer',expiresIn:3600};}
      else if(u.pathname.endsWith('/station/latest')){requests.station++;body={success:true,batterySOC:13,dischargePower:0,lastUpdateTime:new Date(now).toISOString()};}
      else if(u.pathname.endsWith('/device/latest')){requests.device++;body={success:true,deviceDataList:[{deviceSn:'synthetic-device',collectionTime:Math.floor(now/1000),
        dataList:[{key:'TotalGridPower',unit:'W',value:requests.station<=3?2500:50}]}]};}
    }else if(u.hostname==='api.telegram.org'){
      if(u.pathname.endsWith('/sendMessage')){
        requests.telegram++;const sent=JSON.parse(String(init?.body));lastText=sent.text;markup=sent.reply_markup?.inline_keyboard??[];
        if(/^(⚡ Grid electricity use|🔋 House battery reserve low|✅ Grid import back below)/.test(lastText))noticeTexts.push(lastText);
        body={ok:true};
      }else if(u.pathname.endsWith('/answerCallbackQuery')){requests.telegram++;body={ok:true};}
    }
    if(!body)throw new SafeError('synthetic_alert_request_not_allowed');
    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  })as typeof fetch};
  const env:Env={...credentials,STATE:kv,MONITOR_CONFIG:c};
  const bot=()=>decodeBotState(values.get('telegram:v1')??null,c);
  const button=(prefix:string)=>{const b=markup.flat().find(b=>b.callback_data.startsWith(prefix));ensure(b&&b.callback_data.length<=64);return b!.callback_data;};
  const send=async(text:string,callback=false)=>{
    const providerBefore=requests.auth+requests.station+requests.device,monitorBefore=monitorWrites.length;
    now+=3000;commands++;if(callback)callbacks++;
    const response=await handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},
      body:JSON.stringify({update_id:++update,...(callback?{callback_query:{id:'synthetic-callback',from:{id:789},data:text,message:{chat:{id:456}}}}:
        {message:{from:{id:789},chat:{id:456},date:Math.floor(now/1000),text}})})}),env,deps);
    ensure(response.status===200&&providerBefore===requests.auth+requests.station+requests.device&&monitorBefore===monitorWrites.length);
  };
  print('2. Reuse authorized bot menus: preview/cancel preserves preferences, Confirm saves, original expiry rejects old menus.');
  await send('/grid');await send(button('grid:pick:k:2000:'),true);await send(button('grid:cancel:k:2000:'),true);ensure(bot().overrides===undefined);
  await send('/grid');await send(button('grid:pick:k:2000:'),true);await send(button('grid:save:k:2000:'),true);ensure(bot().overrides?.gridWatts===2000);
  await send('/grid');const expired=button('grid:pick:m:15:');now+=1800000;await send(expired,true);ensure(/expired|changed/i.test(lastText));
  await send('/grid');await send(button('grid:pick:m:10:'),true);await send(button('grid:save:m:10:'),true);ensure(bot().overrides?.gridMinutes===10);
  await send('/grid');await send(button('grid:pick:r:1:'),true);await send(button('grid:save:r:1:'),true);ensure(bot().overrides?.gridRecovery===true);
  await send('/discharge_kw 3');ensure(bot().overrides?.dischargeWatts===3000);
  print('3. Reuse reserve preview and explicit all-hours confirmation; 13% / 15% / 5 minutes are illustrative synthetic answers, not owner selections.');
  const beforeReserve=JSON.stringify(bot().overrides);await send('/reserve_set 13');ensure(JSON.stringify(bot().overrides)===beforeReserve);
  await send('/reserve_set 13 15 5');await send(button('rs:cancel:'),true);ensure(JSON.stringify(bot().overrides)===beforeReserve);
  await send('/reserve_set 13 15 5');await send(button('rs:save:'),true);ensure(bot().overrides?.reserve?.enabled===true);
  print('4. Reuse five scheduled monitor ticks with synthetic station/device data: reserve warning, grid warning, then measured below-re-arm recovery.');
  let maxMonitorWrites=0,maxPending=0,maxSends=0;
  for(let i=0;i<5;i++){
    if(i)now+=300000;const before=monitorWrites.length,sendsBefore=noticeTexts.length;
    await runMonitor(env,deps);maxMonitorWrites=Math.max(maxMonitorWrites,monitorWrites.length-before);maxSends=Math.max(maxSends,noticeTexts.length-sendsBefore);
    for(const write of monitorWrites.slice(before))maxPending=Math.max(maxPending,JSON.parse(write.value).pending.length);
  }
  const notices={grid:noticeTexts.filter(t=>t.startsWith('⚡')).length,reserve:noticeTexts.filter(t=>t.startsWith('🔋')).length,recovery:noticeTexts.filter(t=>t.startsWith('✅')).length};
  ensure(notices.grid===1&&notices.reserve===1&&notices.recovery===1);
  for(const text of noticeTexts)print(`[SYNTHETIC alert preview]\n${text}`);
  print('5. Reuse cached status without provider refresh or monitor mutation.');
  const stateBefore=values.get('monitor:v1'),providersBefore=requests.auth+requests.station+requests.device;
  await send('/status');ensure(/Cached grid import: 0.05 kW/.test(lastText)&&/at or below 13%/.test(lastText));
  await send('/status brief');ensure(lastText.length<=1000);print(`[SYNTHETIC brief preview]\n${lastText}`);
  ensure(values.get('monitor:v1')===stateBefore&&requests.auth+requests.station+requests.device===providersBefore);
  print('6. Reuse category opt-out and current-code cooldown cleanup before preparing a manual rollback.');
  await send('/grid_recovery off');await send('/reserve off');const optOut=prompts([false,true]);c=await configureGrid(c,optOut.p);env.MONITOR_CONFIG=c;
  const core=JSON.parse(values.get('monitor:v1')!);core.fullArmed=false;core.dischargeArmed=false;core.apiRetryAt=now+3600000;values.set('monitor:v1',JSON.stringify(core));
  const cleanupWrites=monitorWrites.length,cleanupProviders=requests.auth+requests.station+requests.device;now+=3000;await runMonitor(env,deps);
  const cleaned=JSON.parse(values.get('monitor:v1')!);
  const cleanup={monitorWrites:monitorWrites.length-cleanupWrites,providerCalls:requests.auth+requests.station+requests.device-cleanupProviders,
    coreLatchesPreserved:cleaned.fullArmed===false&&cleaned.dischargeArmed===false,gridMetadataAbsent:cleaned.gridImport===undefined,reserveMetadataAbsent:cleaned.reserve===undefined};
  ensure(cleanup.monitorWrites===1&&cleanup.providerCalls===0&&cleanup.coreLatchesPreserved&&cleanup.gridMetadataAbsent&&cleanup.reserveMetadataAbsent);
  // Rehearse only the private in-memory metadata edit, never an actual KV account.
  const rollbackBot=bot(),batteryBefore=rollbackBot.overrides?.dischargeWatts;
  for(const key of ['gridWatts','gridMinutes','gridRecovery','reserve']as const)delete rollbackBot.overrides?.[key];
  values.set('telegram:v1',JSON.stringify(rollbackBot));
  const rollback={unsupportedOverridesAbsent:!Object.keys(bot().overrides??{}).some(k=>['gridWatts','gridMinutes','gridRecovery','reserve'].includes(k)),
    batteryPreferencePreserved:bot().overrides?.dischargeWatts===batteryBefore&&batteryBefore===3000,olderBinaryExecuted:false as const};
  ensure(rollback.unsupportedOverridesAbsent&&rollback.batteryPreferencePreserved&&JSON.stringify(source)===original);
  print('Manual rollback preparation: verify current-code category cleanup first; privately remove only unsupported config/override fields and preserve battery preferences. An older binary was not executed. /settings reset restores all deployment preferences, so use it only when intended.');
  print('Manual release handoff: use private owner secrets and WORKER_CONFIG_JSON only after real source verification and explicit choices. Do not copy a synthetic snapshot. CPU, natural scheduling and owner receipt remain unverified.');
  print('No owner files read or saved, no live provider request, private snapshot upload, deployment, merge or equipment control occurred.');
  print('SYNTHETIC alert release rehearsal complete; all three new policies finish off.');
  return {liveValidated:false as const,setupConfirmed:true,guards:{referenceDeclined:true,allHoursDeclined:true,saveDeclined:true,gridMenuCancelled:true,reserveCancelled:true,incompleteReserveRejected:true,expiredMenuRejected:true,invalidSavedBeforePrompts:true},
    requests,notices,status:{providerRefresh:false,monitorChanged:false},cleanup,rollback,policies:{grid:false,reserve:false,recovery:false},bounds:{maxPending,maxMonitorWrites,maxSends,commands,callbacks}};
}
