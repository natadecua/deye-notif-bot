import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import {fileURLToPath,URL as NodeURL} from 'node:url';import {Miniflare,convertV4MiniflareOptions,Response as LocalResponse,Log,LogLevel} from 'miniflare';
import {config,syntheticSecrets,tokenFixture} from '../helpers.ts';import {initialState} from '../../src/alerts.ts';
test('workerd caches fresh SOC from a partial poll and serves both status views without refreshing Deye',async()=>{
 // Entirely synthetic configuration, stale cache and partial upstream data.
 const c=config({telegram:{enabled:true}}),secret='synthetic-webhook-secret-1234567890';
 const b=await build({entryPoints:[fileURLToPath(new NodeURL('../../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser'});
 let stations=0;const messages:string[]=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,cf:false,compatibilityDate:'2026-10-01',kvNamespaces:['STATE'],log:new Log(LogLevel.NONE),
 bindings:{...syntheticSecrets,MONITOR_CONFIG:c,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret},outboundService:async r=>{
 let body:unknown;const path=new URL(r.url).pathname;
 if(path.endsWith('/account/token'))body=tokenFixture;
 else if(path.endsWith('/station/latest')){stations++;body={success:true,batterySOC:76,dischargePower:null,batteryPower:-700,lastUpdateTime:new Date().toISOString()};}
 else if(path.endsWith('/sendMessage')){messages.push((await r.json() as {text:string}).text);body={ok:true};}else throw Error('Unexpected synthetic route');
 return new LocalResponse(JSON.stringify(body));}}));
 try{
 const kv=await mf.getKVNamespace('STATE'),old=Date.now()-10800000;
 await kv.put('monitor:v1',JSON.stringify({...initialState(c),latestReading:{at:old,soc:23,dischargeWatts:2275},lastReadingAt:old,fullArmed:false}));
 await new Promise(r=>setTimeout(r,1200));const worker=await mf.getWorker();await worker.scheduled({cron:'*/5 * * * *',scheduledTime:new Date()});await new Promise(r=>setTimeout(r,1200));
 const before=await kv.get('monitor:v1'),state=JSON.parse(before!);assert.equal(state.batteryStatus.soc,76);assert.equal(state.latestReading.soc,23);assert.equal(state.fullArmed,false);assert.equal(messages.length,0);
 for(const [i,text]of ['/status','/status brief'].entries()){
 const r=await mf.dispatchFetch('https://synthetic.invalid/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:i+1,message:{date:Math.floor(Date.now()/1000),from:{id:789},chat:{id:456},text}})});
 assert.equal(r.status,200);assert.match(messages.at(-1)!,/Charge: 76%/);assert.match(messages.at(-1)!,/discharge: unavailable/);assert.doesNotMatch(messages.at(-1)!,/2\.275 kW|Charge: 23%|discharge: 0 kW/);
 assert.equal(await kv.get('monitor:v1'),before);await new Promise(r=>setTimeout(r,2200));
 }
 assert.equal(stations,1);
 }finally{await mf.dispose();}
});
