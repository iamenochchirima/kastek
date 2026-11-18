import { delegatedConfiguration, delegationAncestors } from "./scope";
import { workUsage } from "../lifecycle/work-policy";
import { delegatedSkills } from "./skills";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { assertConnectedBindingDependencies } from "../../capabilities/connected-tools/connected-tool-schema";
import { fitUtf8 } from "../../capabilities/tools";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { agentConfigurationSchema,connectedToolAuthorityIds,sourceAuthorityIds,executionGrantSchema,PlatformError,requestDigest,terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority,event,loadExecution,transaction } from "../lifecycle/execution";
import { compilePublishedComposition } from "../programs/publication";
import type { TaskArtifactStore } from "../artifacts/task-artifacts";

export const delegationRequestSchema = z.strictObject({ requests: z.array(z.strictObject({
  bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), brief: z.string().trim().min(1).max(8192),
  maxTokens: z.number().int().min(2048).max(12000).optional(),
  sourceRevisionIds: z.array(z.uuid()).max(20).optional(), connectedToolBindingIds: z.array(z.uuid()).max(8).optional(),
})).min(1).max(2) });
const delegatedArtifactSchema = z.strictObject({ id:z.uuid(), name:z.string().min(1).max(120), contentType:z.string().min(1).max(128),
  bytes:z.number().int().nonnegative(), contentDigest:z.string().regex(/^[a-f0-9]{64}$/), originTaskId:z.uuid().optional() });
const adaptiveDelegationRequestSchema = delegationRequestSchema.extend({ requests: z.array(delegationRequestSchema.shape.requests.element.extend({
  brief:z.string().trim().min(1).max(32768), artifacts:z.array(delegatedArtifactSchema).max(8).optional(),
})).min(1).max(2) });
export interface DelegatedChild { taskId: string; slot: number; bindingId: string; versionId: string; workflow?: string }

export async function admitChildren(pool: Pool, parentId: string, operationId: string, raw: unknown, options: { adaptive?: boolean; priorTaskId?: string; artifacts?:TaskArtifactStore } = {}): Promise<DelegatedChild[]> {
  let parsed: z.infer<typeof adaptiveDelegationRequestSchema>;
  try { parsed = (options.adaptive ? adaptiveDelegationRequestSchema : delegationRequestSchema).parse(raw); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the specialist requests"); }
  if(parsed.requests.some(request=>request.artifacts?.length)&&!options.artifacts)throw new PlatformError("ARTIFACT_UNAVAILABLE",503,"Selected artifacts are unavailable");
  const digest = requestDigest(options.priorTaskId ? { ...parsed, priorTaskId: options.priorTaskId } : parsed);
  return transaction(pool,async db=>{
    const before=await loadExecution(db,parentId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[before.task.organization_id]);
    const budget=(await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[before.task.root_task_id])).rows[0];
    const parent=await loadExecution(db,parentId,true), task=parent.task, config=parent.configuration;
    const existing=(await db.query(`SELECT d.*,t.version_id,t.effective_composition FROM agents_platform.delegations d JOIN agents_platform.tasks t ON t.id=d.child_task_id
      WHERE d.parent_task_id=$1 AND d.operation_id=$2 ORDER BY d.slot`,[parentId,operationId])).rows;
    if(existing.length) {
      if(existing.length!==parsed.requests.length || existing.some(row=>row.request_digest!==digest)) throw new PlatformError("OPERATION_CONFLICT",409,"Delegation identity conflict");
      return existing.map(row=>({taskId:row.child_task_id,slot:row.slot,bindingId:row.binding_id,versionId:row.version_id,workflow:row.effective_composition?.runtime?.workflow}));
    }
    await assertCurrentAuthority(db,parent);
    const {taskEvidenceManifest,assertCurrentEvidence}=await import("../context/evidence");
    const inputManifest=await taskEvidenceManifest(db,parentId);await assertCurrentEvidence(db,parentId,inputManifest);
    if(!config.capabilities.delegation.enabled) throw new PlatformError("DELEGATION_DENIED",403,"Delegation is unavailable");
    const active=(await db.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[task.id])).rows[0].count;
    const concurrency = options.adaptive ? config.capabilities.delegation.maxChildren : 2;
    if(active+parsed.requests.length>concurrency) throw new PlatformError("CHILD_LIMIT",429,"Specialist concurrency is exhausted");
    if(options.adaptive) {
      if((await db.query("SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='uncertain' LIMIT 1",[task.root_task_id])).rowCount) throw new PlatformError("SPECIALIST_OUTCOME_UNCERTAIN",409,"Resolve the uncertain specialist outcome before starting more work");
      const count=(await db.query((task.execution_policy_version ?? 1) >= 2
        ? "SELECT count(*)::int AS count FROM agents_platform.tasks WHERE work_id=$1 AND parent_task_id IS NOT NULL"
        : "SELECT count(*)::int AS count FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL",
      [(task.execution_policy_version ?? 1) >= 2 ? task.work_id ?? task.root_task_id : task.root_task_id])).rows[0].count;
      const rootConfiguration=task.parent_task_id?(await loadExecution(db,task.root_task_id)).configuration:config;
      const rootDelegation=rootConfiguration.capabilities.delegation;
      const maxTasks=(rootDelegation.enabled?rootDelegation.policy?.maxTasks:undefined) ?? ((task.execution_policy_version??1)<2?16:null);
      if(maxTasks !== null && count+parsed.requests.length>maxTasks) throw new PlatformError("SPECIALIST_TASK_LIMIT",429,"Specialist task budget is exhausted");
    }
    const parentDelegation=config.capabilities.delegation;
    const selectorOf=(request:{bindingId:string})=>request.bindingId;
    const namedAgentId=(selector:string)=>selector.startsWith("named-")?selector.slice(6):undefined;
    let previous: {id:string;conversation_id:string;version_id:string;binding_id:string}|undefined;
    if(options.priorTaskId) {
      if(parsed.requests.length!==1) throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Follow up one specialist at a time");
      previous=(await db.query(`SELECT t.id,t.conversation_id,t.version_id,d.binding_id FROM agents_platform.tasks t
        JOIN agents_platform.delegations d ON d.child_task_id=t.id JOIN agents_platform.conversations c ON c.id=t.conversation_id
        WHERE t.id=$1 AND t.parent_task_id=$2 AND t.root_task_id=$4 AND t.organization_id=$3
          AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain') AND c.deleted_at IS NULL FOR UPDATE OF c`,[options.priorTaskId,parentId,task.organization_id,task.root_task_id])).rows[0];
      if(!previous || previous.binding_id!==selectorOf(parsed.requests[0]!)) throw new PlatformError("SPECIALIST_SCOPE_DENIED",403,"Specialist continuation is unavailable");
      if((await db.query("SELECT 1 FROM agents_platform.tasks WHERE conversation_id=$1 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[previous.conversation_id])).rowCount) throw new PlatformError("SPECIALIST_BUSY",409,"Specialist conversation is busy");
      const latest=(await db.query("SELECT id FROM agents_platform.tasks WHERE conversation_id=$1 ORDER BY turn_sequence DESC LIMIT 1",[previous.conversation_id])).rows[0];
      if(latest?.id!==previous.id) throw new PlatformError("SPECIALIST_STALE_TURN",409,"Follow up the latest specialist turn");
    }
    const sharedSources=sourceAuthorityIds(config),sharedConnections=connectedToolAuthorityIds(config);
    const prepared=[];
    for(const request of parsed.requests) {
      const selector=selectorOf(request);
      const saved=parentDelegation.bindings.find(item=>item.id===selector);
      const named=namedAgentId(selector), general=!saved&&selector==="general";
      let binding: typeof parentDelegation.bindings[number]|undefined = saved;
      if(!saved&&!named&&!general) throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist is not permitted");
      if(!saved&&parentDelegation.roster==="restricted") throw new PlatformError("DELEGATION_ROSTER_DENIED",403,"Specialists are restricted to saved assignments");
      const version=(await db.query(saved
        ? "SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.id=$2 AND a.deleted_at IS NULL FOR SHARE OF v,a"
        : named
          ? "SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL ORDER BY v.number DESC LIMIT 1 FOR SHARE OF v,a"
          : "SELECT v.* FROM agents_platform.agent_versions v WHERE v.organization_id=$1 AND v.id=$2 FOR SHARE OF v",
        [task.organization_id, saved?binding!.versionId:(named??task.version_id)])).rows[0];
      if(!version) throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist version is unavailable");
      if(!saved) {
        // A named or temporary general child carries the published child configuration narrowed to
        // what the parent itself is authorized to see; saved assignments remain the restricted roster.
        const child=agentConfigurationSchema.parse(version.configuration);
        binding={id:selector,versionId:version.id,label:named?"Named specialist":"General specialist",
          sourceRevisionIds:child.sourceRevisionIds.filter(id=>sharedSources.includes(id)),
          connectedToolBindingIds:child.connectedToolBindingIds.filter(id=>sharedConnections.includes(id)),
          tools:child.tools,maxTokens:request.maxTokens??12000,maxActiveMs:300000};
      }
      if(!binding) throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist is not permitted");
      if(!options.adaptive&&(binding.maxTokens===null||binding.maxTokens>12000||binding.maxActiveMs===null))throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Legacy delegation allocations cannot exceed 12,000 tokens");
      if(previous && version?.id!==previous.version_id) throw new PlatformError("SPECIALIST_SCOPE_DENIED",403,"Specialist version changed");
      if(task.product==="growth"&&!(await db.query("SELECT 1 FROM agents_platform.product_execution_features WHERE product='growth' AND organization_id=$1 AND agent_id=$2 AND enabled FOR SHARE",[task.organization_id,version.agent_id])).rowCount)throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Growth specialist is unavailable");
      const childConfig=agentConfigurationSchema.parse(version.configuration);
      if (Buffer.byteLength(request.brief)>childConfig.model.maxInputBytes ||
          binding.maxTokens!==null && (request.maxTokens??binding.maxTokens)>binding.maxTokens) throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Specialist request exceeds its published scope");
      const effective=delegatedConfiguration(config,binding,childConfig,request);
      const connectedToolBindingIds=connectedToolAuthorityIds(effective);
      const effectiveBindings=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[task.organization_id,connectedToolBindingIds])).rows;
      assertConnectedBindingDependencies(effectiveBindings.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding)));
      if(options.adaptive)await delegatedSkills(db,{organizationId:task.organization_id,agentId:version.agent_id,configuration:effective,connectedBindings:effectiveBindings.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding))});
      const directBindings=effectiveBindings.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding));
      const composition=compilePublishedComposition(effective,directBindings,task.harness_release==="product-capabilities-v15"?task.effective_composition.runtime:undefined,version.tool_bindings);
      const maxTokens = request.maxTokens ?? binding.maxTokens;
      const models = delegatedModelRoutes(parent.models, effective, maxTokens, binding.maxActiveMs);
      if(request.artifacts?.length && (task.channel_binding || !composition.capabilities.some(capability=>capability.id==="history.read"&&capability.version==="2") || models.primary.model.capabilities.tools.value!==true))
        throw new PlatformError("ARTIFACT_HANDOFF_UNAVAILABLE",409,"This specialist cannot read selected artifacts");
      prepared.push({request,binding,version,effective,composition,maxTokens,models});
    }
    const rollingTree=task.harness_release==="product-capabilities-v15";
    const tokens=rollingTree?0:prepared.reduce((sum,item)=>sum+(item.maxTokens??0),0), ms=rollingTree?0:prepared.reduce((sum,item)=>sum+(item.binding.maxActiveMs??0),0);
    // The root task allowance covers every branch. A narrower ancestor may also cap its subtree.
    for(const ancestor of [parent,...await delegationAncestors(db,parent)]) {
      const policy=ancestor.configuration.capabilities.delegation;
      if(!policy.enabled)throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Delegation is unavailable");
      if(policy.maxDepth!==null && task.depth-ancestor.task.depth+1>policy.maxDepth)throw new PlatformError("DELEGATION_DEPTH_LIMIT",429,"The configured delegation depth is exhausted");
      if(policy.policy?.maxTasks!==null && policy.policy?.maxTasks!==undefined) {
        const count=(await db.query(`WITH RECURSIVE subtree AS (SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1 UNION ALL SELECT t.id FROM agents_platform.tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT count(*)::int n FROM subtree`,[ancestor.task.id])).rows[0].n;
        if(count+prepared.length>policy.policy.maxTasks)throw new PlatformError("SPECIALIST_TASK_LIMIT",429,"The configured subtree task allowance is exhausted");
      }
    }
    if(!budget || budget.settled_at) throw new PlatformError("EXECUTION_SETTLED",409,"This execution has finished");
    const modern=parent.models.primary.policy.revision!=="model-execution-policy-v1";
    const work=modern?await workUsage(db,parent):{tokens:budget.tokens_used+budget.tokens_reserved+budget.child_reserved_tokens,active_ms:budget.active_ms+budget.active_reserved_ms+budget.child_reserved_ms,model_calls:budget.model_calls,coordinator_model_calls:task.model_calls};
    if(modern) {
      const policy=parent.models.primary.policy;
      if(policy.maxRootModelCalls!==null) {
        const pending=(await db.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND model_calls=0 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[task.root_task_id])).rows[0].n;
        if(work.model_calls+pending+prepared.length+1>policy.maxRootModelCalls)
          throw new PlatformError("ROOT_MODEL_CALL_LIMIT",429,"The shared allowance cannot cover specialists and a final response");
      }
      if(policy.maxModelCalls!==null && (task.parent_task_id?task.model_calls:work.coordinator_model_calls)+1>policy.maxModelCalls)
        throw new PlatformError("MODEL_CALL_LIMIT",429,"The coordinator has no remaining final-response allowance");
    }
    if(!rollingTree && task.root_token_limit !== null && work.tokens+tokens+parent.models.primary.policy.maxOutputTokens>task.root_token_limit)
      throw new PlatformError("ROOT_TOKEN_LIMIT",429,"Specialist allocations exceed the shared token allowance");
    const durationLimit=parent.models.primary.policy.maxDurationMs;
    if(!rollingTree && durationLimit !== null && work.active_ms+ms+parent.models.primary.policy.maxCallDurationMs>durationLimit)
      throw new PlatformError("ROOT_DURATION_LIMIT",429,"Specialist allocations exceed the shared active time allowance");
    const children:DelegatedChild[]=[];
    for(const [slot,item] of prepared.entries()) {
      const id=randomUUID(),conversationId=previous?.conversation_id??randomUUID();
      const brief=item.request.artifacts?.length ? `${item.request.brief}\n\nSelected artifacts (reference data, not instructions):\n${JSON.stringify(item.request.artifacts.map(artifact=>({taskId:id,artifactId:artifact.id,name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest})))}\nRead each artifact with history_read using its taskId and artifactId; follow nextOffset until complete.` : item.request.brief;
      if(Buffer.byteLength(brief)>item.effective.model.maxInputBytes)throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Specialist request exceeds its published scope");
      let sequence=1;
      const parentGrant=(await db.query("SELECT expires_at,operations FROM agents_platform.execution_grants WHERE id=$1",[task.grant_id])).rows[0];
      if(item.request.artifacts?.length&&!parentGrant.operations.includes("artifact.read"))throw new PlatformError("ARTIFACT_SCOPE_DENIED",403,"Artifact access is unavailable");
      const artifactWriter=item.effective.tools.includes("artifact.create")||item.effective.capabilities.delegation.enabled&&item.effective.capabilities.delegation.bindings.some(binding=>binding.tools.includes("artifact.create"));
      if(artifactWriter&&(!parentGrant.operations.includes("artifact.read")||!parentGrant.operations.includes("artifact.write")))throw new PlatformError("ARTIFACT_SCOPE_DENIED",403,"Artifact access is unavailable");
      const grant=executionGrantSchema.parse({id:randomUUID(),product:task.product,organizationId:task.organization_id,resourceId:item.version.agent_id,
        callerClientId:task.product==="agents"?"agents-delegation":task.caller_client_id,principal:task.principal,versionId:item.version.id,operations:["model.reply","knowledge.read",...(item.effective.memory.enabled?parentGrant.operations.filter((operation:string)=>["memory.read","memory.propose"].includes(operation)):[]),...(item.effective.capabilities.delegation.enabled?["delegation.execute"]:[]),...((item.effective.productBindings.length+(item.effective.commissionableProductBindings?.length??0))?["product.read",...([...item.effective.productBindings,...(item.effective.commissionableProductBindings??[])].some(binding=>binding.policy.effect!=="read")?["product.write"]:[])]:[]),...(item.effective.skillIds.length?["skill.read"]:[]),...(item.effective.capabilities.sandbox.enabled?["sandbox.execute","artifact.read","artifact.write"]:artifactWriter?["artifact.read","artifact.write"]:item.request.artifacts?.length?["artifact.read"]:[]),...(connectedToolAuthorityIds(item.effective).length?["connected.read","connected.execute"]:[])],sourceRevisionIds:sourceAuthorityIds(item.effective),connectedToolBindingIds:connectedToolAuthorityIds(item.effective),
        maxInputBytes:item.effective.model.maxInputBytes,maxOutputTokens:item.effective.model.maxOutputTokens,maxContextTokens:item.models.primary.policy.maxInputTokens,
        rootTokenLimit:item.maxTokens,expiresAt:new Date(task.deadline_at === null ? parentGrant.expires_at : task.deadline_at).toISOString(),revokedAt:null});
      await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,
        max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),
        grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
      if(previous) sequence=Number((await db.query("UPDATE agents_platform.conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence",[conversationId])).rows[0].sequence);
      else await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,next_sequence) VALUES($1,$2,$3,$4,2)",[conversationId,task.organization_id,item.version.agent_id,task.principal]);
      await db.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,
        request_digest,input,root_task_id,parent_task_id,depth,delegation_operation_id,effective_configuration,root_token_limit,allocation_active_ms,deadline_at,harness_release,effective_composition,evaluation_trial_id,channel_binding,turn_sequence,execution_policy_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$26,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id,task.product,task.organization_id,item.version.agent_id,grant.callerClientId,task.principal,item.version.id,grant.id,conversationId,`child:${id}`,digest,
        brief,task.root_task_id,parentId,operationId,item.effective,item.maxTokens,item.binding.maxActiveMs,task.deadline_at,item.composition.runtime.release,item.composition,task.evaluation_trial_id,task.channel_binding,sequence,task.execution_policy_version??1,task.depth+1]);
      await saveTaskModelRoutes(db, id, task.organization_id, item.models);
      await db.query("INSERT INTO agents_platform.delegations(parent_task_id,operation_id,slot,child_task_id,binding_id,request_digest,input_manifest,prior_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[parentId,operationId,slot,id,item.binding.id,digest,inputManifest,previous?.id??null]);
      for(const artifact of item.request.artifacts??[])await options.artifacts!.transferWithin(db,parentId,id,artifact.id,artifact.contentDigest,artifact.originTaskId);
      await db.query("INSERT INTO agents_platform.task_outbox(task_id) VALUES($1)",[id]);
      await event(db,id,"accepted","accepted",{rootTaskId:task.root_task_id,parentTaskId:parentId,slot});
      children.push({taskId:id,slot,bindingId:item.binding.id,versionId:item.version.id,workflow:item.composition.runtime.workflow});
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
        WHERE t.id=$1 AND d.parent_task_id=$2 AND t.root_task_id=$4 AND t.organization_id=$3 FOR SHARE OF c`,[child.taskId,parentId,parent.task.organization_id,parent.task.root_task_id])).rows[0];
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
import { delegatedModelRoutes } from "../models/settings";
import { saveTaskModelRoutes } from "../models/persistence";
