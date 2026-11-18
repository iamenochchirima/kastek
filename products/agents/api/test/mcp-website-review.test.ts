import {createHash,randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {WebsiteReview} from "../src/product/mcp/website-review";
import {WebsiteAppearanceStore} from "../src/product/deployments/appearance-store";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {SourceReview} from "../src/product/mcp/source-review";
import {publishFixtureSource} from "./knowledge-fixture";
import {assertMcpJobAuthority,assertMcpTaskAuthority} from "../src/infrastructure/mcp-job-authority";
import {WebsiteCrawlStore} from "../src/product/agents/website-crawls";
import {IngestionService} from "../src/capabilities/knowledge/ingestion-runtime";
import {connectFixtureModel} from "./model-fixture";
import {createServer as createHttp2Server, type ServerHttp2Session} from "node:http2";
import {createServer as reservePort} from "node:net";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createEndpointHandler} from "@restatedev/restate-sdk";
import {createBusinessWorkflow} from "../src/execution/business/business";
import {settleTask} from "../src/execution/lifecycle/execution";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import type {ModelFetch} from "../src/infrastructure/model-network";
import {dispatchTasksOnce} from "../src/execution/lifecycle/dispatcher";
import {HARNESS_RELEASE,WORKFLOW_NAME,SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME} from "../src/contracts/execution";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import {registerAgentsMcp} from "../src/product/mcp/server";
import {projectMcpReferences,resolveMcpReferences} from "../src/product/mcp/references";

async function completePreview(pool:Pool,models:Awaited<ReturnType<typeof connectFixtureModel>>["store"],taskId:string){
 const binary=process.env.AGENTS_TEST_RESTATE_BINARY;if(!binary)throw new Error("AGENTS_TEST_RESTATE_BINARY is required for worker completion");
 const port=async()=>{const s=reservePort();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const n=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return n;};
 const ingressPort=await port(),adminPort=await port(),internalPort=await port();
 const directory=await mkdtemp(join(tmpdir(),"agents-mcp-preview-")),configuration=join(directory,"restate.toml");
 await writeFile(configuration,await readFile(resolve(__dirname,"scheduling-restate.toml"),"utf8")+`\n[ingress]\nbind-address="127.0.0.1:${ingressPort}"\n[admin]\nbind-address="127.0.0.1:${adminPort}"\n`);
 const native=spawn(binary,["--config-file",configuration,"--base-dir",join(directory,"data"),"--bind-address",`127.0.0.1:${internalPort}`,"--advertised-host","127.0.0.1","--node-name","mcp-preview","--no-logo"],{stdio:"ignore"});
 const sessions=new Set<ServerHttp2Session>();
 let calls=0;const options={modelProvider:models,modelRuntime:{dispatch:(input:Parameters<typeof dispatchBoundModel>[0])=>dispatchBoundModel(input,policy=>{const network=(async(url,request)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Fixture destination denied");await policy.beforeDispatch?.();calls++;const body=JSON.parse(String(request?.body));return new Response(`data: ${JSON.stringify({id:"fixture",model:body.model,choices:[{index:0,delta:{role:"assistant",content:"The opening hours are not available yet."},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});}) as ModelFetch;network.markProgress=()=>{};return network;})}};
 const worker=createHttp2Server(createEndpointHandler({services:[createBusinessWorkflow(pool,options),createBusinessWorkflow(pool,options,{release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME})]}));
 worker.on("session",session=>{sessions.add(session);session.once("close",()=>sessions.delete(session));});
 await new Promise<void>(r=>worker.listen(0,"127.0.0.1",r));
 const admin=`http://127.0.0.1:${adminPort}`,ingress=`http://127.0.0.1:${ingressPort}`,deadline=Date.now()+30000;
 try {
  while(Date.now()<deadline){try{if((await fetch(`${admin}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const registration=await fetch(`${admin}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://127.0.0.1:${(worker.address() as {port:number}).port}`})});if(!registration.ok)throw Error(`Worker registration failed: ${registration.status}`);
  while(Date.now()<deadline){await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:admin,runtimeRoutes:{[HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:admin,workflowName:WORKFLOW_NAME},[SHARED_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:admin,workflowName:SHARED_WORKFLOW_NAME}}});const row=(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];if(["completed","failed","refused","incomplete","uncertain","waiting_authority"].includes(row?.state))return {state:row.state,calls};await new Promise(r=>setTimeout(r,100));}
  throw Error("Preview worker timed out");
 } finally {for(const s of sessions)s.destroy();await new Promise<void>(r=>worker.close(()=>r()));if(native.exitCode===null){native.kill("SIGTERM");await new Promise<void>(r=>native.once("exit",()=>r()));}await rm(directory,{recursive:true,force:true});}
}

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("MCP website activation review",()=>{
 const database=`agents_mcp_review_${randomUUID().replaceAll("-","")}`;
 let admin:Pool,pool:Pool;
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 it("requires approval, protects retries and rejects stale or revoked requests",async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await store.createOrganization(account.id,"Test"),connectionId=randomUUID(),scope={accountId:account.id,organizationId:org.id,connectionId};
  await pool.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES('client','Client',ARRAY['https://client.test/callback'],'hash')");
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,'client',$2,$3,'https://agents.test/mcp',ARRAY['agents:manage'],'hash',now()+interval '1 hour')",[connectionId,account.id,org.id]);
  const agent=await store.createConfiguredAgent({...scope,name:"Support",offering:"faq"});
  const reviews=new WebsiteReview(pool,"https://agents.test"),requestId=randomUUID(),input={agentId:agent.agent.id,requestId,allowedOrigins:["example.com"]};
  const projected=await projectMcpReferences(pool,scope,{id:agent.agent.id,agent_id:agent.agent.id,instructions:`Record ${agent.agent.id}`,url:`https://example.com/${agent.agent.id}`,nextOffset:20,pageIds:["a".repeat(64)]}) as {id:string;agent_id:string;instructions:string;url:string;nextOffset:number;pageIds:string[]};
  expect(projected.id).toMatch(/^ref_/);expect(projected.instructions).toBe(`Record ${agent.agent.id}`);
  expect(projected.agent_id).toBe(projected.id);expect(projected.url).toBe(`https://example.com/${agent.agent.id}`);expect(projected.nextOffset).toBe(20);
  expect(await resolveMcpReferences(pool,scope,{agentId:projected.id,pageIds:projected.pageIds})).toEqual({agentId:agent.agent.id,pageIds:["a".repeat(64)]});
  expect(await resolveMcpReferences(pool,scope,{agent_id:projected.agent_id})).toEqual({agent_id:agent.agent.id});
  await expect(resolveMcpReferences(pool,{...scope,connectionId:randomUUID()},{agentId:projected.id})).rejects.toMatchObject({code:"REFERENCE_UNAVAILABLE"});
  await pool.query("UPDATE agents_platform.mcp_references SET expires_at=now()-interval '1 second' WHERE id=$1",[projected.id.slice(4)]);
  await expect(resolveMcpReferences(pool,scope,{agentId:projected.id})).rejects.toMatchObject({code:"REFERENCE_UNAVAILABLE"});
  const proposal=await reviews.propose(scope,input);
  expect((await reviews.propose(scope,input)).id).toBe(proposal.id);
  expect(await store.listDeployments(account.id,org.id,agent.agent.id)).toHaveLength(0);
  const result=await reviews.decide(account.id,proposal.id,true);
  expect(result.state).toBe("approved");
  expect((await reviews.decide(account.id,proposal.id,true)).deploymentId).toBe(result.deploymentId);
  expect(await store.listDeployments(account.id,org.id,agent.agent.id)).toHaveLength(1);
  const stale=await reviews.propose(scope,{...input,requestId:randomUUID()});
  const appearance=new WebsiteAppearanceStore(pool),draft=await appearance.getDraft(scope,agent.agent.id);
  await appearance.updateDraft(scope,agent.agent.id,{appearance:{...draft.appearance,title:"Changed"},expectedRevision:draft.revision});
  await expect(reviews.decide(account.id,stale.id,true)).rejects.toMatchObject({code:"REVIEW_STALE"});
  const revoked=await reviews.propose(scope,{...input,requestId:randomUUID()});
  await pool.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=now() WHERE id=$1",[connectionId]);
  await expect(reviews.decide(account.id,revoked.id,true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
 it("shows the authorized exact source revision and bounds its review preview",async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"preview-source@example.test",displayName:"Owner"});
  const org=await store.createOrganization(account.id,"Source preview"),connectionId=randomUUID(),scope={accountId:account.id,organizationId:org.id,connectionId};
  await pool.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES('source-preview-client','Client',ARRAY['https://client.test/callback'],'hash')");
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,'source-preview-client',$2,$3,'https://agents.test/mcp',ARRAY['agents:manage'],'preview-source-hash',now()+interval '1 hour')",[connectionId,account.id,org.id]);
  const source=await publishFixtureSource(pool,{...scope,title:"Details",content:"A".repeat(12001),visibility:"private"});
  await pool.query("UPDATE agents_platform.source_revision_policy SET state='candidate',approved_by=NULL,approved_at=NULL WHERE revision_id=$1",[source.id]);
  const reviews=new SourceReview(pool,source.knowledge,"https://agents.test");
  const request=await reviews.propose(scope,{sourceId:source.sourceId,requestId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:source.id});
  const review=await reviews.get(account.id,request.id);
  expect(review.preview).toEqual({revision:1,excerpt:"A".repeat(12000),truncated:true});
  await expect(reviews.get(randomUUID(),request.id)).rejects.toMatchObject({code:"NOT_FOUND"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[org.id,account.id]);
  await expect(reviews.get(account.id,request.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
 it("reviews source visibility exactly once and respects revocation",async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"source@example.test",displayName:"Owner"});
  const org=await store.createOrganization(account.id,"Source"),connectionId=randomUUID(),scope={accountId:account.id,organizationId:org.id,connectionId};
  await pool.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES('source-client','Client',ARRAY['https://client.test/callback'],'hash')");
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,'source-client',$2,$3,'https://agents.test/mcp',ARRAY['agents:manage'],'source-hash',now()+interval '1 hour')",[connectionId,account.id,org.id]);
  const source=await publishFixtureSource(pool,{...scope,title:"Opening hours",content:"Open Monday.",visibility:"private"});
  const reviews=new SourceReview(pool,source.knowledge,"https://agents.test"),requestId=randomUUID(),input={sourceId:source.sourceId,requestId,expectedGeneration:1,action:"visibility",visibility:"public"};
  const proposal=await reviews.propose(scope,input);expect((await reviews.propose(scope,input)).id).toBe(proposal.id);
  expect((await reviews.decide(account.id,proposal.id,true)).state).toBe("approved");expect((await reviews.decide(account.id,proposal.id,true)).state).toBe("approved");
  expect((await source.knowledge.list(scope))[0]?.visibility).toBe("public");
  const pending=await reviews.propose(scope,{...input,requestId:randomUUID(),expectedGeneration:2,visibility:"private"});
  const agent=await store.createConfiguredAgent({...scope,name:"Knowledge agent",offering:"faq"});
  const crawlId=randomUUID();await pool.query(`INSERT INTO agents_platform.website_crawls(id,organization_id,agent_id,account_id,operation_id,request_digest,url,provider_origin,state,page_limit,discovery_depth,mcp_connection_id,updated_at) VALUES($1,$2,$3,$4,$5,'digest','https://example.com','https://crawl.example','queued',1,0,$6,now()-interval '3 seconds')`,[crawlId,org.id,agent.agent.id,account.id,randomUUID(),connectionId]);
  const job=await source.knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Queued",contentType:"text/plain",content:Buffer.from("Queued content"),parserRelease:"fixture-parser-v1"});
  const jobAuthority={mcp_connection_id:connectionId,organization_id:org.id,importer_account_id:account.id};
  await expect(assertMcpJobAuthority(pool,jobAuthority)).resolves.toBeUndefined();
  await pool.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=now() WHERE id=$1",[connectionId]);
  await expect(assertMcpJobAuthority(pool,jobAuthority)).rejects.toMatchObject({code:"ACCESS_DENIED"});
  await new WebsiteCrawlStore(pool,source.knowledge).tick();
  expect((await pool.query("SELECT state,error_code FROM agents_platform.website_crawls WHERE id=$1",[crawlId])).rows[0]).toMatchObject({state:"failed",error_code:"ACCESS_DENIED"});
  const ingestion=new IngestionService(pool,source.storage as never,{} as never,source.knowledge);
  await expect(ingestion.begin(job.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
  await expect(reviews.decide(account.id,pending.id,true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
 it("serializes a write against OAuth revocation",async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"race@example.test",displayName:"Owner"});
  const org=await store.createOrganization(account.id,"Race"),connectionId=randomUUID(),token=`agents_oauth_${"z".repeat(43)}`;
  await pool.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES('race-client','Client',ARRAY['https://client.test/callback'],'hash')");
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,'race-client',$2,$3,'https://agents.example/mcp',ARRAY['agents:manage'],$4,now()+interval '1 hour')",[connectionId,account.id,org.id,createHash("sha256").update(token).digest("hex")]);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;});
  const app=Fastify();registerAgentsMcp(app,{pool,publicUrl:"https://agents.example",allowedOrigins:[],operations:[{name:"write",description:"Fixture write",scope:"agents:manage",inputSchema:{type:"object"},run:async()=>{entered();await resume;await pool.query("UPDATE agents_platform.organizations SET name='Committed' WHERE id=$1",[org.id]);return {ok:true};}}]});
  try {
   const call=app.inject({method:"POST",url:"/mcp",headers:{host:"agents.example",authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"write",arguments:{}}}}).then(response=>response);
   await started;let revoked=false;const revoke=pool.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=now() WHERE id=$1",[connectionId]).then(()=>{revoked=true;});
   await new Promise(r=>setTimeout(r,40));expect(revoked).toBe(false);release();expect((await call).statusCode).toBe(200);await revoke;
   expect((await pool.query("SELECT name FROM agents_platform.organizations WHERE id=$1",[org.id])).rows[0].name).toBe("Committed");
  } finally {release();await app.close();}
 });
 it("serves the creation operations over authenticated MCP",async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"mcp@example.test",displayName:"Owner"});
  const org=await store.createOrganization(account.id,"MCP"),session=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+3600000)});
  const model=await connectFixtureModel(pool,account.id,org.id);
  process.env.AGENTS_MCP_ENABLED="true";
  const portReservation=reservePort();await new Promise<void>(r=>portReservation.listen(0,"127.0.0.1",r));const actualPort=(portReservation.address() as {port:number}).port;await new Promise<void>(r=>portReservation.close(()=>r()));
  process.env.AGENTS_MCP_ALLOWED_HOSTS=`127.0.0.1:${actualPort}`;
  const app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:(pool.options as {connectionString:string}).connectionString,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_ISSUER_URL:"https://identity.test",AGENTS_OIDC_CLIENT_SECRET:"isolated-mcp-fixture-secret"})});
  try {
   const registration=await app.inject({method:"POST",url:"/oauth/register",payload:{client_name:"Test assistant",redirect_uris:["https://client.test/callback"]}});expect(registration.statusCode).toBe(201);
   const clientId=registration.json().client_id,verifier=randomBytes(32).toString("base64url"),resource="http://localhost:3100/mcp";
   const query=new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:"https://client.test/callback",resource,scope:"agents:read agents:manage",state:"test",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
   const start=await app.inject({method:"GET",url:`/oauth/authorize?${query}`});expect(start.statusCode).toBe(302);
   const nonce=new URL(start.headers.location!,"http://localhost:3100").searchParams.get("request"),cookie=`agents_session=${session.token}`;
   expect((await app.inject({method:"GET",url:`/api/mcp/oauth/requests/${nonce}`,headers:{cookie}})).statusCode).toBe(200);
   const decision=await app.inject({method:"POST",url:`/api/mcp/oauth/requests/${nonce}/decision`,headers:{cookie,origin:"http://localhost:3100"},payload:{approved:true,organizationId:org.id}});expect(decision.statusCode).toBe(200);
   const code=new URL(decision.json().redirectUrl).searchParams.get("code")!;
   const exchange=await app.inject({method:"POST",url:"/oauth/token",headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({grant_type:"authorization_code",client_id:clientId,resource,redirect_uri:"https://client.test/callback",code,code_verifier:verifier}).toString()});expect(exchange.statusCode).toBe(200);const token=exchange.json().access_token;
   await app.listen({host:"127.0.0.1",port:actualPort});
   const client=new Client({name:"fixture-assistant",version:"1"});
   await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${actualPort}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
   try{const tools=(await client.listTools()).tools;expect(tools.some(item=>item.name==="create_agent")).toBe(true);expect(tools.find(item=>item.name==="create_agent")?.annotations?.idempotentHint).toBe(true);}finally{await client.close();}
   const call=async(name:string,args:unknown)=>app.inject({method:"POST",url:"/mcp",headers:{host:"localhost:3100",authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
   const created=await call("create_agent",{name:"Bike support",operationId:randomUUID()});
   const capabilities=await call("get_capabilities",{});expect(capabilities.statusCode).toBe(200);const capabilityData=JSON.parse(capabilities.json().result.content[0].text);expect(capabilityData.knowledge.sourceLimit).toBeGreaterThan(0);expect(capabilityData.websiteTextImport).toMatchObject({available:false,maxBytes:262144,retrieval:"lexical-v1"});expect(capabilityData.documentImport).toBe(false);
   expect(created.statusCode).toBe(200);expect(created.json().result.structuredContent.agent.name).toBe("Bike support");const content=created.json().result.content[0].text;let agentId=JSON.parse(content).agent.id;
   const runRequest={agentId,message:"Hello",requestId:randomUUID()};
   const started=await call("start_agent_run",runRequest);expect(started.json().result.isError).not.toBe(true);
   const startedRun=started.json().result.structuredContent;expect(startedRun.state).toBe("accepted");expect(startedRun.taskId).toMatch(/^ref_/);
   const replay=await call("start_agent_run",runRequest);expect(replay.json().result.structuredContent).toMatchObject({taskId:startedRun.taskId,replayed:true});
   const readRun=await call("get_agent_run",{taskId:startedRun.taskId});expect(readRun.json().result.structuredContent).toMatchObject({taskId:startedRun.taskId,state:"accepted"});
   const runId=(await pool.query("SELECT target FROM agents_platform.mcp_references WHERE id=$1",[startedRun.taskId.slice(4)])).rows[0].target;
   await settleTask(pool,runId,{state:"failed",errorCode:"TEST_FINISHED"});
   const readiness=await call("agent_readiness",{agentId});expect(readiness.statusCode).toBe(200);expect(readiness.json().result.isError).not.toBe(true);
   const agent=JSON.parse((await call("get_agent",{agentId})).json().result.content[0].text);
   const configured=await call("update_agent_instructions",{agentId,expectedRevision:agent.revision,instructions:"Answer clearly using approved knowledge."});expect(configured.json().result.isError).not.toBe(true);
   const preview=await call("start_private_preview",{agentId,message:"When are you open?",requestId:randomUUID()});expect(preview.json().result.isError).not.toBe(true);
   if(process.env.AGENTS_TEST_RESTATE_BINARY){const taskId=JSON.parse(preview.json().result.content[0].text).id;const nativeTask=(await pool.query("SELECT target FROM agents_platform.mcp_references WHERE id=$1",[taskId.slice(4)])).rows[0].target;expect(await completePreview(pool,model.store,nativeTask)).toEqual({state:"completed",calls:1});const result=JSON.parse((await call("get_private_preview",{taskId})).json().result.content[0].text);expect(result.output).toBe("The opening hours are not available yet.");}
   const support=await store.createConfiguredAgent({accountId:account.id,organizationId:org.id,name:"Website support",offering:"customer-service"});
   const connection=(await pool.query("SELECT id FROM agents_platform.mcp_oauth_connections WHERE access_hash=$1",[createHash("sha256").update(token).digest("hex")])).rows[0];
   agentId=(await projectMcpReferences(pool,{connectionId:connection.id,organizationId:org.id},{agentId:support.agent.id}) as {agentId:string}).agentId;
   const crawls=await call("list_website_crawls",{agentId});expect(crawls.statusCode).toBe(200);expect(crawls.json().result.isError).not.toBe(true);
   const review=await call("request_website_activation",{agentId,requestId:randomUUID(),allowedOrigins:["example.com"]});expect(review.json().result.isError).not.toBe(true);
   const reviewId=new URL(JSON.parse(review.json().result.content[0].text).reviewUrl).searchParams.get("request");
   const activate=await app.inject({method:"POST",url:`/api/mcp/website-reviews/${reviewId}/decision`,headers:{cookie,origin:"http://localhost:3100"},payload:{approved:true}});expect(activate.statusCode).toBe(200);expect(activate.json().state).toBe("approved");
   const pending=await call("start_private_preview",{agentId,message:"Please check again",requestId:randomUUID()});const pendingRef=JSON.parse(pending.json().result.content[0].text).id;const pendingId=(await pool.query("SELECT target FROM agents_platform.mcp_references WHERE id=$1",[pendingRef.slice(4)])).rows[0].target;
   await pool.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=now() WHERE access_hash=$1",[createHash("sha256").update(token).digest("hex")]);
   await expect(assertMcpTaskAuthority(pool,pendingId)).rejects.toMatchObject({code:"ACCESS_DENIED"});
   await expect(assertMcpTaskAuthority(pool,runId)).rejects.toMatchObject({code:"ACCESS_DENIED"});
   expect((await call("get_agent_run",{taskId:startedRun.taskId})).statusCode).toBe(401);
   if(process.env.AGENTS_TEST_RESTATE_BINARY){const denied=await completePreview(pool,model.store,pendingId);expect(denied.calls).toBe(0);expect(denied.state).not.toBe("completed");}
  } finally {delete process.env.AGENTS_MCP_ENABLED;delete process.env.AGENTS_MCP_ALLOWED_HOSTS;await app.close();}
 },60000);
});
