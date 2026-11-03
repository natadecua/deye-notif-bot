import { test } from 'node:test';import assert from 'node:assert/strict';
import { build } from 'esbuild';import {fileURLToPath,URL as NodeURL} from 'node:url';
import { decodeGridReading,advanceGridImport,type GridState } from '../src/grid-import.ts';
// Invented synthetic samples/policy/mapping only: NOT verified installation semantics.
const now=1800000000000,policy={thresholdWatts:300,rearmWatts:100,minimumMinutes:5};
const limits={maxAgeSeconds:600,maxGapSeconds:900};
const mapping={point:'TotalGridPower',importSign:'positive',referenceConfirmed:true};
const raw=(value:unknown=500,unit='W')=>({collectionTime:now/1000,dataList:[{key:'TotalGridPower',value,unit}]});
const step=(state:unknown,at=now,watts=500,p=policy)=>advanceGridImport(p,'synthetic-source',state,{at,importWatts:watts},at,limits);
function ok(r:ReturnType<typeof advanceGridImport>){assert.equal(r.status,'ok');return r as Extract<typeof r,{status:'ok'}>;}
test('grid decoding requires confirmed direction, exact point/unit and device timestamp',()=>{
  assert.deepEqual(decodeGridReading(raw(),mapping,now,600),{status:'available',reading:{at:now,importWatts:500}});
  assert.deepEqual(decodeGridReading(raw(-500),{...mapping,importSign:'negative'},now,600),{status:'available',reading:{at:now,importWatts:500}});
  assert.deepEqual(decodeGridReading(raw(-500),mapping,now,600),{status:'available',reading:{at:now,importWatts:0}});
  for(const m of [undefined,{...mapping,referenceConfirmed:false},{...mapping,importSign:'guess'},{...mapping,point:'purchasePower'}])
    assert.equal(decodeGridReading(raw(),m,now,600).status,'unavailable');
});
test('missing and malformed grid values never become zero or borrow battery units/timestamps',()=>{
  for(const value of [null,'',true,'500secret',NaN,Infinity])assert.equal(decodeGridReading(raw(value),mapping,now,600).status,'unavailable');
  assert.equal(decodeGridReading({...raw(),dataList:[{key:'TotalGridPower',unit:'W'}]},mapping,now,600).status,'unavailable');
  assert.equal(decodeGridReading(raw(0),mapping,now,600).status,'available');
  assert.equal(decodeGridReading(raw('500'),mapping,now,600).status,'available');
  for(const value of [raw(500,'kW'),{...raw(),collectionTime:undefined},{...raw(),collectionTime:now},
    {...raw(),dataList:[...raw().dataList,...raw().dataList]}, {lastUpdateTime:new Date(now).toISOString(),purchasePower:500}])
    assert.equal(decodeGridReading(value,mapping,now,600).status,'unavailable');
});
test('device source age is exact, independent and never trusted when future or stale',()=>{
  assert.equal(decodeGridReading(raw(),mapping,now+600000,600).status,'available');
  assert.equal(decodeGridReading(raw(),mapping,now+600001,600).status,'unavailable');
  assert.equal(decodeGridReading(raw(),mapping,now-1,600).status,'unavailable');
});
test('distinct fresh samples spanning the duration produce one candidate at any hour',()=>{
  const a=ok(step(undefined));assert.equal(a.event,undefined);
  const duplicate=ok(step(a.state));assert.equal(duplicate.event,undefined);
  const b=ok(step(duplicate.state,now+300000));assert.equal(b.event?.importWatts,500);
  assert.equal(b.event?.at,now+300000);assert.equal(b.event?.expiresAt,now+900000);
  assert.equal(ok(step(b.state,now+600000)).event,undefined);
  assert.deepEqual(a.state,duplicate.state);
});
test('hysteresis is strict and export/low import can rearm a later episode',()=>{
  let s=ok(step(ok(step(undefined)).state,now+300000)).state;
  s=ok(step(s,now+600000,100)).state;assert.equal(s.armed,false);
  s=ok(step(s,now+900000,0)).state;assert.equal(s.armed,true);
  s=ok(step(s,now+1200000)).state;assert(ok(step(s,now+1500000)).event);
});
test('cloud dips, unavailable data, long gaps and out-of-order samples do not prove sustained import',()=>{
  const first=ok(step(undefined)).state;
  const dip=ok(step(first,now+300000,300)).state;assert.equal(ok(step(dip,now+600000)).event,undefined);
  const missing=ok(advanceGridImport(policy,'synthetic-source',first,undefined,now+300000,limits));
  assert.equal(ok(step(missing.state,now+600000)).event,undefined);
  assert.equal(ok(step(first,now+1200000)).event,undefined);
  const late=ok(advanceGridImport(policy,'synthetic-source',first,{at:now-1,importWatts:500},now+1000,limits));
  assert.equal(late.event,undefined);assert.equal(late.state.lastSampleAt,now);
});
test('policy/source changes restart confirmation, serialization is bounded and input is immutable',()=>{
  const first=ok(step(undefined)).state,before=JSON.stringify(first);
  assert.equal(ok(step(first,now+300000,500,{...policy,minimumMinutes:10})).event,undefined);
  assert.equal(ok(advanceGridImport(policy,'synthetic-other-source',first,{at:now+300000,importWatts:500},now+300000,limits)).event,undefined);
  assert.equal(JSON.stringify(first),before);
  let state:GridState=JSON.parse(before);for(let i=1;i<100;i++)state=ok(step(state,now+i*300000)).state;
  assert(JSON.stringify(state).length<400);
});
test('corrupt companion state and invalid policies/clocks fail with fixed codes',()=>{
  for(const bad of [{},{version:1,secret:'synthetic-private'}, {...ok(step(undefined)).state,highCount:99}]){
    const r=step(bad);assert.equal(r.status,'invalid');assert(!JSON.stringify(r).includes('synthetic-private'));
  }
  for(const p of [{...policy,rearmWatts:300},{...policy,minimumMinutes:0},{...policy,minimumMinutes:1.5}])assert.equal(step(undefined,now,500,p).status,'invalid');
  assert.equal(step(undefined,-1).status,'invalid');
});
test('clock rollback and stale/future readings cannot issue a candidate',()=>{
  const a=ok(step(undefined)).state;
  assert.equal(ok(advanceGridImport(policy,'synthetic-source',a,{at:now,importWatts:500},now-1,limits)).event,undefined);
  for(const at of [now-600001,now+1])assert.equal(ok(advanceGridImport(policy,'synthetic-source',undefined,{at,importWatts:500},now,limits)).event,undefined);
});
test('pure grid foundation is outside the deployed Worker graph',async()=>{
  const r=await build({entryPoints:[fileURLToPath(new NodeURL('../src/index.ts',import.meta.url))],bundle:true,write:false,metafile:true,platform:'browser'});
  assert(!Object.keys(r.metafile!.inputs).some(p=>p.replaceAll('\\','/').endsWith('/grid-import.ts')));
});
test('zero rearm is rejected rather than accepting a policy that cannot rearm at zero import',()=>{
  const r=step(undefined,now,500,{...policy,rearmWatts:0});
  assert.deepEqual(r,{status:'invalid',code:'grid_policy_invalid'});
});
test('malformed persisted policy identities cannot silently reset or bypass rollback protection',()=>{
  const initial=ok(step(undefined)).state;
  for(const identity of ['', 'synthetic-private-identity', '[]',
    JSON.stringify(['synthetic-source',300,100,0]),JSON.stringify(['synthetic-source',300,300,5]),
    ' '+initial.identity,JSON.stringify(['synthetic-source',300,'100',5]),
    JSON.stringify(['synthetic-source',300,100,5,'extra'])]){
    for(const at of [now-1,now+300000]){
      const r=step({...initial,identity},at);
      assert.deepEqual(r,{status:'invalid',code:'grid_state_invalid'});
      assert(!JSON.stringify(r).includes('synthetic-private'));
    }
  }
});
test('latched grid states cannot carry high-import confirmation evidence',()=>{
  const a=ok(step(undefined)).state;
  assert.deepEqual(step({...a,armed:false}),{status:'invalid',code:'grid_state_invalid'});
});
test('candidate expiry cannot exceed the supported clock range',()=>{
  const edge=253402300799999;
  const initial=ok(step(undefined,edge-900000)).state;
  assert.deepEqual(step(initial,edge-1),{status:'invalid',code:'grid_clock_invalid'});
});
test('source keys cannot generate oversized or non-round-trippable identities',()=>{
  for(const source of ['\u0001'.repeat(64),'source\nprivate','source with spaces','x'.repeat(65)]){
    assert.deepEqual(advanceGridImport(policy,source,undefined,{at:now,importWatts:500},now,limits),
      {status:'invalid',code:'grid_policy_invalid'});
  }
  const state=ok(advanceGridImport(policy,'v1:synthetic-source_hash.01',undefined,{at:now,importWatts:500},now,limits)).state;
  assert.equal(ok(advanceGridImport(policy,'v1:synthetic-source_hash.01',JSON.parse(JSON.stringify(state)),
    {at:now+300000,importWatts:500},now+300000,limits)).event?.importWatts,500);
});
