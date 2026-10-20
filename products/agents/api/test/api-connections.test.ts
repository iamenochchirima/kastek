import { randomBytes,randomUUID } from "node:crypto";
import { createServer,type Server } from "node:http";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { ApiConnectionStore } from "../src/product/connections/api-connections";
import { registerApiConnectionRoutes } from "../src/product/connections/api-connection-routes";
import { PlatformStore } from "../src/product/agents/store";
import { ConnectionStore } from "../src/product/connections/connections";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { createNativeApiCapabilityCatalog } from "../src/capabilities/connected-tools/generic-connected-runtime";
import { EvidenceStore } from "../src/execution/context/evidence";
import { ConnectionVault } from "../src/infrastructure/vault";
import { transaction } from "../src/infrastructure/database";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("persisted fixed-origin API connection management",()=>{
  let admin:Pool,pool:Pool,platform:PlatformStore,store:ApiConnectionStore,server:Server,serverUrl:string;
  const database=`agents_api_connections_${randomUUID().replaceAll("-","")}`;
  const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")});
  const storage={async put(){},async get(){return new Uint8Array();},async delete(){}};
  let reads=0,writes=0,lastHeaders:Record<string,unknown>={},lastUrl="";
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
    server=createServer((request,response)=>{
      if(["GET","HEAD"].includes(request.method??""))reads++;else writes++;
      lastHeaders=request.headers;lastUrl=request.url??"";response.setHeader("content-type","application/json");response.end(JSON.stringify({ok:true}));
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));serverUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const connections=new ConnectionStore(pool,vault,[]),executor=new ConnectedExecutor(pool,connections,storage,new EvidenceStore(pool,storage));
    store=new ApiConnectionStore(pool,vault,{registry:executor.registry,createCatalog:createNativeApiCapabilityCatalog,testLoopback:true});
  });
  afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){const account=await platform.ensureAccount({issuer:"http://localhost:8080/realms/api",subject:randomUUID(),email:"api@example.test",displayName:"Owner"});const organization=await platform.createOrganization(account.id,"API fixture");return {accountId:account.id,organizationId:organization.id};}
  function document(security?:Record<string,unknown>,location="header") {
    return {openapi:"3.1.0",info:{title:"Fixture records",version:"1"},servers:[{url:serverUrl}],
      ...(security?{components:{securitySchemes:{provider:security}},security:[{provider:[]}]}:{}),
      paths:{"/records/{id}":{parameters:[{name:"id",in:"path",required:true,schema:{type:"string",minLength:1,maxLength:80}}],
        get:{operationId:"readRecord",summary:"Read a record",responses:{"200":{description:"Record",content:{"application/json":{schema:{type:"object"}}}}}},
        post:{operationId:"updateRecord",summary:"Update a record",requestBody:{required:true,content:{"application/json":{schema:{type:"object",properties:{title:{type:"string",maxLength:80}},required:["title"],additionalProperties:false}}}},responses:{"200":{description:"Updated"}}}}}};
  }
  async function create(scope:Awaited<ReturnType<typeof fixture>>,source=document(),credentials:Record<string,unknown>={}) {
    const preview=await store.preview(scope,{document:source,serverUrl});
    const input={operationId:randomUUID(),name:"Records API",document:source,serverUrl,expectedImportDigest:preview.importDigest,credentials};
    return {connection:await store.create(scope,input),input,preview};
  }
  it("previews offline, saves immutable import and encrypted keys, and returns no credential values",async()=>{
    const scope=await fixture(),token="private-server-token-12345",before=reads+writes,source=document({type:"http",scheme:"bearer"});
    const {connection,input,preview}=await create(scope,source,{provider:{type:"bearer",token}});
    expect(reads+writes).toBe(before);expect(connection.status).toBe("selection_required");expect(preview.operations[0]?.parameters[0]?.name).toBe("id");
    expect(preview.operations.every(operation=>operation.effect==="unknown"&&operation.reviewRequired)).toBe(true);
    expect(connection.credentialSchemes).toEqual([{schemeId:"provider",type:"bearer",configured:true}]);
    expect(JSON.stringify([connection,preview,await store.list(scope),await store.operations(scope,connection.id)])).not.toContain(token);
    expect((await store.create(scope,input)).id).toBe(connection.id);
    await expect(store.create(scope,{...input,name:"Changed request"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    await expect(store.create(scope,{...input,operationId:randomUUID(),serverUrl:serverUrl+"/different"})).rejects.toMatchObject({code:"API_IMPORT_CHANGED"});
    const envelope=(await pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1",[connection.id])).rows[0].envelope;
    expect(JSON.stringify(envelope)).not.toContain(token);expect(JSON.parse(vault.open(scope.organizationId,connection.id,1,envelope)).credentials.provider.token).toBe(token);
    await expect(pool.query("UPDATE agents_platform.api_import_catalogs SET catalog='{}' WHERE connection_id=$1",[connection.id])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM agents_platform.api_operation_templates WHERE connection_id=$1",[connection.id])).rejects.toThrow("immutable");
  });
  it("pins selected operations as exact-reviewed bindings and never probes writes or unreviewed GET operations",async()=>{
    const scope=await fixture(),{connection}=await create(scope),operations=await store.operations(scope,connection.id),read=operations.find(operation=>operation.method==="GET")!,write=operations.find(operation=>operation.method==="POST")!;
    const selection={operationId:randomUUID(),expectedGeneration:connection.generation,selections:[{operationId:read.id},{operationId:write.id}]};
    const selected=await store.select(scope,connection.id,selection);
    expect(selected.connection.status).toBe("ready");expect(selected.bindings).toHaveLength(2);
    expect(selected.bindings.every(binding=>binding.policy.effect==="reviewed_write"&&binding.policy.approval==="exact_single_use"&&binding.policy.retry==="status_only")).toBe(true);
    expect(selected.connection.bindingIds).toEqual(selected.bindings.map(binding=>binding.id));
    expect((await store.select(scope,connection.id,selection)).bindings.map(binding=>binding.id)).toEqual(selected.connection.bindingIds);
    const before=reads+writes;
    await expect(store.probe(scope,connection.id,{operationId:read.id,expectedGeneration:selected.connection.generation,arguments:{path:{id:"one"}}})).rejects.toMatchObject({code:"API_PROBE_REVIEW_REQUIRED"});
    await expect(store.probe(scope,connection.id,{operationId:write.id,expectedGeneration:selected.connection.generation,arguments:{path:{id:"one"},body:{title:"Write"}}})).rejects.toMatchObject({code:"API_PROBE_REVIEW_REQUIRED"});
    expect(reads+writes).toBe(before);
    const readonly=await store.select(scope,connection.id,{operationId:randomUUID(),expectedGeneration:selected.connection.generation,selections:[{operationId:read.id,effectPolicy:"owner_reviewed_read"}]});
    expect(readonly.bindings[0]?.policy.effect).toBe("read");
    expect((await store.probe(scope,connection.id,{operationId:read.id,expectedGeneration:readonly.connection.generation,arguments:{path:{id:"one"}}})).status).toBe("ready");
    expect(reads).toBeGreaterThan(0);expect(writes).toBe(0);expect(lastUrl).toBe("/v1/records/one");
    await expect(transaction(pool,db=>store.resolveApiOperation(db,scope,connection.id,selected.connection.policyRevision,read.alias))).rejects.toMatchObject({code:"CONNECTION_INACTIVE"});
    const runtime=await transaction(pool,db=>store.resolveApiOperation(db,scope,connection.id,readonly.connection.policyRevision,read.alias));
    expect(runtime.template.serverOrigin).toBe(new URL(serverUrl).origin);expect(runtime.template.method).toBe("GET");expect(runtime.importDigest).toBe(connection.importDigest);
    await expect(transaction(pool,db=>store.resolveApiOperation(db,scope,connection.id,readonly.connection.policyRevision,write.alias))).rejects.toMatchObject({code:"API_OPERATION_UNAVAILABLE"});
  });
  it.each([
    [{type:"apiKey",in:"header",name:"x-api-key"},{type:"api_key",value:"header-secret-1234"},"x-api-key","header-secret-1234"],
    [{type:"apiKey",in:"query",name:"provider_key"},{type:"api_key",value:"query-secret-1234"},"query","query-secret-1234"],
    [{type:"http",scheme:"bearer"},{type:"bearer",token:"bearer-secret-1234"},"authorization","Bearer bearer-secret-1234"],
    [{type:"http",scheme:"basic"},{type:"basic",username:"fixture",password:"basic-secret-1234"},"authorization","Basic "+Buffer.from("fixture:basic-secret-1234").toString("base64")],
  ])("applies %j credentials only to the explicitly selected fixed-origin read",async(scheme,credential,header,expected)=>{
    const scope=await fixture(),{connection}=await create(scope,document(scheme as Record<string,unknown>),{provider:credential}),read=(await store.operations(scope,connection.id)).find(operation=>operation.method==="GET")!;
    const selected=await store.select(scope,connection.id,{operationId:randomUUID(),expectedGeneration:connection.generation,selections:[{operationId:read.id,effectPolicy:"owner_reviewed_read"}]});
    await store.probe(scope,connection.id,{operationId:read.id,expectedGeneration:selected.connection.generation,arguments:{path:{id:"credential"}}});
    if(header==="query")expect(new URL(lastUrl,serverUrl).searchParams.get("provider_key")).toBe(expected);else expect(lastHeaders[header as string]).toBe(expected);
    const changed=await store.updateCredentials(scope,connection.id,{operationId:randomUUID(),expectedGeneration:selected.connection.generation,credentials:{}});
    expect(changed.selectedOperationIds).toEqual([]);expect(changed.bindingIds).toEqual([]);expect(changed.policyRevision).toBeGreaterThan(selected.connection.policyRevision);
    await expect(store.select(scope,connection.id,{operationId:randomUUID(),expectedGeneration:changed.generation,selections:[{operationId:read.id}]})).rejects.toMatchObject({code:"API_CREDENTIAL_REQUIRED"});
  });
  it("keeps OAuth explicitly unsupported and supports reviewed authored request templates",async()=>{
    const scope=await fixture(),source=document({type:"oauth2",flows:{authorizationCode:{authorizationUrl:"https://accounts.example.com/authorize",tokenUrl:"https://accounts.example.com/token",scopes:{}}}});
    const {connection,preview}=await create(scope,source);
    expect(connection.status).toBe("unsupported");expect(preview.operations[0]?.diagnostics).toContainEqual(expect.objectContaining({code:"API_OAUTH_CLIENT_REQUIRED"}));
    const requestTemplate={title:"Authored status",method:"GET",path:"/status",parameters:[]};
    const authoredPreview=await store.preview(scope,{requestTemplate,serverUrl});
    const authored=await store.create(scope,{operationId:randomUUID(),name:"Authored",requestTemplate,serverUrl,expectedImportDigest:authoredPreview.importDigest});
    expect(authored.sourceKind).toBe("request_template");expect((await store.operations(scope,authored.id))[0]?.path).toBe("/status");
  });
  it("enforces account isolation, current owner authority and management HTTP persistence",async()=>{
    const scope=await fixture(),other=await fixture(),member=await fixture(),{connection}=await create(scope);
    await expect(store.get(other,connection.id)).rejects.toMatchObject({code:"CONNECTION_NOT_FOUND"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[scope.organizationId,member.accountId]);
    const memberScope={...scope,accountId:member.accountId};
    const preview=await store.preview(memberScope,{document:document(),serverUrl});
    await expect(store.create(memberScope,{operationId:randomUUID(),name:"Denied",document:document(),serverUrl,expectedImportDigest:preview.importDigest})).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const app=Fastify(),base=`/api/organizations/${scope.organizationId}/api-connections`;
    registerApiConnectionRoutes(app,{store,resolveScope:async()=>scope});
    try {
      const previewResponse=await app.inject({method:"POST",url:base+"/preview",payload:{document:document(),serverUrl}});expect(previewResponse.statusCode).toBe(200);
      const saved=await app.inject({method:"POST",url:base,payload:{operationId:randomUUID(),name:"HTTP import",document:document(),serverUrl,expectedImportDigest:previewResponse.json().preview.importDigest}});
      expect(saved.statusCode).toBe(200);const id=saved.json().connection.id;
      expect((await app.inject({method:"GET",url:base+`/${id}/operations`})).json().operations).toHaveLength(2);
      expect((await app.inject({method:"GET",url:base})).json().connections.map((item:any)=>item.id)).toContain(id);
      const disconnected=await app.inject({method:"POST",url:base+`/${id}/disconnect`,payload:{expectedGeneration:saved.json().connection.generation}});expect(disconnected.statusCode).toBe(200);
      expect((await store.get(scope,id)).status).toBe("disconnected");
    }finally{await app.close();}
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[scope.organizationId,scope.accountId]);
    await expect(store.list(scope)).rejects.toMatchObject({code:"ACCESS_DENIED"});
  });
});
