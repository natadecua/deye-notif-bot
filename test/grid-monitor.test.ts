import {test} from 'node:test';import assert from 'node:assert/strict';
import {runMonitor} from '../src/monitor.ts';import {validateConfig} from '../src/config.ts';
import {applyTelegramCommand,resolveSettings,settingsOverrides} from '../src/telegram-settings.ts';
import {config,harness,json} from './helpers.ts';
// Invented synthetic source/mapping only, not verified installation semantics.
const policy={enabled:true,thresholdWatts:1000,rearmWatts:100,minimumMinutes:10,
  point:'TotalGridPower',importSign:'positive',referenceConfirmed:true,allHoursConfirmed:true};
function setup(change={}){
  const c=config({daytimeDischarge:{timeZone:'Asia/Manila',startHour:6,endHour:18,minimumMinutes:15},gridImport:{...policy,...change}} as never);
  const h=harness(c),env={...h.env,GRID_DEVICE_SN:'synthetic-inverter'};
  let watts:unknown=1500,unit='W',error=false,lag=0;
  h.hook(url=>{
    if(url.endsWith('/device/latest'))return error?json({secret:'synthetic-private'},503):json({success:true,deviceDataList:[
      {deviceSn:'synthetic-inverter',collectionTime:(h.clock.time-lag)/1000,dataList:[{key:'TotalGridPower',unit,value:watts}]}]});
    return undefined;
  });
  const tick=async(soc=80,battery=0)=>{h.reading(soc,battery);return runMonitor(env,h.deps);};
  const state=()=>JSON.parse(h.kv.data.get('monitor:v1')!);
  return {...h,c,env,tick,state,set:(value:unknown,u='W',age=0)=>{watts=value;unit=u;lag=age;},fail:()=>{error=true;}};
}
test('grid runtime policy requires explicit verified mapping, independent thresholds and all-hours consent',()=>{
  for(const p of [{...policy,referenceConfirmed:false},{...policy,allHoursConfirmed:false},{...policy,rearmWatts:0},
    {...policy,point:'purchasePower'},{...policy,token:'synthetic-private'},{enabled:false,thresholdWatts:1000}]){
    assert.throws(()=>validateConfig(config({gridImport:p} as never)),/^SafeError: grid_config_invalid$/);
  }
});
test('grid warns at night after ten minutes, reuses authentication and remains latched',async()=>{
  const h=setup();await h.tick();h.advance();await h.tick();assert.equal(h.sent.length,0);
  h.advance();await h.tick();assert.equal(h.sent.length,1);assert.match(h.sent[0],/Grid electricity use/);
  assert.match(h.sent[0],/1.5 kW/);assert.match(h.sent[0],/1 kW/);assert.match(h.sent[0],/10 minutes/);
  assert.match(h.sent[0],/EV charging: unknown/);assert.doesNotMatch(h.sent[0],/synthetic|reduce|EV caused|deviceSn/);
  assert.equal(h.calls.filter(x=>x.url.includes('/account/token')).length,1);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,3);
  h.advance();await h.tick();assert.equal(h.sent.length,1);
});
test('missing, stale or wrong-unit grid data suppress only grid while battery alerts continue',async()=>{
  for(const [value,unit,lag]of [[null,'W',0],[1500,'kW',0],[1500,'W',700000]] as const){
    const h=setup();h.set(value,unit,lag);await h.tick(100);
    assert.equal(h.sent.length,1);assert.match(h.sent[0],/House battery full/);
    assert.equal(h.state().apiFailures,0);assert.equal(h.state().fullArmed,false);
  }
});
test('grid-only retry cooldown does not pause station polling or spend two device attempts',async()=>{
  const h=setup();h.fail();await h.tick();
  assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,1);
  assert.equal(h.state().apiFailures,0);h.advance(1000);await h.tick();
  assert.equal(h.calls.filter(x=>x.url.endsWith('/station/latest')).length,2);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,1);
});
test('fresh below-threshold source cancels pending grid delivery without renewing expiry',async()=>{
  const h=setup();await h.tick();h.advance();await h.tick();
  // Telegram transport failure is bounded and leaves the original event queued.
  const fetch=h.deps.fetch;h.deps.fetch=async(url,init)=>String(url).endsWith('/sendMessage')?json({},503):fetch(url,init);
  h.advance();await h.tick();const pending=h.state().pending.find((x:{kind:string})=>x.kind==='grid');assert(pending);
  h.deps.fetch=fetch;h.set(0);h.advance();await h.tick();assert(!h.state().pending.some((x:{kind:string})=>x.kind==='grid'));
  assert.equal(h.sent.length,0);assert(pending.expiresAt>pending.createdAt);
});
test('first checkpoint failure prevents grid delivery and cleanup preserves battery latches',async()=>{
  const h=setup();await h.tick();h.advance();await h.tick();h.advance();
  h.kv.failOnPut=k=>k==='monitor:v1';await assert.rejects(h.tick());assert.equal(h.sent.length,0);
  h.kv.failOnPut=undefined;h.env.MONITOR_CONFIG={...h.c,gridImport:{enabled:false}};
  await h.tick();assert.equal(h.state().gridImport,undefined);assert.equal(h.state().fullArmed,true);
});
test('grid-off and disabled paths add no device call or state writes',async()=>{
  const h=setup({enabled:false}); // canonical off must contain no unused policy fields
  h.env.MONITOR_CONFIG={...h.c,gridImport:{enabled:false}};await h.tick();
  assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,0);
  const n=h.kv.puts.length;h.env.MONITOR_CONFIG={...h.c,gridImport:{enabled:false},enabled:false};await h.tick();assert.equal(h.kv.puts.length,n);
});
test('grid status and threshold commands require verified setup and preserve battery preferences',()=>{
  const h=setup(),before=structuredClone(h.c);
  const changed=applyTelegramCommand(h.c,'/grid_kw 2');assert.equal(changed.changed,true);
  assert.equal(changed.config.gridImport?.enabled&&changed.config.gridImport.thresholdWatts,2000);
  assert.equal(changed.config.dischargeWatts,h.c.dischargeWatts);assert.deepEqual(h.c,before);
  assert.match(changed.reply,/Grid preferences saved: above 2 kW for 10 minutes/);
  const duration=applyTelegramCommand(h.c,'/grid_minutes 15');
  assert.equal(duration.config.gridImport?.enabled&&duration.config.gridImport.minimumMinutes,15);
  assert.match(duration.reply,/Grid preferences saved: above 1 kW for 15 minutes/);
  assert.equal(resolveSettings(h.c,settingsOverrides(changed.config)).gridImport?.enabled&&
    (resolveSettings(h.c,settingsOverrides(changed.config)).gridImport as typeof policy).thresholdWatts,2000);
  assert.equal(applyTelegramCommand(config(),'/grid_kw 1').changed,false);
  assert.match(applyTelegramCommand(config(),'/settings').reply,/Grid-import alerts: off/);
  assert.match(applyTelegramCommand(h.c,'/settings').reply,/above 1 kW for 10 minutes/);
});
test('grid event expires without renewed attempts or re-creation after a long Telegram wait',async()=>{
  const h=setup();await h.tick();h.advance();await h.tick();
  const fetch=h.deps.fetch;h.deps.fetch=async(url,init)=>String(url).endsWith('/sendMessage')?
    json({parameters:{retry_after:3600}},429):fetch(url,init);
  h.advance();await h.tick();assert(!h.state().pending.some((x:{kind:string})=>x.kind==='grid'));
  h.deps.fetch=fetch;h.advance(3600000);await h.tick();assert.equal(h.sent.length,0);
});
test('corrupt grid metadata is retained and cannot silence a full-charge event',async()=>{
  const h=setup();await h.tick();const s=h.state();s.gridImport={secret:'synthetic-private-invalid'};
  h.kv.data.set('monitor:v1',JSON.stringify(s));h.advance();await h.tick(100);
  assert.match(h.sent[0],/House battery full/);assert.deepEqual(h.state().gridImport,s.gridImport);
});
test('corrupt policy identity is not treated as a legitimate source/policy migration',async()=>{
  const h=setup();await h.tick();const s=h.state();s.gridImport.policyKey='synthetic-private-policy';
  h.kv.data.set('monitor:v1',JSON.stringify(s));h.advance();await h.tick(100);
  assert.deepEqual(h.state().gridImport,s.gridImport);assert.match(h.sent[0],/House battery full/);
});
test('grid and full-charge retain two slots and two attempts when three rules qualify together',async()=>{
  const h=setup();h.c.daytimeDischarge={timeZone:'UTC',startHour:6,endHour:18,minimumMinutes:10};
  await h.tick(80,500);h.advance();await h.tick(80,500);h.advance();await h.tick(100,500);
  assert.equal(h.sent.length,2);assert.match(h.sent[0],/Grid electricity use/);assert.match(h.sent[1],/House battery full/);
  for(const put of h.kv.puts.filter(x=>x.key==='monitor:v1'))assert(JSON.parse(put.value).pending.length<=2);
  assert.equal(h.state().dischargeArmed,false);
});
test('disabled grid cleanup during global cooldown preserves original battery state without provider calls',async()=>{
  const h=setup();await h.tick();const s=h.state();s.fullArmed=false;s.apiRetryAt=h.clock.time+3600000;
  h.kv.data.set('monitor:v1',JSON.stringify(s));h.env.MONITOR_CONFIG={...h.c,gridImport:{enabled:false}};
  const calls=h.calls.length,puts=h.kv.puts.length;h.advance(2000);await h.tick();
  assert.equal(h.calls.length,calls);assert.equal(h.kv.puts.length,puts+1);assert.equal(h.state().gridImport,undefined);
  assert.equal(h.state().fullArmed,false);assert.equal(h.state().apiRetryAt,s.apiRetryAt);
});
test('clock rollback plus policy edit preserves the high-water guard and makes no device request',async()=>{
  const h=setup();await h.tick();const prior=h.state().gridImport;
  if(h.c.gridImport?.enabled)h.c.gridImport.thresholdWatts=1100;
  h.advance(-1000);const calls=h.calls.filter(x=>x.url.endsWith('/device/latest')).length;
  await h.tick();assert.equal(h.state().gridImport.tracker.lastObservedAt,prior.tracker.lastObservedAt);
  assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,calls);
});
