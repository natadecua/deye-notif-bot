import { SafeError } from './errors.ts';
import { advanceGridImport, type GridMapping, type GridPolicy } from './grid-import.ts';
export type GridImportConfig = GridPolicy & GridMapping & { enabled:true; allHoursConfirmed:true;recovery?:boolean };
export function validateGridConfig(raw:unknown):GridImportConfig|undefined {
  if(raw===undefined)return;
  const p=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:undefined;
  const invalid=()=>{throw new SafeError('grid_config_invalid');};
  if(!p)return invalid();
  if(p.enabled===false&&Object.keys(p).length===1)return;
  if(p.enabled!==true||![8,9].includes(Object.keys(p).length)||Object.keys(p).some(k=>
    !['enabled','thresholdWatts','rearmWatts','minimumMinutes','point','importSign','referenceConfirmed','allHoursConfirmed','recovery'].includes(k))||
    p.recovery!==undefined&&typeof p.recovery!=='boolean'||p.referenceConfirmed!==true||p.allHoursConfirmed!==true||!['TotalGridPower','ExternalCTPowerL1L2'].includes(p.point as string)||
    !['positive','negative'].includes(p.importSign as string))return invalid();
  if(advanceGridImport(p as unknown as GridPolicy,'validate',undefined,undefined,0,
    {maxAgeSeconds:600,maxGapSeconds:900}).status!=='ok')return invalid();
  return {...p} as unknown as GridImportConfig;
}
