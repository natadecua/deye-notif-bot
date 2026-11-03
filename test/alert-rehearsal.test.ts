import {test} from 'node:test';import assert from 'node:assert/strict';
import {runAlertRehearsal} from '../scripts/alert-rehearsal.ts';import {config} from './helpers.ts';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';import {fileURLToPath,URL as NodeURL} from 'node:url';import {spawnSync} from 'node:child_process';
// All source settings, private-file sentinels and services below are synthetic.
test('release rehearsal runs actual grid setup and consent with no source mutation',async()=>{
 const source=config({enabled:false,measurementsConfirmed:false}),before=structuredClone(source),out:string[]=[];
 const result=await runAlertRehearsal(source,s=>out.push(s));
 assert.equal(result.setupConfirmed,true);assert.deepEqual(source,before);assert.equal(result.liveValidated,false);
 assert.match(out.join('\n'),/Zero alone does not verify direction/);assert.match(out.join('\n'),/all hours/i);
 assert.match(out.join('\n'),/GRID_DEVICE_SN/);assert.match(out.join('\n'),/synthetic.*not.*installation evidence/i);
});
test('release rehearsal proves cancellation, original menu expiry and invalid saved consent recovery',async()=>{
 const out:string[]=[],result=await runAlertRehearsal(config(),s=>out.push(s));
 assert.deepEqual(result.guards,{referenceDeclined:true,allHoursDeclined:true,saveDeclined:true,gridMenuCancelled:true,reserveCancelled:true,incompleteReserveRejected:true,expiredMenuRejected:true,invalidSavedBeforePrompts:true});
 assert.match(out.join('\n'),/grid_config_invalid:.*wrangler\.jsonc/);assert.match(out.join('\n'),/Previous in-memory grid policy retained/);
 assert.match(out.join('\n'),/manual.*rollback|rollback.*manual/i);
});
test('release rehearsal delivers synthetic notices, cached status and cleanup within shared resource bounds',async()=>{
 const original=globalThis.fetch,out:string[]=[];globalThis.fetch=async()=>{throw Error('Synthetic forbidden live fetch');};
 try{
 const r=await runAlertRehearsal(config(),s=>out.push(s));
 const requests=r.requests as Record<string,number>;assert.equal(requests.auth,1);assert.equal(requests.station,5);assert.equal(requests.device,5);assert.equal(requests.weather,0);
 assert.deepEqual(r.notices,{grid:1,reserve:1,recovery:1});assert.deepEqual(r.status,{providerRefresh:false,monitorChanged:false});
 assert.deepEqual(r.cleanup,{monitorWrites:1,providerCalls:0,coreLatchesPreserved:true,gridMetadataAbsent:true,reserveMetadataAbsent:true});
 assert.deepEqual(r.policies,{grid:false,reserve:false,recovery:false});
 const bounds=r.bounds as Record<string,number>;assert(bounds.maxPending<=2);assert(bounds.maxMonitorWrites<=2);assert(bounds.maxSends<=2);assert(bounds.commands<48);assert.equal(requests.telegram,bounds.commands+bounds.callbacks+3);
 assert.deepEqual(r.rollback,{unsupportedOverridesAbsent:true,batteryPreferencePreserved:true,olderBinaryExecuted:false});
 const text=out.join('\n');assert.match(text,/Grid electricity use/);assert.match(text,/House battery reserve low/);assert.match(text,/Grid import back below/);
 assert.match(text,/WORKER_CONFIG_JSON/);assert.match(text,/manual.*release/i);assert.match(text,/CPU.*receipt.*unverified/);
 assert.doesNotMatch(text,/synthetic-app-secret|synthetic-password|synthetic-bearer|789|123:synthetic-token|"stationId"|"gridImport"|secret_token|synthetic-device/);
 }finally{globalThis.fetch=original;}
});
test('standalone rehearsal ignores poisoned owner files and environment credentials outside the checkout',()=>{
 const root=resolve(tmpdir()),dir=mkdtempSync(join(root,'deye-alert-rehearsal-'));
 const marker='synthetic-private-poison-marker',files=['.dev.vars','.env','wrangler.jsonc'];for(const f of files)writeFileSync(join(dir,f),marker);
 try{
 const loader=new NodeURL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href;const entry=fileURLToPath(new NodeURL('../scripts/alert-rehearsal-demo.ts',import.meta.url));
 const r=spawnSync(process.execPath,['--import',loader,entry],{cwd:dir,encoding:'utf8',timeout:20000,env:{...process.env,DEYE_APP_SECRET:marker,TELEGRAM_BOT_TOKEN:marker,CLOUDFLARE_API_TOKEN:marker}});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SYNTHETIC ALERT RELEASE REHEARSAL/);assert.match(r.stdout,/No owner files.*no live provider/i);assert(!r.stdout.includes(marker));
 for(const f of files)assert.equal(readFileSync(join(dir,f),'utf8'),marker);
 }finally{assert.equal(dirname(resolve(dir)),root);assert(basename(dir).startsWith('deye-alert-rehearsal-'));rmSync(dir,{recursive:true,force:true});}
});
