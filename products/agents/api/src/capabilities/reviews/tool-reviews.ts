import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError, requestDigest, terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority, loadExecution } from "../../execution/lifecycle/execution";
import { assertChildConnectedAuthority } from "../../execution/context/evidence";
import { notifyActionTask, requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { resolveAutomationOwner } from "../../execution/lifecycle/automation-authority";

export interface ToolReview {
  id:string;taskId:string;rootTaskId:string;operationId:string;bindingId:string;bindingDigest:string;
  requestDigest:string;arguments:unknown;connectionId:string;reviewerAccountId:string;state:string;expiresAt:string;
  operationName:string;connectionName:string;destination:string|null;effect:string;
}
const dto=(row:Record<string,any>):ToolReview=>({id:row.id,taskId:row.task_id,rootTaskId:row.root_task_id,
  operationId:row.operation_id,bindingId:row.binding_id,bindingDigest:row.binding_digest,requestDigest:row.request_digest,
  arguments:row.arguments,connectionId:row.connection_id,reviewerAccountId:row.reviewer_account_id,state:row.state,
  expiresAt:new Date(row.expires_at).toISOString(),operationName:row.operation_name??"Tool request",connectionName:row.connection_name??"Connected server",
  destination:row.destination??null,effect:row.effect??"reviewed_write"});
const denied=()=>new PlatformError("TOOL_REVIEW_DENIED",403,"Tool authorization is unavailable");
function operationName(binding:CapabilityBinding):string {
  const target=binding.definition.remote?.target;
  return target?.kind==="prompt"?`Activate prompt ${target.name}`:target?.kind==="resource"?`Read resource ${target.uri}`:target?.kind==="template"?`Read resource ${binding.remoteSelection?.uri??target.uriTemplate}`:target?.kind==="tool"?target.name:binding.definition.providerOperation;
}

export class ToolReviewStore {
  constructor(readonly pool:Pool){}
  private async authority(db:PoolClient,taskId:string,binding:CapabilityBinding) {
    const execution=await loadExecution(db,z.uuid().parse(taskId),true);
    await assertCurrentAuthority(db,execution);
    if(!binding.connection || !["remote-mcp-v1","custom-api-v1"].includes(binding.connection.profileId)
      || !execution.configuration.connectedToolBindingIds.includes(binding.id)
      || !execution.connectedBindings.some(selected=>selected.id===binding.id&&selected.digest===binding.digest)
      || binding.policy.approval!=="exact_single_use")throw denied();
    const grant=(await db.query("SELECT operations,connected_tool_binding_ids FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
    if(!grant?.operations.includes("connected.execute")||!grant.connected_tool_binding_ids.includes(binding.id))throw denied();
    await assertChildConnectedAuthority(db,execution,binding.id);
    const connection=(await db.query(`SELECT c.* FROM agents_platform.connections c JOIN agents_platform.memberships m
      ON m.organization_id=c.organization_id AND m.account_id=c.account_id AND m.revoked_at IS NULL
      WHERE c.id=$1 AND c.organization_id=$2 AND c.state='active' AND c.expires_at>now() AND c.policy_revision=$3 FOR SHARE OF c,m`,
      [binding.connection.id,execution.task.organization_id,binding.connection.policyRevision])).rows[0];
    if(!connection)throw denied();
    // Customer deployment authority requires its own verified identity/resource contract.
    if(execution.task.principal.kind==="visitor")throw denied();
    const principal=execution.task.principal;
    const actor=principal.kind==="automation"?await resolveAutomationOwner(db,execution.task.organization_id,principal):
      principal.kind==="human"?(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[principal.issuer,principal.subject])).rows[0]?.id:undefined;
    if(actor!==connection.account_id)throw denied();
    return {execution,connection};
  }
  async prepare(taskId:string,operationId:string,rawBinding:CapabilityBinding,args:unknown):Promise<ToolReview> {
    z.string().min(1).max(256).parse(operationId);const binding=capabilityBindingSchema.parse(rawBinding);
    if(Buffer.byteLength(JSON.stringify(args))>65536)throw new PlatformError("TOOL_ARGUMENTS_LIMIT",413,"Tool arguments exceed their bound");
    const digest=requestDigest({bindingDigest:binding.digest,arguments:args});
    return transaction(this.pool,async db=>{
      const {execution,connection}=await this.authority(db,taskId,binding);
      const old=(await db.query("SELECT * FROM agents_platform.tool_invocation_reviews WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
      if(old){if(old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Tool review changed");return dto({...old,operation_name:operationName(binding),connection_name:connection.name,destination:connection.resource,effect:binding.policy.effect});}
      const row=(await db.query(`INSERT INTO agents_platform.tool_invocation_reviews(id,organization_id,task_id,root_task_id,operation_id,
        binding_id,binding_digest,request_digest,arguments,connection_id,connection_policy_revision,reviewer_account_id,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',LEAST($13::timestamptz,now()+interval '15 minutes')) RETURNING *`,
      [randomUUID(),execution.task.organization_id,taskId,execution.task.root_task_id,operationId,binding.id,binding.digest,digest,
        JSON.stringify(args),connection.id,connection.policy_revision,connection.account_id,execution.task.deadline_at])).rows[0];
      return dto({...row,operation_name:operationName(binding),connection_name:connection.name,destination:connection.resource,effect:binding.policy.effect});
    });
  }
  async list(scope:ActionScope,taskId:string):Promise<ToolReview[]> {
    return transaction(this.pool,async db=>{await requireActionMember(db,scope);
      return (await db.query(`SELECT r.*,b.binding AS reviewed_binding,c.name AS connection_name,
        c.resource AS destination,b.binding#>>'{policy,effect}' AS effect
        FROM agents_platform.tool_invocation_reviews r JOIN agents_platform.capability_bindings b ON b.id=r.binding_id
        JOIN agents_platform.connections c ON c.id=r.connection_id WHERE r.organization_id=$1 AND r.reviewer_account_id=$2
        AND r.task_id=$3 ORDER BY r.created_at,r.id LIMIT 100`,[scope.organizationId,scope.accountId,z.uuid().parse(taskId)])).rows.map(row=>dto({...row,operation_name:operationName(capabilityBindingSchema.parse(row.reviewed_binding))}));
    });
  }
  async decide(scope:ActionScope,id:string,input:{decision:"approve"|"reject";requestDigest:string}) {
    z.uuid().parse(id);z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input);
    return transaction(this.pool,async db=>{
      await requireActionMember(db,scope);
      let row=(await db.query(`SELECT * FROM agents_platform.tool_invocation_reviews WHERE id=$1 AND organization_id=$2 AND reviewer_account_id=$3`,[id,scope.organizationId,scope.accountId])).rows[0];
      if(!row)throw denied();
      if(row.request_digest!==input.requestDigest)throw new PlatformError("REVIEW_CHANGED",409,"Review the current tool request");
      const desired=input.decision==="approve"?"approved":"rejected";
      if(row.state===desired)return dto(row);
      if(row.state!=="pending"||new Date(row.expires_at).getTime()<=Date.now())throw new PlatformError("REVIEW_EXPIRED",409,"Tool review is no longer pending");
      const execution=await loadExecution(db,row.task_id,true);
      if(terminalTaskStates.has(execution.task.state))throw denied();
      const binding=execution.connectedBindings.find(selected=>selected.id===row.binding_id&&selected.digest===row.binding_digest);
      if(!binding)throw denied();await this.authority(db,row.task_id,binding);
      row=(await db.query("SELECT * FROM agents_platform.tool_invocation_reviews WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(row.state===desired)return dto(row);
      if(row.state!=="pending"||new Date(row.expires_at).getTime()<=Date.now())throw new PlatformError("REVIEW_EXPIRED",409,"Tool review is no longer pending");
      const updated=(await db.query(`UPDATE agents_platform.tool_invocation_reviews SET state=$2,approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,[id,desired])).rows[0];
      await notifyActionTask(db,row.task_id);return dto(updated);
    });
  }
  async claim(db:PoolClient,taskId:string,operationId:string,binding:CapabilityBinding,args:unknown) {
    await this.authority(db,taskId,binding);
    const row=(await db.query(`UPDATE agents_platform.tool_invocation_reviews SET state='claimed',claimed_at=now()
      WHERE task_id=$1 AND operation_id=$2 AND binding_id=$3 AND binding_digest=$4 AND request_digest=$5
      AND state='approved' AND expires_at>now() RETURNING id`,[taskId,operationId,binding.id,binding.digest,requestDigest({bindingDigest:binding.digest,arguments:args})])).rows[0];
    if(!row)throw new PlatformError("TOOL_REVIEW_REQUIRED",409,"This exact tool request needs approval");
    return row.id as string;
  }
  async assertApproved(db:PoolClient,input:{taskId:string;operationId:string;binding:CapabilityBinding;arguments:unknown}) {
    await this.authority(db,input.taskId,input.binding);
    const row=(await db.query(`SELECT state,expires_at,claimed_at FROM agents_platform.tool_invocation_reviews WHERE task_id=$1 AND operation_id=$2
      AND binding_id=$3 AND binding_digest=$4 AND request_digest=$5 FOR SHARE`,[input.taskId,input.operationId,input.binding.id,input.binding.digest,
      requestDigest({bindingDigest:input.binding.digest,arguments:input.arguments})])).rows[0];
    if(!row||!(row.state==="approved"&&new Date(row.expires_at).getTime()>Date.now()||row.state==="claimed"&&new Date(row.claimed_at).getTime()<new Date(row.expires_at).getTime()))
      throw new PlatformError("TOOL_REVIEW_REQUIRED",409,"This exact tool request needs approval");
  }
  port() {
    return {
      assertApproved:(db:PoolClient,input:{taskId:string;operationId:string;binding:CapabilityBinding;arguments:unknown})=>this.assertApproved(db,input),
      claim:async(db:PoolClient,input:{taskId:string;operationId:string;binding:CapabilityBinding;arguments:unknown})=>{await this.claim(db,input.taskId,input.operationId,input.binding,input.arguments);},
      completed:async(db:PoolClient,input:{taskId:string;operationId:string})=>this.settle(db,input.taskId,input.operationId,"completed"),
      failed:async(db:PoolClient,input:{taskId:string;operationId:string})=>this.settle(db,input.taskId,input.operationId,"uncertain"),
    };
  }
  async settle(db:PoolClient,taskId:string,operationId:string,state:"completed"|"uncertain") {
    await db.query("UPDATE agents_platform.tool_invocation_reviews SET state=$3 WHERE task_id=$1 AND operation_id=$2 AND state='claimed'",[taskId,operationId,state]);
  }
}
