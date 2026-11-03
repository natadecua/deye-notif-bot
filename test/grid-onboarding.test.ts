import {test} from 'node:test';import assert from 'node:assert/strict';
import {configureGrid} from '../scripts/grid-preferences.ts';import type {PreferencePrompts} from '../scripts/preferences.ts';
import {config} from './helpers.ts';
// Synthetic explicit choices, not owner installation verification.
function prompts(values:unknown[]){const a=[...values],out:string[]=[];let count=0;
  const next=async()=>{count++;assert(a.length);return a.shift() as never;};
  const p:PreferencePrompts={text:next,number:next,choose:next,confirm:next,checklist:next,print:s=>out.push(s)};
  return {p,out,count:()=>count};}
const answers=[true,'TotalGridPower','positive',true,1,0.1,10,true,true];
test('offline grid setup requires entered mapping/reference, independent kW/time, all-hours consent and save',async()=>{
  const c=config(),before=structuredClone(c),h=prompts(answers),result=await configureGrid(c,h.p);
  assert.deepEqual(result.gridImport,{enabled:true,point:'TotalGridPower',importSign:'positive',referenceConfirmed:true,
    thresholdWatts:1000,rearmWatts:100,minimumMinutes:10,allHoursConfirmed:true});
  assert.deepEqual(c,before);assert.match(h.out.join('\n'),/GRID_DEVICE_SN/);assert.match(h.out.join('\n'),/manual/i);
});
test('grid setup cancellation retains previous settings at reference, all-hours or save consent',async()=>{
  const source=config();for(const a of [[...answers.slice(0,3),false],[...answers.slice(0,7),false],
    [...answers.slice(0,8),false],[false,false]]){
    await assert.rejects(configureGrid(source,prompts(a).p),/grid_setup_not_confirmed/);assert.deepEqual(source,config());
  }
});
test('grid setup rejects guessed sign, wrong point, fractional minutes and invalid saved consent',async()=>{
  for(const [i,value]of [[1,'gridPower'],[2,'guess'],[5,0],[6,1.5]] as const){const a:unknown[]=[...answers];a[i]=value;
    await assert.rejects(configureGrid(config(),prompts(a).p),/grid_config_invalid/);}
  const h=prompts([]);await assert.rejects(configureGrid(config({gridImport:{enabled:true,referenceConfirmed:false}} as never),h.p),/grid_config_invalid/);
  assert.equal(h.count(),0);
});
test('grid opt-out removes only grid policy after final local save',async()=>{
  const h=prompts([false,true]),result=await configureGrid(config(),h.p);
  assert.equal(result.gridImport,undefined);assert.equal(h.count(),2);assert.match(h.out.join('\n'),/cleanup.*monitoring.*enabled/i);
});
