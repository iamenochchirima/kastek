import {recordOperationsWorkerHeartbeat} from "@kasitek-labs/server-support/operations-source";
import { randomUUID } from "node:crypto";
import {CONTEXT_COMPACTION_WORKFLOW,dispatcherPhases,type DispatcherPhase} from "../../contracts/execution";
import {restateServiceName} from "../../contracts/restate-names";
import {advanceCapacity} from "../scheduling/capacity";
import { claimDispatchBatch,parallelEach,type DispatchPolicy } from "../scheduling/dispatch-claims";
import type { Pool } from "pg";
import { transaction } from "../../infrastructure/database";
import {recordEvent} from "../../observability/event-store";
import { HARNESS_RELEASE,reconcilePendingRoots,settleTask,WORKFLOW_NAME } from "./execution";

export interface DispatcherOptions {
  ingressUrl: string;
  adminUrl: string;
  fetch?: typeof fetch;
  onError?: (code: string) => void;
  onPhase?: (phase:DispatcherPhase,durationMs:number,success:boolean)=>void;
  policy?: Partial<DispatchPolicy>;
  workload?: "interactive" | "background";
  runtimeRoutes?: Record<string,{ingressUrl:string;adminUrl:string;workflowName:string}>;
  supportStatusRoute?: {ingressUrl:string;adminUrl:string;workflowName:string};
}

type DispatcherContext={request:typeof fetch;routes:NonNullable<DispatcherOptions["runtimeRoutes"]>;releases:string[]};
function dispatcherContext(options:DispatcherOptions):DispatcherContext{
  const request = options.fetch ?? fetch;
  const routes=options.runtimeRoutes??{[HARNESS_RELEASE]:{ingressUrl:options.ingressUrl,adminUrl:options.adminUrl,workflowName:WORKFLOW_NAME}};
  const releases=Object.keys(routes);if(!releases.length||releases.length>8)throw Error("Invalid compatible runtime routes");
  for(const route of Object.values(routes))if(!/^https?:$/.test(new URL(route.ingressUrl).protocol)||!/^https?:$/.test(new URL(route.adminUrl).protocol)||!/^AgentsBusinessRunV[0-9]+$/.test(route.workflowName))throw Error("Invalid compatible runtime route");
  if(options.supportStatusRoute && (!/^https?:$/.test(new URL(options.supportStatusRoute.ingressUrl).protocol) || !/^https?:$/.test(new URL(options.supportStatusRoute.adminUrl).protocol) || options.supportStatusRoute.workflowName!=='AgentsSupportStatusV23'))throw Error('Invalid support status runtime route');
  return{request,routes,releases};
}

async function dispatchRootBatch(pool:Pool,options:DispatcherOptions,{request,routes,releases}:DispatcherContext):Promise<number>{
  let committed=0;
  await pool.query(`WITH terminal AS (SELECT o.task_id FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id
    WHERE o.dispatched_at IS NULL AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')
    ORDER BY o.created_at,o.task_id FOR UPDATE OF o SKIP LOCKED LIMIT 128)
    UPDATE agents_platform.task_outbox o SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL FROM terminal t WHERE t.task_id=o.task_id`);
  const {owner,rows,policy}=await claimDispatchBatch(pool,options.policy,releases,options.workload);
  await drainBatch(rows,policy.parallelism,async row=>{
    try {
      const task = (await pool.query(`SELECT state,runtime_invocation_id,harness_release,parent_task_id,EXISTS(SELECT 1 FROM agents_platform.operations op WHERE op.task_id=t.parent_task_id AND op.id=t.delegation_operation_id AND op.name IN ('agents.start','agents.followup') AND op.state='completed') AS background${options.supportStatusRoute?',execution_purpose':''} FROM agents_platform.tasks t WHERE id=$1`, [row.task_id])).rows[0];
      const route=task?.execution_purpose==='support_status_v1'?options.supportStatusRoute:routes[task?.harness_release];if(!route)throw new Error("HARNESS_RELEASE_UNAVAILABLE");
      if (Date.now() - new Date(row.created_at).getTime() >= 24 * 60 * 60 * 1000) {
        await settleTask(pool, row.task_id, { state: "uncertain", errorCode: "DISPATCH_WINDOW_EXPIRED" });
      } else if (task?.parent_task_id && !task.background) {
        if(task.state==="cancel_requested"&&!task.runtime_invocation_id)await settleTask(pool,row.task_id,{state:"cancelled"});
      } else if (task?.state === "cancel_requested" && !task.runtime_invocation_id &&
          (await pool.query(`SELECT attempts FROM agents_platform.task_outbox WHERE task_id=$1`, [row.task_id])).rows[0]?.attempts === 1) {
        await settleTask(pool, row.task_id, { state: "cancelled" });
      } else {
        const response = await request(`${route.ingressUrl.replace(/\/$/, "")}/restate/send/${restateServiceName(route.workflowName)}/${row.task_id}/run`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: row.task_id }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("RUNTIME_DISPATCH_FAILED");
        const sent = await response.json() as { invocationId?: unknown };
        if (typeof sent.invocationId !== "string" || !sent.invocationId.startsWith("inv_")) throw new Error("RUNTIME_INVALID_RESPONSE");
        // Bind the accepted workflow identity independently of the submission response.
        const lookup = await request(`${route.ingressUrl.replace(/\/$/, "")}/restate/lookup`, {
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({target:"workflow",workflowName:restateServiceName(route.workflowName),workflowKey:row.task_id}),signal:AbortSignal.timeout(5000),
        });
        if(!lookup.ok)throw new Error("RUNTIME_LOOKUP_PENDING");
        const body=await lookup.json() as {invocationId?:unknown};
        if(typeof body.invocationId!=="string"||!body.invocationId.startsWith("inv_"))throw new Error("RUNTIME_INVALID_RESPONSE");
        const bound = await pool.query(`UPDATE agents_platform.tasks SET runtime_invocation_id=$2,updated_at=now()
          WHERE id=$1 AND (runtime_invocation_id IS NULL OR runtime_invocation_id=$2)
          AND EXISTS(SELECT 1 FROM agents_platform.task_outbox WHERE task_id=$1 AND lease_owner=$3 AND lease_until>now())`, [row.task_id, body.invocationId,owner]);
        if (bound.rowCount !== 1) throw new Error("RUNTIME_IDENTITY_CONFLICT");
      }
      const acknowledgement=await pool.query(`UPDATE agents_platform.task_outbox SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL,last_error_code=NULL
        WHERE task_id=$1 AND lease_owner=$2 AND dispatched_at IS NULL`, [row.task_id, owner]);
      committed+=acknowledgement.rowCount??0;
    } catch {
      await pool.query(`UPDATE agents_platform.task_outbox SET lease_owner=NULL,lease_until=NULL,
        available_at=now()+interval '5 seconds',last_error_code='RUNTIME_DISPATCH_FAILED' WHERE task_id=$1 AND lease_owner=$2`, [row.task_id, owner]);
      options.onError?.("RUNTIME_DISPATCH_FAILED");
    }
  });
  return committed;
}

async function dispatchControls(pool:Pool,options:DispatcherOptions,{request,routes,releases}:DispatcherContext):Promise<void>{
  const controlOwner=randomUUID();
  const controls = (await pool.query(`WITH due AS (SELECT c.task_id,c.generation FROM agents_platform.task_controls c JOIN agents_platform.tasks t ON t.id=c.task_id
    WHERE c.dispatched_at IS NULL AND (c.lease_until IS NULL OR c.lease_until<now()) AND t.harness_release=ANY($2::text[]) AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')
    ORDER BY c.task_id,c.generation FOR UPDATE OF c SKIP LOCKED LIMIT 32)
    UPDATE agents_platform.task_controls c SET lease_owner=$1,lease_until=now()+interval '30 seconds' FROM due
    WHERE c.task_id=due.task_id AND c.generation=due.generation RETURNING c.task_id,c.generation,c.kind,(SELECT harness_release FROM agents_platform.tasks WHERE id=c.task_id) AS harness_release,
      (SELECT grant_id FROM agents_platform.tasks WHERE id=c.task_id) AS grant_id,
      (SELECT parent_task_id IS NOT NULL AND execution_policy_version>=2 FROM agents_platform.tasks WHERE id=c.task_id) AS derived_renewal`,[controlOwner,releases])).rows;
  await drainBatch(controls,8,async control=>{
    const route=routes[control.harness_release]!;
    try {
      const response = await request(`${route.ingressUrl.replace(/\/$/, "")}/${restateServiceName(route.workflowName)}/${control.task_id}/${control.kind==="review"?"review":"resume"}`, {
        method: "POST", headers: {"content-type":"application/json", "idempotency-key":`continue:${control.task_id}:${control.generation}${control.kind==="authority"&&control.derived_renewal?":"+control.grant_id:""}`},
        body:JSON.stringify({generation:Number(control.generation)}), signal:AbortSignal.timeout(5000) });
      if(response.ok) await pool.query("UPDATE agents_platform.task_controls SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL WHERE task_id=$1 AND generation=$2 AND lease_owner=$3",[control.task_id,control.generation,controlOwner]);
    } catch { options.onError?.("RUNTIME_CONTINUATION_FAILED"); }
  });
  await transaction(pool,async db=>{
    const expired=await db.query(`WITH due AS (SELECT id FROM agents_platform.tasks WHERE deadline_at<now() AND state IN ('accepted','running','waiting_authority','waiting_review','waiting_children','reconciling')
      ORDER BY deadline_at,id FOR NO KEY UPDATE SKIP LOCKED LIMIT 128) UPDATE agents_platform.tasks t SET state='cancel_requested',error_code='TASK_DEADLINE',updated_at=now()
      FROM due WHERE t.id=due.id RETURNING t.id`);
    for(const task of expired.rows)await recordEvent(db,task.id,'deadline-stop','cancel_requested',{errorCode:'TASK_DEADLINE'});
  });

  const cancellations = (await pool.query(`SELECT id,runtime_invocation_id,created_at,harness_release FROM agents_platform.tasks
    WHERE state='cancel_requested' AND runtime_invocation_id IS NOT NULL AND harness_release=ANY($1::text[]) ORDER BY updated_at LIMIT 10`,[releases])).rows;
  await drainBatch(cancellations,8,async task=>{
    const route=routes[task.harness_release]!;
    try {
      try {
        const response = await request(`${route.adminUrl.replace(/\/$/, "")}/invocations/${encodeURIComponent(task.runtime_invocation_id)}/cancel`,
          { method: "PATCH", signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
      } catch { options.onError?.("RUNTIME_CANCEL_REQUEST_UNCONFIRMED"); }
      // A repeated cancel may return 409 after completion. Only authoritative output settles it.
      const output = await request(`${route.ingressUrl.replace(/\/$/, "")}/restate/output/${encodeURIComponent(task.runtime_invocation_id)}`,
        { signal: AbortSignal.timeout(5000) });
      const body = await output.json() as { message?: unknown; state?: unknown; output?: unknown; errorCode?: unknown };
      if (output.status === 409 && typeof body.message === "string" && /cancel/i.test(body.message)) {
        await settleTask(pool, task.id, { state: "cancelled" });
      } else if (output.ok && ["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"].includes(String(body.state))) {
        await settleTask(pool, task.id, { state: body.state as "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "uncertain",
          output: typeof body.output === "string" ? body.output : undefined,
          errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined });
      } else if (Date.now() - new Date(task.created_at).getTime() > 24 * 60 * 60 * 1000) {
        await settleTask(pool, task.id, { state: "uncertain", errorCode: "CANCELLATION_UNCONFIRMED" });
      }
    } catch {
      options.onError?.("RUNTIME_CANCEL_FAILED");
      if (Date.now() - new Date(task.created_at).getTime() > 24 * 60 * 60 * 1000) {
        await settleTask(pool, task.id, { state: "uncertain", errorCode: "CANCELLATION_UNCONFIRMED" });
      }
    }
  });
}

function phaseWork(pool:Pool,options:DispatcherOptions):Record<DispatcherPhase,()=>Promise<number>>{
  let context:DispatcherContext|undefined;
  const validated=()=>context??=dispatcherContext(options);
  return{
    dispatch:async()=>dispatchRootBatch(pool,options,validated()),
    capacity:async()=>{validated();return advanceCapacity(pool);},
    capacity_notifications:async()=>publishCapacityNotifications(pool,options,validated().routes),
    controls:async()=>{await dispatchControls(pool,options,validated());return 0;},
    reconciliation:async()=>{validated();await reconcilePendingRoots(pool);return 0;},
  };
}

async function runPhase(options:DispatcherOptions,phase:DispatcherPhase,work:()=>Promise<number>):Promise<number>{
  const started=performance.now();let success=false;
  try{const committed=await work();success=true;return committed;}
  finally{try{options.onPhase?.(phase,Math.max(0,performance.now()-started),success);}catch{}}
}

export async function dispatchTasksOnce(pool:Pool,options:DispatcherOptions):Promise<void>{
  const work=phaseWork(pool,options);
  for(const phase of ["dispatch","reconciliation","capacity","capacity_notifications","controls"] as const)await runPhase(options,phase,work[phase]);
}

export function startDispatcher(pool:Pool,options:DispatcherOptions):{stop():Promise<void>}{
  const work=phaseWork(pool,options),wakers=new Set<()=>void>();let stopped=false;
  const loops=dispatcherPhases.map(phase=>(async()=>{
    while(!stopped){
      await recordOperationsWorkerHeartbeat(pool,"dispatcher_"+phase);
      let committed=0;
      try{committed=await runPhase(options,phase,work[phase]);}
      catch{try{options.onError?.("RUNTIME_PUBLISHER_FAILED");}catch{}}
      if(!stopped&&committed>0&&["dispatch","capacity","capacity_notifications"].includes(phase)){
        await new Promise<void>(resolve=>setImmediate(resolve));
        continue;
      }
      if(!stopped)await new Promise<void>(resolve=>{
        const wake=()=>{clearTimeout(timer);wakers.delete(wake);resolve();};
        const timer=setTimeout(wake,1000);wakers.add(wake);
      });
    }
  })());
  return{stop:async()=>{stopped=true;for(const wake of wakers)wake();await Promise.all(loops);}};
}

async function publishCapacityNotifications(pool:Pool,options:DispatcherOptions,routes:NonNullable<DispatcherOptions["runtimeRoutes"]>):Promise<number>{
 let committed=0;
 const owner=randomUUID(),request=options.fetch??fetch;
 const notifications=(await pool.query(`WITH due AS (SELECT n.request_id,n.generation FROM agents_platform.capacity_notifications n JOIN agents_platform.tasks t ON t.id=n.task_id
 WHERE t.harness_release=ANY($2::text[]) AND n.dispatched_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY n.available_at,n.request_id,n.generation FOR UPDATE OF n SKIP LOCKED LIMIT 64)
 UPDATE agents_platform.capacity_notifications n SET lease_owner=$1,lease_until=now()+interval '30 seconds' FROM due
 WHERE n.request_id=due.request_id AND n.generation=due.generation RETURNING n.*,(SELECT harness_release FROM agents_platform.tasks WHERE id=n.task_id) AS harness_release,
   (SELECT id FROM agents_platform.context_compaction_jobs j WHERE j.id=n.request_id AND j.task_id=n.task_id AND j.mode='background') AS compaction_job_id`,[owner,Object.keys(routes)])).rows;
 await drainBatch(notifications,8,async row=>{
 const route=routes[row.harness_release]!;
 try{
  const target=row.compaction_job_id?{workflow:restateServiceName(CONTEXT_COMPACTION_WORKFLOW),key:row.compaction_job_id}:{workflow:restateServiceName(route.workflowName),key:row.task_id};
  const response=await request(`${route.ingressUrl.replace(/\/$/,"")}/${target.workflow}/${encodeURIComponent(target.key)}/capacity`,{
  method:"POST",headers:{"content-type":"application/json","idempotency-key":`capacity:${row.request_id}:${row.generation}`},
  body:JSON.stringify({requestId:row.request_id,generation:row.generation}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error("CAPACITY_NOTIFICATION_FAILED");
  const acknowledgement=await pool.query(`UPDATE agents_platform.capacity_notifications SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL
  WHERE request_id=$1 AND generation=$2 AND lease_owner=$3 AND dispatched_at IS NULL`,[row.request_id,row.generation,owner]);
  committed+=acknowledgement.rowCount??0;
 }catch{
  await pool.query(`UPDATE agents_platform.capacity_notifications SET lease_owner=NULL,lease_until=NULL,available_at=now()+interval '5 seconds'
  WHERE request_id=$1 AND generation=$2 AND lease_owner=$3`,[row.request_id,row.generation,owner]);options.onError?.("CAPACITY_NOTIFICATION_FAILED");
 }
 });
 return committed;
}

async function drainBatch<T>(rows:T[],parallelism:number,work:(row:T)=>Promise<void>):Promise<void>{
 let failed=false,failure:unknown;
 await parallelEach(rows,parallelism,async row=>{try{await work(row);}catch(error){if(!failed){failed=true;failure=error;}}});
 if(failed)throw failure;
}
