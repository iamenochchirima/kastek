import {createHash,randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {ModelProviderStore} from "../src/product/model-providers/store";
import {managedModelDefaultFromEnvironment,defaultAgentsModelId} from "../src/product/model-providers/managed-default";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {transaction} from "../src/infrastructure/database";
import {resolveAcceptedModelRoutes} from "../src/execution/models/resolution";
import {modelServicePolicy} from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("managed starter model with owned PostgreSQL",()=>{
  const database=`agents_managed_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool,platform:PlatformStore,models:ModelProviderStore;
  const vault=new ModelCredentialVault(new ConnectionVault("fixture",{fixture:randomBytes(32).toString("base64")}));
  const model=(id:string,price="0")=>({id,name:id,context_length:1048576,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],
    architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:price,completion:price}});
  let prices="0",discoveries=0;
  const discoveryFetch=async()=>{discoveries++;return {status:200,body:JSON.stringify({data:[model(defaultAgentsModelId,prices),model("paid/model","1")]})};};
  beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    platform=new PlatformStore(pool);models=new ModelProviderStore(pool,vault,undefined,{discoveryFetch});});
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){const owner=await platform.ensureAccount({issuer:"https://identity.example.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const organization=await platform.createOrganization(owner.id,"Managed model");return {accountId:owner.id,organizationId:organization.id};}
  const initializer=()=>managedModelDefaultFromEnvironment(pool,vault,{OPENROUTER_API_KEY:"private-platform-key"},{discoveryFetch})!;
  async function accepted(scope:Awaited<ReturnType<typeof fixture>>,selection:{kind:"organization_default"}|{kind:"connection";connectionId:string;modelId:string}={kind:"organization_default"}) {
    const agent=await platform.createAgent({...scope,name:"Customer assistant"});
    return transaction(pool,db=>resolveAcceptedModelRoutes(db,{organizationId:scope.organizationId,agentId:agent.id,product:"agents",selection,
      requiresTools:true,layers:[{kind:"platform",reference:"test",limits:modelServicePolicy({})}]}));
  }
  it("initializes one encrypted restricted connection under concurrent owner bootstrap and resolves its normal grant",async()=>{
    const scope=await fixture(),ensure=initializer(),before=discoveries;
    expect((await Promise.all([ensure(scope),ensure(scope),ensure(scope)])).filter(Boolean)).toHaveLength(1);
    expect(discoveries-before).toBe(1);
    const connections=await models.list(scope);expect(connections).toHaveLength(1);expect(connections[0].custody).toBe("platform_managed");
    expect((await models.getDefault(scope)).selection?.modelId).toBe(defaultAgentsModelId);
    expect((await models.cachedModels(scope,connections[0].id)).result?.models.map(item=>item.id)).toEqual([defaultAgentsModelId]);
    const route=await accepted(scope);expect(await transaction(pool,db=>models.resolveCredential(db,route.primary.binding,route.primary.consumer))).toBe("private-platform-key");
    expect(JSON.stringify(await pool.query("SELECT envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1",[scope.organizationId]))).not.toContain("private-platform-key");
    expect(JSON.stringify(connections)).not.toContain("private-platform-key");
  });
  it("keeps explicit defaults and user-owned models, and does not create shared defaults for non-owners",async()=>{
    const scope=await fixture(),byok=await models.create(scope,{providerId:"openrouter",name:"Own provider",apiKey:"own-key"});
    await models.refreshModels(scope,byok.id,1);await models.setDefault(scope,{connectionId:byok.id,modelId:"paid/model",expectedRevision:0});
    const before=discoveries;expect(await initializer()(scope)).toBe(false);expect(discoveries).toBe(before);
    const route=await accepted(scope);expect(route.primary.binding.modelId).toBe("paid/model");
    const second=await fixture();await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1",[second.organizationId]);
    expect(await initializer()(second)).toBe(false);expect(await models.list(second)).toEqual([]);
  });
  it("does not recreate a revoked or removed managed connection, even if its default row is absent",async()=>{
    for(const remove of [false,true]){const scope=await fixture(),ensure=initializer();await ensure(scope);const [connection]=await models.list(scope);
      await models.revoke(scope,connection.id,1,remove);await pool.query("DELETE FROM agents_platform.model_provider_defaults WHERE organization_id=$1",[scope.organizationId]);
      expect(await initializer()(scope)).toBe(false);expect((await pool.query("SELECT count(*)::int count FROM agents_platform.model_provider_connections WHERE organization_id=$1",[scope.organizationId])).rows[0].count).toBe(1);}
  });
  it("blocks managed-key widening through edits, manual metadata, default selection, grants and physical dispatch",async()=>{
    const scope=await fixture();await initializer()(scope);const [connection]=await models.list(scope),route=await accepted(scope);
    await expect(models.update(scope,connection.id,{expectedRevision:1,apiKey:"other-key"})).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(models.addManualModel(scope,connection.id,{expectedRevision:1,modelId:"paid/model"})).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(models.setDefault(scope,{connectionId:connection.id,modelId:"paid/model",expectedRevision:1})).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(models.grant(scope,{connectionId:connection.id,consumer:{kind:"service",serviceId:"test",product:"agents"},roles:["primary"],modelIds:["paid/model"]})).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(models.probe(scope,connection.id,{expectedRevision:1,modelId:"paid/model",allowBillableRequest:true,verifyTools:false})).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(transaction(pool,db=>models.resolveCredential(db,{...route.primary.binding,modelId:"paid/model"},route.primary.consumer))).rejects.toMatchObject({code:"MODEL_MANAGED_READ_ONLY"});
    await expect(accepted(scope,{kind:"connection",connectionId:connection.id,modelId:"paid/model"})).rejects.toMatchObject({code:"MODEL_USE_DENIED"});
  });
  it("does not widen the catalogue on refresh and refuses a now-priced default",async()=>{
    const scope=await fixture();await initializer()(scope);const [connection]=await models.list(scope);
    const result=await models.refreshModels(scope,connection.id,1);expect(result.models.map(item=>item.id)).toEqual([defaultAgentsModelId]);
    prices="1";try {await expect(initializer()(await fixture())).rejects.toMatchObject({code:"MODEL_DEFAULT_UNAVAILABLE"});}finally{prices="0";}
  });
  it("leaves explicit per-agent BYOK selection ahead of the workspace managed default",async()=>{
    const scope=await fixture();await initializer()(scope);const byok=await models.create(scope,{providerId:"openrouter",name:"Own provider",apiKey:"own-key"});
    await models.refreshModels(scope,byok.id,1);const agent=await platform.createAgent({...scope,name:"Own model"});
    await models.grant(scope,{connectionId:byok.id,consumer:{kind:"agent",agentId:agent.id},roles:["primary","compaction","delegated"],modelIds:["paid/model"]});
    const route=await transaction(pool,db=>resolveAcceptedModelRoutes(db,{organizationId:scope.organizationId,agentId:agent.id,product:"agents",requiresTools:true,
      selection:{kind:"connection",connectionId:byok.id,modelId:"paid/model"},layers:[{kind:"platform",reference:"test",limits:modelServicePolicy({})}]}));
    expect(route.primary.binding.modelId).toBe("paid/model");expect(route.primary.binding.connectionId).toBe(byok.id);
  });
  it("initializes the existing and newly created owner workspace through real authenticated HTTP bootstrap",async()=>{
    vi.stubEnv("AGENTS_CONNECTION_ACTIVE_KEY","bootstrap");vi.stubEnv("AGENTS_CONNECTION_KEYS",JSON.stringify({bootstrap:randomBytes(32).toString("base64")}));
    vi.stubEnv("OPENROUTER_API_KEY","http-bootstrap-platform-key");vi.stubEnv("AGENTS_DEFAULT_MODEL_ENABLED","true");vi.stubEnv("AGENTS_DEFAULT_MODEL_ID",defaultAgentsModelId);
    const config=loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:databaseUrl!,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"offline-bootstrap-secret-only"});
    const app=await buildPlatformApp({config,pool,testModelProviderOptions:{discoveryFetch}});
    try {
      const user=await platform.ensureAccount({issuer:config.AGENTS_OIDC_ISSUER_URL,subject:randomUUID(),email:"bootstrap@example.test",displayName:"Owner"});
      const organization=await platform.createOrganization(user.id,"Existing workspace");
      const session=await platform.createSession({accountId:user.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)});
      const headers={cookie:`agents_session=${session.token}`,origin:config.AGENTS_PUBLIC_URL};
      const response=await app.inject({method:"GET",url:"/api/session",headers});expect(response.statusCode).toBe(200);
      expect((await models.getDefault({accountId:user.id,organizationId:organization.id})).selection?.modelId).toBe(defaultAgentsModelId);
      const next=await app.inject({method:"POST",url:"/api/organizations",headers,payload:{name:"New workspace"}});expect(next.statusCode).toBe(201);
      expect((await models.getDefault({accountId:user.id,organizationId:next.json().organization.id})).selection?.modelId).toBe(defaultAgentsModelId);
      expect(JSON.stringify(response.json())+next.body).not.toContain("http-bootstrap-platform-key");
    } finally {await app.close();vi.unstubAllEnvs();}
  });
  it("upgrades the exact preceding schema099 boundary and repeats without resetting provider state",async()=>{
    const upgradeDatabase=`agents_managed_upgrade_${randomUUID().replaceAll("-","")}`;
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);const url=new URL(databaseUrl!);url.pathname=`/${upgradeDatabase}`;
    const upgrade=new Pool({connectionString:url.href});
    try {
      const directory=join(__dirname,"../schema"),files=(await readdir(directory)).filter(name=>/^\d+_[a-z_]+\.sql$/.test(name)&&name<"099_").sort();
      const sql=(await Promise.all(files.map(name=>readFile(join(directory,name),"utf8")))).join("\n");
      await upgrade.query(sql);await upgrade.query("CREATE TABLE agents_platform.schema_version(version text PRIMARY KEY,checksum text NOT NULL)");
      await upgrade.query("INSERT INTO agents_platform.schema_version VALUES('001_platform',$1)",[createHash("sha256").update(sql).digest("hex")]);
      await setupPlatformSchema(upgrade);await setupPlatformSchema(upgrade);
      const columns=await upgrade.query("SELECT column_name FROM information_schema.columns WHERE table_schema='agents_platform' AND table_name='model_provider_connections' AND column_name='managed_model_id'");
      expect(columns.rowCount).toBe(1);
    } finally {await upgrade.end();await dropClosedTestDatabase(admin,upgradeDatabase);}
  });
  it("is disabled without a credential or vault and schema setup is repeatable",async()=>{
    expect(managedModelDefaultFromEnvironment(pool,vault,{AGENTS_DEFAULT_MODEL_ENABLED:"false",OPENROUTER_API_KEY:"key"})).toBeUndefined();
    expect(managedModelDefaultFromEnvironment(pool,vault,{})).toBeUndefined();expect(managedModelDefaultFromEnvironment(pool,undefined,{OPENROUTER_API_KEY:"key"})).toBeUndefined();
    await setupPlatformSchema(pool);
  });
});
