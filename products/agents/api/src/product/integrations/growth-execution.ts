import { exportProductExecutionCapture } from "../evaluation/product-capture";
import { randomUUID,createHash } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { GrowthAgentCommand,GrowthAgentConversation,GrowthAgentFeatureId,GrowthAgentTask,GrowthAgentTaskState,GrowthAgentResult,GrowthAgentContext,GrowthAgentContextEvidence,GrowthAgentPublication } from "@kasitek-labs/contracts";
import { agentConfigurationSchema,canonicalJson,executionGrantSchema,PlatformError,requestDigest,terminalTaskStates,type AdmissionAuthority } from "../../contracts/contracts";
import type { TaskRecord,VersionRecord } from "../../contracts/records";
import { transaction } from "../../infrastructure/database";
import { pageQuery,readPageCursor,finishPage,nextPageCursor } from "../../infrastructure/read-pages";
import { AdmissionStore } from "../../execution/admission/admission-store";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { executionModelLayers } from "../../execution/models/settings";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";
import { privateStoreFromEnvironment } from "../../infrastructure/object-store";
import { growthFeatureConfiguration,validateGrowthPublication,assertGrowthOptionalAuthority } from "./growth-features";
import type { GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
type Db=Pool|PoolClient;
const absent=():never=>{throw new PlatformError("NOT_FOUND",404,"Conversation or task not found");};
const iso=(value:Date|string)=>new Date(value).toISOString();
const state=(value:string):GrowthAgentTaskState=>value==="running"||value==="waiting_children"||value==="reconciling"?"working":value as GrowthAgentTaskState;
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
  async ensureTenant(command:{tenantId:string;publication?:GrowthAgentPublication;defaultsRevision?:string;upgradeDefaults?:boolean}) {
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
      for(const feature of publication.presets) {
        const previous=(await db.query("SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=$2 FOR UPDATE OF f",[command.tenantId,feature.id])).rows[0];
        if(previous){
          if(command.upgradeDefaults&&previous.managed_defaults_revision!==publication.manifest.revision&&
            (previous.managed_configuration_digest?previous.managed_configuration_digest===requestDigest(previous.configuration):previous.revision===1)){
            const config=growthFeatureConfiguration(publication,feature.id,org,command.tenantId),versionId=randomUUID(),number=previous.revision+1;
            config.model=agentConfigurationSchema.parse(previous.configuration).model;
            await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[previous.agent_id,config,number]);
            await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,org,previous.agent_id,number,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,[])]);
            await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,managed_defaults_revision=$5,managed_configuration_digest=$6,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,feature.id,versionId,number,publication.manifest.revision,requestDigest(config)]);
          }
          continue;
        }
        const agentId=randomUUID(),versionId=randomUUID(),config=growthFeatureConfiguration(publication,feature.id,org,command.tenantId);
        await db.query("INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by_service) VALUES($1,$2,$3,$4,$5)",[agentId,org,feature.name,config,provenance]);
        await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,1,1,'business',$4,$5,$6,$7)",[versionId,org,agentId,config,provenance,JSON.stringify(publishedToolBindings(config)),compilePublishedComposition(config,[])]);
        await db.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id,managed_defaults_revision,managed_configuration_digest) VALUES('growth',$1,$2,$3,$4,$5,$6,$7)",[command.tenantId,feature.id,org,agentId,versionId,publication.manifest.revision,requestDigest(config)]);
      }
      return this.tenant(db,command);
    });
  }
  async feature(db:Db,command:GrowthAgentCommand,id:GrowthAgentFeatureId) {
    const row=(await db.query("SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=$2",[command.tenantId,id])).rows[0];
    if(!row)absent();return row;
  }
  async features(command:GrowthAgentCommand) {
    return transaction(this.pool,async db=>{
      const tenant=await this.tenant(db,command),features=[];
      for(const def of (await this.publication(db,command.tenantId)).presets) {
        const row=await this.feature(db,command,def.id),config=agentConfigurationSchema.parse(row.configuration),reasons=[];
        let model:null|{label:string;provider:string;modelId:string}=null;
        if(!row.enabled)reasons.push({code:"FEATURE_DISABLED",message:"Agent unavailable"});
        if(!this.runtime)reasons.push({code:"PRODUCT_ACTIONS_UNAVAILABLE",message:"Connect Growth agent services"});
        try {
          const route=await resolveAcceptedModelRoutes(db,{organizationId:tenant.organization_id,agentId:row.agent_id,product:"growth",selection:config.model.selection,generation:config.model.generation,layers:executionModelLayers(config,{id:row.version_id,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000}),requiresTools:config.tools.length>0||config.productBindings.length>0});
          model={label:route.primary.model.name,provider:route.primary.definition.name,modelId:route.primary.binding.modelId};
        }catch(error){if(error instanceof PlatformError)reasons.push({code:error.code,message:"Configure a Growth model provider"});else throw error;}
        features.push({id:def.id,name:def.name,description:def.description,ready:reasons.length===0,reasons,model});
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
    if(!feature.enabled)throw new PlatformError("FEATURE_DISABLED",409,"This agent is unavailable");
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
    const row=(await this.pool.query("SELECT t.*,p.feature_id,p.sources FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.id JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.product='growth' AND t.organization_id=$1 AND t.id=$2 AND t.principal=$3::jsonb AND p.tenant_id=$4 AND t.parent_task_id IS NULL AND c.deleted_at IS NULL",[tenant.organization_id,id,JSON.stringify(this.principal(command)),command.tenantId])).rows[0];
    if(!row)absent();
    if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
    if(control)await this.runtime.authorizeControl(id);else await this.runtime.authorizeTask(id);return row;
  }
  async taskDto(row:Record<string,any>):Promise<GrowthAgentTask> {
    const projections=(await this.pool.query("SELECT projection FROM agents_platform.product_review_projections WHERE task_id=$1 ORDER BY updated_at,review_id",[row.id])).rows;
    const reviews=[];for(const projected of projections)reviews.push((await this.runtime!.readReview(row.id,projected.projection.id)).review);
    const artifacts=(await this.pool.query("SELECT id,name FROM agents_platform.artifacts WHERE root_task_id=$1 AND state='available' ORDER BY created_at,id LIMIT 100",[row.root_task_id])).rows;
    for(const artifact of artifacts)await this.runtime!.evidence.artifactManifest(this.pool,row.id,artifact.id);
    const artifactResults:GrowthAgentResult[]=artifacts.map(artifact=>({id:artifact.id,kind:"artifact",title:artifact.name??"Artifact",artifactId:artifact.id}));
    return {id:row.id,conversationId:row.conversation_id,featureId:row.feature_id,state:state(row.state),input:row.input,output:row.output,errorCode:row.error_code,
      createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),reviewIds:reviews.map(r=>r.id),sources:row.sources??[],
      results:[...reviews.flatMap(r=>r.result?.state==="saved"?[{id:r.result.recordId,kind:"draft" as const,title:r.draft.title,route:r.result.route,revision:r.result.revision}]:[]),...artifactResults]};
  }
  async submit(db:PoolClient,command:Extract<GrowthAgentCommand,{operation:"turns.submit"}>,snapshot:GrowthAgentContextEvidence,taskId:string) {
    if(!this.runtime)throw new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Growth agent services are unavailable");
    const conversation=await this.conversation(db,command,command.input.conversationId),feature=await this.feature(db,command,conversation.feature_id);
    if(!feature.enabled)throw new PlatformError("FEATURE_DISABLED",409,"This agent is unavailable");
    if(command.input.context!==undefined&&canonicalJson(command.input.context)!==canonicalJson(conversation.context))throw new PlatformError("CONVERSATION_CONTEXT_CONFLICT",409,"Start a conversation for the new context");
    const config=agentConfigurationSchema.parse(feature.configuration),grant=executionGrantSchema.parse({
      id:randomUUID(),product:"growth",organizationId:feature.organization_id,resourceId:feature.feature_id,callerClientId:"growth-api",principal:this.principal(command),
      versionId:feature.version_id,operations:["model.reply","product.read",...(config.productBindings.some(b=>b.policy.effect==="reviewed_write")?["product.write"]:[])],
      maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,
      rootTokenLimit:32000,expiresAt:new Date(Date.now()+86400000).toISOString(),revokedAt:null});
    await db.query("INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
    await db.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)",[grant.id,grant.organizationId,this.trust.issuer,requestDigest(command)]);
    const authority:AdmissionAuthority={product:"growth",organizationId:grant.organizationId,resourceId:grant.resourceId,callerClientId:grant.callerClientId,principal:grant.principal};
    const admitted=await this.store.admitTaskInTransaction(db,{authority,taskId,grantId:grant.id,versionId:feature.version_id,input:command.input.text,requestKey:command.requestId,conversationId:conversation.conversation_id,configurationMode:"current"});
    await db.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,context,context_revision,command_digest,sources) VALUES($1,'growth',$2,$3,$4,$5,$6,$7,$8)",[admitted.task.id,command.tenantId,feature.feature_id,conversation.conversation_id,snapshot.context,snapshot.revision,requestDigest(command),JSON.stringify(snapshot.sources)]);
    await db.query("UPDATE agents_platform.product_conversations SET title=CASE WHEN title='New conversation' THEN left($2,80) ELSE title END,updated_at=now() WHERE conversation_id=$1",[conversation.conversation_id,command.input.text]);
    await db.query("UPDATE agents_platform.product_conversations SET context_display=$2 WHERE conversation_id=$1",[conversation.conversation_id,snapshot.sources[0]?{title:snapshot.sources[0].title,route:snapshot.sources[0].route}:null]);
    return {task:{id:admitted.task.id,conversationId:admitted.task.conversation_id,featureId:feature.feature_id,state:state(admitted.task.state),input:admitted.task.input,output:null,errorCode:null,createdAt:iso(admitted.task.created_at),updatedAt:iso(admitted.task.updated_at)},replayed:false};
  }
  async execute(command:GrowthAgentCommand):Promise<unknown> {
    await this.tenant(this.pool,command);
    switch(command.operation) {
      case "features.list":return this.features(command);
      case "features.configure":return this.withReceipt(command,async db=>{
        const tenant=await this.tenant(db,command);
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
        const previous=await this.feature(db,command,command.input.featureId),configuration=agentConfigurationSchema.parse(command.input.configuration),publication=await this.publication(db,command.tenantId);
        assertGrowthOptionalAuthority(configuration,publication);
        const preset=publication.presets.find(p=>p.id===command.input.featureId)!;
        const oldConfig=agentConfigurationSchema.parse(previous.configuration);
        if(configuration.program.id!=="tool-directed"||configuration.program.version!=="3"||configuration.tools.length||configuration.productBindings.some(binding=>{
          const admitted=oldConfig.productBindings.find(b=>b.id===binding.id&&b.digest===binding.digest);
          return !admitted||!preset.operations.includes(binding.definition.providerOperation);
        }))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The feature exceeds its authorized product capabilities");
        const versionId=randomUUID(),number=previous.revision+1,provenance={product:"growth",clientId:"growth-control",issuer:this.trust.issuer};
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[previous.organization_id]);
        await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[previous.agent_id,configuration,number]);
        await db.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition) VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)",[versionId,previous.organization_id,previous.agent_id,number,configuration,provenance,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
        await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,command.input.featureId,versionId,number]);
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
        const page=await this.store.getConversationPage(authority,c.conversation_id,pageQuery.parse(command.input));
        const messages=[];
        for(const task of page.items){const t=await this.task(command,task.id);messages.push({id:t.id+":user",role:"user",text:t.input,createdAt:iso(t.created_at),taskId:t.id});
          if(t.output)messages.push({id:t.id+":assistant",role:"assistant",text:t.output,createdAt:iso(t.updated_at),taskId:t.id,sources:t.sources??[]});}
        return {conversation:this.conversationDto(c),messages,nextCursor:page.nextCursor};
      }
      case "tasks.export": {
        const task=await this.task(command,command.input.taskId);
        return exportProductExecutionCapture(this.pool,task.id,async(db,id)=>{
          const row=(await db.query("SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.product_execution_features f ON f.product=p.product AND f.tenant_id=p.tenant_id AND f.feature_id=p.feature_id JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id WHERE t.id=$1 AND t.product='growth' AND p.tenant_id=$2 AND t.principal=$3::jsonb AND c.deleted_at IS NULL AND f.enabled AND n.revoked_at IS NULL",[id,command.tenantId,JSON.stringify(this.principal(command))])).rows[0];
          if(!row)throw new PlatformError("PRODUCT_CAPTURE_DENIED",403,"Execution capture is unavailable");
          await this.runtime!.authorizeTask(id);
        });
      }
      case "tasks.get":return {task:await this.taskDto(await this.task(command,command.input.taskId))};
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
        const result=finishPage(rows,page.limit,scope,cursor.snapshot,row=>({position:iso(row.created_at),id:row.id})),tasks=[];
        for(const row of result.items){try {await this.task(command,row.id);tasks.push(await this.taskDto(row));}catch(e){if(!(e instanceof PlatformError)||e.statusCode!==403)throw e;}}
        return {tasks,nextCursor:result.nextCursor};
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
        const task=await this.task(command,command.input.taskId),rows=(await this.pool.query("SELECT projection FROM agents_platform.product_review_projections WHERE task_id=$1 ORDER BY updated_at,review_id",[task.id])).rows;
        const reviews=[];
        for(const row of rows)reviews.push((await this.runtime!.readReview(task.id,row.projection.id)).review);
        return {reviews:[...new Map(reviews.map(review=>[review.id,review])).values()]};
      }
      case "reviews.decide": {
        const task=await this.task(command,command.input.taskId),value=await this.runtime!.readReview(task.id,command.input.reviewId);
        if(value.review.payloadDigest!==command.input.payloadDigest||value.review.state!==(command.input.decision==="approve"?"approved":"rejected")&&value.review.state!=="saved")
          throw new PlatformError("PRODUCT_REVIEW_CONFLICT",409,"The exact Growth review decision could not be verified");
        await transaction(this.pool,async db=>{
          const current=(await db.query("SELECT control_generation FROM agents_platform.tasks WHERE id=$1 FOR UPDATE",[task.id])).rows[0];
          await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1,updated_at=now() WHERE id=$1",[task.id]);
          await db.query("INSERT INTO agents_platform.task_controls(task_id,generation,kind) VALUES($1,$2,'review') ON CONFLICT DO NOTHING",[task.id,current.control_generation]);
        });
        return {reviewId:value.review.id,state:value.review.state};
      }
      case "artifacts.list": {
        const task=await this.task(command,command.input.taskId);
        const rows=(await this.pool.query("SELECT id,name,content_type FROM agents_platform.artifacts WHERE root_task_id=$1 AND state='available' ORDER BY created_at,id LIMIT 100",[task.root_task_id])).rows;
        for(const row of rows)await this.runtime!.evidence.artifactManifest(this.pool,task.id,row.id);
        return {artifacts:rows.map(row=>({id:row.id,title:row.name??"Artifact",mediaType:row.content_type,downloadPath:`/api/agents/tasks/${task.id}/artifacts/${row.id}/download`}))};
      }
      case "artifacts.get": {
        const task=await this.task(command,command.input.taskId);
        const row=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND root_task_id=$2 AND state='available'",[command.input.artifactId,task.root_task_id])).rows[0]??absent();
        const objects=privateStoreFromEnvironment();if(!objects)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
        await this.runtime!.evidence.artifactManifest(this.pool,task.id,row.id);
        const content=await objects.get(row.object_key);
        if(content.byteLength!==row.bytes||createHash("sha256").update(content).digest("hex")!==row.content_digest)throw new PlatformError("ARTIFACT_INTEGRITY",502,"Artifact integrity check failed");
        await this.task(command,task.id);
        await this.runtime!.evidence.artifactManifest(this.pool,task.id,row.id);
        const offset=command.input.offset??0;
        if(offset>content.byteLength)throw new PlatformError("ARTIFACT_OFFSET_INVALID",400,"Invalid artifact offset");
        const end=Math.min(offset+65536,content.byteLength);
        return {artifact:{id:row.id,title:row.name??"Artifact",mediaType:row.content_type,
          downloadPath:`/api/agents/tasks/${task.id}/artifacts/${row.id}/download`,
          ...(command.input.offset===undefined&&/^(text\/|application\/json)/.test(row.content_type)?{text:new TextDecoder("utf-8").decode(content.slice(0,65536))}:{}),
          ...(command.input.offset===undefined?{}:{chunk:{offset,nextOffset:end<content.byteLength?end:null,bytes:content.byteLength,digest:row.content_digest,base64:Buffer.from(content.slice(offset,end)).toString("base64")}})}};
      }
    }
  }
}
