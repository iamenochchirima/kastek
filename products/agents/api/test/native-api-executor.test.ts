import { contextGrantCeiling } from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {connectFixtureModel} from "./model-fixture";
import {subscribeConnectionTelemetry,type ConnectionControlEvent} from "../src/observability/connection-telemetry";
import {collectNativeMetrics} from "../src/observability/metrics";
import type { NativeResponsePolicy } from "../src/adapters/providers/native-response-policy";
import { randomBytes,randomUUID } from "node:crypto";
import { createServer,type Server } from "node:http";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { createNativeApiCapabilityCatalog } from "../src/capabilities/connected-tools/generic-connected-runtime";
import { ToolReviewStore } from "../src/capabilities/reviews/tool-reviews";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration,type ExecutionGrant } from "../src/contracts/contracts";
import { EvidenceStore } from "../src/execution/context/evidence";
import { beginOperation } from "../src/execution/lifecycle/execution";
import { PlatformStore } from "../src/product/agents/store";
import { ConnectionStore } from "../src/product/connections/connections";
import { ApiConnectionStore } from "../src/product/connections/api-connections";
import { ConnectionVault } from "../src/infrastructure/vault";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("native API through published grants, exact reviews and private receipts",()=>{
  let admin:Pool,pool:Pool,platform:PlatformStore,connections:ConnectionStore,api:ApiConnectionStore,reviews:ToolReviewStore,executor:ConnectedExecutor,server:Server,serverUrl:string;
  let sends=0,status=200,hang=false,paged=false,atProvider:(()=>void|Promise<void>)|undefined,lastAuthorization:string|undefined;
  const database=`agents_native_exec_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>(),token="controlled-api-vault-token";
  const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")});
  const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing fixture object");return value;},async delete(key:string){objects.delete(key);}};
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;
    pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);connections=new ConnectionStore(pool,vault,[]);reviews=new ToolReviewStore(pool);
    const evidence=new EvidenceStore(pool,storage);
    executor=new ConnectedExecutor(pool,connections,storage,evidence,{resolveApiOperation:(...args)=>api.resolveApiOperation(...args),genericReview:reviews.port(),testApiLoopback:true});
    api=new ApiConnectionStore(pool,vault,{registry:executor.registry,createCatalog:createNativeApiCapabilityCatalog,testLoopback:true});
    server=createServer(async(request,response)=>{sends++;let body="";for await(const chunk of request)body+=chunk;
      lastAuthorization=request.headers.authorization;await atProvider?.();if(hang)return;response.statusCode=status;response.setHeader("content-type","application/json");
      if(paged){response.end(JSON.stringify({data:[{id:sends,title:`Page ${sends}`,internal:"not-for-model"}],next:sends<3?String(sends+1):null}));return;}
      response.end(JSON.stringify({accepted:status===200,method:request.method,path:request.url,input:body?JSON.parse(body):null}));});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));serverUrl=`http://127.0.0.1:${(server.address()as{port:number}).port}/api`;
  });
  afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(read=false,responsePolicy?:NativeResponsePolicy){
    sends=0;status=200;hang=false;paged=false;atProvider=undefined;lastAuthorization=undefined;
    const account=await platform.ensureAccount({issuer:"http://localhost/native-api",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Native API");
    const scope={accountId:account.id,organizationId:org.id};
    await connectFixtureModel(pool,account.id,org.id);
    const source={openapi:"3.1.0",info:{title:"Controlled provider",version:"1"},servers:[{url:serverUrl}],components:{securitySchemes:{provider:{type:"http",scheme:"bearer"}}},security:[{provider:[]}],
      paths:{"/records/{id}":{parameters:[{name:"id",in:"path",required:true,schema:{type:"string",minLength:1,maxLength:80}}],
        get:{operationId:"readRecord",...(responsePolicy?{"x-kasitek-response":responsePolicy,parameters:[{name:"cursor",in:"query",schema:{type:"string",maxLength:2048}}]}:{}),responses:{"200":{description:"Record"}}},post:{operationId:"updateRecord",requestBody:{required:true,content:{"application/json":{schema:{type:"object",required:["title"],properties:{title:{type:"string",maxLength:80}},additionalProperties:false}}}},responses:{"200":{description:"Updated"}}}}}};
    const preview=await api.preview(scope,{document:source,serverUrl}),created=await api.create(scope,{operationId:randomUUID(),name:"Controlled provider",document:source,serverUrl,expectedImportDigest:preview.importDigest,credentials:{provider:{type:"bearer",token}}});
    const operation=(await api.operations(scope,created.id)).find(operation=>operation.method===(read?"GET":"POST"))!;
    const selected=await api.select(scope,created.id,{operationId:randomUUID(),expectedGeneration:created.generation,selections:[{operationId:operation.id,effectPolicy:read?"owner_reviewed_read":"exact_review"}]});
    const binding=selected.bindings[0]!,configuration={...defaultBusinessConfiguration(),connectedToolBindingIds:[binding.id]},agent=await platform.createAgent({...scope,name:"Native API agent",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const authority={product:"agents"as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human"as const,issuer:account.issuer,subject:account.subject}};
    const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read","connected.execute"],sourceRevisionIds:[],connectedToolBindingIds:[binding.id],maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
    await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Use the controlled API"});
    const args=read?{path:{id:"one"}}:{path:{id:"one"},body:{title:"Approved change"}};return{scope,connection:selected.connection,binding,task,args};
  }
  async function begin(f:Awaited<ReturnType<typeof fixture>>,approve=false){
    const operationId=`tool:${f.task.id}:${randomUUID()}`;
    if(approve){const review=await reviews.prepare(f.task.id,operationId,f.binding,f.args);await reviews.decide(f.scope,review.id,{decision:"approve",requestDigest:review.requestDigest});}
    await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:f.binding.alias,request:f.args,reservedTokens:0,reservedMs:30000,retrySafe:false});return operationId;
  }
  it("publishes an exact schema and performs no HTTP send before approval",async()=>{
    const f=await fixture(),operationId=await begin(f);
    expect(executor.modelToolsFor([f.binding])[0]!.function.parameters).toEqual(f.binding.definition.inputSchema);
    await expect(executor.execute(f.task.id,operationId,f.binding,f.args)).rejects.toMatchObject({code:"TOOL_REVIEW_REQUIRED"});expect(sends).toBe(0);
  });
  it("executes one approved effect with private credentials, evidence and sanitized lifecycle events",async()=>{
    const f=await fixture(),operationId=await begin(f,true),result=await executor.execute(f.task.id,operationId,f.binding,f.args);
    expect(result.status).toBe("ok");expect(result.content).toContain("Approved change");expect(sends).toBe(1);expect(lastAuthorization).toBe(`Bearer ${token}`);expect(JSON.stringify(result)).not.toContain(token);
    expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE operation_id=$1",[operationId])).rows[0].state).toBe("completed");
    const events=(await pool.query("SELECT payload,observation FROM agents_platform.task_events WHERE task_id=$1 AND kind LIKE 'tool.connected_%' ORDER BY sequence",[f.task.id])).rows;
    expect(events).toHaveLength(2);expect(events[1].observation.metadata).toMatchObject({connectionId:f.connection.id,bindingId:f.binding.id,policyRevision:f.connection.policyRevision,authorizationGeneration:f.connection.generation,outcome:"completed"});
    expect(events[1].observation.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0].observation.metadata.authorizationGeneration).toBe(f.connection.generation);
    expect(JSON.stringify(events)).not.toContain(token);expect(JSON.stringify(events)).not.toContain("Approved change");expect(JSON.stringify(events)).not.toContain(serverUrl);
    const metrics=await collectNativeMetrics(pool,"test");
    expect(metrics).toEqual(expect.arrayContaining([expect.objectContaining({name:"agents.connected.provider.attempts",value:1,attributes:{provider:"native_api",phase:"read",outcome:"response"}}),expect.objectContaining({name:"agents.connected.provider.latency_p95_ms",attributes:{provider:"native_api",phase:"read"}})]));
    expect(JSON.stringify(metrics)).not.toContain(f.connection.id);
    const disconnected:ConnectionControlEvent[]=[];const stop=subscribeConnectionTelemetry(event=>{if(event.flow==="disconnect")disconnected.push(event);});
    try{await api.disconnect(f.scope,f.connection.id,f.connection.generation);}finally{stop();}
    expect(disconnected).toMatchObject([{authorizationGeneration:f.connection.generation+1,policyRevision:f.connection.policyRevision+1,outcome:"completed"}]);
    expect(await executor.execute(f.task.id,operationId,f.binding,f.args)).toEqual(result);expect(sends).toBe(1);
  });
  it("executes an owner-attested read without acquiring write approval",async()=>{
    const f=await fixture(true),operationId=await begin(f),result=await executor.execute(f.task.id,operationId,f.binding,f.args);
    expect(result.status).toBe("ok");expect(result.content).toContain('"method":"GET"');expect(sends).toBe(1);
    expect((await pool.query("SELECT count(*) FROM agents_platform.tool_invocation_reviews WHERE operation_id=$1",[operationId])).rows[0].count).toBe("0");
  });
  it("runs bounded cursor pages through each normal physical authority check and immutable private receipt",async()=>{
    const f=await fixture(true,{pagination:{itemsPointer:"/data",nextCursorPointer:"/next",cursorParameter:"cursor",maxPages:3},projection:{fields:{id:"/id",title:"/title"}}});paged=true;
    expect(f.binding.limits.maxPhysicalRequests).toBe(3);const operationId=await begin(f),result=await executor.execute(f.task.id,operationId,f.binding,f.args);
    expect(sends).toBe(3);expect(JSON.parse(result.content)).toMatchObject({items:[{id:1,title:"Page 1"},{id:2,title:"Page 2"},{id:3,title:"Page 3"}],complete:true});expect(result.content).not.toContain("not-for-model");
    const attempts=(await pool.query("SELECT ordinal,state FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[operationId])).rows;expect(attempts).toEqual([{ordinal:1,state:"completed"},{ordinal:2,state:"completed"},{ordinal:3,state:"completed"}]);
    const bodies=(await pool.query("SELECT object_key FROM agents_platform.connected_response_bodies WHERE operation_id=$1",[operationId])).rows;expect(bodies.length).toBeGreaterThan(0);expect(Buffer.from(objects.get(bodies[0]!.object_key)!).toString()).toContain("not-for-model");
    expect(await executor.execute(f.task.id,operationId,f.binding,f.args)).toEqual(result);expect(sends).toBe(3);
  },15000);
  it("fences revoked authority between automatic pages",async()=>{
    const f=await fixture(true,{pagination:{itemsPointer:"/data",nextCursorPointer:"/next",cursorParameter:"cursor",maxPages:3}});paged=true;
    atProvider=async()=>{if(sends===1)await api.disconnect(f.scope,f.connection.id,f.connection.generation);};
    await expect(executor.execute(f.task.id,await begin(f),f.binding,f.args)).rejects.toBeDefined();expect(sends).toBe(1);
  },15000);
  it("retains an HTTP error receipt while marking the unknown effect uncertain",async()=>{
    const f=await fixture(),operationId=await begin(f,true);status=503;
    await expect(executor.execute(f.task.id,operationId,f.binding,f.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});
    const receipt=(await pool.query("SELECT * FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0];expect(receipt.state).toBe("uncertain");expect(receipt.body_key).toBeTruthy();
    expect(JSON.parse(Buffer.from(objects.get(receipt.body_key)!).toString()).status).toBe(503);expect(sends).toBe(1);
    expect(await collectNativeMetrics(pool,"test")).toEqual(expect.arrayContaining([expect.objectContaining({name:"agents.connected.provider.attempts",attributes:{provider:"native_api",phase:"read",outcome:"failed"}})]));
    await expect(executor.execute(f.task.id,operationId,f.binding,f.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(sends).toBe(1);
  });
  it("fences revoked authority before send and never repeats a lost acknowledgement",async()=>{
    const denied=await fixture(),deniedId=await begin(denied,true);await api.disconnect(denied.scope,denied.connection.id,denied.connection.generation);
    await expect(executor.execute(denied.task.id,deniedId,denied.binding,denied.args)).rejects.toBeDefined();expect(sends).toBe(0);
    const f=await fixture(),operationId=await begin(f,true),abort=new AbortController();hang=true;const reached=new Promise<void>(resolve=>{atProvider=resolve;});
    const result=executor.execute(f.task.id,operationId,f.binding,f.args,abort.signal);await reached;abort.abort();
    await expect(result).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(sends).toBe(1);
    await expect(executor.execute(f.task.id,operationId,f.binding,f.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(sends).toBe(1);
  },10000);
});
