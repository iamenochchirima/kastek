import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { assertConnectedBindingDependencies } from "../../capabilities/connected-tools/connected-tool-schema";
import { fitUtf8 } from "../../capabilities/tools";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { agentConfigurationSchema,connectedToolAuthorityIds,executionGrantSchema,PlatformError,requestDigest,terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority,event,HARNESS_RELEASE,loadExecution,transaction } from "../lifecycle/execution";

export const delegationRequestSchema = z.strictObject({ requests: z.array(z.strictObject({
  bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), brief: z.string().trim().min(1).max(8192),
  maxTokens: z.number().int().min(2048).max(12000).optional(),
  sourceRevisionIds: z.array(z.uuid()).max(20).optional(), connectedToolBindingIds: z.array(z.uuid()).max(8).optional(),
})).min(1).max(2) });
export interface DelegatedChild { taskId: string; slot: number; bindingId: string; versionId: string }

export async function admitChildren(pool: Pool, parentId: string, operationId: string, raw: unknown): Promise<DelegatedChild[]> {
  let parsed: z.infer<typeof delegationRequestSchema>;
  try { parsed = delegationRequestSchema.parse(raw); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the specialist requests"); }
  const digest = requestDigest(parsed);
  return transaction(pool,async db=>{
    const before=await loadExecution(db,parentId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[before.task.organization_id]);
    const budget=(await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[before.task.root_task_id])).rows[0];
    const parent=await loadExecution(db,parentId,true), task=parent.task, config=parent.configuration;
    const existing=(await db.query(`SELECT d.*,t.version_id FROM agents_platform.delegations d JOIN agents_platform.tasks t ON t.id=d.child_task_id
      WHERE d.parent_task_id=$1 AND d.operation_id=$2 ORDER BY d.slot`,[parentId,operationId])).rows;
    if(existing.length) {
      if(existing.length!==parsed.requests.length || existing.some(row=>row.request_digest!==digest)) throw new PlatformError("OPERATION_CONFLICT",409,"Delegation identity conflict");
      return existing.map(row=>({taskId:row.child_task_id,slot:row.slot,bindingId:row.binding_id,versionId:row.version_id}));
    }
    await assertCurrentAuthority(db,parent);
    const {taskEvidenceManifest,assertCurrentEvidence}=await import("../context/evidence");
    const inputManifest=await taskEvidenceManifest(db,parentId);await assertCurrentEvidence(db,parentId,inputManifest);
    if(task.depth!==0 || task.parent_task_id || !["human","automation"].includes(task.principal.kind) || !config.capabilities.delegation.enabled) throw new PlatformError("DELEGATION_DENIED",403,"Delegation is unavailable");
    const active=(await db.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[task.id])).rows[0].count;
    if(active+parsed.requests.length>2) throw new PlatformError("CHILD_LIMIT",429,"Only two specialists may run at once");
    const prepared=[];
    for(const request of parsed.requests) {
      const binding=config.capabilities.delegation.bindings.find(item=>item.id===request.bindingId);
      if(!binding) throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist is not permitted");
      const version=(await db.query("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2 FOR SHARE",[task.organization_id,binding.versionId])).rows[0];
      if(!version) throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist version is unavailable");
      const childConfig=agentConfigurationSchema.parse(version.configuration);
      const sourceRevisionIds=request.sourceRevisionIds??binding.sourceRevisionIds, connectedToolBindingIds=request.connectedToolBindingIds??binding.connectedToolBindingIds;
      if(childConfig.executionKind!=="business" || childConfig.memory.enabled || childConfig.capabilities.delegation.enabled || childConfig.capabilities.sandbox.enabled || childConfig.capabilities.workflows.enabled ||
        sourceRevisionIds.some(id=>!binding.sourceRevisionIds.includes(id)||!childConfig.sourceRevisionIds.includes(id)||!config.sourceRevisionIds.includes(id)) ||
        connectedToolBindingIds.some(id=>!binding.connectedToolBindingIds.includes(id)||!childConfig.connectedToolBindingIds.includes(id)||!connectedToolAuthorityIds(config).includes(id)) ||
        binding.tools.some(name=>!childConfig.tools.includes(name)) || Buffer.byteLength(request.brief)>childConfig.model.maxInputBytes ||
        (request.maxTokens??binding.maxTokens)>binding.maxTokens) throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Specialist request exceeds its published scope");
      const effectiveBindings=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[task.organization_id,connectedToolBindingIds])).rows;
      assertConnectedBindingDependencies(effectiveBindings.map(row=>capabilityBindingSchema.parse(row.binding)));
      const effective={...childConfig,sourceRevisionIds,connectedToolBindingIds,tools:binding.tools,memory:{enabled:false}};
      prepared.push({request,binding,version,effective,maxTokens:request.maxTokens??binding.maxTokens});
    }
    const tokens=prepared.reduce((sum,item)=>sum+item.maxTokens,0), ms=prepared.reduce((sum,item)=>sum+item.binding.maxActiveMs,0);
    if(!budget || budget.settled_at || budget.tokens_used+budget.tokens_reserved+budget.child_reserved_tokens+tokens+4000>task.root_token_limit ||
      budget.active_ms+budget.active_reserved_ms+budget.child_reserved_ms+ms+120000>900000) throw new PlatformError("ROOT_LIMIT",429,"Specialist allocations exceed the root budget");
    const children:DelegatedChild[]=[];
    for(const [slot,item] of prepared.entries()) {
      const id=randomUUID(),conversationId=randomUUID();
      const grant=executionGrantSchema.parse({id:randomUUID(),product:task.product,organizationId:task.organization_id,resourceId:item.version.agent_id,
        callerClientId:"agents-delegation",principal:task.principal,versionId:item.version.id,operations:["model.reply","knowledge.read",...(item.effective.connectedToolBindingIds.length?["connected.read"]:[])],sourceRevisionIds:item.effective.sourceRevisionIds,connectedToolBindingIds:item.effective.connectedToolBindingIds,
        maxInputBytes:item.effective.model.maxInputBytes,maxOutputTokens:item.effective.model.maxOutputTokens,maxContextTokens:item.effective.context.maxInputTokens,
        rootTokenLimit:item.maxTokens,expiresAt:new Date(task.deadline_at).toISOString(),revokedAt:null});
      await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,
        max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),
        grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
      await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,next_sequence) VALUES($1,$2,$3,$4,2)",[conversationId,task.organization_id,item.version.agent_id,task.principal]);
      await db.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,
        request_digest,input,root_task_id,parent_task_id,depth,delegation_operation_id,effective_configuration,root_token_limit,allocation_active_ms,deadline_at,harness_release)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$18,$19,$20)`,
      [id,task.product,task.organization_id,item.version.agent_id,grant.callerClientId,task.principal,item.version.id,grant.id,conversationId,`child:${id}`,digest,
        item.request.brief,task.root_task_id,parentId,operationId,item.effective,item.maxTokens,item.binding.maxActiveMs,task.deadline_at,HARNESS_RELEASE]);
      await db.query("INSERT INTO agents_platform.delegations(parent_task_id,operation_id,slot,child_task_id,binding_id,request_digest,input_manifest) VALUES($1,$2,$3,$4,$5,$6,$7)",[parentId,operationId,slot,id,item.binding.id,digest,inputManifest]);
      await db.query("INSERT INTO agents_platform.task_outbox(task_id) VALUES($1)",[id]);
      await event(db,id,"accepted","accepted",{rootTaskId:task.root_task_id,parentTaskId:parentId,slot});
      children.push({taskId:id,slot,bindingId:item.binding.id,versionId:item.version.id});
    }
    await db.query("UPDATE agents_platform.execution_roots SET child_reserved_tokens=child_reserved_tokens+$2,child_reserved_ms=child_reserved_ms+$3 WHERE root_task_id=$1",[task.root_task_id,tokens,ms]);
    await event(db,parentId,`delegation:${operationId}`,"children.admitted",{children:children.map(child=>({taskId:child.taskId,slot:child.slot}))});
    return children;
  });
}

export async function readChildResults(pool:Pool,parentId:string,children:DelegatedChild[]) {
  return transaction(pool,async db=>{
    const parent=await loadExecution(db,parentId); await assertCurrentAuthority(db,parent);
    const results=[];
    for(const child of [...children].sort((a,b)=>a.slot-b.slot)) {
      const row=(await db.query(`SELECT t.*,d.binding_id FROM agents_platform.tasks t JOIN agents_platform.delegations d ON d.child_task_id=t.id
        JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
        WHERE t.id=$1 AND d.parent_task_id=$2 AND t.root_task_id=$2 AND t.organization_id=$3 FOR SHARE OF c`,[child.taskId,parentId,parent.task.organization_id])).rows[0];
      if(!row || !terminalTaskStates.has(row.state)) throw new PlatformError("CHILD_OUTCOME_PENDING",409,"Specialist outcome is not yet available");
      const configuration=agentConfigurationSchema.parse(row.effective_configuration);
      const {assertCurrentEvidence,taskEvidenceManifest}=await import("../context/evidence");
      await assertCurrentEvidence(db,row.id,await taskEvidenceManifest(db,row.id),{requireActiveTask:false});
      const originalOutput=row.output??"", originalBytes=Buffer.byteLength(originalOutput);
      const output=fitUtf8(originalOutput,2048).replace(/\[E[a-f0-9]{0,32}$/,"");
      results.push({taskId:row.id,bindingId:row.binding_id,state:row.state,output,outputTruncated:output!==originalOutput,originalBytes,errorCode:row.error_code,
        sourceRevisionIds:configuration.sourceRevisionIds,connectedToolBindingIds:configuration.connectedToolBindingIds,usage:{tokens:row.tokens_used,modelCalls:row.model_calls,toolCalls:row.tool_calls}});
    }
    return {children:results,partial:results.some(child=>child.state!=="completed"||child.outputTruncated)};
  });
}
