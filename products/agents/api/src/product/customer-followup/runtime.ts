import * as restate from "@restatedev/restate-sdk";
import { restateServiceName } from "../../contracts/restate-names";
import type { Pool } from "pg";
import { CustomerFollowupNotifications } from "./notifications";
import { randomUUID } from "node:crypto";
import { publishFollowupReadiness } from "./readiness";

export const CUSTOMER_FOLLOWUP_WORKFLOW = "AgentsCustomerFollowupV1";
export function createCustomerFollowupWorkflow(service: CustomerFollowupNotifications) {
  return restate.workflow({ name:restateServiceName(CUSTOMER_FOLLOWUP_WORKFLOW), handlers:{run:async(ctx:restate.WorkflowContext,input:{notificationId:string}) => {
    for(let attempt=0;attempt<3;attempt++) {
      const result=await ctx.run(`deliver:${attempt}`, () => service.deliver(input.notificationId));
      if(result!=="in_progress")return;
      await ctx.sleep(60_000);
    }
    throw new restate.TerminalError("Follow-up send claim requires reconciliation",{errorCode:409});
  }} });
}

export async function dispatchCustomerFollowupsOnce(pool: Pool, ingressUrl: string, request: typeof fetch = fetch): Promise<void> {
  const rows = (await pool.query("SELECT id FROM agents_platform.customer_followup_notifications WHERE state='pending' AND dispatched_at IS NULL ORDER BY created_at,id LIMIT 20")).rows;
  for (const row of rows) {
    const response = await request(`${ingressUrl.replace(/\/$/, "")}/restate/send/${restateServiceName(CUSTOMER_FOLLOWUP_WORKFLOW)}/${row.id}/run`, {
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({notificationId:row.id}),signal:AbortSignal.timeout(5000),
    });
    if (!response.ok || !(await response.json() as {invocationId?:string}).invocationId?.startsWith("inv_")) throw new Error("CUSTOMER_FOLLOWUP_DISPATCH_FAILED");
    await pool.query("UPDATE agents_platform.customer_followup_notifications SET dispatched_at=now() WHERE id=$1", [row.id]);
  }
}

export function startCustomerFollowupDispatcher(pool: Pool, ingressUrl: string, onError: (code:string) => void,readiness?:{configurationDigest:string;adminUrl:string}) {
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,wake:(()=>void)|undefined;
  const instanceId=randomUUID();let nextHeartbeat=0;
  const done=(async()=>{while(!stopped){try{
    if(readiness&&Date.now()>=nextHeartbeat){await publishFollowupReadiness(pool,{instanceId,...readiness});nextHeartbeat=Date.now()+15000;}
    await dispatchCustomerFollowupsOnce(pool,ingressUrl);
  }catch{onError("CUSTOMER_FOLLOWUP_DISPATCH_FAILED");}
    if(!stopped)await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000)});}})();
  return {async stop(){stopped=true;if(timer)clearTimeout(timer);wake?.();await done;if(readiness)await pool.query("DELETE FROM agents_platform.customer_followup_runtime WHERE instance_id=$1",[instanceId]);}};
}
