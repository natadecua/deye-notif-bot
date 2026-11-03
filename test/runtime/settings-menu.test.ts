import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, Log, LogLevel } from 'miniflare';
import { config, syntheticSecrets } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';

test('workerd settings selection previews then saves kW threshold only on confirmation',async()=>{
  // Synthetic configuration/accounts, local KV and intercepted Telegram only.
  const bundled=await build({entryPoints:[fileURLToPath(new NodeURL('../../src/index.ts',import.meta.url))],bundle:true,
    format:'esm',platform:'browser',target:'es2022',write:false});
  const c=config({telegram:{enabled:true}}),secret='synthetic-webhook-secret-1234567890';
  const messages:{text:string;reply_markup?:{inline_keyboard:{text:string;callback_data:string}[][]}}[]=[];
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,cf:false,
    compatibilityDate:'2026-10-01',kvNamespaces:['STATE'],log:new Log(LogLevel.NONE),
    bindings:{...syntheticSecrets,MONITOR_CONFIG:c,TELEGRAM_WEBHOOK_SECRET:secret,TELEGRAM_OWNER_ID:'789'},
    outboundService:async r=>{assert.equal(new URL(r.url).hostname,'api.telegram.org');
      if(r.url.endsWith('/sendMessage'))messages.push(await r.json() as typeof messages[number]);
      else assert(r.url.endsWith('/answerCallbackQuery'));
      return new LocalResponse(JSON.stringify({ok:true}));}}));
  try{
    const kv=await runtime.getKVNamespace('STATE'),before=JSON.stringify(initialState(c));await kv.put('monitor:v1',before);
    let id=0;
    const send=(input:string,callback=false)=>runtime.dispatchFetch('https://synthetic.invalid/telegram/webhook',{
      method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:++id,
        ...(callback?{callback_query:{id:'synthetic-menu',from:{id:789},data:input,message:{chat:{id:456}}}}:
          {message:{date:Math.floor(Date.now()/1000),from:{id:789},chat:{id:456},text:input}})})});
    await send('/settings');
    const pick=messages.at(-1)!.reply_markup!.inline_keyboard.flat().find(b=>b.text==='0.5 kW')!.callback_data;
    await new Promise(r=>setTimeout(r,2200));await send(pick,true);
    assert.match(messages.at(-1)!.text,/house battery/);
    assert.equal((await kv.get('telegram:v1','json') as {overrides?:unknown}).overrides,undefined);
    const save=messages.at(-1)!.reply_markup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pref:save:'))!.callback_data;
    await new Promise(r=>setTimeout(r,2200));await send(save,true);
    assert.equal((await kv.get('telegram:v1','json') as {overrides:{dischargeWatts:number}}).overrides.dischargeWatts,500);
    assert.equal(await kv.get('monitor:v1'),before);assert.match(messages.at(-1)!.text,/0.5 kW/);
  }finally{await runtime.dispose();}
});
