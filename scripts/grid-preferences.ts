import type {Config} from '../src/types.ts';import type {PreferencePrompts} from './preferences.ts';
import {validateConfig} from '../src/config.ts';import {validateGridConfig} from '../src/grid-config.ts';
import {gridStatus} from '../src/grid-runtime.ts';import {SafeError} from '../src/errors.ts';
export async function configureGrid(source:Config,p:PreferencePrompts):Promise<Config>{
  const c=structuredClone(validateConfig(source));
  p.print('Grid import is separate from battery discharge. No EV causation or overnight permission is inferred. This offline flow makes no provider call or deployment.');
  if(await p.confirm('Enable independent all-hours grid-import warnings?',false)){
    const point=await p.text('Verified W point: TotalGridPower or ExternalCTPowerL1L2 (enter explicitly):',undefined,
      s=>['TotalGridPower','ExternalCTPowerL1L2'].includes(s)||'Enter the independently verified point.');
    const importSign=await p.text('Verified import sign: type positive or negative:',undefined,
      s=>['positive','negative'].includes(s)||'Enter the independently verified direction.');
    if(!['TotalGridPower','ExternalCTPowerL1L2'].includes(point)||!['positive','negative'].includes(importSign))throw new SafeError('grid_config_invalid');
    if(!await p.confirm('I independently verified W units, device timestamp, import/export direction and installation metering scope against reference observations. Zero alone does not verify direction.',false))throw new SafeError('grid_setup_not_confirmed');
    const kw=(n:number)=>Number.isFinite(n)&&n>0&&Math.round(n*1000)/1000===n;
    const threshold=await p.number('Grid import threshold (kW, explicitly entered):',undefined,n=>kw(n)||'Enter positive kW with up to three decimals.');
    const rearm=await p.number('Re-arm strictly below (kW, positive and below threshold):',undefined,n=>kw(n)&&n<threshold||'Enter a positive lower kW value.');
    const minutes=await p.number('Sustained grid import duration (whole minutes 1–120):',undefined,n=>Number.isInteger(n)&&n>=1&&n<=120||'Enter whole minutes from 1 to 120.');
    if(!kw(threshold)||!kw(rearm))throw new SafeError('grid_config_invalid');
    const candidate=validateGridConfig({enabled:true,point,importSign,referenceConfirmed:true,
      thresholdWatts:Math.round(threshold*1000),rearmWatts:Math.round(rearm*1000),minimumMinutes:minutes,allHoursConfirmed:true})!;
    if(!await p.confirm('I accept grid-import warnings at all hours, including at night. This does not authorize overnight EV charging.',false))throw new SafeError('grid_setup_not_confirmed');
    c.gridImport=candidate;
    p.print('Set GRID_DEVICE_SN privately in ignored .dev.vars for the verified device; never place device identifiers in public configuration or chat. Setup consent does not itself verify the sensor.');
  }else{
    delete c.gridImport;
    p.print('Grid-only cleanup requires deployment with monitoring enabled. Verify cleanup privately before older-version rollback; preserve battery, health and recap state.');
  }
  validateConfig(c);p.print(gridStatus(c,undefined,0));
  p.print('Apply manually with npm run secrets:upload and npm run deploy, or update the private CI snapshot before the manual workflow. CPU, natural scheduling and receipt need separate validation.');
  if(!await p.confirm('Save these grid preferences locally? Deployment remains manual.',false))throw new SafeError('grid_setup_not_confirmed');
  return c;
}
