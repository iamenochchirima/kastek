import { skillPackageCodec } from "../../capabilities/skills/package";
import { ConversationReads } from "../../platform/conversations/reads";
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
import type { GrowthAgentCommand,GrowthAgentConversation,GrowthAgentFeatureId,GrowthAgentTask,GrowthAgentTaskState,GrowthAgentResult,GrowthAgentContext,GrowthAgentContextEvidence,GrowthAgentPublication,GrowthAgentSpecialist } from "@kasitek-labs/contracts";
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
import { MemoryStore, type ProductMemoryManagementScope } from "../../platform/memory/memory";
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
type Db=Pool|PoolClient;
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
function resourceReadinessMessage(code:string):string {
  if(code==="SOURCE_SCOPE_DENIED")return "Knowledge unavailable";
  if(code==="RETRIEVAL_PROFILE_UNAVAILABLE")return "Knowledge search unavailable";
  if(code==="SKILL_DISABLED")return "Skill disabled";
  if(code==="SKILL_REVIEW_REQUIRED")return "Skill needs review";
  if(code==="SKILL_REQUIREMENTS_UNAVAILABLE")return "Skill requirements unavailable";
  if(code.startsWith("SKILL_"))return "Skill unavailable";
  return "Resources unavailable";
}
function modelReadinessMessage(code:string):string {
  if(code==="MODEL_CREDENTIAL_REVOKED")return "Model credentials revoked";
  if(code==="MODEL_CREDENTIAL_UNAVAILABLE")return "Model credentials unavailable";
  if(code==="MODEL_DEFAULT_REQUIRED")return "Model not configured";
  if(code==="MODEL_USE_DENIED")return "Model access unavailable";
  if(code==="MODEL_TOOL_SUPPORT_REQUIRED")return "Model tool support unavailable";
  return "Model unavailable";
}
export class GrowthExecutionService {
  readonly store:AdmissionStore;
  constructor(readonly pool:Pool,readonly trust:GrowthServiceTrust,readonly runtime?:GrowthProductRuntime){this.store=new AdmissionStore(pool);}
  principal(command:GrowthAgentCommand){return {kind:"human" as const,...command.actor};}
  async tenant(db:Db,command:{tenantId:string}) {
    const row=(await db.query("SELECT * FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1 AND client_id='growth-api' AND issuer=$2 AND revoked_at IS NULL",[command.tenantId,this.trust.issuer])).rows[0];
    if(!row)throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"Growth agent access is unavailable");
    return row;
  }
  async publication(db:Db,tenantId:string):Promise<GrowthAgentPublication> {
    const row=(await db.query("SELECT publication FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 ORDER BY created_at DESC,revision DESC LIMIT 1",[tenantId])).rows[0];
    if(!row)throw new PlatformError("PRODUCT_MANIFEST_REQUIRED",409,"Growth capability publication is required");
    return validateGrowthPublication(row.publication);
  }
  async ensureTenant(command:{tenantId:string;publication?:GrowthAgentPublication;defaultsRevision?:string;upgradeDefaults?:boolean;upgradeRuntime?:boolean},options:{model?:ModelDescriptor}={}) {
    return transaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["growth-tenant:"+command.tenantId]);
      const old=(await db.query("SELECT * FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1",[command.tenantId])).rows[0];
      if(old&&(old.revoked_at||old.issuer!==this.trust.issuer||old.client_id!=="growth-api"))throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"Growth agent access is unavailable");
      const org=old?.organization_id??randomUUID(),provenance={product:"growth",clientId:"growth-api",issuer:this.trust.issuer};
      if(!old)await db.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,$2)",[org,"Growth business"]);
      if(!old)await db.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,'growth-api',$3)",[command.tenantId,org,this.trust.issuer]);
      const publication=command.publication?validateGrowthPublication(command.publication):await this.publication(db,command.tenantId);
      if(command.defaultsRevision&&publication.manifest.revision!==command.defaultsRevision)throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The default revision does not match its manifest");
      const digest=requestDigest(publication),existing=(await db.query("SELECT digest FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision=$2",[command.tenantId,publication.manifest.revision])).rows[0];
      if(existing&&existing.digest!==digest)throw new PlatformError("PRODUCT_MANIFEST_CONFLICT",409,"The published revision changed");
      await db.query("INSERT INTO agents_platform.growth_capability_publications(tenant_id,revision,digest,publication,issuer) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[command.tenantId,publication.manifest.revision,digest,publication,this.trust.issuer]);
      const delegationPolicy=growthDelegationPolicy(publication);
      for(const feature of growthFeatureProvisionOrder(publication)) {
        let specialists:import("../../contracts/contracts").AgentConfiguration["capabilities"]["delegation"]|undefined;
        const specialistConfigurations=new Map<string,ReturnType<typeof agentConfigurationSchema.parse>>();
        const specialistIds=delegationPolicy?.delegates[feature.id]??[];
        if(specialistIds.length){
          const rows=(await db.query("SELECT f.feature_id,f.version_id,a.name,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agents a ON a.id=f.agent_id JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=ANY($2::text[]) ORDER BY f.feature_id",[command.tenantId,specialistIds])).rows;
          if(rows.length!==specialistIds.length)throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth specialist defaults are incomplete");
          specialists={enabled:true,maxChildren:delegationPolicy!.maxChildren,maxDepth:delegationPolicy!.maxDepth,policy:delegationPolicy!.policy,bindings:specialistIds.map(featureId=>{
            const row=rows.find(value=>value.feature_id===featureId)!;
            const child=agentConfigurationSchema.parse(row.configuration);specialistConfigurations.set(row.version_id,child);
            return{id:row.feature_id,label:row.name,description:publication.presets.find(item=>item.id===row.feature_id)?.description??row.name,versionId:row.version_id,
              sourceRevisionIds:sourceAuthorityIds(child),connectedToolBindingIds:[],tools:child.tools.filter(tool=>["knowledge.search","knowledge.read","memory.search","memory.read","memory.propose","artifact.create","sandbox.analyze"].includes(tool)),
              maxTokens:delegationPolicy!.childLimits.maxTokens,maxActiveMs:delegationPolicy!.childLimits.maxActiveMs};
          })};
        }
        const previous=(await db.query("SELECT f.*,v.configuration,v.effective_composition,v.tool_bindings,v.created_by_service AS version_service,v.draft_revision AS version_draft_revision,a.draft AS current_draft,a.draft_revision,a.created_by_service AS agent_service,a.deleted_at AS agent_deleted_at FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=f.agent_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=$2 FOR UPDATE OF f",[command.tenantId,feature.id])).rows[0];
        if(previous){
          const managed=(previous.managed_configuration_digest?previous.managed_configuration_digest===requestDigest(previous.configuration):previous.revision===1)&&requestDigest(previous.current_draft)===requestDigest(previous.configuration);
          if(command.upgradeDefaults&&previous.managed_defaults_revision!==publication.manifest.revision&&managed){
            const config=growthDefaultCommissions(growthFeatureConfiguration(publication,feature.id,org,command.tenantId,options.model,specialists),specialistConfigurations),versionId=randomUUID(),number=previous.revision+1;
            config.model=modelSchema.parse(previous.configuration.model);
            config.sourceRevisionIds=previous.configuration.sourceRevisionIds;config.skillIds=previous.configuration.skillIds;
            config.memory=previous.configuration.memory;config.retrievalProfile=previous.configuration.retrievalProfile;
            config.tools=[...new Set([...config.tools,...agentConfigurationSchema.parse(previous.configuration).tools.filter(tool=>tool.startsWith("knowledge.")||tool.startsWith("memory."))])];
            assertGrowthOptionalAuthority(config,publication);
            await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[previous.agent_id,config,number]);
            await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,org,previous.agent_id,number,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,[])]);
            await pinProductCompositionSources(db,{product:"growth",tenantId:command.tenantId,organizationId:org},versionId,config);
            await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,managed_defaults_revision=$5,managed_configuration_digest=$6,artifact_rollout_revision=1,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,versionId,number,publication.manifest.revision,requestDigest(config)]);
            await db.query("UPDATE agents_platform.product_execution_features SET managed_capability_baseline=$3 WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,growthCapabilityBaseline(config)]);
          } else if((command.upgradeDefaults||command.upgradeRuntime)&&
            (previous.effective_composition?.runtime?.release!==SHARED_HARNESS_RELEASE ||
              previous.tool_bindings?.some((binding:{name:string;version:string})=>["agents.start","agents.followup"].includes(binding.name)&&["1","2","3"].includes(binding.version)&&
                builtinToolEnabled(agentConfigurationSchema.parse(previous.configuration),binding.name)))) {
            const config=agentConfigurationSchema.parse(previous.configuration),versionId=randomUUID(),number=previous.revision+1;
            const connected=await growthConnectedPins(db,org,previous.version_id,config);
            await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,org,previous.agent_id,number,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,connected.direct)]);
            await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1",[previous.version_id,versionId]);
            await pinGrowthConnectedTools(db,org,versionId,connected.ids);
            await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,versionId,number]);
          } else if(previous.artifact_rollout_revision===0&&previous.enabled&&!previous.agent_deleted_at&&managed&&previous.managed_configuration_digest&&
            previous.draft_revision===previous.version_draft_revision&&previous.agent_service?.product==="growth"&&previous.version_service?.product==="growth"&&
            previous.agent_service?.issuer===this.trust.issuer&&previous.version_service?.issuer===this.trust.issuer){
            const config=agentConfigurationSchema.parse(previous.configuration),versionId=randomUUID(),number=previous.revision+1;
            if(!config.tools.includes("artifact.create"))config.tools.push("artifact.create");
            const connected=await growthConnectedPins(db,org,previous.version_id,config);
            await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[previous.agent_id,config,number]);
            await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,org,previous.agent_id,number,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,connected.direct)]);
            await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1",[previous.version_id,versionId]);
            await pinGrowthConnectedTools(db,org,versionId,connected.ids);
            await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,managed_configuration_digest=$5,artifact_rollout_revision=1,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,versionId,number,requestDigest(config)]);
            await db.query("UPDATE agents_platform.product_execution_features SET managed_capability_baseline=$3 WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,growthCapabilityBaseline(config)]);
          } else if(previous.artifact_rollout_revision===0&&previous.agent_service?.product==="growth"){
            await db.query("UPDATE agents_platform.product_execution_features SET artifact_rollout_revision=1 WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id]);
          }
          continue;
        }
        const agentId=randomUUID(),versionId=randomUUID(),config=growthDefaultCommissions(growthFeatureConfiguration(publication,feature.id,org,command.tenantId,options.model,specialists),specialistConfigurations);
        const used=(await db.query("SELECT a.avatar FROM agents_platform.product_execution_features f JOIN agents_platform.agents a ON a.id=f.agent_id WHERE f.product='growth' AND f.tenant_id=$1",[command.tenantId])).rows.map((row:{avatar:string})=>row.avatar);
        const available=agentAvatars.filter(avatar=>!used.includes(avatar)),avatar=available.length?available[Math.floor(Math.random()*available.length)]!:randomAgentAvatar();
        const offering = feature.id === "assistant" ? "growth-assistant" : null;
        await db.query("INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,created_by_service,offering) VALUES($1,$2,$3,$4,$5,$6,$7)",[agentId,org,feature.name,avatar,config,provenance,offering]);
        await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,1,1,'business',$4,$5,$6,$7)",[versionId,org,agentId,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,[])]);
        await pinProductCompositionSources(db,{product:"growth",tenantId:command.tenantId,organizationId:org},versionId,config);
        await db.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id,managed_defaults_revision,managed_configuration_digest,artifact_rollout_revision) VALUES('growth',$1,$2,$3,$4,$5,$6,$7,1)",[command.tenantId,feature.id,org,agentId,versionId,publication.manifest.revision,requestDigest(config)]);
        await db.query("UPDATE agents_platform.product_execution_features SET managed_capability_baseline=$3 WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,growthCapabilityBaseline(config)]);
      }
      await refreshGrowthManagedRoster(db,command.tenantId,provenance);
      if(command.upgradeRuntime)await rolloutGrowthConnectionBindings(db,command.tenantId,org,publication);
      return this.tenant(db,command);
    });
  }
  async feature(db:Db,command:GrowthAgentCommand,id:GrowthAgentFeatureId) {
    const row=(await db.query("SELECT f.*,v.configuration,a.name AS agent_name,a.avatar AS agent_avatar,a.deleted_at AS agent_deleted_at FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=$2",[command.tenantId,id])).rows[0];
    if(!row)absent();return row;
  }
  private async selectedSpecialists(db:Db,tenantId:string,organizationId:string,config:ReturnType<typeof agentConfigurationSchema.parse>):Promise<GrowthAgentSpecialist[]|undefined> {
    const delegation=config.capabilities.delegation;
    if(!delegation.enabled)return undefined;
    const rows=(await db.query(`SELECT v.id,v.configuration,a.name,a.deleted_at,count(f.feature_id)::int AS mappings,coalesce(bool_or(f.enabled),false) AS enabled FROM agents_platform.agent_versions v
      JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id
      LEFT JOIN agents_platform.product_execution_features f ON f.product='growth' AND f.tenant_id=$1 AND f.organization_id=v.organization_id AND f.agent_id=v.agent_id
      WHERE v.organization_id=$2 AND v.id=ANY($3::uuid[]) GROUP BY v.id,v.configuration,a.name,a.deleted_at`,[tenantId,organizationId,delegation.bindings.map(binding=>binding.versionId)])).rows;
    return delegation.bindings.map(binding=>{
      const row=rows.find(value=>value.id===binding.versionId);
      const state:GrowthAgentSpecialist["state"]=!row||row.deleted_at||!row.mappings?"unavailable":row.enabled?"configured":"disabled";
      const child=row?agentConfigurationSchema.parse(row.configuration):null;
      const memoryEnabled=Boolean(child?.memory.enabled);
      const memoryAvailable=state==="configured"&&config.memory.enabled&&memoryEnabled&&binding.tools.some(name=>name.startsWith("memory."));
      return {id:binding.id,name:binding.label??row?.name??"Specialist",state,memory:{enabled:memoryEnabled,availableToAssistant:memoryAvailable}};
    });
  }
  async features(command:GrowthAgentCommand) {
    return transaction(this.pool,async db=>{
      const tenant=await this.tenant(db,command),features=[];
      for(const def of (await this.publication(db,command.tenantId)).presets) {
        const row=await this.feature(db,command,def.id),config=agentConfigurationSchema.parse(row.configuration),reasons=[];
        let model:null|{label:string;provider:string;modelId:string}=null;
        if(!row.enabled)reasons.push({code:"FEATURE_DISABLED",message:"Agent unavailable"});
        if(row.agent_deleted_at)reasons.push({code:"AGENT_UNAVAILABLE",message:"Agent unavailable"});
        if(!this.runtime)reasons.push({code:"PRODUCT_ACTIONS_UNAVAILABLE",message:"Connect Growth agent services"});
        if(config.sourceRevisionIds.length||config.skillIds.length)try{
          await validateProductNativeSelection(db,{kind:"product_feature",product:"growth",tenantId:command.tenantId,organizationId:tenant.organization_id,agentId:row.agent_id,actor:command.actor,
            service:{issuer:this.trust.issuer,clientId:"growth-api"},authority:"read"},config,false);
        }catch(error){if(error instanceof PlatformError)reasons.push({code:error.code,message:resourceReadinessMessage(error.code)});else throw error;}
        try {
          const route=await resolveAcceptedModelRoutes(db,{organizationId:tenant.organization_id,agentId:row.agent_id,product:"growth",selection:config.model.selection,generation:config.model.generation,layers:executionModelLayers(config,{id:row.version_id,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),rootTokenLimit:modelServicePolicy().maxRootTokens}),requiresTools:config.tools.length>0||config.productBindings.length>0||config.skillIds.length>0});
          await assertModelCredentialAvailable(db,route.primary.binding);
          model={label:route.primary.model.name,provider:route.primary.definition.name,modelId:route.primary.binding.modelId};
        }catch(error){if(error instanceof PlatformError)reasons.push({code:error.code,message:modelReadinessMessage(error.code)});else throw error;}
        const specialists=await this.selectedSpecialists(db,command.tenantId,tenant.organization_id,config);
        features.push({id:def.id,name:row.agent_name??def.name,avatar:row.agent_avatar,description:def.description,ready:reasons.length===0,reasons,model,revision:row.revision,memory:{enabled:config.memory.enabled},...(specialists?{specialists}:{})});
      }
      const model=features.find(f=>f.id==="assistant")?.model;
      return {features,model:model?{label:model.label,ready:true}:null};
    });
  }
  async conversation(db:Db,command:GrowthAgentCommand,id:string) {
    const row=(await db.query("SELECT p.*,c.organization_id,c.agent_id,c.principal,c.created_at FROM agents_platform.product_conversations p JOIN agents_platform.conversations c ON c.id=p.conversation_id WHERE p.product='growth' AND p.tenant_id=$1 AND p.conversation_id=$2 AND c.principal=$3::jsonb AND c.deleted_at IS NULL",[command.tenantId,id,JSON.stringify(this.principal(command))])).rows[0];
    return row??absent();
  }
  conversationDto(row:Record<string,any>):GrowthAgentConversation {
    return {id:row.conversation_id,featureId:row.feature_id,title:row.title,context:row.context,...(row.context_display?{contextDisplay:row.context_display}:{}),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};
  }
  async createConversation(db:PoolClient,command:GrowthAgentCommand,input:{featureId:GrowthAgentFeatureId;title?:string;context?:GrowthAgentContext|null}) {
    const feature=await this.feature(db,command,input.featureId);
    if(!feature.enabled||feature.agent_deleted_at)throw new PlatformError("FEATURE_DISABLED",409,"This agent is unavailable");
    const id=randomUUID();
    await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)",[id,feature.organization_id,feature.agent_id,this.principal(command)]);
    await db.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,title,context) VALUES($1,'growth',$2,$3,$4,$5)",[id,command.tenantId,input.featureId,(input.title??"New conversation").slice(0,200),input.context??null]);
    return {conversation:this.conversationDto(await this.conversation(db,command,id))};
  }
  async authorizeConversation(command:GrowthAgentCommand,conversation:Record<string,any>,operation="authorization.check" as "authorization.check"|"context.read",taskId=randomUUID()) {
    if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
    const context=conversation.context??{kind:"workspace",resourceId:command.tenantId};
    return this.runtime.client.call({version:"1",requestId:randomUUID(),operationId:"preflight:"+command.requestId,
      tenantId:command.tenantId,actor:command.actor,taskId,conversationId:conversation.conversation_id??taskId,
      featureId:conversation.feature_id,context,contextRevision:null,operation,
      input:operation==="context.read"?{context}:{context}} as import("@kasitek-labs/contracts").GrowthAgentAction);
  }
  async withReceipt(command:GrowthAgentCommand,perform:(db:PoolClient)=>Promise<unknown>) {
    return transaction(this.pool,async db=>{
      await this.tenant(db,command);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["growth-command:"+command.tenantId+":"+command.requestId]);
      const digest=requestDigest(command),old=(await db.query("SELECT * FROM agents_platform.product_command_receipts WHERE product='growth' AND tenant_id=$1 AND request_id=$2",[command.tenantId,command.requestId])).rows[0];
      if(old){if(old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The request identity was used for different input");return command.operation==="turns.submit"?{...old.response,replayed:true}:old.response;}
      const response=await perform(db);
      await db.query("INSERT INTO agents_platform.product_command_receipts(product,tenant_id,request_id,request_digest,response) VALUES('growth',$1,$2,$3,$4)",[command.tenantId,command.requestId,digest,response]);
      return response;
    });
  }
  async task(command:GrowthAgentCommand,id:string,control=false) {
    const tenant=await this.tenant(this.pool,command);
    const row=(await this.pool.query("SELECT t.*,p.feature_id,p.sources,p.context AS task_context,p.selected_context FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.id JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.product='growth' AND t.organization_id=$1 AND t.id=$2 AND t.principal=$3::jsonb AND p.tenant_id=$4 AND t.parent_task_id IS NULL AND c.deleted_at IS NULL",[tenant.organization_id,id,JSON.stringify(this.principal(command)),command.tenantId])).rows[0];
    if(!row)absent();
    if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
    if(control)await this.runtime.authorizeControl(id);else await this.runtime.authorizeTask(id);return row;
  }
  async taskDto(row:Record<string,any>):Promise<GrowthAgentTask> {
    const observedAt=new Date().toISOString();
    try {await assertCurrentEvidence(this.pool,row.id,await taskEvidenceManifest(this.pool,row.id),{requireActiveTask:false});}
    catch(error){
      if(!(error instanceof PlatformError)||![403,404,409,503].includes(error.statusCode))throw error;
      return {observedAt,id:row.id,conversationId:row.conversation_id,featureId:row.feature_id,state:state(row.state),input:row.input,output:null,errorCode:"EVIDENCE_UNAVAILABLE",
        createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),reviewIds:[],sources:[],results:[]};
    }
    const projections=(await this.pool.query("SELECT p.task_id,p.projection FROM agents_platform.product_review_projections p JOIN agents_platform.tasks t ON t.id=p.task_id WHERE p.product='growth' AND t.root_task_id=$1 ORDER BY p.updated_at,p.review_id",[row.id])).rows;
    const reviews=[];for(const projected of projections)reviews.push((await this.runtime!.readReview(projected.task_id,projected.projection.id)).review);
    const artifacts=await new TaskArtifactStore(this.pool).listForRoot(row.root_task_id);
    const artifactResults:GrowthAgentResult[]=artifacts.map(artifact=>({id:artifact.id,kind:"artifact",title:artifact.name??"Artifact",artifactId:artifact.id}));
    const admitted=(await this.pool.query("SELECT coalesce(t.effective_configuration,v.configuration) configuration,g.expires_at FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1",[row.id])).rows[0];
    const configuration=admitted?.configuration;
    const adaptive=configuration?.program?.id==="tool-directed"&&configuration?.program?.version==="4"&&configuration?.capabilities?.delegation?.enabled===true;
    const visibleChildren=adaptive?await readProductChildren(this.pool,row as never):[];
    const children=visibleChildren;
    const closed=adaptive&&Boolean((await this.pool.query("SELECT 1 FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[row.id])).rowCount);
    const limitBoundary=["incomplete","failed"].includes(row.state)?await transaction(this.pool,db=>workLimitBoundary(db,row.id)):null;
    const terminalContinuation=!limitBoundary&&["incomplete","failed"].includes(row.state)&&(row.deadline_at===null||new Date(row.deadline_at).getTime()>Date.now())&&
      !(await this.pool.query(`SELECT 1 FROM agents_platform.tasks t WHERE t.work_id=$1 AND
        (t.prior_task_id=$2 OR t.state NOT IN ('completed','incomplete','refused','failed','cancelled') OR
         EXISTS(SELECT 1 FROM agents_platform.operations o WHERE o.task_id=t.id AND o.state IN ('started','uncertain'))) LIMIT 1`,[row.work_id??row.root_task_id,row.id])).rowCount;
    const output=typeof row.output==="string"?projectRecipientText(row.output,await taskRecipientTextScope(this.pool,row.id,[row.output])):row.output;
    return {...await readPublicAgentUpdates(this.pool,row.id),observedAt,id:row.id,conversationId:row.conversation_id,featureId:row.feature_id,state:state(row.state),input:row.input,output,errorCode:row.error_code,
      runtime:await readGrowthRuntime(this.pool,row as Parameters<typeof readGrowthRuntime>[1]),
      workId:row.work_id??row.root_task_id,priorTaskId:row.prior_task_id??null,
      ...(limitBoundary?{boundary:limitBoundary}:row.error_code?{boundary:{reason:row.error_code,scope:row.state==="waiting_authority"?"authority" as const:row.state==="uncertain"?"runtime" as const:"work" as const,policyRevision:null,limit:null,used:null,policySource:null,retryable:terminalContinuation||row.state==="waiting_authority",action:terminalContinuation||row.state==="waiting_authority"?"continue" as const:row.state==="uncertain"?"reconcile" as const:null}}:{}),
      canContinue:terminalContinuation||row.state==="waiting_authority"||row.state==="waiting_children"&&Boolean((await this.pool.query("SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' LIMIT 1",[row.id])).rowCount),
      ...(adaptive?{canSteer:!terminalTaskStates.has(row.state)&&!["cancel_requested","waiting_authority"].includes(row.state)&&new Date(admitted.expires_at).getTime()>Date.now()&&!closed,
        orchestration:await projectWorkProgress(this.pool,row.id,await readWorkProgress(this.pool,row.id)),children:visibleChildren}:{}),
      createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),reviewIds:reviews.map(r=>r.id),sources:row.sources??[],
      results:[...reviews.flatMap(r=>r.kind==="content_draft"&&r.result?.state==="saved"?[{id:r.result.recordId,kind:"draft" as const,title:r.draft.title,route:r.result.route,revision:r.result.revision}]:[]),...artifactResults]};
  }
  async submit(db:PoolClient,command:Extract<GrowthAgentCommand,{operation:"turns.submit"}>,snapshot:GrowthAgentContextEvidence,taskId:string) {
    if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
    const conversation=await this.conversation(db,command,command.input.conversationId),feature=await this.feature(db,command,conversation.feature_id);
    if(!feature.enabled||feature.agent_deleted_at)throw new PlatformError("FEATURE_DISABLED",409,"This agent is unavailable");
    if(command.input.context!==undefined&&canonicalJson(command.input.context)!==canonicalJson(conversation.context))throw new PlatformError("CONVERSATION_CONTEXT_CONFLICT",409,"Start a conversation for the new context");
    const config=agentConfigurationSchema.parse(feature.configuration),grant=executionGrantSchema.parse({
      id:randomUUID(),product:"growth",organizationId:feature.organization_id,resourceId:feature.feature_id,callerClientId:"growth-api",principal:this.principal(command),
      versionId:feature.version_id,operations:["model.reply","product.read",...(sourceAuthorityIds(config).length?["knowledge.read"]:[]),...(config.memory.enabled?["memory.read","memory.propose"]:[]),...(config.skillIds.length?["skill.read"]:[]),...(config.capabilities.delegation.enabled?["delegation.execute"]:[]),...(config.tools.includes("artifact.create")||config.capabilities.delegation.enabled&&config.capabilities.delegation.bindings.some(binding=>binding.tools.includes("artifact.create"))?["artifact.read","artifact.write"]:[]),...(productAuthorityBindings(config).some(b=>b.policy.effect!=="read")?["product.write"]:[])],sourceRevisionIds:sourceAuthorityIds(config),
      maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),
      rootTokenLimit:modelServicePolicy().maxRootTokens,expiresAt:new Date(Date.now()+86400000).toISOString(),revokedAt:null});
    await db.query("INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
    await db.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)",[grant.id,grant.organizationId,this.trust.issuer,requestDigest(command)]);
    const authority:AdmissionAuthority={product:"growth",organizationId:grant.organizationId,resourceId:grant.resourceId,callerClientId:grant.callerClientId,principal:grant.principal};
    const admitted=await this.store.admitTaskInTransaction(db,{authority,taskId,grantId:grant.id,versionId:feature.version_id,input:command.input.text,requestKey:command.requestId,conversationId:conversation.conversation_id,configurationMode:"current"});
    if(canonicalJson(snapshot.context)!==canonicalJson(conversation.context??{kind:"workspace",resourceId:command.tenantId}))throw new PlatformError("CONVERSATION_CONTEXT_CONFLICT",409,"The selected context changed");
    await db.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,context,context_revision,command_digest,sources,selected_context) VALUES($1,'growth',$2,$3,$4,$5,$6,$7,$8,$9)",[admitted.task.id,command.tenantId,feature.feature_id,conversation.conversation_id,snapshot.context,snapshot.revision,requestDigest(command),JSON.stringify([]),conversation.context]);
    await db.query("UPDATE agents_platform.product_conversations SET title=CASE WHEN title='New conversation' THEN left($2,80) ELSE title END,updated_at=now() WHERE conversation_id=$1",[conversation.conversation_id,command.input.text]);
    await db.query("UPDATE agents_platform.product_conversations SET context_display=$2 WHERE conversation_id=$1",[conversation.conversation_id,snapshot.sources[0]?{title:snapshot.sources[0].title,route:snapshot.sources[0].route}:null]);
    return {task:{id:admitted.task.id,conversationId:admitted.task.conversation_id,featureId:feature.feature_id,state:state(admitted.task.state),input:admitted.task.input,output:null,errorCode:null,createdAt:iso(admitted.task.created_at),updatedAt:iso(admitted.task.updated_at)},replayed:false};
  }
  async execute(command:GrowthAgentCommand):Promise<unknown> {
    await this.tenant(this.pool,command);
    if(["features.list","conversations.create","turns.submit"].includes(command.operation))
      await this.ensureTenant({tenantId:command.tenantId,upgradeRuntime:true,
        ...(command.operation==="features.list"&&command.input.publication?{publication:command.input.publication}:{})});
    if(command.operation==="features.upgrade.preview"||command.operation==="features.upgrade.apply") {
      const run=async(db:PoolClient)=>{
        const tenant=await this.tenant(db,command);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
        const currentTenant=(await db.query("SELECT revoked_at FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1 FOR SHARE",[command.tenantId])).rows[0];
        if(!currentTenant||currentTenant.revoked_at)throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"Growth agent access is unavailable");
        if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
        const authorize=async(featureId:GrowthAgentFeatureId)=>this.runtime!.client.call({version:"1",requestId:randomUUID(),operationId:"capability-upgrade:"+command.requestId,tenantId:command.tenantId,actor:command.actor,taskId:command.requestId,conversationId:command.requestId,featureId,context:null,operation:"authorization.check",input:{context:null,manage:true}});
        await authorize(command.input.featureId);
        const scope={tenantId:command.tenantId,featureId:command.input.featureId,publication:command.input.publication,actor:command.actor,issuer:this.trust.issuer};
        const plan=await planGrowthCapabilityUpgrade(db,scope);
        for(const feature of plan.preview.features)if(feature.featureId!==command.input.featureId)await authorize(feature.featureId);
        if(command.operation==="features.upgrade.preview")return plan.preview;
        const resolved=await planGrowthCapabilityUpgrade(db,scope,command.input.resolutions);
        if(resolved.preview.unavailable.length)throw new PlatformError("CAPABILITY_UPGRADE_UNAVAILABLE",409,"The selected capability update is unavailable.");
        resolved.preview=plan.preview;
        return applyGrowthCapabilityUpgrade(db,resolved,command.input,{product:"growth",clientId:"growth-api",issuer:this.trust.issuer},command.tenantId);
      };
      return command.operation==="features.upgrade.preview"?transaction(this.pool,run):this.withReceipt(command,run);
    }
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
        const updated=await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb",[previous.agent_id,configuration,number,previous.configuration]);
        if(!updated.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
        await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
          VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[versionId,previous.organization_id,previous.agent_id,number,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,connected.direct)]);
        await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1",[previous.version_id,versionId]);
        await pinGrowthConnectedTools(db,previous.organization_id,versionId,connected.ids);
        await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,command.input.featureId,versionId,number]);
        if(command.input.featureId!=="assistant")await refreshGrowthManagedRoster(db,command.tenantId,service);
        return {revision:number};
      });
    }
    if(isGrowthResourceOperation(command.operation)) {
      const selected=command as GrowthAgentCommand<import("@kasitek-labs/contracts").GrowthAgentResourceOperation>;
      await this.authorizeConversation(command,{feature_id:selected.input.featureId,context:null});
      const feature=await this.feature(this.pool,command,selected.input.featureId);
      const scope:ProductResourceScope={kind:"product_feature",product:"growth",tenantId:command.tenantId,organizationId:feature.organization_id,agentId:feature.agent_id,
        actor:command.actor,service:{issuer:this.trust.issuer,clientId:"growth-api"},authority:"manage"};
      const resources=new GrowthResourceService(this.pool),publication=await this.publication(this.pool,command.tenantId);
      if(selected.operation==="resources.list"||selected.operation==="resources.preview")return resources.execute(scope,selected,publication);
      return this.withReceipt(command,db=>resources.execute(scope,selected,publication,db));
    }
    if(command.operation==="memory.list"||command.operation==="memory.mutate"||command.operation==="memory.configure"){
      await this.authorizeConversation(command,{feature_id:command.input.featureId,context:null});
      const feature=await this.feature(this.pool,command,command.input.featureId),memory=new MemoryStore(this.pool, skillPackageCodec);
      const scope:ProductMemoryManagementScope={namespace:"product_actor",product:"growth",tenantId:command.tenantId,clientId:null,
        organizationId:feature.organization_id,agentId:feature.agent_id,actor:command.actor};
      if(command.operation==="memory.list"){
        const result=await memory.list(scope,{offset:command.input.offset,limit:command.input.limit});
        return {memories:result.memories,candidates:result.candidates,nextOffset:result.nextOffset,generation:result.generation};
      }
      if(command.operation==="memory.mutate")return memory.mutate(scope,command.input.memoryId,{operationId:command.requestId,
        expectedRevision:command.input.expectedRevision,action:command.input.action,...(command.input.content===undefined?{}:{content:command.input.content}),
        ...(command.input.assertion===undefined?{}:{assertion:command.input.assertion})});
      return this.withReceipt(command,async db=>{
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[feature.organization_id]);
        const previous=await this.feature(db,command,command.input.featureId);
        if(previous.revision!==command.input.expectedRevision)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
        const configuration=agentConfigurationSchema.parse(previous.configuration),publication=await this.publication(db,command.tenantId);
        configuration.memory={enabled:command.input.enabled};configuration.tools=configuration.tools.filter(tool=>!tool.startsWith("memory."));
        if(command.input.enabled)configuration.tools.push("memory.search","memory.propose");
        assertGrowthConfigurationPreservingConnections(configuration,agentConfigurationSchema.parse(previous.configuration),publication);
        const connected=await growthConnectedPins(db,previous.organization_id,previous.version_id,configuration);
        const versionId=randomUUID(),number=previous.revision+1,service={product:"growth",clientId:"growth-api",issuer:this.trust.issuer};
        const updated=await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb",[previous.agent_id,configuration,number,previous.configuration]);
        if(!updated.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
        await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
          VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[versionId,previous.organization_id,previous.agent_id,number,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,connected.direct)]);
        await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1",[previous.version_id,versionId]);
        await pinGrowthConnectedTools(db,previous.organization_id,versionId,connected.ids);
        await db.query(`UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,
          managed_configuration_digest=CASE WHEN managed_configuration_digest=$5 THEN $6 ELSE managed_configuration_digest END,updated_at=now()
          WHERE product='growth' AND tenant_id=$1 AND feature_id=$2`,[command.tenantId,command.input.featureId,versionId,number,requestDigest(previous.configuration),requestDigest(configuration)]);
        if(command.input.featureId!=="assistant")await refreshGrowthManagedRoster(db,command.tenantId,service);
        return {enabled:command.input.enabled,revision:number};
      });
    }
    switch(command.operation) {
      case "features.list":return this.features(command);
      case "features.profile":return this.withReceipt(command,async db=>{
        const feature=await this.feature(db,command,command.input.featureId);
        if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
        await this.runtime.client.call({version:"1",requestId:randomUUID(),operationId:"profile:"+command.requestId,tenantId:command.tenantId,actor:command.actor,taskId:command.requestId,conversationId:command.requestId,featureId:command.input.featureId,context:null,operation:"authorization.check",input:{context:null,manage:true}});
        const row=(await db.query("UPDATE agents_platform.agents SET name=$3,avatar=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING name,avatar",[feature.organization_id,feature.agent_id,command.input.name.trim(),command.input.avatar])).rows[0];
        return row??absent();
      });
      case "features.configure":return this.withReceipt(command,async db=>{
        const tenant=await this.tenant(db,command);
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
        const previous=await this.feature(db,command,command.input.featureId),parsed=agentConfigurationSchema.safeParse(command.input.configuration),publication=await this.publication(db,command.tenantId);
        if(!parsed.success)throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The feature configuration exceeds its authorized capabilities");
        const source=(await db.query(`SELECT source.configuration FROM agents_platform.agent_versions current
          JOIN agents_platform.agent_versions source ON source.id=current.runtime_derived_from AND source.organization_id=current.organization_id AND source.agent_id=current.agent_id
          WHERE current.id=$1 AND current.organization_id=$2`,[previous.version_id,previous.organization_id])).rows[0];
        const configuration=source?rebaseGrowthRuntimeDraft(parsed.data,agentConfigurationSchema.parse(source.configuration),agentConfigurationSchema.parse(previous.configuration)):parsed.data;
        const oldConfig=agentConfigurationSchema.parse(previous.configuration);
        assertGrowthConfigurationPreservingConnections(configuration,oldConfig,publication);
        if(configuration.program.id!=="tool-directed"||!(["3","4"].includes(configuration.program.version))||
          (configuration.capabilities.delegation.enabled&&configuration.program.version!=="4")||
          configuration.tools.some(tool=>!["knowledge.search","knowledge.read","memory.search","memory.read","memory.propose","artifact.create",...(configuration.program.version==="4"?orchestrationTools:[])].includes(tool))||configuration.productBindings.some(binding=>{
          const admitted=oldConfig.productBindings.find(b=>b.id===binding.id&&b.digest===binding.digest);
          return !admitted;
        }))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The feature exceeds its authorized product capabilities");
        await validateProductNativeSelection(db,{kind:"product_feature",product:"growth",tenantId:command.tenantId,organizationId:previous.organization_id,agentId:previous.agent_id,actor:command.actor,service:{issuer:this.trust.issuer,clientId:"growth-api"},authority:"manage"},configuration);
        if(configuration.capabilities.delegation.enabled) {
          for(const binding of configuration.capabilities.delegation.bindings) {
            const admitted=(await db.query("SELECT 1 FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.agent_id=f.agent_id AND v.organization_id=f.organization_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.enabled AND v.id=$2",[command.tenantId,binding.versionId])).rowCount;
            if(!admitted)throw new PlatformError("DELEGATION_BINDING_DENIED",403,"Specialist is not a permitted Growth feature");
          }
        }
        const commissioned=configuration.commissionableProductBindings??[];
        if(commissioned.length){
          const selected=configuration.capabilities.delegation.enabled?configuration.capabilities.delegation.bindings.map(binding=>binding.versionId):[];
          const versions=(await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=ANY($2::uuid[])",[previous.organization_id,selected])).rows;
          const allowed=[...productAuthorityBindings(oldConfig),...versions.flatMap(row=>productAuthorityBindings(agentConfigurationSchema.parse(row.configuration)))];
          if(commissioned.some(binding=>!allowed.some(value=>value.id===binding.id&&value.digest===binding.digest)))throw new PlatformError("DELEGATION_BINDING_DENIED",403,"The commissioned product capability is outside the selected specialists");
        }
        const connectedIds=connectedToolAuthorityIds(configuration);
        const connected=(await db.query(`SELECT b.id,b.binding FROM agents_platform.capability_bindings b
          JOIN agents_platform.version_connected_tools v ON v.organization_id=b.organization_id AND v.binding_id=b.id AND v.version_id=$3
          JOIN agents_platform.connections c ON c.organization_id=b.organization_id AND c.id=b.connection_id AND c.account_id=b.account_id
          JOIN agents_platform.accounts a ON a.id=b.account_id AND a.issuer=$4 AND a.subject=$5
          JOIN agents_platform.memberships m ON m.organization_id=b.organization_id AND m.account_id=b.account_id AND m.revoked_at IS NULL
          WHERE b.organization_id=$1 AND b.id=ANY($2::uuid[]) AND c.state='active' AND c.expires_at>now()
            AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer FOR SHARE OF b,c,m`,[previous.organization_id,connectedIds,previous.version_id,command.actor.issuer,command.actor.subject])).rows;
        if(connected.length!==connectedIds.length)throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"Connected tools are unavailable");
        const directConnected=connected.map(row=>capabilityBindingSchema.parse(row.binding)).filter(binding=>configuration.connectedToolBindingIds.includes(binding.id));
        const versionId=randomUUID(),number=previous.revision+1,provenance={product:"growth",clientId:"growth-control",issuer:this.trust.issuer};
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[previous.organization_id]);
        await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[previous.agent_id,configuration,number]);
        await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,previous.organization_id,previous.agent_id,number,configuration,provenance,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,directConnected)]);
        await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,command.input.featureId,versionId,number]);
        await pinProductCompositionSources(db,{product:"growth",tenantId:command.tenantId,organizationId:previous.organization_id},versionId,configuration);
        if(connectedIds.length)await db.query("INSERT INTO agents_platform.version_connected_tools(organization_id,version_id,binding_id) SELECT $1,$2,unnest($3::uuid[])",[previous.organization_id,versionId,connectedIds]);
        if(command.input.featureId!=="assistant")await refreshGrowthManagedRoster(db,command.tenantId,provenance);
        const def=publication.presets.find(f=>f.id===command.input.featureId)!;
        return {feature:{id:def.id,name:def.name,description:def.description,ready:false,reasons:[{code:"CHECK_READINESS",message:"Refresh agent readiness"}]}};
      });
      case "conversations.create":
        await this.authorizeConversation(command,{feature_id:command.input.featureId,context:command.input.context??null});
        return this.withReceipt(command,db=>this.createConversation(db,command,command.input));
      case "conversations.context":
        await this.authorizeConversation(command,{...(await this.conversation(this.pool,command,command.input.conversationId)),context:command.input.context});
        return this.withReceipt(command,async db=>{
        const prior=await this.conversation(db,command,command.input.conversationId);
        return this.createConversation(db,command,{featureId:prior.feature_id,context:command.input.context});
      });
      case "turns.submit": {
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
      case "tasks.observe":return observeGrowthTask(this,command);
      case "tasks.get":return {task:await this.taskDto(await this.task(command,command.input.taskId))};
      case "tasks.instructions": {
        const task=await this.task(command,command.input.taskId,true);
        const digest=requestDigest({tenantId:command.tenantId,requestId:command.requestId});
        const requestKey=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
        return this.withReceipt(command,db=>queueOrchestrationInstructionInTransaction(db,task.id,{instruction:command.input.instruction,requestKey}));
      }
      case "tasks.continue": {
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
      case "tasks.cancel": {
        const task=await this.task(command,command.input.taskId,true);
        if(!terminalTaskStates.has(task.state))await requestTreeCancellation(this.pool,task.id);
        const current=await this.task(command,task.id,true);
        return {task:{id:current.id,conversationId:current.conversation_id,featureId:current.feature_id,state:state(current.state),input:"",output:null,errorCode:null,
          createdAt:iso(current.created_at),updatedAt:iso(current.updated_at),reviewIds:[],sources:[],results:[]}};
      }
      case "tasks.list": {
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
      case "tasks.events": {
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
