import {test} from 'node:test';import assert from 'node:assert/strict';
import {initialState,transition} from '../src/alerts.ts';import {config,BASE_TIME} from './helpers.ts';
// Synthetic pending notices only; no installation data.
test('battery admission keeps a grid recovery ahead of lower-priority health within two slots',()=>{
 const c=config(),s=initialState(c);s.pending=[
 {kind:'grid_recovered',id:`grid_recovered:${BASE_TIME}`,qualifiedAt:BASE_TIME,createdAt:BASE_TIME,expiresAt:BASE_TIME+600000,
 sourceKey:'a'.repeat(64),policyKey:'synthetic',reading:{at:BASE_TIME,importWatts:0},attempts:0,nextAttemptAt:BASE_TIME},
 {kind:'health',id:'synthetic',createdAt:BASE_TIME,nextAttemptAt:BASE_TIME,attempts:0,
 notice:{kind:'stale',policy:'synthetic',episodeAt:BASE_TIME,qualifiedAt:BASE_TIME}}];
 transition(s,{at:BASE_TIME,soc:100,dischargeWatts:0},c,BASE_TIME);
 assert.deepEqual(s.pending.map(a=>a.kind),['full','grid_recovered']);
});
