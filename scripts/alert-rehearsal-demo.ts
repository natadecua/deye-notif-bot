import {readFile} from 'node:fs/promises';
import {URL as NodeURL} from 'node:url';
import {runAlertRehearsal} from './alert-rehearsal.ts';
import {errorCode} from '../src/errors.ts';
try{
 // Public template only. Never import the owner-file/live-transport CLI adapter.
 const template=JSON.parse(await readFile(new NodeURL('../wrangler.example.jsonc',import.meta.url),'utf8'));
 await runAlertRehearsal(template.vars.MONITOR_CONFIG,s=>console.log(s));
}catch(error){console.error(`Synthetic alert rehearsal failed: ${errorCode(error)}`);process.exitCode=1;}
