import {test} from 'node:test';import assert from 'node:assert/strict';
import {handleTelegramRequest} from '../src/bot.ts';import {runMonitor} from '../src/monitor.ts';
import {config,harness,json} from './helpers.ts';
// Invented verified mapping and owner identities; all services intercepted.
const policy={enabled:true as const,thresholdWatts:1000,rearmWatts:100,minimumMinutes:10,
  point:'TotalGridPower' as const,importSign:'positive' as const,referenceConfirmed:true as const,allHoursConfirmed:true as const};
function setup(recovery=false){
  const c=config({telegram:{enabled:true},gridImport:{...policy,...(recovery?{recovery:true}:{})}}),h=harness(c);
  const secret='synthetic-webhook-secret-1234567890',env={...h.env,GRID_DEVICE_SN:'synthetic-device',TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret};
  let id=0,watts=1500;
  h.hook(url=>url.endsWith('/answerCallbackQuery')?json({ok:true}):url.endsWith('/device/latest')?
    json({success:true,deviceDataList:[{deviceSn:'synthetic-device',collectionTime:h.clock.time/1000,dataList:[{key:'TotalGridPower',unit:'W',value:watts}]}]}):undefined);
  const send=(text:string,callback=false,owner=789)=>handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:++id,
      ...(callback?{callback_query:{id:'synthetic',from:{id:owner},data:text,message:{chat:{id:456}}}}:
      {message:{from:{id:owner},chat:{id:456},date:Math.floor(h.clock.time/1000),text}})})}),env,h.deps);
  const buttons=()=>JSON.parse(String(h.calls.filter(x=>x.url.endsWith('/sendMessage')).at(-1)!.init!.body)).reply_markup?.inline_keyboard?.flat()??[];
  const find=(part:string)=>{const b=buttons().find((b:{callback_data:string})=>b.callback_data.startsWith(part));assert(b,part);return b.callback_data;};
  const tick=async()=>{h.reading(80,0);return runMonitor(env,h.deps);};
  return {...h,c,env,send,buttons,find,tick,set:(n:number)=>{watts=n;},bot:()=>JSON.parse(h.kv.data.get('telegram:v1')!)};
}
test('grid menu previews threshold, duration and recovery changes before explicit save',async()=>{
  for(const [key,value,field]of [['k',2000,'gridWatts'],['m',15,'gridMinutes'],['r',1,'gridRecovery']]as const){
    const h=setup();await h.send('/grid');const pick=h.find(`grid:pick:${key}:${value}:`);
    assert(h.buttons().every((b:{callback_data:string})=>Buffer.byteLength(b.callback_data)<=64));
    h.advance(2000);await h.send(pick,true);assert.equal(h.bot().overrides,undefined);
    h.advance(2000);await h.send(h.find(`grid:save:${key}:${value}:`),true);
    assert.equal(h.bot().overrides[field],key==='r'?true:value);
    if(key==='r')assert.match(h.sent.at(-1)!,/Recovery notice: on/);
    assert.equal(h.kv.puts.filter(p=>p.key==='monitor:v1').length,0);
    assert(!h.calls.some(x=>x.url.includes('deyecloud')));
  }
});
test('grid menu authorization, cancellation, original expiry and changed policy are enforced',async()=>{
  const h=setup();await h.send('/grid');const pick=h.find('grid:pick:k:2000:');
  h.advance(2000);const writes=h.kv.puts.length;assert.equal((await h.send(pick,true,999)).status,403);assert.equal(h.kv.puts.length,writes);
  await h.send(pick,true);const save=h.find('grid:save:k:2000:');h.advance(2000);await h.send(h.find('grid:cancel:k:2000:'),true);assert.equal(h.bot().overrides,undefined);
  h.advance(1800000);await h.send(save,true);assert.match(h.sent.at(-1)!,/expired|changed/i);
  const j=setup();await j.send('/grid');const old=j.find('grid:pick:k:2000:');j.advance(2000);await j.send('/grid_minutes 15');j.advance(2000);await j.send(old,true);assert.match(j.sent.at(-1)!,/expired|changed/i);
});
test('unverified grid menu cannot enable a source or create grid overrides',async()=>{
  const h=setup();delete h.c.gridImport;await h.send('/grid');assert.match(h.sent.at(-1)!,/off|unverified/i);assert.equal(h.buttons().length,0);assert.equal(h.bot().overrides,undefined);
});
test('opt-in grid recovery follows an accepted warning and two distinct low samples across five minutes',async()=>{
  const h=setup(true);await h.tick();h.advance();await h.tick();h.advance();await h.tick();assert.equal(h.sent.length,1);
  h.set(50);h.advance();await h.tick();assert.equal(h.sent.length,1);
  h.advance();await h.tick();assert.equal(h.sent.length,2);assert.match(h.sent[1],/Grid import back below/);assert.match(h.sent[1],/0.05 kW/);assert.doesNotMatch(h.sent[1],/^Grid outage|^EV stopped|^Grid import stopped/im);
  h.advance();await h.tick();assert.equal(h.sent.length,2);
});
test('grid recovery is default-off and is never announced without an accepted warning',async()=>{
  for(const recovery of [false,true]){const h=setup(recovery);h.set(0);for(let i=0;i<4;i++){await h.tick();h.advance();}assert.equal(h.sent.length,0);}
  const h=setup();for(let i=0;i<3;i++){await h.tick();h.advance();}h.set(0);await h.tick();h.advance();await h.tick();assert.equal(h.sent.length,1);
});

test('a failed grid warning never authorizes a recovery notice and missing data is never zero',async()=>{
 const h=setup(true);await h.tick();h.advance();await h.tick();
 const fetch=h.deps.fetch;h.deps.fetch=async(url,init)=>String(url).endsWith('/sendMessage')?json({},400):fetch(url,init);
 h.advance();await h.tick();h.deps.fetch=fetch;h.set(0);h.advance();await h.tick();h.advance();await h.tick();assert.equal(h.sent.length,0);
 const j=setup(true);for(let i=0;i<3;i++){await j.tick();j.advance();}j.set(0);await j.tick();j.advance();
 const jfetch=j.deps.fetch;j.deps.fetch=async(url,init)=>String(url).endsWith('/device/latest')?json({success:true,deviceDataList:[]}):jfetch(url,init);
 await j.tick();assert.equal(j.sent.length,1);
});
test('turning recovery off removes its pending notice and cannot enable an unverified grid source',async()=>{
 const h=setup(true);for(let i=0;i<3;i++){await h.tick();h.advance();}h.set(0);await h.tick();h.advance();
 const fetch=h.deps.fetch;h.deps.fetch=async(url,init)=>String(url).endsWith('/sendMessage')?json({},503):fetch(url,init);await h.tick();
 assert(JSON.parse(h.kv.data.get('monitor:v1')!).pending.some((a:{kind:string})=>a.kind==='grid_recovered'));
 h.deps.fetch=fetch;h.advance(2000);await h.send('/grid_recovery off');h.advance();await h.tick();
 assert(!JSON.parse(h.kv.data.get('monitor:v1')!).pending.some((a:{kind:string})=>a.kind==='grid_recovered'));
 assert.equal(h.sent.filter(t=>t.startsWith('✅')).length,0);
});
