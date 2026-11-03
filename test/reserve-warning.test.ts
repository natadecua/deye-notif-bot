import {test} from 'node:test';import assert from 'node:assert/strict';
import {config,harness,json} from './helpers.ts';import {runMonitor} from '../src/monitor.ts';import {validateConfig} from '../src/config.ts';
// Synthetic reserve choices, not owner consent or an overnight energy forecast.
const reserve={enabled:true,warnSoc:13,rearmSoc:15,minimumMinutes:5,allHoursConfirmed:true};
function setup(extra={}){const c=config({reserve:{...reserve,...extra}} as never),h=harness(c);
 return {...h,c,tick:async(soc=13)=>{h.reading(soc,0);return runMonitor(h.env,h.deps);},state:()=>JSON.parse(h.kv.data.get('monitor:v1')!)};}
test('reserve policy is explicit, default-off and rejects missing consent or unsafe hysteresis',()=>{
 for(const p of [{...reserve,allHoursConfirmed:false},{...reserve,rearmSoc:13},{...reserve,warnSoc:0},{...reserve,minimumMinutes:0},{...reserve,secret:'synthetic'}])assert.throws(()=>validateConfig(config({reserve:p} as never)),/reserve_config_invalid/);
});
test('reserve warns at the chosen SOC after distinct fresh samples and remains latched until recovery',async()=>{
 const h=setup();await h.tick();assert.equal(h.sent.length,0);h.advance();await h.tick();assert.equal(h.sent.length,1);
 assert.match(h.sent[0],/House battery reserve low/);assert.match(h.sent[0],/13%/);assert.match(h.sent[0],/not an overnight/);assert.doesNotMatch(h.sent[0],/EV caused|pause.*EV|enough.*night/i);
 h.advance();await h.tick();assert.equal(h.sent.length,1);h.advance();await h.tick(16);h.advance();await h.tick();h.advance();await h.tick();assert.equal(h.sent.length,2);
});
test('reserve unknown/stale samples break confirmation, preserving battery cycles and two-slot capacity',async()=>{
 const h=setup();await h.tick();h.advance();h.reading(13,0,h.clock.time-700000);await runMonitor(h.env,h.deps);
 h.advance();await h.tick();assert.equal(h.sent.length,0);h.advance();await h.tick();assert.equal(h.sent.length,1);
 for(const p of h.kv.puts.filter(p=>p.key==='monitor:v1'))assert(JSON.parse(p.value).pending.length<=2);
 assert.equal(h.state().fullArmed,true);assert.equal(h.calls.filter(x=>x.url.endsWith('/device/latest')).length,0);
});
test('reserve default-off and opt-out cleanup preserve core battery latches during cooldown',async()=>{
 const h=setup();await h.tick();const s=h.state();s.fullArmed=false;s.apiRetryAt=h.clock.time+3600000;h.kv.data.set('monitor:v1',JSON.stringify(s));
 delete (h.c as unknown as {reserve?:unknown}).reserve;const calls=h.calls.length;h.advance(2000);await h.tick();assert.equal(h.calls.length,calls);assert.equal(h.state().reserve,undefined);assert.equal(h.state().fullArmed,false);
});

test('reserve retry keeps original identity and expiry while refreshing source readings across restart',async()=>{
 const h=setup();await h.tick();h.advance();h.hook(url=>url.endsWith('/sendMessage')?json({},503):undefined);await h.tick();
 const first=h.state().pending.find((a:{kind:string})=>a.kind==='reserve');assert(first);
 const paused=h.state();paused.pending[0].nextAttemptAt=first.createdAt+540000;h.kv.data.set('monitor:v1',JSON.stringify(paused));
 h.advance();await h.tick();const second=h.state().pending.find((a:{kind:string})=>a.kind==='reserve');assert(second);
 assert.equal(second.id,first.id);assert.equal(second.expiresAt,first.expiresAt);
 h.advance(1000);h.hook(undefined);const raw=h.state();raw.pending[0].nextAttemptAt=h.clock.time;h.kv.data.set('monitor:v1',JSON.stringify(raw));
 await h.tick();assert.equal(h.sent.length,1);assert.equal(h.state().pending.length,0);
});

test('duplicate reserve readings cannot confirm and clock rollback survives policy changes',async()=>{
 const h=setup();await h.tick();h.advance();h.reading(13,0,h.clock.time-300000);await runMonitor(h.env,h.deps);assert.equal(h.sent.length,0);
 const before=h.state().reserve;h.c.reserve={...reserve,warnSoc:12} as never;h.advance(-301000);await h.tick(12);
 assert.equal(h.state().reserve.lastObservedAt,before.lastObservedAt);assert.equal(h.sent.length,0);
});
test('corrupt optional reserve metadata is retained without blocking full-charge delivery',async()=>{
 const h=setup();await h.tick();const s=h.state();s.reserve={secret:'synthetic-private'};h.kv.data.set('monitor:v1',JSON.stringify(s));
 h.advance();await h.tick(100);assert.match(h.sent[0],/House battery full/);assert.deepEqual(h.state().reserve,s.reserve);
});
test('reserve first checkpoint failure prevents send and long Retry-After cannot renew its original event',async()=>{
 const h=setup();await h.tick();h.advance();h.kv.failOnPut=k=>k==='monitor:v1';await assert.rejects(h.tick());assert.equal(h.sent.length,0);
 h.kv.failOnPut=undefined;h.hook(url=>url.endsWith('/sendMessage')?json({parameters:{retry_after:3600}},429):undefined);await h.tick();
 assert.equal(h.state().pending.length,0);h.hook(undefined);h.advance(3600000);await h.tick();assert.equal(h.sent.length,0);
});
