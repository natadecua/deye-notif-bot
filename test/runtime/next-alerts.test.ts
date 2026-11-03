import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import {fileURLToPath,URL as NodeURL} from 'node:url';
import {Miniflare,convertV4MiniflareOptions,Response as LocalResponse,Log,LogLevel} from 'miniflare';
import {config,syntheticSecrets,fixture,tokenFixture,BASE_TIME} from '../helpers.ts';
test('workerd confirms grid and reserve UI then schedules independent warning and recovery notices',async()=>{
 // Synthetic verified mapping/policy and intercepted services; no owner configuration.
 const c=config({telegram:{enabled:true},gridImport:{enabled:true,thresholdWatts:1000,rearmWatts:100,minimumMinutes:10,
  point:'TotalGridPower',importSign:'positive',referenceConfirmed:true,allHoursConfirmed:true,recovery:true}});
 const b=await build({stdin:{contents:`import w from './src/index.ts';export default {...w,async fetch(r,e,x){const v=await w.fetch(r,e,x);globalThis.__nextNow+=3000;return v;},async scheduled(c,e,x){await w.scheduled(c,e,x);globalThis.__nextNow+=300000;}};`,resolveDir:fileURLToPath(new NodeURL('../../',import.meta.url))},
 bundle:true,write:false,format:'esm',platform:'browser',banner:{js:`globalThis.__nextNow=${BASE_TIME};Date.now=()=>globalThis.__nextNow;`}});
 let at=BASE_TIME,stations=0,devices=0,update=0;const bodies:{text:string;reply_markup?:{inline_keyboard:{callback_data:string}[][]}}[]=[];
 const secret='synthetic-webhook-secret-1234567890';
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,cf:false,compatibilityDate:'2026-10-01',kvNamespaces:['STATE'],log:new Log(LogLevel.NONE),
 bindings:{...syntheticSecrets,GRID_DEVICE_SN:'synthetic-device',MONITOR_CONFIG:c,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret},
 outboundService:async r=>{let body:unknown;const path=new URL(r.url).pathname;
 if(path.endsWith('/account/token'))body=tokenFixture;
 else if(path.endsWith('/station/latest')){stations++;body={...fixture,batterySOC:13,dischargePower:0,lastUpdateTime:new Date(at).toISOString()};}
 else if(path.endsWith('/device/latest')){devices++;body={success:true,deviceDataList:[{deviceSn:'synthetic-device',collectionTime:at/1000,dataList:[{key:'TotalGridPower',unit:'W',value:stations<=3?2500:50}]}]};}
 else if(path.endsWith('/sendMessage')){bodies.push(await r.json() as never);body={ok:true};}
 else if(path.endsWith('/answerCallbackQuery'))body={ok:true};else throw Error('Unexpected synthetic route');
 return new LocalResponse(JSON.stringify(body));}}));
 const pause=()=>new Promise(r=>setTimeout(r,1200));
 const send=async(text:string,callback=false)=>{const response=await mf.dispatchFetch('https://synthetic.invalid/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},
 body:JSON.stringify({update_id:++update,...(callback?{callback_query:{id:'synthetic',from:{id:789},data:text,message:{chat:{id:456}}}}:
 {message:{from:{id:789},chat:{id:456},date:Math.floor(at/1000),text}})})});assert.equal(response.status,200);at+=3000;await pause();};
 const button=(prefix:string)=>{const x=bodies.at(-1)?.reply_markup?.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));assert(x,prefix);return x.callback_data;};
 try{
 await send('/grid');await send(button('grid:pick:k:2000:'),true);await send(button('grid:save:k:2000:'),true);
 await send('/reserve_set 13 15 5');await send(button('rs:save:'),true);
 const kv=await mf.getKVNamespace('STATE'),saved=JSON.parse((await kv.get('telegram:v1'))!);assert.equal(saved.overrides.gridWatts,2000);assert.equal(saved.overrides.reserve.warnSoc,13);
 const worker=await mf.getWorker();for(let i=0;i<5;i++){await worker.scheduled({cron:'*/5 * * * *',scheduledTime:new Date()});at+=300000;await pause();}
 assert.equal(bodies.filter(x=>x.text.startsWith('🔋 House battery reserve low')).length,1);
 assert.equal(bodies.filter(x=>x.text.startsWith('⚡ Grid electricity use')).length,1);
 assert.equal(bodies.filter(x=>x.text.startsWith('✅ Grid import back below')).length,1);
 const before=await kv.get('monitor:v1');await send('/status');assert.match(bodies.at(-1)!.text,/Cached grid import: 0.05 kW/);assert.match(bodies.at(-1)!.text,/at or below 13%/);
 assert.equal(stations,5);assert.equal(devices,5);assert.equal(await kv.get('monitor:v1'),before);
 }finally{await mf.dispose();}
});
