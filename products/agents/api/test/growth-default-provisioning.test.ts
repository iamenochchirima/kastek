import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import Fastify from "fastify";
import {createServer} from "node:http";
import {generateKeyPair,exportSPKI,exportPKCS8,jwtVerify,SignJWT} from "jose";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import type {GrowthAgentProvisionRequest} from "@kasitek-labs/contracts";
import {GrowthProvisionAuth,GrowthProvisionService,registerGrowthProvisionRoute,growthManagedModelProfileSchema} from "../src/product/integrations/growth-provisioning";
import {GrowthProductRuntime,growthInstalledAdapterManifest} from "../src/execution/products/growth-runtime";
import {GrowthActionClient} from "../src/adapters/products/growth-action-client";
import type {GrowthAgentPublication,ProductCapabilityDescriptor} from "@kasitek-labs/contracts";
import {GrowthExecutionService} from "../src/product/integrations/growth-execution";
import {provisionGrowthModel} from "../src/product/integrations/growth-model-provisioning";
import {controlGrowthExecution} from "../src/product/integrations/growth-control";
import {setupPlatformSchema} from "../src/composition/setup";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {requestDigest} from "../src/contracts/contracts";
const issuer="https://growth.fixture.test",profile={id:"growth-default",revision:"1",providerId:"openrouter",modelId:"fixture/default",credentialRef:"FIXTURE_MANAGED_MODEL_KEY"};
function publication(revision="1"):GrowthAgentPublication {
 const descriptor:ProductCapabilityDescriptor={operation:"workspace.read",revision:"1",description:"Read approved fixture context",inputSchema:{type:"object",properties:{},additionalProperties:false},outputSchema:null,handlerRef:"growth.workspace.read@1",requiredAuthority:["feature.agents.manage"],evidence:"versioned_sources",policy:{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"},limits:{timeoutMs:10000,maxPhysicalAttempts:1,maxResponseBytes:131072,maxModelResultBytes:8192}};
 const body={schemaVersion:1 as const,product:"growth",revision,adapter:{id:growthInstalledAdapterManifest.id,release:growthInstalledAdapterManifest.release,manifestDigest:requestDigest(growthInstalledAdapterManifest)},operations:[descriptor]};
 return {manifest:{...body,digest:requestDigest(body)},presets:(["assistant","research","content","campaigns"] as const).map(id=>({id,name:id,description:"Fixture preset",instructions:"Choose permitted tools as needed. Revision "+revision,operations:["workspace.read"]})),policy:{revision,optionalCapabilities:{knowledge:false,skills:false,memory:false,delegation:false,sandbox:false,workflows:false,connections:false}}};
}
const request=(tenantId=randomUUID()):GrowthAgentProvisionRequest=>({version:"1",requestId:randomUUID(),tenantId,publication:publication(),defaultsRevision:"1",modelProfileId:profile.id,modelProfileRevision:profile.revision});
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
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP DATABASE IF EXISTS "'+database+'" WITH (FORCE)');await admin.end();}});
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
  it("never revives tenant or model revocations, rejects implicit profile upgrades",async()=>{
    const input=request();await service.provision(input);await controlGrowthExecution(pool,{tenantId:input.tenantId,action:"tenant.disable"});
    expect(await service.provision(input)).toMatchObject({state:"blocked",code:"PRODUCT_TENANT_UNAVAILABLE"});
    const other=request();await service.provision(other);await controlGrowthExecution(pool,{tenantId:other.tenantId,action:"model.revoke"});
    expect(await service.provision(other)).toMatchObject({state:"blocked",code:"MODEL_CONNECTION_UNAVAILABLE"});
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
