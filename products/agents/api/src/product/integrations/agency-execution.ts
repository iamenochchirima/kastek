import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgencyAgentCommand, AgencyAgentConversation, GrowthAgentCommand, GrowthAgentTask } from "@kasitek-labs/contracts";
import { agentConfigurationSchema, canonicalJson, defaultBusinessConfiguration, executionGrantSchema, PlatformError, requestDigest, terminalTaskStates, type AgentConfiguration } from "../../contracts/contracts";
import { createProductBindings, registerProductManifest, sameProductAuthority } from "../../capabilities/products/product-capabilities";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { AdmissionStore } from "../../execution/admission/admission-store";
import { transaction } from "../../infrastructure/database";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { modelServicePolicy, executionModelLayers, contextGrantCeiling } from "../../execution/models/settings";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { assertModelCredentialAvailable } from "../../execution/models/credential-readiness";
import type { ProductRuntime } from "../../execution/products/product-runtime";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { requestTreeCancellationInTransaction, queueChildContinuations } from "../../execution/lifecycle/execution";
import { continueWorkInTransaction } from "../../execution/lifecycle/work-continuation";
import { queueOrchestrationInstructionInTransaction } from "../../execution/delegation/progress";
import { finishPage, pageQuery, readPageCursor } from "../../infrastructure/read-pages";
import { readGrowthRuntime } from "./growth-runtime-reporting";
import { observeProductTask, readProductChildren } from "./growth-observation";
import { readPublicAgentUpdates } from "./public-agent-activity";
import { projectRecipientText, taskRecipientTextScope } from "../../execution/context/recipient-text";
import { MemoryStore, type ProductMemoryManagementScope } from "../../execution/memory/memory";
import { builtinProviderRegistry } from "../../adapters/models/registry";
import { TaskArtifactStore } from "../../execution/artifacts/task-artifacts";
import { privateStoreFromEnvironment } from "../../infrastructure/object-store";

type Db=Pool|PoolClient;
const missing=()=>new PlatformError("NOT_FOUND",404,"Agent conversation or task not found");
const iso=(value:Date|string)=>new Date(value).toISOString();
const clientInstructions="Help the staff member with this Agency client. Use permitted tools for current records. Distinguish facts from suggestions. Ask for missing facts when they are necessary, and never invent client details. Only report an action as completed when its receipt confirms it.";
const legacyAgencyContext={maxInputTokens:8192,compactAtTokens:6144} as const;
const defaultAgencyContexts:AgentConfiguration["context"][]=[{mode:"automatic"},legacyAgencyContext];
function matchesManagedAgencyDefault(configuration:AgentConfiguration,binding:AgentConfiguration["productBindings"][number],includeArtifact:boolean,context:AgentConfiguration["context"]):boolean{
  const expected=defaultBusinessConfiguration();expected.program={id:"tool-directed",version:"4"};expected.instructions=clientInstructions;
  expected.model.selection=configuration.model.selection;expected.memory=configuration.memory;expected.context=context;
  expected.tools=[...(configuration.memory.enabled?["memory.search","memory.propose"] as const:[]),...(includeArtifact?["artifact.create"] as const:[])];
  expected.productBindings=[binding];return canonicalJson(configuration)===canonicalJson(expected);
}
function matchesManagedAgencyContextDefault(configuration:AgentConfiguration,binding:AgentConfiguration["productBindings"][number],context:AgentConfiguration["context"]):boolean{
  const expected=defaultBusinessConfiguration();expected.program={id:"tool-directed",version:"4"};expected.instructions=clientInstructions;
  expected.model=configuration.model;expected.memory=configuration.memory;expected.context=context;expected.tools=configuration.tools;
  expected.productBindings=[binding];return canonicalJson(configuration)===canonicalJson(expected);
}
function hasLegacyAgencyContext(configuration:AgentConfiguration):boolean{return canonicalJson(configuration.context)===canonicalJson(legacyAgencyContext);}
export function agencyFeatureId(command:Pick<AgencyAgentCommand,"actor"|"clientId">):string {
  return "client-"+requestDigest({clientId:command.clientId,actor:command.actor});
}
export class AgencyExecutionService {
  readonly store:AdmissionStore;
  constructor(readonly pool:Pool,readonly issuer:string,readonly runtime:ProductRuntime){this.store=new AdmissionStore(pool);}
  principal(command:Pick<AgencyAgentCommand,"actor">){return {kind:"human" as const,...command.actor};}
  async tenant(db:Db,command:AgencyAgentCommand){
    const tenant=(await db.query(`SELECT * FROM agents_platform.product_execution_tenants
      WHERE product='agencies' AND tenant_id=$1 AND client_id='agency-api' AND issuer=$2 AND revoked_at IS NULL`,[command.tenantId,this.issuer])).rows[0];
    if(!tenant)throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"Agency execution is unavailable");
    return tenant;
  }
  async feature(db:Db,command:AgencyAgentCommand){
    const row=(await db.query(`SELECT f.*,v.configuration FROM agents_platform.product_execution_features f
      JOIN agents_platform.agent_versions v ON v.id=f.version_id AND v.organization_id=f.organization_id
      WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2 AND f.enabled`,[command.tenantId,agencyFeatureId(command)])).rows[0];
    if(!row)throw new PlatformError("PRODUCT_FEATURE_UNAVAILABLE",409,"Configure the client agent");
    return row;
  }
  async ensure(command:Extract<AgencyAgentCommand,{operation:"tenant.ensure"}>){
    const manifest=registerProductManifest(command.input.manifest);
    if(manifest.product!=="agencies"||manifest.operations.length!==1||manifest.operations[0]!.operation!=="agency.workspace_agents.read")
      throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The Agency capability is unavailable");
    return transaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["agency-tenant:"+command.tenantId]);
      let tenant=(await db.query("SELECT * FROM agents_platform.product_execution_tenants WHERE product='agencies' AND tenant_id=$1",[command.tenantId])).rows[0];
      if(tenant&&(tenant.revoked_at||tenant.client_id!=="agency-api"||tenant.issuer!==this.issuer))throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"Agency execution is unavailable");
      if(!tenant){
        const id=randomUUID();await db.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Agency workspace')",[id]);
        tenant=(await db.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('agencies',$1,$2,'agency-api',$3) RETURNING *",[command.tenantId,id,this.issuer])).rows[0];
      }
      const previous=(await db.query("SELECT digest FROM agents_platform.product_capability_publications WHERE product='agencies' AND tenant_id=$1 AND revision=$2",[command.tenantId,manifest.revision])).rows[0];
      if(previous&&previous.digest!==manifest.digest)throw new PlatformError("PRODUCT_MANIFEST_CONFLICT",409,"The published Agency revision changed");
      await db.query("INSERT INTO agents_platform.product_capability_publications(product,tenant_id,revision,digest,manifest) VALUES('agencies',$1,$2,$3,$4) ON CONFLICT DO NOTHING",[command.tenantId,manifest.revision,manifest.digest,manifest]);
      let existing=(await db.query(`SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id
        WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[command.tenantId,agencyFeatureId(command)])).rows[0];
      if(existing){
        let configuration=agentConfigurationSchema.parse(existing.configuration);
        let binding=configuration.productBindings.find(binding=>binding.authority?.clientId===command.clientId&&binding.authority.mappingRef===command.input.mappingRef);
        if(!existing.enabled||!binding)throw new PlatformError("PRODUCT_FEATURE_UNAVAILABLE",409,"Client agent setup was changed or disabled");
        if(existing.artifact_rollout_revision===0||hasLegacyAgencyContext(configuration)){
          await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[existing.organization_id]);
          existing=(await db.query(`SELECT f.*,v.configuration,v.draft_revision AS version_draft_revision,
            a.draft,a.draft_revision,a.created_by_service AS agent_owner,v.created_by_service AS version_owner
            FROM agents_platform.product_execution_features f
            JOIN agents_platform.agent_versions v ON v.id=f.version_id AND v.agent_id=f.agent_id
            JOIN agents_platform.agents a ON a.id=f.agent_id AND a.organization_id=f.organization_id AND a.deleted_at IS NULL
            WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2 FOR UPDATE OF f,a`,[command.tenantId,agencyFeatureId(command)])).rows[0];
          if(!existing?.enabled)throw new PlatformError("PRODUCT_FEATURE_UNAVAILABLE",409,"Client agent setup was changed or disabled");
          configuration=agentConfigurationSchema.parse(existing.configuration);
          binding=configuration.productBindings.find(binding=>binding.authority?.clientId===command.clientId&&binding.authority.mappingRef===command.input.mappingRef);
          if(!binding)throw new PlatformError("PRODUCT_FEATURE_UNAVAILABLE",409,"Client agent setup was changed or disabled");
          const managedBinding=binding;
          const service={product:"agencies",clientId:"agency-api",issuer:this.issuer};
          const managed=canonicalJson(existing.agent_owner)===canonicalJson(service)&&canonicalJson(existing.version_owner)===canonicalJson(service);
          if(managed){
            let sameBinding=false;
            try{
              const expected=createProductBindings(manifest,tenant.organization_id,{originProduct:"agencies",originTenantId:command.tenantId,
                tenantId:command.tenantId,clientId:command.clientId,originClientId:command.clientId,mappingRef:command.input.mappingRef,policyRevision:"client-metadata-1"},["agency.workspace_agents.read"])[0]!;
              sameBinding=configuration.productBindings.length===1&&sameProductAuthority(managedBinding,expected);
            }catch(error){if(!(error instanceof PlatformError))throw error;}
            const unchanged=existing.draft_revision===existing.version_draft_revision&&canonicalJson(existing.draft)===canonicalJson(existing.configuration);
            const pins=(await db.query(`SELECT
              EXISTS(SELECT 1 FROM agents_platform.version_sources WHERE version_id=$1) AS has_sources,
              EXISTS(SELECT 1 FROM agents_platform.version_connected_tools WHERE version_id=$1) AS has_connected_tools`,[existing.version_id])).rows[0];
            const hasExternalPins=Boolean(pins.has_sources||pins.has_connected_tools);
            let configurationChanged=false;
            if(existing.artifact_rollout_revision===0&&unchanged&&sameBinding&&!hasExternalPins&&
              defaultAgencyContexts.some(context=>matchesManagedAgencyDefault(configuration,managedBinding,false,context))){
              configuration.tools.push("artifact.create");configurationChanged=true;
            }
            if(unchanged&&sameBinding&&!hasExternalPins&&hasLegacyAgencyContext(configuration)&&
              matchesManagedAgencyContextDefault(configuration,managedBinding,legacyAgencyContext)){
              configuration.context={mode:"automatic"};configurationChanged=true;
            }
            if(configurationChanged){
              const versionId=randomUUID(),draftRevision=existing.draft_revision+1,featureRevision=existing.revision+1;
              const versionNumber=Number((await db.query("SELECT coalesce(max(number),0)+1 AS number FROM agents_platform.agent_versions WHERE agent_id=$1",[existing.agent_id])).rows[0].number);
              await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[existing.agent_id,configuration,draftRevision]);
              await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
                VALUES($1,$2,$3,$4,$5,'business',$6,$7,$8,$9)`,[versionId,existing.organization_id,existing.agent_id,versionNumber,draftRevision,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
              await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,artifact_rollout_revision=CASE WHEN artifact_rollout_revision=0 THEN 1 ELSE artifact_rollout_revision END,updated_at=now() WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,existing.feature_id,versionId,featureRevision]);
            }else if(existing.artifact_rollout_revision===0)
              await db.query("UPDATE agents_platform.product_execution_features SET artifact_rollout_revision=1 WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,existing.feature_id]);
          }
        }
        return {organizationId:tenant.organization_id,featureId:existing.feature_id,binding};
      }
      const configuration=defaultBusinessConfiguration();configuration.program={id:"tool-directed",version:"4"};configuration.tools=["artifact.create"];
      configuration.instructions=clientInstructions;
      configuration.productBindings=createProductBindings(manifest,tenant.organization_id,{originProduct:"agencies",originTenantId:command.tenantId,
        tenantId:command.tenantId,clientId:command.clientId,originClientId:command.clientId,mappingRef:command.input.mappingRef,policyRevision:"client-metadata-1"},["agency.workspace_agents.read"]);
      const agentId=randomUUID(),versionId=randomUUID(),service={product:"agencies",clientId:"agency-api",issuer:this.issuer};
      await db.query("INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by_service) VALUES($1,$2,'Assistant',$3,$4)",[agentId,tenant.organization_id,configuration,service]);
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
        VALUES($1,$2,$3,1,1,'business',$4,$5,$6,$7)`,[versionId,tenant.organization_id,agentId,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
      await db.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id,artifact_rollout_revision) VALUES('agencies',$1,$2,$3,$4,$5,1)",[command.tenantId,agencyFeatureId(command),tenant.organization_id,agentId,versionId]);
      return {organizationId:tenant.organization_id,featureId:agencyFeatureId(command),binding:configuration.productBindings[0]};
    });
  }
  async readiness(command:AgencyAgentCommand){
    return transaction(this.pool,async db=>{
      const tenant=await this.tenant(db,command),feature=await this.feature(db,command),configuration=agentConfigurationSchema.parse(feature.configuration);
      try{
        const route=await resolveAcceptedModelRoutes(db,{organizationId:tenant.organization_id,agentId:feature.agent_id,product:"agencies",selection:configuration.model.selection,
          generation:configuration.model.generation,layers:executionModelLayers(configuration,{id:feature.version_id,maxInputBytes:configuration.model.maxInputBytes,
            maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),rootTokenLimit:modelServicePolicy().maxRootTokens}),requiresTools:configuration.productBindings.length>0});
        await assertModelCredentialAvailable(db,route.primary.binding);
        return {ready:true,memoryEnabled:configuration.memory.enabled,revision:feature.revision,model:{label:route.primary.model.name,provider:route.primary.definition.id,modelId:route.primary.binding.modelId}};
      }catch(error){if(!(error instanceof PlatformError))throw error;return {ready:false,code:error.code,memoryEnabled:configuration.memory.enabled,revision:feature.revision,model:null};}
    });
  }
  async receipt(command:AgencyAgentCommand,perform:(db:PoolClient)=>Promise<unknown>){
    return transaction(this.pool,async db=>{
      await this.tenant(db,command);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["agency-command:"+command.tenantId+":"+command.requestId]);
      const digest=requestDigest(command),old=(await db.query("SELECT request_digest,response FROM agents_platform.product_command_receipts WHERE product='agencies' AND tenant_id=$1 AND request_id=$2",[command.tenantId,command.requestId])).rows[0];
      if(old){if(old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The request identity was used for different input");return old.response;}
      const response=await perform(db);
      await db.query("INSERT INTO agents_platform.product_command_receipts(product,tenant_id,request_id,request_digest,response) VALUES('agencies',$1,$2,$3,$4)",[command.tenantId,command.requestId,digest,response]);return response;
    });
  }
  async conversation(db:Db,command:AgencyAgentCommand,id:string){
    const row=(await db.query(`SELECT p.*,c.organization_id,c.agent_id,c.principal,c.created_at FROM agents_platform.product_conversations p
      JOIN agents_platform.conversations c ON c.id=p.conversation_id
      WHERE p.product='agencies' AND p.tenant_id=$1 AND p.client_id=$2 AND p.feature_id=$3 AND p.conversation_id=$4 AND c.principal=$5::jsonb AND c.deleted_at IS NULL`,
      [command.tenantId,command.clientId,agencyFeatureId(command),id,this.principal(command)])).rows[0];
    if(!row)throw missing();return row;
  }
  conversationDto(row:Record<string,any>):AgencyAgentConversation{return {id:row.conversation_id,clientId:row.client_id,title:row.title,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
  async task(command:AgencyAgentCommand,id:string){
    const tenant=await this.tenant(this.pool,command);
    const row=(await this.pool.query(`SELECT t.*,p.feature_id,p.client_id,p.sources FROM agents_platform.tasks t
      JOIN agents_platform.product_task_contexts p ON p.task_id=t.id JOIN agents_platform.conversations c ON c.id=t.conversation_id
      WHERE t.product='agencies' AND t.organization_id=$1 AND t.id=$2 AND t.principal=$3::jsonb AND t.parent_task_id IS NULL
        AND p.tenant_id=$4 AND p.client_id=$5 AND p.feature_id=$6 AND c.deleted_at IS NULL`,
      [tenant.organization_id,id,this.principal(command),command.tenantId,command.clientId,agencyFeatureId(command)])).rows[0];
    if(!row)throw missing();await this.runtime.authorizeTask(id);return row;
  }
  async taskDto(row:Record<string,any>):Promise<GrowthAgentTask>{
    const dto:GrowthAgentTask={id:row.id,conversationId:row.conversation_id,featureId:"assistant",state:["running","waiting_children","reconciling"].includes(row.state)?"working":row.state,
      input:row.input,output:row.output,errorCode:row.error_code,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),observedAt:new Date().toISOString(),
      workId:row.work_id??row.root_task_id,priorTaskId:row.prior_task_id??null,canSteer:!terminalTaskStates.has(row.state)&&!["cancel_requested","waiting_authority"].includes(row.state),canContinue:row.state==="waiting_authority",sources:row.sources??[]};
    let artifacts:Awaited<ReturnType<TaskArtifactStore["listForRoot"]>>=[];
    try{
      await assertCurrentEvidence(this.pool,row.id,await taskEvidenceManifest(this.pool,row.id),{requireActiveTask:false});
      if((await this.pool.query("SELECT 1 FROM agents_platform.artifacts WHERE root_task_id=$1 AND state='available' LIMIT 1",[row.id])).rowCount)
        artifacts=await new TaskArtifactStore(this.pool,privateStoreFromEnvironment()).listForRoot(row.id);
    }
    catch(error){if(!(error instanceof PlatformError)||![403,404,409,503].includes(error.statusCode))throw error;return {...dto,output:null,errorCode:"EVIDENCE_UNAVAILABLE",sources:[],children:[],updates:[]};}
    if(typeof dto.output==="string")dto.output=projectRecipientText(dto.output,await taskRecipientTextScope(this.pool,row.id,[dto.output]));
    return {...dto,...await readPublicAgentUpdates(this.pool,row.id),children:await readProductChildren(this.pool,row as never,"agencies"),runtime:await readGrowthRuntime(this.pool,row as never,"agencies"),
      results:artifacts.map(artifact=>({id:artifact.id,kind:"artifact" as const,title:artifact.name,artifactId:artifact.id}))};
  }
  async grant(db:PoolClient,command:AgencyAgentCommand,feature:Record<string,any>){
    const configuration=agentConfigurationSchema.parse(feature.configuration);
    const artifactCreation=configuration.tools.includes("artifact.create")||configuration.capabilities.delegation.enabled&&configuration.capabilities.delegation.bindings.some(binding=>binding.tools.includes("artifact.create"));
    const grant=executionGrantSchema.parse({id:randomUUID(),product:"agencies",organizationId:feature.organization_id,
      resourceId:feature.feature_id,callerClientId:"agency-api",principal:this.principal(command),versionId:feature.version_id,operations:["model.reply","product.read",...(configuration.memory.enabled?["memory.read","memory.propose"]:[]),...(artifactCreation?["artifact.read","artifact.write"]:[])],
      maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),
      rootTokenLimit:modelServicePolicy().maxRootTokens,expiresAt:new Date(Date.now()+86400000).toISOString(),revokedAt:null});
    await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,grant.principal,grant.versionId,JSON.stringify(grant.operations),grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt]);
    await db.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'agencies',$2,'agency-api',$3,$4)",[grant.id,feature.organization_id,this.issuer,requestDigest(command)]);
    return {grant,configuration,authority:{product:"agencies" as const,organizationId:feature.organization_id,resourceId:feature.feature_id,callerClientId:"agency-api",principal:this.principal(command)}};
  }
  async execute(command:AgencyAgentCommand):Promise<unknown>{
    if(command.operation==="tenant.ensure")return this.ensure(command);
    await this.tenant(this.pool,command);await this.feature(this.pool,command);
    if(command.operation.startsWith("memory.")){
      const feature=await this.feature(this.pool,command),memory=new MemoryStore(this.pool);
      const scope:ProductMemoryManagementScope={namespace:"product_actor",product:"agencies",tenantId:command.tenantId,clientId:command.clientId,
        organizationId:feature.organization_id,agentId:feature.agent_id,actor:command.actor};
      if(command.operation==="memory.list")return memory.list(scope,command.input);
      if(command.operation==="memory.propose")return memory.proposeManaged(scope,{...command.input,operationId:command.requestId});
      if(command.operation==="memory.mutate")return memory.mutate(scope,command.input.memoryId,{operationId:command.requestId,
        expectedRevision:command.input.expectedRevision,action:command.input.action,
        ...(command.input.content===undefined?{}:{content:command.input.content}),
        ...(command.input.assertion===undefined?{}:{assertion:command.input.assertion})});
      if(command.operation==="memory.configure")return this.receipt(command,async db=>{
        await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[feature.organization_id]);
        const current=await this.feature(db,command);
        if(current.revision!==command.input.expectedRevision)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
        const configuration=agentConfigurationSchema.parse(current.configuration),number=current.revision+1,versionId=randomUUID();
        configuration.memory={enabled:command.input.enabled};configuration.tools=configuration.tools.filter(tool=>!tool.startsWith("memory."));
        if(command.input.enabled)configuration.tools.push("memory.search","memory.propose");
        const service={product:"agencies",clientId:"agency-api",issuer:this.issuer};
        await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1",[current.agent_id,configuration,number]);
        await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
          VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[versionId,current.organization_id,current.agent_id,number,configuration,service,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
        await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,updated_at=now() WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[command.tenantId,current.feature_id,versionId,number]);
        return {memoryEnabled:command.input.enabled,revision:number};
      });
    }
    switch(command.operation){
      case "models.providers":return {providers:builtinProviderRegistry.filter(provider=>provider.adapter.readiness==="installed").map(provider=>({id:provider.id,name:provider.name}))};
      case "readiness.get":return this.readiness(command);
      case "conversations.create":return this.receipt(command,async db=>{
        const feature=await this.feature(db,command),id=randomUUID();
        await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)",[id,feature.organization_id,feature.agent_id,this.principal(command)]);
        await db.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,client_id,title) VALUES($1,'agencies',$2,$3,$4,$5)",[id,command.tenantId,feature.feature_id,command.clientId,command.input.title??"New conversation"]);
        return {conversation:this.conversationDto(await this.conversation(db,command,id))};
      });
      case "conversations.list":{
        const page=pageQuery.parse(command.input),scope={kind:"agency-conversations",tenant:command.tenantId,client:command.clientId,actor:command.actor},cursor=readPageCursor(page.cursor,scope);
        const rows=(await this.pool.query(`SELECT p.*,c.created_at FROM agents_platform.product_conversations p JOIN agents_platform.conversations c ON c.id=p.conversation_id
          WHERE p.product='agencies' AND p.tenant_id=$1 AND p.client_id=$2 AND p.feature_id=$3 AND c.principal=$4::jsonb AND c.deleted_at IS NULL
            AND ($5::text='' OR (p.updated_at,p.conversation_id)<($5::timestamptz,$6::uuid)) AND p.updated_at<=$7
          ORDER BY p.updated_at DESC,p.conversation_id DESC LIMIT $8`,[command.tenantId,command.clientId,agencyFeatureId(command),this.principal(command),cursor.position,cursor.id||null,cursor.snapshot,page.limit+1])).rows;
        const result=finishPage(rows,page.limit,scope,cursor.snapshot,row=>({position:iso(row.updated_at),id:row.conversation_id}));return {conversations:result.items.map(row=>this.conversationDto(row)),nextCursor:result.nextCursor};
      }
      case "conversations.get":{
        const conversation=await this.conversation(this.pool,command,command.input.conversationId),tenant=await this.tenant(this.pool,command);
        if(!(await this.pool.query("SELECT 1 FROM agents_platform.tasks WHERE conversation_id=$1 AND parent_task_id IS NULL LIMIT 1",[conversation.conversation_id])).rowCount)
          return {conversation:this.conversationDto(conversation),messages:[],tasks:[],nextCursor:null};
        const page=await this.store.getConversationPage({product:"agencies",organizationId:tenant.organization_id,resourceId:conversation.feature_id,callerClientId:"agency-api",principal:this.principal(command)},conversation.conversation_id,pageQuery.parse(command.input));
        const messages=[],tasks=[];
        for(const task of page.items){const dto=await this.taskDto(await this.task(command,task.id));tasks.push(dto);messages.push({id:dto.id+":user",role:"user",text:dto.input,taskId:dto.id,createdAt:dto.createdAt});
          for(const instruction of (await this.pool.query("SELECT sequence,instruction,created_at FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence",[dto.id])).rows)
            messages.push({id:`${dto.id}:instruction:${instruction.sequence}`,role:"user",text:instruction.instruction,taskId:dto.id,createdAt:iso(instruction.created_at)});
          if(dto.output)messages.push({id:dto.id+":assistant",role:"assistant",text:dto.output,taskId:dto.id,createdAt:dto.updatedAt,sources:dto.sources});}
        return {conversation:this.conversationDto(conversation),messages,tasks,nextCursor:page.nextCursor};
      }
      case "turns.submit":return this.receipt(command,async db=>{
        const conversation=await this.conversation(db,command,command.input.conversationId),feature=await this.feature(db,command),{grant,authority}=await this.grant(db,command,feature);
        const admitted=await this.store.admitTaskInTransaction(db,{authority,grantId:grant.id,versionId:feature.version_id,input:command.input.text,requestKey:command.requestId,conversationId:conversation.conversation_id,configurationMode:"current"});
        await db.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,client_id,command_digest) VALUES($1,'agencies',$2,$3,$4,$5,$6)",[admitted.task.id,command.tenantId,feature.feature_id,conversation.conversation_id,command.clientId,requestDigest(command)]);
        await db.query("UPDATE agents_platform.product_conversations SET title=CASE WHEN title='New conversation' THEN left($2,80) ELSE title END,updated_at=now() WHERE conversation_id=$1",[conversation.conversation_id,command.input.text]);
        return {task:{id:admitted.task.id,conversationId:admitted.task.conversation_id,featureId:"assistant",state:admitted.task.state,input:admitted.task.input,output:null,errorCode:null,createdAt:iso(admitted.task.created_at),updatedAt:iso(admitted.task.updated_at)}};
      });
      case "tasks.get":return {task:await this.taskDto(await this.task(command,command.input.taskId))};
      case "artifacts.list":{
        const task=await this.task(command,command.input.taskId);
        const store=new TaskArtifactStore(this.pool,privateStoreFromEnvironment());
        const artifacts=command.input.childTaskId?await store.listForChild(task.id,command.input.childTaskId):await store.listForRoot(task.id);
        return {artifacts:artifacts.map(artifact=>({id:artifact.id,title:artifact.name,mediaType:artifact.contentType,
          downloadPath:`/api/clients/${encodeURIComponent(command.clientId)}/agent/tasks/${task.id}/artifacts/${artifact.id}/download${command.input.childTaskId?`?${new URLSearchParams({childTaskId:command.input.childTaskId})}`:""}`}))};
      }
      case "artifacts.get":{
        const task=await this.task(command,command.input.taskId);
        const {artifact,content}=await new TaskArtifactStore(this.pool,privateStoreFromEnvironment()).readForProduct(task.id,command.input.artifactId,command.input.childTaskId);
        const offset=command.input.offset??0;
        if(offset>content.byteLength)throw new PlatformError("ARTIFACT_OFFSET_INVALID",400,"Invalid artifact offset");
        const end=Math.min(offset+65536,content.byteLength);
        return {artifact:{id:artifact.id,title:artifact.name,mediaType:artifact.contentType,
          downloadPath:`/api/clients/${encodeURIComponent(command.clientId)}/agent/tasks/${task.id}/artifacts/${artifact.id}/download${command.input.childTaskId?`?${new URLSearchParams({childTaskId:command.input.childTaskId})}`:""}`,
          ...(command.input.offset===undefined?{text:new TextDecoder("utf-8").decode(content.slice(0,65536))}:{chunk:{offset,nextOffset:end<content.byteLength?end:null,
            bytes:content.byteLength,digest:artifact.contentDigest,base64:Buffer.from(content.slice(offset,end)).toString("base64")}})}};
      }
      case "tasks.observe":{
        const observed={version:command.version,requestId:command.requestId,tenantId:command.tenantId,actor:command.actor,operation:"tasks.observe" as const,input:command.input} as Extract<GrowthAgentCommand,{operation:"tasks.observe"}>;
        return observeProductTask({pool:this.pool,task:(_value,id)=>this.task(command,id),taskDto:row=>this.taskDto(row),principal:()=>this.principal(command),runtime:this.runtime},observed,{product:"agencies",clientId:command.clientId});
      }
      case "tasks.cancel":{const task=await this.task(command,command.input.taskId);return this.receipt(command,async db=>{await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[task.organization_id]);await requestTreeCancellationInTransaction(db,task.id);return {accepted:true,taskId:task.id};});}
      case "tasks.instructions":{const task=await this.task(command,command.input.taskId);return this.receipt(command,async db=>{
        await queueOrchestrationInstructionInTransaction(db,task.id,{instruction:command.input.instruction,requestKey:command.requestId});
        const row=(await db.query("SELECT sequence,instruction,created_at FROM agents_platform.orchestration_instructions WHERE task_id=$1 AND request_key=$2",[task.id,command.requestId])).rows[0];
        return {accepted:true,message:{id:`${task.id}:instruction:${row.sequence}`,role:"user",text:row.instruction,taskId:task.id,createdAt:iso(row.created_at)}};
      });}
      case "tasks.continue":{
        const task=await this.task(command,command.input.taskId);
        const result=await this.receipt(command,async db=>{
          const feature=await this.feature(db,command);
          const pinned=(await db.query("SELECT coalesce($2::jsonb,configuration) AS configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$3",[task.version_id,task.effective_configuration,task.organization_id])).rows[0];
          if(!pinned)throw missing();
          const {grant,authority}=await this.grant(db,command,{...feature,version_id:task.version_id,configuration:pinned.configuration});
          if(["incomplete","failed"].includes(task.state)){
            const continued=await continueWorkInTransaction(db,this.store,{priorTaskId:task.id,authority,grantId:grant.id,requestKey:command.requestId});
            await db.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,client_id,command_digest) VALUES($1,'agencies',$2,$3,$4,$5,$6)",[continued.task.id,command.tenantId,task.feature_id,task.conversation_id,command.clientId,requestDigest(command)]);return {accepted:true,taskId:continued.task.id};
          }
          if(task.state!=="waiting_authority")throw new PlatformError("WORK_CONTINUATION_UNAVAILABLE",409,"This work cannot continue");
          await db.query("UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1,updated_at=now() WHERE id=$1 AND state='waiting_authority'",[task.id,grant.id]);
          await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING",[task.id,task.control_generation]);
          return {accepted:true,taskId:task.id};
        });await queueChildContinuations(this.pool,task.id);return result;
      }
    }
  }
}
