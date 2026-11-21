import { GrowthExecutionService } from "./growth-execution";
import { skillPackageCodec } from "../../capabilities/skills/package";
import { ConversationReads } from "../../platform/conversations";
import { planGrowthCapabilityUpgrade, applyGrowthCapabilityUpgrade, growthCapabilityBaseline, growthDefaultCommissions } from "./growth-capability-upgrade";
import { listGrowthModels, authorizeGrowthModelSelection } from "./growth-model-selection";
import { readPublicAgentUpdates } from "./public-agent-activity";
import { projectRecipientText, taskRecipientTextScope, projectWorkProgress, projectRecipientMessages } from "../../execution/context/recipient-text";
import { readProductChildren,observeGrowthTask } from "./growth-observation";
import { readGrowthRuntime } from "./growth-runtime-reporting";
import { orchestrationTools } from "../../contracts/orchestration";
import { queueOrchestrationInstructionInTransaction, readWorkProgress } from "../../execution/delegation/progress";
import { continueWorkInTransaction, workLimitBoundary } from "../../execution/lifecycle/work-continuation";
import { queueChildContinuations } from "../../execution/lifecycle/execution";
import type {ModelDescriptor} from "../../contracts/model-providers";
import { exportProductExecutionCapture } from "../evaluation/product-capture";
import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { GrowthAgentCommand,ProductAgentCommand,GrowthAgentConversation,GrowthAgentFeatureId,GrowthAgentTask,GrowthAgentTaskState,GrowthAgentResult,GrowthAgentContext,GrowthAgentContextEvidence,GrowthAgentPublication,GrowthAgentSpecialist } from "@kasitek-labs/contracts";
import { agentConfigurationSchema,modelSchema,canonicalJson,executionGrantSchema,PlatformError,requestDigest,terminalTaskStates,sourceAuthorityIds,connectedToolAuthorityIds,type AdmissionAuthority } from "../../contracts/contracts";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import type { TaskRecord,VersionRecord } from "../../contracts/records";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { transaction } from "../../infrastructure/database";
import { pageQuery,readPageCursor,finishPage,nextPageCursor } from "../../infrastructure/read-pages";
import { AdmissionStore } from "../../execution/admission/admission-store";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { builtinToolEnabled,publishedToolBindings } from "../../capabilities/tool-definitions";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { modelServicePolicy, executionModelLayers, contextGrantCeiling } from "../../execution/models/settings";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";
import { privateStoreFromEnvironment } from "../../infrastructure/object-store";
import { TaskArtifactStore } from "../../execution/artifacts/task-artifacts";
import { growthDelegationPolicy,growthFeatureConfiguration,growthFeatureProvisionOrder,validateGrowthPublication,assertGrowthOptionalAuthority,assertGrowthConfigurationPreservingConnections } from "./growth-features";
import { agentAvatars, randomAgentAvatar } from "../agents/avatars";
import { assertModelCredentialAvailable } from "../../execution/models/credential-readiness";
import { productAuthorityBindings } from "../../capabilities/products/product-capabilities";
import { MemoryStore, type ProductMemoryManagementScope } from "../../platform/memory";
import { refreshGrowthManagedRoster } from "./growth-managed-roster";
import { rebaseGrowthRuntimeDraft } from "./growth-runtime-binding-plan";
import { rolloutGrowthConnectionBindings } from "./growth-runtime-binding-rollout";
import { growthConnectedPins,pinGrowthConnectedTools } from "./growth-connected-pins";
import type { GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
import { isGrowthResourceOperation } from "@kasitek-labs/contracts";
import { GrowthResourceService } from "./growth-resources";
import { validateProductNativeSelection, pinProductCompositionSources } from "../../capabilities/products/native-selection";
import type { ProductResourceScope } from "../../contracts/resource-scope";
import { SHARED_HARNESS_RELEASE } from "../../contracts/execution";
const absent=():never=>{throw new PlatformError("NOT_FOUND",404,"Conversation or task not found");};
const iso=(value:Date|string)=>new Date(value).toISOString();
const state=(value:string):GrowthAgentTaskState=>value==="running"||value==="waiting_children"||value==="reconciling"?"working":value as GrowthAgentTaskState;
const growthTaskListReadConcurrency=4;
async function mapBounded<T,R>(items:readonly T[],limit:number,visit:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  const results=new Array<R>(items.length);let next=0,failed=false,failure:unknown;
  const worker=async()=>{
    while(!failed){
      const index=next++;if(index>=items.length)return;
      try{results[index]=await visit(items[index]!,index);}
      catch(error){failed=true;failure??=error;return;}
    }
  };
  await Promise.all(Array.from({length:Math.min(items.length,limit)},worker));
  if(failed)throw failure;
  return results;
}

/** Shared conversations, runs, reviews, artifacts and model operations for product backends. */
export class ProductAgentExecutionService extends GrowthExecutionService {
  async execute(raw:ProductAgentCommand):Promise<unknown> {
    const command=raw as any,sharedInput=command.input as Record<string,any>;
    if(sharedInput?.target?.kind==="product_feature")sharedInput.featureId=sharedInput.target.featureId;
    if(sharedInput?.message!==undefined&&sharedInput.text===undefined)sharedInput.text=sharedInput.message;
    await this.tenant(this.pool,command);
    if(["conversations.create","runs.start"].includes(command.operation))
      await this.ensureTenant({tenantId:command.tenantId,upgradeRuntime:true});
    if(command.operation==="models.list"||command.operation==="models.select") {
      await this.authorizeConversation(command,{feature_id:command.input.featureId,context:null});
      if(command.operation==="models.list")return transaction(this.pool,async db=>listGrowthModels(db,await this.feature(db,command,command.input.featureId)));
      return this.withReceipt(command,async db=>{
        const tenant=await this.tenant(db,command);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
        const previous=await this.feature(db,command,command.input.featureId);
        if(previous.revision!==command.input.expectedRevision)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
        const configuration=await authorizeGrowthModelSelection(db,previous,command.input.selection);
        const connected=await growthConnectedPins(db,previous.organization_id,previous.version_id,configuration);
        const versionId=randomUUID(),number=previous.revision+1,service={product:"growth",clientId:"growth-api",issuer:this.trust.issuer};
        await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb",[previous.agent_id,configuration,number,previous.configuration]);
        await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
          VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[versionId,previous.organization_id,previous.agent_id,number,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,connected.direct)]);
        await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1",[previous.version_id,versionId]);
        await pinGrowthConnectedTools(db,previous.organization_id,versionId,connected.ids);
        await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,command.input.featureId,versionId,number]);
        if(command.input.featureId!=="assistant")await refreshGrowthManagedRoster(db,command.tenantId,service);
        return {revision:number};
      });
    }
    switch(command.operation) {
      case "conversations.create":
        await this.authorizeConversation(command,{feature_id:command.input.featureId,context:command.input.context??null});
        return this.withReceipt(command,db=>this.createConversation(db,command,command.input));
      case "conversations.context":
        await this.authorizeConversation(command,{...(await this.conversation(this.pool,command,command.input.conversationId)),context:command.input.context});
        return this.withReceipt(command,async db=>{
        const prior=await this.conversation(db,command,command.input.conversationId);
        return this.createConversation(db,command,{featureId:prior.feature_id,context:command.input.context});
      });
      case "runs.start": {
        const conversation=await this.conversation(this.pool,command,command.input.conversationId),taskId=randomUUID();
        const snapshot=await this.authorizeConversation(command,conversation,"context.read",taskId) as GrowthAgentContextEvidence;
        return this.withReceipt(command,db=>this.submit(db,command,snapshot,taskId));
      }
      case "conversations.list": {
        const {input}=command,scope={kind:"growth-conversations",tenant:command.tenantId,actor:command.actor,featureId:input.featureId??null,search:input.search??""};
        const page=pageQuery.parse(input),cursor=readPageCursor(page.cursor,scope);
        const rows=(await this.pool.query("SELECT p.*,c.created_at FROM agents_platform.product_conversations p JOIN agents_platform.conversations c ON c.id=p.conversation_id WHERE p.product='growth' AND p.tenant_id=$1 AND c.principal=$2::jsonb AND c.deleted_at IS NULL AND ($3::text IS NULL OR p.feature_id=$3) AND p.title ILIKE $4 AND ($5::text='' OR (p.updated_at,p.conversation_id)<($5::timestamptz,$6::uuid)) AND p.updated_at<=$7 ORDER BY p.updated_at DESC,p.conversation_id DESC LIMIT $8",[command.tenantId,JSON.stringify(this.principal(command)),input.featureId??null,"%"+(input.search??"")+"%",cursor.position,cursor.id||null,cursor.snapshot,page.limit+1])).rows;
        const result=finishPage(rows,page.limit,scope,cursor.snapshot,row=>({position:iso(row.updated_at),id:row.conversation_id}));
        const conversations=[];
        for(const row of result.items)try {await this.authorizeConversation(command,row);conversations.push(this.conversationDto(row));}
          catch(error){if(!(error instanceof PlatformError)||![403,404].includes(error.statusCode))throw error;}
        return {conversations,nextCursor:result.nextCursor};
      }
      case "conversations.get": {
        const c=await this.conversation(this.pool,command,command.input.conversationId);
        await this.authorizeConversation(command,c);
        const latest=(await this.pool.query("SELECT id FROM agents_platform.tasks WHERE conversation_id=$1 AND parent_task_id IS NULL ORDER BY turn_sequence DESC LIMIT 1",[c.conversation_id])).rows[0];
        if(!latest)return {conversation:this.conversationDto(c),messages:[],nextCursor:null};
        await this.task(command,latest.id);
        const authority:AdmissionAuthority={product:"growth",organizationId:c.organization_id,resourceId:c.feature_id,callerClientId:"growth-api",principal:this.principal(command)};
        const page=await new ConversationReads(this.pool).getConversationPage(authority,c.conversation_id,pageQuery.parse(command.input));
        const messages=await mapBounded(page.items,growthTaskListReadConcurrency,async task=>{
          const t=await this.task(command,task.id),items:Array<{id:string;role:"user"|"assistant";text:string;createdAt:string;taskId:string;sources?:GrowthAgentTask["sources"]}>=[{id:t.id+":user",role:"user",text:t.input,createdAt:iso(t.created_at),taskId:t.id}];
          const instructions=(await this.pool.query("SELECT sequence,instruction,created_at FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence",[t.id])).rows;
          for(const instruction of instructions)items.push({id:t.id+":instruction:"+instruction.sequence,role:"user",text:instruction.instruction,createdAt:iso(instruction.created_at),taskId:t.id});
          let visible=true;
          try {await assertCurrentEvidence(this.pool,t.id,await taskEvidenceManifest(this.pool,t.id),{requireActiveTask:false});}
          catch(error){if(!(error instanceof PlatformError)||![403,404,409,503].includes(error.statusCode))throw error;visible=false;}
          if(t.output&&visible)items.push({id:t.id+":assistant",role:"assistant",text:t.output,createdAt:iso(t.updated_at),taskId:t.id,sources:t.sources??[]});
          return items;
        });
        return {conversation:this.conversationDto(c),messages:await projectRecipientMessages(this.pool,latest.id,messages.flat()),nextCursor:page.nextCursor};
      }
      case "tasks.export": {
        const task=await this.task(command,command.input.taskId);
        return exportProductExecutionCapture(this.pool,task.id,async(db,id)=>{
          const row=(await db.query("SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.product_execution_features f ON f.product=p.product AND f.tenant_id=p.tenant_id AND f.feature_id=p.feature_id JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id WHERE t.id=$1 AND t.product='growth' AND p.tenant_id=$2 AND t.principal=$3::jsonb AND c.deleted_at IS NULL AND f.enabled AND n.revoked_at IS NULL",[id,command.tenantId,JSON.stringify(this.principal(command))])).rows[0];
          if(!row)throw new PlatformError("PRODUCT_CAPTURE_DENIED",403,"Execution capture is unavailable");
          await this.runtime!.authorizeTask(id);
        });
      }
      case "runs.activity":return observeGrowthTask(this,command as never);
      case "runs.get":return {task:await this.taskDto(await this.task(command,command.input.taskId))};
      case "runs.steer": {
        const task=await this.task(command,command.input.taskId,true);
        const digest=requestDigest({tenantId:command.tenantId,requestId:command.requestId});
        const requestKey=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
        return this.withReceipt(command,db=>queueOrchestrationInstructionInTransaction(db,task.id,{instruction:command.input.instruction,requestKey}));
      }
      case "runs.continue": {
        const task=await this.task(command,command.input.taskId,true);
        const nextId=randomUUID(),terminal=["incomplete","failed"].includes(task.state);
        const snapshot=terminal?await this.authorizeConversation(command,{...(await this.conversation(this.pool,command,task.conversation_id)),context:task.task_context},"context.read",nextId) as GrowthAgentContextEvidence:undefined;
        const result=await this.withReceipt(command,async db=>{
          await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[task.organization_id]);
          const current=(await db.query("SELECT t.*,g.revoked_at,g.operations AS grant_operations,g.source_revision_ids,g.connected_tool_binding_ids,g.max_input_bytes,g.max_output_tokens,g.max_context_tokens FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1 FOR NO KEY UPDATE OF t FOR SHARE OF g",[task.id])).rows[0];
          if(current.revoked_at)throw new PlatformError("GRANT_REVOKED",403,"Execution access was revoked");
          const childNeeds=(await db.query("SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' LIMIT 1",[task.id])).rowCount;
          if(!terminal&&current.state!=="waiting_authority"&&!(current.state==="waiting_children"&&childNeeds))return {accepted:true,taskId:task.id};
          if(current.deadline_at!==null&&new Date(current.deadline_at).getTime()<=Date.now())throw new PlatformError("ROOT_LIMIT",409,"Execution deadline has passed");
          const configuration=agentConfigurationSchema.parse((await db.query("SELECT coalesce($2::jsonb,configuration) configuration FROM agents_platform.agent_versions WHERE id=$1",[current.version_id,current.effective_configuration])).rows[0].configuration);
          const grant=executionGrantSchema.parse({id:randomUUID(),product:"growth",organizationId:current.organization_id,resourceId:current.resource_id,callerClientId:"growth-api",principal:current.principal,versionId:current.version_id,
            operations:current.grant_operations,sourceRevisionIds:current.source_revision_ids,connectedToolBindingIds:current.connected_tool_binding_ids,
            maxInputBytes:Math.min(configuration.model.maxInputBytes,current.max_input_bytes),maxOutputTokens:Math.min(configuration.model.maxOutputTokens,current.max_output_tokens),maxContextTokens:Math.min(contextGrantCeiling(configuration),current.max_context_tokens),rootTokenLimit:current.root_token_limit,expiresAt:new Date(Math.min(Date.now()+30*60_000,current.deadline_at===null?Infinity:new Date(current.deadline_at).getTime())).toISOString(),revokedAt:null});
          await db.query("INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
          await db.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)",[grant.id,grant.organizationId,this.trust.issuer,requestDigest(command)]);
          if(terminal){
            const continued=await continueWorkInTransaction(db,this.store,{priorTaskId:task.id,authority:{product:"growth",organizationId:current.organization_id,resourceId:current.resource_id,callerClientId:"growth-api",principal:current.principal},grantId:grant.id,requestKey:command.requestId,taskId:nextId});
            if(canonicalJson(snapshot!.context)!==canonicalJson(task.task_context))throw new PlatformError("CONVERSATION_CONTEXT_CONFLICT",409,"The selected context changed");
            await db.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,context,context_revision,command_digest,sources,selected_context) VALUES($1,'growth',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(task_id) DO NOTHING",[continued.task.id,command.tenantId,task.feature_id,task.conversation_id,snapshot!.context,snapshot!.revision,requestDigest(command),JSON.stringify([]),task.selected_context]);
            return {accepted:true,taskId:continued.task.id};
          }
          await db.query("UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1,updated_at=now() WHERE id=$1",[task.id,grant.id]);
          if(current.state==="waiting_authority")await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING",[task.id,current.control_generation]);
          return {accepted:true,taskId:task.id};
        }) as {accepted:boolean;taskId:string};
        if(result.taskId===task.id)await queueChildContinuations(this.pool,task.id);
        return {task:await this.taskDto(await this.task(command,result.taskId))};
      }
      case "runs.cancel": {
        const task=await this.task(command,command.input.taskId,true);
        if(!terminalTaskStates.has(task.state))await requestTreeCancellation(this.pool,task.id);
        const current=await this.task(command,task.id,true);
        return {task:{id:current.id,conversationId:current.conversation_id,featureId:current.feature_id,state:state(current.state),input:"",output:null,errorCode:null,
          createdAt:iso(current.created_at),updatedAt:iso(current.updated_at),reviewIds:[],sources:[],results:[]}};
      }
      case "runs.list": {
        const input=command.input,scope={kind:"growth-tasks",tenant:command.tenantId,actor:command.actor,...input,cursor:undefined};
        delete scope.cursor;
        const page=pageQuery.parse(input),cursor=readPageCursor(page.cursor,scope),active=input.state==="active",filter=input.state==="working"?["running","waiting_children","reconciling"]:input.state?[input.state]:null;
        const rows=(await this.pool.query("SELECT t.*,p.feature_id,p.sources FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.id JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE p.tenant_id=$1 AND t.product='growth' AND t.principal=$2::jsonb AND t.parent_task_id IS NULL AND c.deleted_at IS NULL AND ($3::uuid IS NULL OR t.conversation_id=$3) AND ($4::boolean=false OR t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')) AND ($5::text[] IS NULL OR $4 OR t.state=ANY($5)) AND t.input ILIKE $6 AND ($7::text='' OR (t.created_at,t.id)<($7::timestamptz,$8::uuid)) AND t.created_at<=$9 ORDER BY t.created_at DESC,t.id DESC LIMIT $10",[command.tenantId,JSON.stringify(this.principal(command)),input.conversationId??null,active,filter,"%"+(input.search??"")+"%",cursor.position,cursor.id||null,cursor.snapshot,page.limit+1])).rows;
        const result=finishPage(rows,page.limit,scope,cursor.snapshot,row=>({position:iso(row.created_at),id:row.id}));
        const tasks=await mapBounded(result.items,growthTaskListReadConcurrency,async row=>{
          try {await this.task(command,row.id);return await this.taskDto(row);}
          catch(e){if(e instanceof PlatformError&&e.statusCode===403)return null;throw e;}
        });
        return {tasks:tasks.filter((task):task is GrowthAgentTask=>task!==null),nextCursor:result.nextCursor};
      }
      case "runs.events": {
        const task=await this.task(command,command.input.taskId),scope={kind:"growth-events",tenant:command.tenantId,actor:command.actor,task:task.id};
        const page=pageQuery.parse(command.input),cursor=readPageCursor(page.cursor,scope);
        if(cursor.position&&!/^[0-9]{1,19}$/.test(cursor.position))throw new PlatformError("INVALID_CURSOR",400,"Invalid event cursor");
        const rows=(await this.pool.query("SELECT sequence,kind,created_at FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT $3",[task.id,cursor.position||"0",page.limit])).rows;
        const last=rows.at(-1);
        return {events:rows.map(row=>({id:String(row.sequence),taskId:task.id,type:row.kind,createdAt:iso(row.created_at)})),
          nextCursor:last?nextPageCursor({snapshot:new Date().toISOString(),position:String(last.sequence),id:""},scope):page.cursor??null};
      }
      case "reviews.list": {
        const task=await this.task(command,command.input.taskId),rows=(await this.pool.query("SELECT p.task_id,p.projection FROM agents_platform.product_review_projections p JOIN agents_platform.tasks t ON t.id=p.task_id WHERE p.product='growth' AND t.root_task_id=$1 ORDER BY p.updated_at,p.review_id",[task.id])).rows;
        const reviews=[];
        for(const row of rows)reviews.push((await this.runtime!.readReview(row.task_id,row.projection.id)).review);
        return {reviews:[...new Map(reviews.map(review=>[review.id,review])).values()]};
      }
      case "reviews.decide": {
        const tenant=await this.tenant(this.pool,command);
        // Growth callbacks identify the task that proposed the review, which may be a specialist.
        const owner=(await this.pool.query(`SELECT p.task_id,t.root_task_id
          FROM agents_platform.tasks t
          JOIN agents_platform.product_task_contexts context ON context.task_id=t.root_task_id
          JOIN agents_platform.conversations c ON c.id=t.conversation_id
          JOIN agents_platform.product_review_projections p ON p.product='growth' AND p.review_id=$2
          JOIN agents_platform.tasks reviewed ON reviewed.id=p.task_id AND reviewed.root_task_id=t.root_task_id
          WHERE t.id=$1 AND t.product='growth' AND t.organization_id=$3 AND context.product='growth'
            AND context.tenant_id=$4 AND t.principal=$5::jsonb AND reviewed.principal=$5::jsonb
            AND reviewed.organization_id=$3
            AND c.deleted_at IS NULL AND (t.parent_task_id IS NULL OR p.task_id=t.id)`,
        [command.input.taskId,command.input.reviewId,tenant.organization_id,command.tenantId,JSON.stringify(this.principal(command))])).rows[0]??absent();
        await this.task(command,owner.root_task_id,true);
        const review=await this.runtime!.readReviewStatus(owner.task_id,command.input.reviewId);
        const decided=review.state===(command.input.decision==="approve"?"approved":"rejected") || command.input.decision==="approve" && ["saved","succeeded"].includes(review.state);
        if(review.id!==command.input.reviewId||review.payloadDigest!==command.input.payloadDigest||!decided)
          throw new PlatformError("PRODUCT_REVIEW_CONFLICT",409,"The exact Growth review decision could not be verified");
        await transaction(this.pool,async db=>{
          const current=(await db.query("SELECT control_generation FROM agents_platform.tasks WHERE id=$1 FOR UPDATE",[owner.task_id])).rows[0];
          await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1,updated_at=now() WHERE id=$1",[owner.task_id]);
          await db.query("INSERT INTO agents_platform.task_controls(task_id,generation,kind) VALUES($1,$2,'review') ON CONFLICT DO NOTHING",[owner.task_id,current.control_generation]);
        });
        return {reviewId:review.id,state:review.state};
      }
      case "artifacts.list": {
        const task=await this.task(command,command.input.taskId);
        const store=new TaskArtifactStore(this.pool),childId=command.input.childTaskId;
        const rows=childId?await store.listForChild(task.id,childId):await store.listForRoot(task.root_task_id);
        await this.task(command,task.id);
        return {artifacts:rows.map(row=>({id:row.id,title:row.name??"Artifact",mediaType:row.contentType,downloadPath:`/api/agents/tasks/${task.id}/artifacts/${row.id}/download${childId?`?childTaskId=${encodeURIComponent(childId)}`:""}`}))};
      }
      case "artifacts.get": {
        const task=await this.task(command,command.input.taskId);
        const childId=command.input.childTaskId;
        const {artifact:row,content}=await new TaskArtifactStore(this.pool,privateStoreFromEnvironment()).readForProduct(task.id,command.input.artifactId,childId);
        await this.task(command,task.id);
        const offset=command.input.offset??0;
        if(offset>content.byteLength)throw new PlatformError("ARTIFACT_OFFSET_INVALID",400,"Invalid artifact offset");
        const end=Math.min(offset+65536,content.byteLength);
        return {artifact:{id:row.id,title:row.name??"Artifact",mediaType:row.contentType,
          downloadPath:`/api/agents/tasks/${task.id}/artifacts/${row.id}/download${childId?`?childTaskId=${encodeURIComponent(childId)}`:""}`,
          ...(command.input.offset===undefined&&/^(text\/|application\/json)/.test(row.contentType)?{text:new TextDecoder("utf-8").decode(content.slice(0,65536))}:{}),
          ...(command.input.offset===undefined?{}:{chunk:{offset,nextOffset:end<content.byteLength?end:null,bytes:content.byteLength,digest:row.contentDigest,base64:Buffer.from(content.slice(offset,end)).toString("base64")}})}};
      }
    }
  }
}
