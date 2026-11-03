import type {Config,PendingAlert,State} from './types.ts';
import {settleHealth} from './health-outbox.ts';
const priority:Record<PendingAlert['kind'],number>={grid:6,reserve:5,full:4,discharge:3,grid_recovered:2,health:1,recap:0};
export function admitAlert(s:State,c:Config,a:PendingAlert,now:number):void {
 const all=[...s.pending,a].sort((x,y)=>priority[y.kind]-priority[x.kind]);
 for(const dropped of all.slice(2))if(dropped.kind==='health')settleHealth(s,c,dropped,'abandoned',now);
 s.pending=all.slice(0,2);
}
