import {test} from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {fileURLToPath,URL as NodeURL} from 'node:url';
import {Miniflare,convertV4MiniflareOptions,Response as LocalResponse,Log,LogLevel} from 'miniflare';
import {config,syntheticSecrets,fixture,tokenFixture,BASE_TIME} from '../helpers.ts';
test('workerd schedules all-hours grid warning and cached status without a provider refresh',async()=>{
  // Invented policy/mapping/data and intercepted services only. Test-only clock wrapper.
  const c=config({telegram:{enabled:true},daytimeDischarge:{timeZone:'Asia/Manila',startHour:6,endHour:18,minimumMinutes:15},
    gridImport:{enabled:true,thresholdWatts:1000,rearmWatts:100,minimumMinutes:10,point:'TotalGridPower',
      importSign:'positive',referenceConfirmed:true,allHoursConfirmed:true}});
  const bundle=await build({stdin:{contents:`import w from './src/index.ts';export default {...w,async scheduled(c,e,x){await w.scheduled(c,e,x);globalThis.__gridNow+=300000;}};`,
    resolveDir:fileURLToPath(new NodeURL('../../',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser',
    banner:{js:`globalThis.__gridNow=${BASE_TIME};Date.now=()=>globalThis.__gridNow;`}});
  let stations=0,devices=0;const messages:string[]=[],secret='synthetic-webhook-secret-1234567890';
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,cf:false,
    compatibilityDate:'2026-10-01',kvNamespaces:['STATE'],log:new Log(LogLevel.NONE),
    bindings:{...syntheticSecrets,GRID_DEVICE_SN:'synthetic-inverter',MONITOR_CONFIG:c,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret},
    outboundService:async r=>{
      const path=new URL(r.url).pathname;let body:unknown;
      if(path.endsWith('/account/token'))body=tokenFixture;
      else if(path.endsWith('/station/latest')){body={...fixture,batterySOC:80,dischargePower:0,lastUpdateTime:new Date(BASE_TIME+stations*300000).toISOString()};stations++;}
      else if(path.endsWith('/device/latest')){devices++;body={success:true,deviceDataList:[{deviceSn:'synthetic-inverter',
        collectionTime:(BASE_TIME+(stations-1)*300000)/1000,dataList:[{key:'TotalGridPower',value:'1500',unit:'W'}]}]};}
      else if(path.endsWith('/sendMessage')){messages.push((await r.json() as {text:string}).text);body={ok:true};}
      else throw Error('Unexpected synthetic route');
      return new LocalResponse(JSON.stringify(body));
    }}));
  try{
    const worker=await runtime.getWorker();for(let i=0;i<3;i++){
      await worker.scheduled({cron:'*/5 * * * *',scheduledTime:new Date()});
      await new Promise(r=>setTimeout(r,1200));
    }
    assert.equal(messages.length,1);assert.match(messages[0],/Grid electricity use/);assert.match(messages[0],/1.5 kW/);
    const kv=await runtime.getKVNamespace('STATE'),before=await kv.get('monitor:v1');
    const r=await runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook',{method:'POST',
      headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:1,message:{
        date:(BASE_TIME+900000)/1000,from:{id:789},chat:{id:456},text:'/status'}})});
    assert.equal(r.status,200);assert.equal(messages.length,2);assert.match(messages[1],/Cached grid import: 1.5 kW/);
    assert.equal(stations,3);assert.equal(devices,3);assert.equal(await kv.get('monitor:v1'),before);
  }finally{await runtime.dispose();}
});
