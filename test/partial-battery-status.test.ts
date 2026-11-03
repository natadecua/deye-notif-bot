import {test} from 'node:test';import assert from 'node:assert/strict';
import {runMonitor} from '../src/monitor.ts';import {handleTelegramRequest} from '../src/bot.ts';
import {renderBriefSnapshot} from '../src/snapshot.ts';import {config,harness,json} from './helpers.ts';
import {normalizeReading} from '../src/reading.ts';
// Synthetic station values/identities and intercepted services; no owner credentials.
function setup(extra={}){
 const c=config({telegram:{enabled:true},...extra}),h=harness(c),secret='synthetic-webhook-secret-1234567890';
 const env={...h.env,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret};
 const partial=(soc:unknown=76,power:unknown=null,at=h.clock.time)=>h.hook(url=>url.endsWith('/station/latest')?json({success:true,batterySOC:soc,dischargePower:power,lastUpdateTime:new Date(at).toISOString(),batteryPower:-700}):undefined);
 const state=()=>JSON.parse(h.kv.data.get('monitor:v1')!);
 const status=(brief=false)=>handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:1,message:{from:{id:789},chat:{id:456},date:Math.floor(h.clock.time/1000),text:brief?'/status brief':'/status'}})}),env,h.deps);
 return {...h,c,env,partial,state,status,tick:()=>runMonitor(env,h.deps)};
}
test('fresh SOC is displayed while missing discharge stays unavailable and the last complete reading is preserved',async()=>{
 const h=setup();h.reading(23,2275);await h.tick();const old=h.state().latestReading;h.advance(3*3600000);h.partial();await h.tick();
 const s=h.state();assert.deepEqual(s.latestReading,old);assert.equal(s.batteryStatus.soc,76);assert.equal(s.batteryStatus.dischargeWatts,undefined);
 assert.equal(h.sent.length,0);await h.status();const text=h.sent.at(-1)!;
 assert.match(text,/Charge: 76%/);assert.match(text,/Battery discharge: unavailable/);assert.match(text,/within the configured freshness limit/);
 assert.match(text,/discharge.*unavailable|unavailable.*discharge/i);assert.doesNotMatch(text,/2\.275 kW|Charge: 23%|Battery discharge: 0 kW/);
 const brief=renderBriefSnapshot(s,h.c,h.clock.time);assert.match(brief,/Charge: 76%/);assert.match(brief,/discharge: unavailable/);assert(brief.length<=1000);
});
test('partial samples cannot trigger battery alerts or carry a discharge confirmation across the gap',async()=>{
 const h=setup();h.reading(80,500);await h.tick();h.advance();h.partial(100);await h.tick();assert.equal(h.sent.length,0);assert.equal(h.state().highCount,0);assert.equal(h.state().fullArmed,true);
 h.advance();h.hook(undefined);h.reading(80,500);await h.tick();assert.equal(h.sent.length,0);h.advance();h.reading(80,500);await h.tick();assert.equal(h.sent.length,1);
});
test('invalid SOC is unavailable independently and a genuine numeric zero remains a measured zero',async()=>{
 const h=setup();h.partial(null,0);await h.tick();await h.status();assert.match(h.sent.at(-1)!,/Charge: unavailable/);assert.match(h.sent.at(-1)!,/Battery discharge: 0 kW/);
 assert.doesNotMatch(h.sent.at(-1)!,/Charge: 0%/);assert.equal(h.state().latestReading,undefined);
});
test('missing, null, string, negative and nonfinite power never becomes zero or a signed-field substitute',async()=>{
 for(const power of [null,'0','500',-1,Infinity]){
  const h=setup();h.partial(60,power);await h.tick();const text=renderBriefSnapshot(h.state(),h.c,h.clock.time);
  assert.match(text,/Charge: 60%/);assert.match(text,/discharge: unavailable/);assert.doesNotMatch(text,/0\.7 kW/);
 }
 assert.throws(()=>normalizeReading({batterySOC:60,dischargePower:null,lastUpdateTime:new Date(Date.now()).toISOString()},config(),Date.now()),/measurement_missing_or_invalid/);
});
test('stale, future and out-of-order source values cannot replace a newer partial view or trigger old advice',async()=>{
 const h=setup();h.partial(60);await h.tick();const at=h.clock.time;h.advance();h.partial(100,1000,at-1000);await h.tick();
 assert.equal(h.sent.length,0);assert.equal(h.state().latestReading,undefined);assert.equal(h.state().batteryStatus.soc,60);
 h.advance();h.partial(70,null,h.clock.time+1);await h.tick();assert.equal(h.state().batteryStatus.soc,60);
 h.advance();h.partial(80,null,h.clock.time-700000);await h.tick();assert.equal(h.state().batteryStatus.soc,60);
 const text=renderBriefSnapshot(h.state(),h.c,h.clock.time);assert.match(text,/stale/);
});
test('cached status makes no provider request or monitor write, and invalid optional cache cannot break battery state',async()=>{
 const h=setup();h.partial(70);await h.tick();const raw=h.kv.data.get('monitor:v1'),calls=h.calls.length,writes=h.kv.puts.filter(p=>p.key==='monitor:v1').length;
 await h.status(true);assert.equal(h.calls.length,calls+1);assert.equal(h.kv.puts.filter(p=>p.key==='monitor:v1').length,writes);assert.equal(h.kv.data.get('monitor:v1'),raw);
 const j=setup();j.reading(50,100);await j.tick();const s=j.state();s.batteryStatus={version:1,at:j.clock.time,soc:99,secret:'synthetic-private'};j.kv.data.set('monitor:v1',JSON.stringify(s));
 const text=renderBriefSnapshot(j.state(),j.c,j.clock.time);assert.match(text,/Charge: 50%/);assert.doesNotMatch(text,/synthetic-private|99%/);
});

test('W/kW conversion, all-unavailable data, complete recovery and cached SOC freshness stay independent',async()=>{
 const h=setup({powerUnit:'kW'});h.partial(null,0.472);await h.tick();assert.match(renderBriefSnapshot(h.state(),h.c,h.clock.time),/Battery discharge: 0.472 kW/);
 h.advance();h.partial(null,null);await h.tick();let text=renderBriefSnapshot(h.state(),h.c,h.clock.time);assert.match(text,/Charge: unavailable/);assert.match(text,/discharge: unavailable/);
 h.advance();h.hook(undefined);h.reading(80,0.5);await h.tick();text=renderBriefSnapshot(h.state(),h.c,h.clock.time);assert.match(text,/Charge: 80%/);assert.match(text,/0.5 kW/);
 const j=setup();j.partial(75);await j.tick();const raw=j.kv.data.get('monitor:v1');j.advance(600001);await j.status(true);assert.match(j.sent.at(-1)!,/stale/);assert.equal(j.kv.data.get('monitor:v1'),raw);
});
