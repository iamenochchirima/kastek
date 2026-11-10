import * as restate from '@restatedev/restate-sdk';
import { restateServiceName } from '../../contracts/restate-names';
import type { Pool } from 'pg';
import { AutomationService,type AutomationConfig } from './automations';
export const AUTOMATION_WORKFLOW='AgentsAutomationV1';
export function nextOccurrence(c:AutomationConfig&{activatedAt?:number},now:number):number|null {
 const s=c.schedule;if(s.kind==='event')return null;
 const anchor=Date.parse(s.kind==='once'?s.at:s.anchor);
 if(s.kind==='once')return anchor<(c.activatedAt??-Infinity)?null:anchor;
 const interval=s.everySeconds*1000;
 const latest=anchor>now?anchor:anchor+Math.floor((now-anchor)/interval)*interval;
 const first=c.activatedAt===undefined?anchor:anchor+Math.max(0,Math.ceil((c.activatedAt-anchor)/interval))*interval;
 return Math.max(first,latest);
}
export function createAutomationWorkflow(service:AutomationService) {
 return restate.workflow({name:restateServiceName(AUTOMATION_WORKFLOW),handlers:{run:async(ctx:restate.WorkflowContext,input:{id:string;revision:number})=>{
  // A unique durable workflow per immutable revision; database fences superseded revisions.
  let cursor=-1;
  for(let tick=0;tick<44_000;tick++) {
   const snapshot=await ctx.run(`configuration:${tick}`,()=>service.timerSnapshot(input.id,input.revision));if(!snapshot)return;
   const now=await ctx.date.now(),candidate=nextOccurrence(snapshot,snapshot.activatedAt);if(candidate===null)return;
   let at=candidate;
   if(snapshot.schedule.kind==='interval'&&cursor>=0)at=cursor+snapshot.schedule.everySeconds*1000;
   if(at>=Date.parse(snapshot.expiresAt))return;
   if(at>now)await ctx.sleep(at-now);
   const result=await ctx.run(`occurrence:${tick}`,async()=>{
    // Coalesce elapsed fixed intervals after downtime to the latest eligible instant.
    const current=await service.timerSnapshot(input.id,input.revision);if(!current)return null;
    const eligible=nextOccurrence(current,Date.now())!;
    const effective=Math.max(at,eligible);
    if(effective>=Date.parse(current.expiresAt))return null;
    try {await service.occur(input.id,input.revision,`schedule:${input.revision}:${effective}`,new Date(effective),undefined,undefined,at);return effective;}
    catch(error){if((error as {code?:string}).code==='AUTOMATION_AUTHORITY_DENIED'||(error as {code?:string}).code==='AUTOMATION_ACCESS_DENIED')return null;throw error;}
   });
   if(result===null||snapshot.schedule.kind==='once')return;cursor=result;
  }
 }}});
}
export async function dispatchAutomationTimersOnce(pool:Pool,ingressUrl:string,request:typeof fetch=fetch):Promise<void> {
 const rows=(await pool.query(`SELECT o.* FROM agents_platform.automation_timer_outbox o WHERE dispatched_at IS NULL ORDER BY automation_id,revision LIMIT 20`)).rows;
 for(const row of rows){
  const response=await request(`${ingressUrl.replace(/\/$/,'')}/restate/send/${restateServiceName(AUTOMATION_WORKFLOW)}/${row.automation_id}:${row.revision}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:row.automation_id,revision:row.revision}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('AUTOMATION_DISPATCH_FAILED');
  const output=await response.json() as {invocationId?:string};if(!output.invocationId?.startsWith('inv_'))throw new Error('AUTOMATION_DISPATCH_FAILED');
  await pool.query('UPDATE agents_platform.automation_timer_outbox SET dispatched_at=now() WHERE automation_id=$1 AND revision=$2',[row.automation_id,row.revision]);
 }
}
export function startAutomationDispatcher(pool:Pool,service:AutomationService,ingressUrl:string,onError:(code:string)=>void,reconcile?:()=>Promise<unknown>) {
 let stopped=false,timer:NodeJS.Timeout|undefined,wake:(()=>void)|undefined;
 const done=(async()=>{while(!stopped){try{await dispatchAutomationTimersOnce(pool,ingressUrl);await reconcile?.();}catch{onError('AUTOMATION_PUBLISHER_FAILED');}if(!stopped)await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000);});}})();
 return {stop:async()=>{stopped=true;if(timer)clearTimeout(timer);wake?.();await done;}};
}
