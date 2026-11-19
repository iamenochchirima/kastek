import {dropClosedTestDatabase} from "./support/database-cleanup";
import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import Fastify from "fastify";
import {createServer} from "node:http";
import {generateKeyPair,exportSPKI,exportPKCS8,jwtVerify,SignJWT} from "jose";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {GROWTH_AGENT_PROVISION_PATH,GROWTH_AGENT_PUBLICATION_MAX_BYTES,type GrowthAgentProvisionRequest} from "@kasitek-labs/contracts";
import {GrowthProvisionAuth,GrowthProvisionService,registerGrowthProvisionRoute,growthManagedModelProfileSchema} from "../src/product/integrations/growth-provisioning";
import {GrowthProductRuntime} from "../src/execution/products/growth-runtime";
import {growthInstalledAdapterManifest} from "../src/adapters/products/growth-capability-manifests";
import {GrowthActionClient} from "../src/adapters/products/growth-action-client";
import type {GrowthAgentCapabilityUpgradePreview,GrowthAgentCommand, GrowthAgentPublication,ProductCapabilityDescriptor} from "@kasitek-labs/contracts";
import {GrowthExecutionService} from "../src/product/integrations/growth-execution";
import {delegatedConfiguration} from "../src/execution/delegation/scope";
import {provisionGrowthModel} from "../src/product/integrations/growth-model-provisioning";
import {controlGrowthExecution} from "../src/product/integrations/growth-control";
import {setupPlatformSchema} from "../src/composition/setup";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {requestDigest} from "../src/contracts/contracts";
import {compilePublishedComposition} from "../src/execution/programs/publication";
import {SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME} from "../src/contracts/execution";
import {createProductBindings,productAuthorityBindings} from "../src/capabilities/products/product-capabilities";
import {growthAgentPublication as currentGrowthPublication,growthAgentPublicationV10} from "../../../growth/api/src/agents/manifest";
const issuer="https://growth.fixture.test",profile={id:"growth-default",revision:"1",providerId:"openrouter",modelId:"fixture/default",credentialRef:"FIXTURE_MANAGED_MODEL_KEY"};
function publication(revision="1"):GrowthAgentPublication {
 const descriptor:ProductCapabilityDescriptor={operation:"workspace.read",revision:"1",description:"Read approved fixture context",inputSchema:{type:"object",properties:{},additionalProperties:false},outputSchema:null,handlerRef:"growth.workspace.read@1",requiredAuthority:["feature.agents.manage"],evidence:"versioned_sources",policy:{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"},limits:{timeoutMs:10000,maxPhysicalAttempts:1,maxResponseBytes:131072,maxModelResultBytes:8192}};
 const body={schemaVersion:1 as const,product:"growth",revision,adapter:{id:growthInstalledAdapterManifest.id,release:growthInstalledAdapterManifest.release,manifestDigest:requestDigest(growthInstalledAdapterManifest)},operations:[descriptor]};
 return {manifest:{...body,digest:requestDigest(body)},presets:(["assistant","research","content","campaigns"] as const).map(id=>({id,name:id,description:"Fixture preset",instructions:"Choose permitted tools as needed. Revision "+revision,operations:["workspace.read"]})),policy:{revision,optionalCapabilities:{knowledge:false,skills:false,memory:false,delegation:false,sandbox:false,workflows:false,connections:false}}};
}
const request=(tenantId=randomUUID()):GrowthAgentProvisionRequest=>({version:"1",requestId:randomUUID(),tenantId,publication:publication(),defaultsRevision:"1",modelProfileId:profile.id,modelProfileRevision:profile.revision});
it("current Growth publication reaches provisioning authentication within the bounded HTTP body",async()=>{
  const app=Fastify({bodyLimit:128_000}),input={...request(),publication:currentGrowthPublication};
  registerGrowthProvisionRoute(app,{} as Pool,undefined,{});
  try {
    const accepted=await app.inject({method:"POST",url:GROWTH_AGENT_PROVISION_PATH,payload:input});
    expect(accepted.statusCode).toBe(503);
    expect(accepted.json().message).toBe("Growth provisioning is not configured");
    const oversized=await app.inject({method:"POST",url:GROWTH_AGENT_PROVISION_PATH,payload:{...input,padding:"x".repeat(GROWTH_AGENT_PUBLICATION_MAX_BYTES+200_000)}});
    expect(oversized.statusCode).toBe(413);
  } finally { await app.close(); }
});
it("product lifecycle route is registered, bounded and unconfigured without trust",async()=>{
  const app=Fastify({bodyLimit:128_000});
  registerGrowthProvisionRoute(app,{} as Pool,undefined,{});
  try {
    const envelope={version:"1",requestId:randomUUID(),product:"growth",tenantId:"org",actor:{issuer,subject:"growth-provisioner"},
      operation:"agents.applyPublication",input:{defaultsRevision:"1",modelProfileId:profile.id,modelProfileRevision:profile.revision}};
    const response=await app.inject({method:"POST",url:"/internal/v1/products/growth/lifecycle",payload:envelope});
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe("Product lifecycle is not configured");
    const oversized=await app.inject({method:"POST",url:"/internal/v1/products/growth/lifecycle",payload:{...envelope,padding:"x".repeat(GROWTH_AGENT_PUBLICATION_MAX_BYTES+200_000)}});
    expect(oversized.statusCode).toBe(413);
  } finally { await app.close(); }
});
it("provision authority rejects human command identity, changed payload, foreign audience and expired signatures",async()=>{
  const keys=await generateKeyPair("RS256",{extractable:true}),auth=new GrowthProvisionAuth(issuer,{setup:await exportSPKI(keys.publicKey)}),input=request(),now=Math.floor(Date.now()/1000);
  const token=(sub="growth-provisioner",aud="agents-product-provisioning",start=now)=>new SignJWT({product:"growth",requestDigest:requestDigest(input)})
    .setProtectedHeader({alg:"RS256",kid:"setup"}).setIssuer(issuer).setSubject(sub).setAudience(aud).setIssuedAt(start).setExpirationTime(start+60).setJti(randomUUID()).sign(keys.privateKey);
  await expect(auth.verify(await token(),input)).resolves.toHaveProperty("jti");
  for(const invalid of [await token("growth-api"),await token("growth-control"),await token("growth-provisioner","agents-product-api"),await token("growth-provisioner","agents-product-provisioning",now-180)])await expect(auth.verify(invalid,input)).rejects.toMatchObject({code:"PRODUCT_PROVISION_DENIED"});
  await expect(auth.verify(await token(),{...input,tenantId:randomUUID()})).rejects.toMatchObject({code:"PRODUCT_PROVISION_DENIED"});
});
it("profiles require an explicit protected credential reference and forbid embedded keys",()=>{
  expect(growthManagedModelProfileSchema.safeParse(profile).success).toBe(true);
  expect(growthManagedModelProfileSchema.safeParse({...profile,apiKey:"bad"}).success).toBe(false);
  expect(growthManagedModelProfileSchema.safeParse({...profile,credentialRef:""}).success).toBe(false);
});
const adminUrl=process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl?describe:describe.skip)("automatic Growth defaults in isolated PostgreSQL",()=>{
  const database="agents_growth_defaults_"+randomUUID().replaceAll("-","");
  const vault=new ModelCredentialVault(new ConnectionVault("test",{test:randomBytes(32).toString("base64")}));
  let admin:Pool,pool:Pool,calls=0,active=true,configured:unknown=profile,credential:string|undefined="synthetic-only-key";
  let service:GrowthProvisionService;
  const trust={issuer,actorIssuer:issuer+"/identity",keys:{fixture:"not consumed by execution service"}};
  const discoveryFetch=async()=>{calls++;return {status:200,body:JSON.stringify({data:[{id:profile.modelId,name:"Fixture",context_length:131072,top_provider:{max_completion_tokens:16384},supported_parameters:["tools","max_tokens","temperature"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})};};
  beforeAll(async()=>{
    admin=new Pool({connectionString:adminUrl});await admin.query('CREATE DATABASE "'+database+'"');const url=new URL(adminUrl!);url.pathname="/"+database;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    const key=await generateKeyPair("RS256",{extractable:true});
    new GrowthProductRuntime(pool,new GrowthActionClient({origin:"http://127.0.0.1:9",issuer:"https://agents.fixture.test",keyId:"fixture",privateKey:await exportPKCS8(key.privateKey),environment:"test"}));
    service=new GrowthProvisionService(pool,{trust,vault,profile:()=>configured,credential:()=>credential,active:async()=>active,discoveryFetch});
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("reviews capability-only upgrades with three-way restrictions and customized coordinator pins",async()=>{
    const input={...request(),publication:growthAgentPublicationV10 as GrowthAgentPublication,defaultsRevision:"10"};
    expect(await service.provision(input)).toMatchObject({state:"ready"});
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.product_execution_features WHERE tenant_id=$1 AND managed_capability_baseline IS NOT NULL",[input.tenantId])).rows[0].count).toBe(4);
    await pool.query("UPDATE agents_platform.product_execution_features SET managed_capability_baseline=NULL WHERE tenant_id=$1",[input.tenantId]);
    const rows=(await pool.query(`SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1`,[input.tenantId])).rows;
    const content=rows.find(row=>row.feature_id==="content")!,assistant=rows.find(row=>row.feature_id==="assistant")!;
    const current=structuredClone(content.configuration);current.instructions="My customized content instructions.";current.context={mode:"automatic"};current.memory={enabled:true};current.model.generation={temperature:0.3};
    const denied=current.productBindings.shift()!.definition.providerOperation;current.tools=current.tools.filter((name:string)=>name!=="artifact.create");
    async function customize(feature:any,configuration:any){
      const versionId=randomUUID(),number=feature.revision+1;
      await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
        SELECT $1,organization_id,agent_id,$3,$3,execution_kind,$4,created_by_service,tool_bindings,$5 FROM agents_platform.agent_versions WHERE id=$2`,[versionId,feature.version_id,number,configuration,compilePublishedComposition(configuration,[])]);
      await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3 WHERE id=$1",[feature.agent_id,configuration,number]);
      await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4 WHERE tenant_id=$1 AND feature_id=$2",[input.tenantId,feature.feature_id,versionId,number]);feature.version_id=versionId;feature.revision=number;
    }
    await customize(content,current);
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='content'",[input.tenantId]);
    const parent=structuredClone({...assistant.configuration,instructions:"My customized coordinator."});
    const restrictedRole=parent.capabilities.delegation.bindings.find((binding:any)=>binding.id==="content");restrictedRole.maxTokens=8192;restrictedRole.maxActiveMs=120000;restrictedRole.tools=[];
    await customize(assistant,parent);
    let authorized=true,checks=0;
    const runtime={client:{call:async(action:any)=>{checks++;expect(action.input.manage).toBe(true);if(!authorized)throw Object.assign(new Error("Denied"),{code:"FORBIDDEN"});return {authorized:true};}}} as unknown as GrowthProductRuntime;
    const execution=new GrowthExecutionService(pool,trust,runtime),actor={issuer:trust.actorIssuer,subject:"manager"};
    const command={version:"1" as const,requestId:randomUUID(),tenantId:input.tenantId,actor,operation:"features.upgrade.preview" as const,input:{featureId:"content" as const,publication:currentGrowthPublication as GrowthAgentPublication}};
    async function updateFeature(featureId:"research"|"campaigns"|"assistant"){
      const proposal=await execution.execute({...command,requestId:randomUUID(),input:{...command.input,featureId}}) as GrowthAgentCapabilityUpgradePreview;
      if(!proposal.canApply)return;
      await execution.execute({...command,operation:"features.upgrade.apply",requestId:randomUUID(),input:{...command.input,featureId,targetPublicationDigest:proposal.targetPublicationDigest,diffDigest:proposal.diffDigest,expectedRevisions:proposal.expectedRevisions,resolutions:Object.fromEntries(proposal.conflicts.map(conflict=>[conflict.id,featureId==="assistant"&&conflict.id.startsWith("assistant:specialist:")?"use_update":"keep_current"]))}} as GrowthAgentCommand<"features.upgrade.apply">);
    }
    await updateFeature("research");
    const preview=await execution.execute(command) as GrowthAgentCapabilityUpgradePreview;
    expect(preview.canApply,JSON.stringify(preview.unavailable)).toBe(true);expect(preview.expectedRevisions).toHaveProperty("assistant");
    expect(preview.conflicts.some(conflict=>conflict.id===`content:operation:${denied}`)).toBe(true);expect(preview.conflicts.some(conflict=>conflict.id==="assistant:pin:content")).toBe(true);
    const resolutions=Object.fromEntries(preview.conflicts.map(conflict=>[conflict.id,conflict.id.startsWith("assistant:pin:")?"use_update":"keep_current"]));
    const apply={...command,requestId:randomUUID(),operation:"features.upgrade.apply",input:{...command.input,targetPublicationDigest:preview.targetPublicationDigest,diffDigest:preview.diffDigest,expectedRevisions:preview.expectedRevisions,resolutions}} as GrowthAgentCommand<"features.upgrade.apply">;
    await expect(execution.execute(apply)).rejects.toMatchObject({code:"CAPABILITY_AUTHORITY_LIMIT"});
    apply.requestId=randomUUID();apply.input.resolutions=Object.fromEntries(preview.conflicts.map(conflict=>[conflict.id,"keep_current"]));
    const result=await execution.execute(apply);expect(await execution.execute(apply)).toEqual(result);
    const next=(await pool.query(`SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1`,[input.tenantId])).rows;
    const upgraded=next.find(row=>row.feature_id==="content")!,coordinator=next.find(row=>row.feature_id==="assistant")!;
    expect(upgraded.revision).toBe(content.revision+1);expect(upgraded.enabled).toBe(false);
    for(const field of ["instructions","model","context","memory","sourceRevisionIds","skillIds","retrievalProfile"])expect(upgraded.configuration[field]).toEqual(current[field]);
    expect(upgraded.configuration.productBindings.some((binding:any)=>binding.definition.providerOperation===denied)).toBe(false);
    expect(upgraded.configuration.tools).not.toContain("artifact.create");expect(upgraded.configuration.commissionableProductBindings?.some((binding:any)=>binding.definition.providerOperation===denied)??false).toBe(false);expect(upgraded.configuration.capabilities.delegation.bindings[0].tools).not.toContain("artifact.create");expect(upgraded.configuration.capabilities.delegation.bindings.map((binding:any)=>binding.id)).toEqual(["research"]);
    const research=next.find(row=>row.feature_id==="research")!,researchRole=upgraded.configuration.capabilities.delegation.bindings[0];
    expect(delegatedConfiguration(upgraded.configuration,researchRole,research.configuration).productBindings.map(binding=>binding.definition.providerOperation).sort()).toEqual(research.configuration.productBindings.filter((binding:any)=>binding.definition.providerOperation!==denied).map((binding:any)=>binding.definition.providerOperation).sort());
    expect(coordinator.configuration.instructions).toBe(parent.instructions);expect(coordinator.configuration.capabilities.delegation.bindings.find((binding:any)=>binding.id==="content").versionId).toBe(parent.capabilities.delegation.bindings.find((binding:any)=>binding.id==="content").versionId);expect(coordinator.configuration.productBindings).toEqual(parent.productBindings);
    expect((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[content.version_id])).rows[0].configuration).toEqual(current);
    await expect(execution.execute({...apply,requestId:randomUUID()})).rejects.toMatchObject({code:"CONFIGURATION_CHANGED"});
    const reviewedAgain=await execution.execute({...command,requestId:randomUUID()}) as GrowthAgentCapabilityUpgradePreview;expect(reviewedAgain.conflicts.some(conflict=>conflict.id===`content:operation:${denied}`)).toBe(true);
    await updateFeature("campaigns");await updateFeature("assistant");
    const parentAfter=(await pool.query(`SELECT v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'`,[input.tenantId])).rows[0].configuration;
    const acceptedRole=parentAfter.capabilities.delegation.bindings.find((binding:any)=>binding.id==="content");expect(acceptedRole).toMatchObject({maxTokens:8192,maxActiveMs:120000,tools:[]});
    expect(delegatedConfiguration(parentAfter,acceptedRole,upgraded.configuration).productBindings.map(binding=>binding.definition.providerOperation).sort()).toEqual(upgraded.configuration.productBindings.map((binding:any)=>binding.definition.providerOperation).sort());
    for(const role of parentAfter.capabilities.delegation.bindings)for(const id of role.productBindingIds??[])expect(productAuthorityBindings(parentAfter).some(binding=>binding.id===id)).toBe(true);
    authorized=false;await expect(execution.execute({...command,requestId:randomUUID()})).rejects.toMatchObject({code:"FORBIDDEN"});expect(checks).toBeGreaterThan(2);
    const fresh={...request(),publication:currentGrowthPublication as GrowthAgentPublication,defaultsRevision:currentGrowthPublication.manifest.revision};expect(await service.provision(fresh)).toMatchObject({state:"ready"});
    const defaults=(await pool.query(`SELECT f.version_id,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1`,[fresh.tenantId])).rows;
    for(const item of defaults){expect(productAuthorityBindings(item.configuration).length).toBeLessThanOrEqual(64);if(item.configuration.capabilities.delegation.enabled)for(const role of item.configuration.capabilities.delegation.bindings){const child=defaults.find(row=>row.version_id===role.versionId)!;expect(delegatedConfiguration(item.configuration,role,child.configuration).productBindings.map(binding=>binding.definition.providerOperation).sort()).toEqual(child.configuration.productBindings.map((binding:any)=>binding.definition.providerOperation).sort());}}

  },60_000);
  it("concurrent retries and lost acknowledgements converge without duplicate credentials or versions",async()=>{
    const input=request();expect((await Promise.all(Array.from({length:5},()=>service.provision(input)))).every(r=>r.state==="ready")).toBe(true);
    expect((await service.provision(input)).state).toBe("ready");expect(calls).toBe(1);
    for(const [table,count] of [["agents",4],["agent_versions",4],["model_provider_connections",1],["model_provider_credentials",1],["model_provider_use_grants",1],["product_model_defaults",1]] as const)expect(Number((await pool.query("SELECT count(*) FROM agents_platform."+table)).rows[0].count)).toBe(count);
    const prior=(await pool.query("SELECT revision,connection_id FROM agents_platform.product_model_defaults")).rows[0];
    await provisionGrowthModel(pool,vault,{tenantId:input.tenantId,providerId:profile.providerId,modelId:profile.modelId,apiKey:credential},{discoveryFetch});
    expect((await pool.query("SELECT revision,connection_id FROM agents_platform.product_model_defaults")).rows[0]).toEqual(prior);
  });
  it("serves authenticated HTTP provisioning and calls the separately authenticated Growth lifecycle endpoint",async()=>{
    const signing=await generateKeyPair("RS256",{extractable:true}),actions=await generateKeyPair("RS256",{extractable:true}),input=request();
    let checks=0;
    const lifecycle=createServer(async(req,res)=>{
      try {
        expect(req.url).toBe("/internal/agents/provisioning-check");
        let text="";for await(const chunk of req)text+=chunk;
        const {payload}=await jwtVerify(req.headers.authorization!.slice(7),actions.publicKey,{issuer:"https://agents.fixture.test",audience:"growth-agent-provisioning-lifecycle"});
        expect(payload.sub).toBe("agents-provisioner");expect(payload.requestDigest).toBe(requestDigest(JSON.parse(text)));checks++;
        res.setHeader("content-type","application/json");res.end(JSON.stringify({active:true}));
      }catch {res.statusCode=403;res.end("{}");}
    });
    await new Promise<void>(resolve=>lifecycle.listen(0,"127.0.0.1",resolve));
    const app=Fastify();app.setErrorHandler((error,_req,reply)=>reply.code((error as any).statusCode??500).send({code:(error as any).code??"UNEXPECTED"}));
    registerGrowthProvisionRoute(app,pool,trust,{NODE_ENV:"test",GROWTH_AGENTS_PROVISION_PUBLIC_KEYS_JSON:JSON.stringify({setup:await exportSPKI(signing.publicKey)}),
      GROWTH_MANAGED_MODEL_PROFILE_JSON:JSON.stringify(profile),FIXTURE_MANAGED_MODEL_KEY:"synthetic-only-key",AGENTS_CONNECTION_ACTIVE_KEY:"fixture",AGENTS_CONNECTION_KEYS:JSON.stringify({fixture:randomBytes(32).toString("base64")}),
      GROWTH_PRODUCT_API_URL:"http://127.0.0.1:"+(lifecycle.address() as {port:number}).port,AGENTS_PRODUCT_ACTION_PRIVATE_KEY:await exportPKCS8(actions.privateKey),AGENTS_PRODUCT_ACTION_ISSUER:"https://agents.fixture.test"},{discoveryFetch});
    const now=Math.floor(Date.now()/1000),token=await new SignJWT({product:"growth",requestDigest:requestDigest(input)}).setProtectedHeader({alg:"RS256",kid:"setup"})
      .setIssuer(issuer).setSubject("growth-provisioner").setAudience("agents-product-provisioning").setIssuedAt(now).setExpirationTime(now+60).setJti(randomUUID()).sign(signing.privateKey);
    try {
      const response=await app.inject({method:"POST",url:"/internal/v1/products/growth/provision",headers:{authorization:"Bearer "+token},payload:input});
      expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({state:"ready",tenantId:input.tenantId});expect(checks).toBe(2);
      expect((await app.inject({method:"POST",url:"/internal/v1/products/growth/provision",payload:input})).statusCode).toBe(401);
      const replay=await app.inject({method:"POST",url:"/internal/v1/products/growth/provision",headers:{authorization:"Bearer "+token},payload:input});
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().state).toBe("ready");
    } finally {await app.close();lifecycle.closeAllConnections();await new Promise<void>(resolve=>lifecycle.close(()=>resolve()));}
  });
  it("repair recreates only missing defaults and preserves instructions, disabled flags and default identity",async()=>{
    const input=request();await service.provision(input);
    const execution=new GrowthExecutionService(pool,trust),configuration=(await pool.query("SELECT v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'",[input.tenantId])).rows[0].configuration;
    configuration.instructions="Customized";
    await execution.execute({version:"1",requestId:randomUUID(),tenantId:input.tenantId,actor:{issuer:trust.actorIssuer,subject:"staff"},operation:"features.configure",input:{featureId:"assistant",configuration}});
    const feature=(await pool.query("SELECT * FROM agents_platform.product_execution_features WHERE tenant_id=$1 AND feature_id='assistant'",[input.tenantId])).rows[0];
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='assistant'",[input.tenantId]);
    await pool.query("DELETE FROM agents_platform.product_execution_features WHERE tenant_id=$1 AND feature_id='research'",[input.tenantId]);
    expect((await service.provision(input)).state).toBe("ready");
    const current=(await pool.query("SELECT f.enabled,f.version_id,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'",[input.tenantId])).rows[0];
    expect(current.enabled).toBe(false);expect(current.version_id).toBe(feature.version_id);expect(current.configuration.instructions).toBe("Customized");
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.product_execution_features WHERE tenant_id=$1",[input.tenantId])).rows[0].count)).toBe(4);
  });
  it("republishes a stale runtime from the normal feature path while preserving custom configuration and unsaved drafts",async()=>{
    const input=request();expect((await service.provision(input)).state).toBe("ready");
    const prior=(await pool.query(`SELECT f.*,v.configuration,v.created_by_service FROM agents_platform.product_execution_features f
      JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'`,[input.tenantId])).rows[0];
    const configuration={...prior.configuration,instructions:"Keep this published assistant",context:{maxInputTokens:8192,compactAtTokens:6144}};
    const oldId=randomUUID(),oldComposition=compilePublishedComposition(configuration,[],{release:"product-capabilities-v14",workflow:"AgentsBusinessRunV24"});
    await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
      SELECT $1,organization_id,agent_id,2,2,execution_kind,$2,created_by_service,tool_bindings,$3 FROM agents_platform.agent_versions WHERE id=$4`,[oldId,configuration,oldComposition,prior.version_id]);
    await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$2,revision=2 WHERE tenant_id=$1 AND feature_id='assistant'",[input.tenantId,oldId]);
    const draft={...configuration,instructions:"Keep this unsaved draft"};
    await pool.query("UPDATE agents_platform.agents SET draft=$2 WHERE id=$1",[prior.agent_id,draft]);
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='research'",[input.tenantId]);
    const model=(await pool.query("SELECT * FROM agents_platform.product_model_defaults WHERE organization_id=$1",[prior.organization_id])).rows[0];
    const latest=publication("9");latest.policy.optionalCapabilities.knowledge=true;latest.policy.optionalCapabilities.skills=true;latest.policy.optionalCapabilities.memory=true;
    latest.presets=latest.presets.map(preset=>({...preset,operations:[]}));
    const execution=new GrowthExecutionService(pool,trust),command={version:"1" as const,requestId:randomUUID(),tenantId:input.tenantId,
      actor:{issuer:trust.actorIssuer,subject:"staff"},operation:"features.list" as const,input:{publication:latest}};
    await execution.execute(command);
    const current=(await pool.query(`SELECT f.version_id,v.configuration,v.effective_composition,v.draft_revision,a.draft,a.draft_revision AS current_draft_revision FROM agents_platform.product_execution_features f
      JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=f.agent_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'`,[input.tenantId])).rows[0];
    expect(current.version_id).not.toBe(oldId);expect(current.configuration).toEqual(configuration);expect(current.draft).toEqual(draft);
    expect(current.draft_revision).toBe(3);expect(current.current_draft_revision).toBe(1);
    expect(current.effective_composition.runtime).toEqual({kind:"business",release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME});
    expect((await pool.query("SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$1",[oldId])).rows[0].effective_composition).toEqual(oldComposition);
    expect((await pool.query("SELECT enabled FROM agents_platform.product_execution_features WHERE tenant_id=$1 AND feature_id='research'",[input.tenantId])).rows[0].enabled).toBe(false);
    expect((await pool.query("SELECT * FROM agents_platform.product_model_defaults WHERE organization_id=$1",[prior.organization_id])).rows[0]).toEqual(model);
    expect((await pool.query("SELECT revision,publication#>'{policy,optionalCapabilities}' AS capabilities FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",[input.tenantId])).rows[0]).toMatchObject({revision:"9",capabilities:{knowledge:true,skills:true,memory:true}});
    await execution.execute({...command,requestId:randomUUID()});
    expect((await pool.query("SELECT version_id FROM agents_platform.product_execution_features WHERE tenant_id=$1 AND feature_id='assistant'",[input.tenantId])).rows[0].version_id).toBe(current.version_id);
    await expect(execution.execute({...command,requestId:randomUUID(),operation:"features.configure",input:{featureId:"assistant",configuration}})).resolves.toHaveProperty("feature");
    const original=configuration.productBindings[0]!,invented=createProductBindings(latest.manifest,prior.organization_id,original.authority!,[original.definition.providerOperation]);
    await expect(execution.execute({...command,requestId:randomUUID(),operation:"features.configure",input:{featureId:"assistant",configuration:{...configuration,productBindings:invented}}})).rejects.toMatchObject({code:"PRODUCT_CAPABILITY_UNAVAILABLE"});
  });
  it("upgrades only managed defaults explicitly and preserves custom settings, disablement and model identity",async()=>{
    const input=request();expect((await service.provision(input)).state).toBe("ready");
    const execution=new GrowthExecutionService(pool,trust),row=(await pool.query("SELECT f.*,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1 AND f.feature_id='assistant'",[input.tenantId])).rows[0];
    await execution.execute({version:"1",requestId:randomUUID(),tenantId:input.tenantId,actor:{issuer:trust.actorIssuer,subject:"staff"},operation:"features.configure",input:{featureId:"assistant",configuration:{...row.configuration,instructions:"My custom assistant"}}});
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='content'",[input.tenantId]);
    const model=(await pool.query("SELECT d.* FROM agents_platform.product_model_defaults d JOIN agents_platform.product_execution_tenants t ON t.organization_id=d.organization_id WHERE t.tenant_id=$1",[input.tenantId])).rows[0];
    const upgrade={...input,requestId:randomUUID(),defaultsRevision:"2",publication:publication("2"),upgradeDefaults:true};
    expect((await service.provision(upgrade)).state).toBe("ready");expect((await service.provision(upgrade)).state).toBe("ready");
    const current=(await pool.query("SELECT f.feature_id,f.enabled,f.revision,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1",[input.tenantId])).rows;
    expect(current.find(row=>row.feature_id==='assistant').configuration.instructions).toBe("My custom assistant");
    expect(current.find(row=>row.feature_id==='research').configuration.instructions).toContain("Revision 2");
    expect(current.find(row=>row.feature_id==='research').revision).toBe(2);expect(current.find(row=>row.feature_id==='content').enabled).toBe(false);
    expect((await pool.query("SELECT * FROM agents_platform.product_model_defaults WHERE organization_id=$1",[model.organization_id])).rows[0]).toEqual(model);
  });
  it("upgrades retained revision4 through current revision6 without restoring finite defaults or changing custom agents and model selection",async()=>{
    const priorPublication=publication("4");priorPublication.policy.optionalCapabilities.delegation=true;
    const input={...request(),defaultsRevision:"4",publication:priorPublication};
    expect((await service.provision(input)).state).toBe("ready");
    const execution=new GrowthExecutionService(pool,trust);
    const read=async()=> (await pool.query("SELECT f.feature_id,f.version_id,f.enabled,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1",[input.tenantId])).rows;
    const before=await read(),assistant=before.find(row=>row.feature_id==='assistant'),content=before.find(row=>row.feature_id==='content');
    await execution.execute({version:"1",requestId:randomUUID(),tenantId:input.tenantId,actor:{issuer:trust.actorIssuer,subject:"staff"},operation:"features.configure",input:{featureId:"content",configuration:{...content.configuration,instructions:"Keep my custom content agent"}}});
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='research'",[input.tenantId]);
    const customized=(await read()).find(row=>row.feature_id==='content');
    const nextPublication=publication("5");nextPublication.policy.optionalCapabilities.delegation=true;
    const upgrade={...input,requestId:randomUUID(),defaultsRevision:"5",publication:nextPublication,upgradeDefaults:true};
    expect((await service.provision(upgrade)).state).toBe("ready");
    const after=await read(),current=after.find(row=>row.feature_id==='assistant');
    expect(current.version_id).not.toBe(assistant.version_id);
    expect(current.configuration.instructions).toContain("Revision 5");
    expect(current.configuration.model).toEqual(assistant.configuration.model);
    expect(current.configuration.capabilities.delegation.policy.maxTasks).toBeNull();
    expect(current.configuration.capabilities.delegation.bindings).toHaveLength(3);
    for(const binding of current.configuration.capabilities.delegation.bindings){
      expect(binding.maxTokens).toBeNull();expect(binding.maxActiveMs).toBeNull();
      expect(binding.versionId).toBe(after.find(row=>row.feature_id===binding.id).version_id);
    }
    expect(after.find(row=>row.feature_id==='content')).toEqual(customized);
    expect(after.find(row=>row.feature_id==='research').enabled).toBe(false);
    expect((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[assistant.version_id])).rows[0].configuration).toEqual(assistant.configuration);
    expect((await pool.query("SELECT revision,publication FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 ORDER BY revision",[input.tenantId])).rows.map(row=>row.revision)).toEqual(["4","5"]);
    const versions=after.map(row=>row.version_id).sort();
    expect((await service.provision(upgrade)).state).toBe("ready");
    expect((await read()).map(row=>row.version_id).sort()).toEqual(versions);
    const canonical=publication("6");canonical.policy.optionalCapabilities.delegation=true;
    expect((await service.provision({...input,requestId:randomUUID(),defaultsRevision:"6",publication:canonical,upgradeDefaults:true})).state).toBe("ready");
    const canonicalRows=await read(),canonicalAssistant=canonicalRows.find(row=>row.feature_id==='assistant');
    expect(canonicalAssistant.configuration.capabilities.delegation.policy.maxTasks).toBeNull();
    for(const binding of canonicalAssistant.configuration.capabilities.delegation.bindings){expect(binding.maxTokens).toBeNull();expect(binding.maxActiveMs).toBeNull();}
    expect(canonicalRows.find(row=>row.feature_id==='content')).toEqual(customized);
    expect(canonicalRows.find(row=>row.feature_id==='research').enabled).toBe(false);
    expect(canonicalAssistant.configuration.model).toEqual(assistant.configuration.model);
  });
  it("upgrades managed Growth revision10 into the versioned recursive delegation graph",async()=>{
    const tenantId=randomUUID(),input={...request(tenantId),defaultsRevision:"10",publication:growthAgentPublicationV10};
    expect((await service.provision(input)).state).toBe("ready");
    const read=async()=> (await pool.query("SELECT f.feature_id,f.version_id,f.revision,f.enabled,f.managed_defaults_revision,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.tenant_id=$1",[tenantId])).rows;
    const prior=await read(),priorAssistant=prior.find(row=>row.feature_id==='assistant')!;
    expect(priorAssistant.configuration.capabilities.delegation.maxDepth).toBe(1);
    expect(priorAssistant.configuration.capabilities.delegation.policy.maxTasks).toBe(16);
    for(const binding of priorAssistant.configuration.capabilities.delegation.bindings){expect(binding.maxTokens).toBe(48000);expect(binding.maxActiveMs).toBe(300000);}

    const upgrade={...input,requestId:randomUUID(),defaultsRevision:"11",publication:currentGrowthPublication,upgradeDefaults:true};
    expect((await service.provision(upgrade)).state).toBe("ready");
    const current=await read(),assistant=current.find(row=>row.feature_id==='assistant')!,content=current.find(row=>row.feature_id==='content')!,
      research=current.find(row=>row.feature_id==='research')!,campaigns=current.find(row=>row.feature_id==='campaigns')!;
    expect(assistant.version_id).not.toBe(priorAssistant.version_id);
    expect(assistant.managed_defaults_revision).toBe("11");
    expect(assistant.configuration.capabilities.delegation).toMatchObject({enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3}});
    expect(assistant.configuration.capabilities.delegation.bindings).toHaveLength(3);
    for(const binding of assistant.configuration.capabilities.delegation.bindings){
      expect(binding.maxTokens).toBeNull();expect(binding.maxActiveMs).toBeNull();
      expect(binding.versionId).toBe(current.find(row=>row.feature_id===binding.id)!.version_id);
    }
    expect(content.configuration.capabilities.delegation).toMatchObject({enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3}});
    expect(content.configuration.tools).toContain("agents.start");
    expect(content.configuration.capabilities.delegation.bindings.map(binding=>binding.id)).toEqual(["research"]);
    expect(content.configuration.capabilities.delegation.bindings[0]!.versionId).toBe(research.version_id);
    expect(campaigns.configuration.capabilities.delegation).toMatchObject({enabled:true,maxDepth:null,policy:{maxTasks:null,maxStalls:3}});
    expect(campaigns.configuration.capabilities.delegation.bindings.map(binding=>binding.id)).toEqual(["research"]);
    expect(research.configuration.capabilities.delegation.enabled).toBe(false);

    const child=delegatedConfiguration(assistant.configuration,assistant.configuration.capabilities.delegation.bindings.find(binding=>binding.id==="content")!,content.configuration);
    expect(child.capabilities.delegation.enabled).toBe(true);
    expect(child.capabilities.delegation.maxDepth).toBeNull();
    expect(child.tools).toContain("agents.start");
    const grandchild=delegatedConfiguration(child,child.capabilities.delegation.bindings[0]!,research.configuration);
    expect(grandchild.capabilities.delegation.enabled).toBe(false);
    expect(grandchild.tools).not.toContain("agents.start");

    expect((await pool.query("SELECT publication FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision='10'",[tenantId])).rows[0].publication).toEqual(growthAgentPublicationV10);
    expect((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[priorAssistant.version_id])).rows[0].configuration).toEqual(priorAssistant.configuration);
    const versions=current.map(row=>row.version_id).sort();
    expect((await service.provision(upgrade)).state).toBe("ready");
    expect((await read()).map(row=>row.version_id).sort()).toEqual(versions);
    expect((await pool.query("SELECT revision FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 ORDER BY revision",[tenantId])).rows.map(row=>row.revision)).toEqual(["10","11"]);
  });
  it("never revives tenant or model revocations, rejects implicit profile upgrades",async()=>{
    const input=request();await service.provision(input);await controlGrowthExecution(pool,{tenantId:input.tenantId,action:"tenant.disable"});
    expect(await service.provision(input)).toMatchObject({state:"blocked",code:"PRODUCT_TENANT_UNAVAILABLE"});
    const other=request();await service.provision(other);await controlGrowthExecution(pool,{tenantId:other.tenantId,action:"model.revoke"});
    expect(await service.provision(other)).toMatchObject({state:"blocked",code:"MODEL_CONNECTION_UNAVAILABLE"});
    const credentialOnly=request();await service.provision(credentialOnly);
    await pool.query(`UPDATE agents_platform.model_provider_credentials c SET state='revoked',envelope=NULL
      FROM agents_platform.product_model_defaults d JOIN agents_platform.product_execution_tenants t ON t.organization_id=d.organization_id AND t.product=d.product
      WHERE t.product='growth' AND t.tenant_id=$1 AND c.organization_id=d.organization_id AND c.connection_id=d.connection_id`,[credentialOnly.tenantId]);
    expect(await service.provision(credentialOnly)).toMatchObject({state:"blocked",code:"MODEL_CREDENTIAL_REVOKED"});
    expect((await pool.query(`SELECT c.state FROM agents_platform.model_provider_credentials c
      JOIN agents_platform.product_execution_tenants t ON t.organization_id=c.organization_id WHERE t.product='growth' AND t.tenant_id=$1`,[credentialOnly.tenantId])).rows).toEqual([{state:"revoked"}]);
    const upgrade=request();await service.provision(upgrade);configured={...profile,revision:"2"};
    expect(await service.provision({...upgrade,modelProfileRevision:"2"})).toMatchObject({state:"blocked",code:"MODEL_PROFILE_UPGRADE_REQUIRED"});configured=profile;
  });
  it("concurrent profile revisions cannot both acknowledge ownership",async()=>{
    const input=request(),next={...profile,revision:"2"};
    const second=new GrowthProvisionService(pool,{trust,vault,profile:()=>next,credential:()=>credential,active:async()=>true,discoveryFetch});
    const results=await Promise.all([service.provision(input),second.provision({...input,modelProfileRevision:"2"})]);
    expect(results.filter(r=>r.state==="ready")).toHaveLength(1);
    expect(results.filter(r=>r.state==="blocked")).toMatchObject([{code:"MODEL_PROFILE_UPGRADE_REQUIRED"}]);
    const org=(await pool.query("SELECT organization_id FROM agents_platform.product_execution_tenants WHERE tenant_id=$1",[input.tenantId])).rows[0].organization_id;
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.model_provider_connections WHERE organization_id=$1",[org])).rows[0].count)).toBe(1);
  });
  it("checks lifecycle again after discovery and refuses unsupported tool metadata without saving credentials",async()=>{
    let checks=0;
    const input=request(),late=new GrowthProvisionService(pool,{trust,vault,profile:()=>profile,credential:()=>credential,active:async()=>++checks===1,discoveryFetch});
    expect(await late.provision(input)).toMatchObject({state:"blocked",code:"PRODUCT_TENANT_INACTIVE"});
    expect((await pool.query("SELECT * FROM agents_platform.product_execution_tenants WHERE tenant_id=$1",[input.tenantId])).rowCount).toBe(0);
    const invalid=request(),noTools=new GrowthProvisionService(pool,{trust,vault,profile:()=>profile,credential:()=>credential,active:async()=>true,
      discoveryFetch:async()=>{const r=await discoveryFetch();const body=JSON.parse(r.body);body.data[0].supported_parameters=[];return {...r,body:JSON.stringify(body)};}});
    expect(await noTools.provision(invalid)).toMatchObject({state:"blocked",code:"MODEL_TOOL_SUPPORT_REQUIRED"});
    const org=(await pool.query("SELECT organization_id FROM agents_platform.product_execution_tenants WHERE tenant_id=$1",[invalid.tenantId])).rows[0].organization_id;
    expect((await pool.query("SELECT * FROM agents_platform.model_provider_credentials WHERE organization_id=$1",[org])).rowCount).toBe(0);
  });
  it("reports missing credential/profile and lifecycle rejection without creating tenants",async()=>{
    const input=request();credential=undefined;expect(await service.provision(input)).toMatchObject({state:"blocked",code:"MODEL_CREDENTIAL_REQUIRED"});credential="synthetic-only-key";
    configured=null;expect(await service.provision(input)).toMatchObject({state:"blocked",code:"MODEL_PROFILE_REQUIRED"});configured=profile;
    active=false;expect(await service.provision(input)).toMatchObject({state:"blocked",code:"PRODUCT_TENANT_INACTIVE"});active=true;
    expect((await pool.query("SELECT * FROM agents_platform.product_execution_tenants WHERE tenant_id=$1",[input.tenantId])).rowCount).toBe(0);
    const execution=new GrowthExecutionService(pool,trust);
    await expect(execution.execute({version:"1",requestId:randomUUID(),tenantId:input.tenantId,actor:{issuer:trust.actorIssuer,subject:"staff"},operation:"features.list",input:{}})).rejects.toMatchObject({code:"PRODUCT_TENANT_UNAVAILABLE"});
  });
});
