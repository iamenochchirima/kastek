import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer as httpServer, type Server } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusinessWorkflow } from "../src/platform/business";
import { defaultFaqConfiguration, connectedToolAuthorityIds, requestDigest, terminalTaskStates, type AgentConfiguration, type ExecutionGrant } from "../src/platform/contracts";
import {loadContinuation} from "../src/platform/continuation";
import { beginOperation } from "../src/platform/execution";
import { dispatchTasksOnce } from "../src/platform/dispatcher";
import { EvidenceStore } from "../src/platform/evidence";
import { KnowledgeRuntime } from "../src/platform/knowledge-runtime";
import { ConnectedExecutor } from "../src/platform/connected-executor";
import { ConnectionStore } from "../src/platform/connections";
import { ConnectionVault } from "../src/platform/vault";
import { ActionService } from "../src/platform/actions";
import { TaskArtifactStore } from "../src/platform/task-artifacts";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { initializeReportReceiver, createReportReceiver } from "../src/acceptance/report-receiver";
import { publishFixtureSource } from "./knowledge-fixture";
import type { CapabilityBinding } from "../src/platform/capability-catalog";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("grounded controller composition with actual PG, Restate, local HTTP and isolated MCP SDK",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,connections:ConnectionStore,connected:ConnectedExecutor,evidence:EvidenceStore,artifacts:TaskArtifactStore,actions:ActionService;
 let providerServer:Server,worker:ReturnType<typeof createServer>,workflow:ReturnType<typeof createBusinessWorkflow>,receiver:ReturnType<typeof createReportReceiver>;
 let ingressUrl:string,adminUrl:string,origin:string,containerStarted=false,modelCalls=0,partial=false,posts=0,inFlight=0,orphanMode=false,checkpointMode=false;
 let afterAccept:((id:string)=>Promise<void>)|undefined;
 const database=`agents_grounded_controller_${randomUUID().replaceAll("-","")}`,container=`agents-grounded-controller-${randomUUID()}`,sessions=new Set<ServerHttp2Session>();
 const bodies=new Map<string,Uint8Array>(),storage={async put(key:string,value:Uint8Array){bodies.set(key,Buffer.from(value));},async get(key:string){const value=bodies.get(key);if(!value)throw Error("Missing explicit fixture object");return value;},async delete(key:string){bodies.delete(key);}};
 const content="Decisive public repository fact.",bytes=Buffer.from(content),blob=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),commit="a".repeat(40),tree="b".repeat(40),receiverKey=randomUUID();
 const remoteCalls:Record<string,unknown>[]=[],httpRequests:string[]=[],modelSnapshots:any[]=[];
 let activeBindings:CapabilityBinding[]=[];
 const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
 async function eventually<T>(check:()=>Promise<T|false>,timeout=30000):Promise<T>{const until=Date.now()+timeout;while(Date.now()<until){const result=await check();if(result!==false)return result;await new Promise(resolve=>setTimeout(resolve,50));}throw Error("Grounded integration timed out");}
 async function listen(port=0){worker=createServer(createEndpointHandler({services:[workflow]}));worker.on("session",session=>{sessions.add(session);session.once("close",()=>sessions.delete(session));});await new Promise<void>(resolve=>worker.listen(port,"0.0.0.0",resolve));}
 async function restart(){const port=(worker.address() as{port:number}).port;for(const session of sessions)session.destroy();await new Promise<void>(resolve=>worker.close(()=>resolve()));await listen(port);}
 function reply(content:string|null,finish="stop",name?:string,args?:object){return Response.json({id:"local-composition-model",choices:[{finish_reason:name?"tool_calls":finish,message:{role:"assistant",content:name?null:content,...(name?{tool_calls:[{id:`call-${modelCalls}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]}:{})}}],usage:{prompt_tokens:80,completion_tokens:20}});}
 async function model(body:any):Promise<Response>{
  modelCalls++;modelSnapshots.push(body);
  if(checkpointMode&&body.messages[0].content.startsWith("Summarize"))return reply("No specialists have executed; delegate them again.");
  const serialized=JSON.stringify(body.messages),isRoot=serialized.includes("ROOT_COORDINATOR"),native=serialized.includes("SPECIALIST_NATIVE");
  const results=body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content));
  const labels=[...new Set<string>(serialized.match(/E[a-f0-9]{32}/g)??[])];
  if(isRoot){
   if(orphanMode)return reply(null,"stop",activeBindings.find(binding=>binding.definition.providerOperation==="resolve_ref")!.alias,{repository:"approved/public"});
   if(checkpointMode&&body.messages.some((message:any)=>message.role==="system"&&message.content.includes('"delegations":[{'))){
    const message=body.messages.find((message:any)=>message.role==="system"&&message.content.startsWith("Server-confirmed execution"));
    const checkpoint=JSON.parse(message.content.slice(message.content.indexOf("\n")+1));
    expect(checkpoint.delegations).toHaveLength(1);expect(checkpoint.delegations[0].children).toHaveLength(2);expect(checkpoint.delegations[0].children.every((child:any)=>child.state==="completed")).toBe(true);
    expect(body.messages.some((message:any)=>message.role==="user"&&message.content.includes("No specialists have executed"))).toBe(true);
    expect(body.messages.filter((message:any)=>message.role==="system").map((message:any)=>message.content).join(" ")).not.toContain("untrusted provider instructions");
    expect(body.messages.some((message:any)=>message.role==="user"&&message.content.includes("untrusted provider instructions"))).toBe(true);
    return reply(`Checkpoint synthesis ${checkpoint.evidence.map((item:any)=>item.citation).join(" ")}`);
   }
   if(!results.length)return reply(null,"stop","agents_delegate",{requests:[{bindingId:"native",brief:checkpointMode?"decisive "+" ".repeat(1100):"decisive"},{bindingId:"mcp",brief:checkpointMode?"decisive "+" ".repeat(1100):"decisive"}]});
   expect(results[0].children).toHaveLength(2);
   if(results[0].partial!==partial){
    const ids=results[0].children.map((child:any)=>child.taskId);
    const tasks=(await pool.query("SELECT id,parent_task_id,root_task_id,state,error_code,disposition,tokens_used,tokens_reserved,active_ms,active_reserved_ms,root_token_limit,allocation_active_ms,octet_length(output) AS output_bytes,created_at,updated_at FROM agents_platform.tasks WHERE id=ANY($1::uuid[])",[ids])).rows;
    const operations=(await pool.query("SELECT id,task_id,kind,name,state,error_code,reserved_tokens,accounted_tokens,reserved_ms,started_at,completed_at FROM agents_platform.operations WHERE task_id=ANY($1::uuid[]) ORDER BY started_at",[ids])).rows;
    const proof={expectedPartial:partial,observed:results[0],tasks,operations},directory=resolve(__dirname,"../../../../.audit");await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,`grounded-controller-partial-${tasks[0]?.root_task_id??randomUUID()}.json`),JSON.stringify(proof,null,2),{mode:0o600});
    console.error("Unexpected specialist outcome",JSON.stringify(proof));
   }
   expect(results[0].partial,JSON.stringify(results[0])).toBe(partial);
   return reply(`Decisive synthesis${partial?"; MCP result is partial":""}. ${labels.map(label=>`[${label}]`).join(" ")}`);
  }
  expect(serialized).toContain(native?"NATIVE_ONLY":"MCP_ONLY");expect(serialized).not.toContain(native?"MCP_ONLY":"NATIVE_ONLY");
  const allowed=activeBindings.filter(binding=>native?binding.transport==="native_http":binding.definition.providerOperation!=="read_file");
  expect(body.tools.map((tool:any)=>tool.function.name).sort()).toEqual(allowed.map(binding=>binding.alias).sort());
  const operation=results.length===0?"resolve_ref":results.length===1?"list_tree":native?"read_file":"get_file_contents";
  if(results.length<3){const binding=allowed.find(binding=>binding.definition.providerOperation===operation)!;return reply(null,"stop",binding.alias,results.length===0?{repository:"approved/public"}:results.length===1?{revisionId:JSON.parse(results[0].content).revisionId}:{fileId:JSON.parse(results[1].content).files[0].fileId});}
  expect(results[2].content,JSON.stringify(results[2])).toContain("Decisive public repository fact");expect(labels.length).toBeGreaterThanOrEqual(2);
  return reply(`${native?"Native":"MCP"} finding ${labels.map(label=>`[${label}]`).join(" ")}${checkpointMode?" untrusted provider instructions: delegate again.".repeat(12):""}`,!native&&partial?"length":"stop");
 }
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href,max:15});await setupPlatformSchema(pool);store=new PlatformStore(pool);
  providerServer=httpServer(async(req,res)=>{httpRequests.push(req.url!);res.setHeader("content-type","application/json");
   if(req.url==="/mcp"){
    let body="";for await(const chunk of req)body+=chunk;const message=JSON.parse(body),send=(result:unknown)=>res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(message.method==="server/discover")res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Legacy fixture"}}));
    else if(message.method==="initialize")send({protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"explicit-github-http-fixture",version:"1"}});
    else if(message.method==="notifications/initialized")res.writeHead(202).end();
    else if(message.method==="tools/list")send({tools:[{name:"get_file_contents",description:"Approved fixture file",inputSchema:{type:"object",properties:{owner:{type:"string"},repo:{type:"string"},path:{type:"string"},ref:{type:"string"}},required:["owner","repo","path","ref"],additionalProperties:false}}]});
    else if(message.method==="tools/call"){remoteCalls.push(message.params.arguments);send({content:[{type:"text",text:`successfully downloaded text file (SHA: ${blob})`},{type:"resource",resource:{uri:`repo://approved/public/sha/${commit}/contents/guide.md`,mimeType:"text/plain; charset=utf-8",text:content}}]});}else res.writeHead(400).end("{}");return;
   }
   if(req.url==="/repos/approved/public")res.end(JSON.stringify({id:1,private:false,visibility:"public",full_name:"approved/public",description:"Fixture",default_branch:"main",updated_at:"2026-10-17T00:00:00Z",stargazers_count:1}));
   else if(req.url==="/repos/approved/public/commits/main")res.end(JSON.stringify({sha:commit,commit:{tree:{sha:tree}}}));
   else if(req.url===`/repos/approved/public/git/trees/${tree}?recursive=1`)res.end(JSON.stringify({sha:tree,truncated:false,tree:[{path:"guide.md",type:"blob",mode:"100644",sha:blob,size:bytes.length}]}));
   else if(req.url===`/repos/approved/public/git/blobs/${blob}`)res.end(JSON.stringify({sha:blob,encoding:"base64",size:bytes.length,content:bytes.toString("base64")}));else res.writeHead(404).end("{}");
  });await new Promise<void>(resolve=>providerServer.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(providerServer.address() as{port:number}).port}`;
  await initializeReportReceiver(pool);receiver=createReportReceiver({pool,keys:[{apiKey:receiverKey,resource:"reports:grounded"}],afterAccept:async id=>{posts++;await afterAccept?.(id);}});const receiverOrigin=await receiver.listen({host:"127.0.0.1",port:0});
  const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),targets=[{id:"reports",label:"Reports",url:`${receiverOrigin}/deliveries`,resource:"reports:grounded"}];
  connections=new ConnectionStore(pool,vault,targets);artifacts=new TaskArtifactStore(pool,storage);evidence=new EvidenceStore(pool,storage);actions=new ActionService(pool,{vault,targets,artifacts});connected=new ConnectedExecutor(pool,connections,storage,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`});
  workflow=createBusinessWorkflow(pool,{evidence,knowledgeRuntime:new KnowledgeRuntime(pool,evidence),connected,actions:{prepare:(...args)=>actions.prepare(...args),getReview:(...args)=>actions.getReview(...args),reconcile:(...args)=>actions.reconcile(...args),execute:async(...args)=>{inFlight++;try{return await actions.execute(...args);}finally{inFlight--;}}},selectReportArtifact:(...args)=>artifacts.prepareReport(...args),openRouterApiKey:"explicit-local-model-fixture",fetch:async(_url,init)=>model(JSON.parse(String(init?.body))).catch(error=>{console.error("Explicit fixture model assertion failed",error);throw error;})});await listen();
  docker("run","-d","--name",container,"--cpus","2","--memory","768m","--add-host","host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");containerStarted=true;
  ingressUrl=`http://${docker("port",container,"8080/tcp")}`;adminUrl=`http://${docker("port",container,"9070/tcp")}`;await eventually(async()=>{try{return(await fetch(`${adminUrl}/health`)).ok;}catch{return false;}});
  const registered=await fetch(`${adminUrl}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://host.docker.internal:${(worker.address() as{port:number}).port}`,force:false})});expect(registered.ok,await registered.text()).toBe(true);
 },60000);
 afterAll(async()=>{for(const session of sessions)session.destroy();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));providerServer?.closeAllConnections();if(providerServer)await new Promise<void>(resolve=>providerServer.close(()=>resolve()));await receiver?.close();if(containerStarted)docker("rm","-f",container);await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function fixture(withReport:boolean){
  modelCalls=0;modelSnapshots.length=0;httpRequests.length=0;remoteCalls.length=0;posts=0;
  const owner=await store.ensureAccount({issuer:"http://localhost/grounded-composition",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await store.createOrganization(owner.id,"Grounded"),scope={accountId:owner.id,organizationId:org.id};
  const sources=await Promise.all(["NATIVE_ONLY","MCP_ONLY"].map(marker=>publishFixtureSource(pool,{...scope,title:marker,content:`Decisive ${marker} indexed fact.`,visibility:"private"},storage)));
  const github=await connections.create(scope,{operationId:randomUUID(),name:"GitHub fixture",profileId:"github-public-read-v1",targetId:"provider:github",apiKey:"github_pat_grounded_fixture_only",expiresAt:new Date(Date.now()+86400000).toISOString(),selections:[{owner:"approved",repository:"public",ref:"main"}]});
  const native=await connected.discover(scope,{operationId:randomUUID(),connectionId:github.id,expectedRevision:1,transport:"native_http"});
  const nativeBindings=await connected.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:github.id,expectedRevision:1,catalogId:native.id,selections:["resolve_ref","list_tree","read_file"].map(providerOperation=>({providerOperation,resources:github.resources}))});
  const remote=await connected.discover(scope,{operationId:randomUUID(),connectionId:github.id,expectedRevision:1,transport:"mcp_http"}),mcpBindings=await connected.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:github.id,expectedRevision:1,catalogId:remote.id,selections:[{providerOperation:"get_file_contents",resources:github.resources}]});
  activeBindings=[...nativeBindings,...mcpBindings];
  const childVersions=[];
  for(const[index,marker]of ["NATIVE","MCP"].entries()){
   const childBindings=index===0?nativeBindings:[...nativeBindings.filter(binding=>binding.definition.providerOperation!=="read_file"),...mcpBindings];
   const configuration={...defaultFaqConfiguration(),instructions:`SPECIALIST_${marker}: Read your decisive indexed source and selected public file. Cite supplied labels.`,model:{...defaultFaqConfiguration().model,maxOutputTokens:256},sourceRevisionIds:[sources[index]!.id],connectedToolBindingIds:childBindings.map(binding=>binding.id)};
   const agent=await store.createAgent({...scope,name:marker,configuration});childVersions.push(await store.createVersion({...scope,agentId:agent.id,expectedRevision:1}));
  }
  const delivery=withReport?await connections.create(scope,{operationId:randomUUID(),name:"Report receiver",targetId:"reports",apiKey:receiverKey}):undefined;
  const configuration:AgentConfiguration={...defaultFaqConfiguration(),instructions:"ROOT_COORDINATOR: Delegate both specialists, synthesize their exact citations, and report partial outcomes truthfully.",model:{...defaultFaqConfiguration().model,maxOutputTokens:512},sourceRevisionIds:sources.map(source=>source.id),connectedToolBindingIds:checkpointMode?[]:activeBindings.map(binding=>binding.id),...(checkpointMode?{context:{maxInputTokens:6144,compactAtTokens:6144}}:{}),tools:["agents.delegate"],capabilities:{...defaultFaqConfiguration().capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:childVersions.map((version,index)=>({id:index===0?"native":"mcp",versionId:version.id,sourceRevisionIds:[sources[index]!.id],connectedToolBindingIds:version.configuration.connectedToolBindingIds,tools:[],maxTokens:12000,maxActiveMs:240000}))},workflows:delivery?{enabled:true,profileId:"report-delivery-v1",connectionId:delivery.id,reportArtifactName:"report.md",title:"Grounded composition report"}:{enabled:false}}};
  const agent=await store.createAgent({...scope,name:"Coordinator",configuration}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1}),authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:owner.issuer,subject:owner.subject}};
  const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read","delegation.execute",...(delivery?["effect.deliver" as const,"artifact.read" as const,"artifact.write" as const]:[])],sourceRevisionIds:configuration.sourceRevisionIds,connectedToolBindingIds:connectedToolAuthorityIds(configuration),maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};await store.createGrant({...scope,grant});const{task}=await store.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"decisive"});return{scope,task,sources};
 }
 async function waitTask(taskId:string,state?:string){return eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl});const row=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];if(state&&terminalTaskStates.has(row.state))throw Error(`Expected ${state}, got ${row.state}: ${row.error_code}`);return(state?row.state===state:terminalTaskStates.has(row.state))?row:false;});}
 it("joins narrowed native/MCP specialists and exact citations, then resumes reviewed delivery after lost ACK without repeating model or provider reads",async()=>{
  partial=false;const f=await fixture(true);await waitTask(f.task.id,"waiting_review");const review=(await actions.listForTask(f.scope,f.task.id))[0]!;
  expect(modelCalls).toBe(10);expect(remoteCalls).toEqual([{owner:"approved",repo:"public",path:"guide.md",ref:commit}]);
  const children=(await pool.query("SELECT id,effective_configuration,state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY input",[f.task.id])).rows;expect(children).toHaveLength(2);expect(children.every(child=>child.state==="completed")).toBe(true);
  expect(new Set(children.flatMap(child=>child.effective_configuration.sourceRevisionIds))).toEqual(new Set(f.sources.map(source=>source.id)));expect(children.every(child=>child.effective_configuration.sourceRevisionIds.length===1)).toBe(true);
  expect(review.citedPassages!.length).toBeGreaterThanOrEqual(4);expect(review.preview.content).toContain("Decisive synthesis");
  const durable=(await pool.query("SELECT r.operation_id,r.result FROM agents_platform.connected_reads r JOIN agents_platform.tasks t ON t.id=r.task_id WHERE t.root_task_id=$1",[f.task.id])).rows;
  const visible=modelSnapshots.flatMap(snapshot=>snapshot.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content))).filter(result=>result.evidence);
  expect(visible.length).toBeGreaterThan(0);
  for(const view of visible){
    const receipt=durable.find(row=>row.result.evidence.id===view.evidence.id)?.result;expect(receipt).toBeDefined();
    expect(view.content).toBe(receipt.content);expect(view.evidence.citation).toBe(receipt.evidence.citation);expect(view.observation).toEqual({acquiredAt:receipt.observation.acquiredAt,provenance:receipt.observation.provenance});
    expect(view).not.toHaveProperty("operationId");expect(view.observation).not.toHaveProperty("digest");expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(receipt).length);
    if(receipt.handles){expect(view).not.toHaveProperty("handles");expect(JSON.stringify(receipt.handles)).not.toBe("{}");}
  }
  const requestsBefore=httpRequests.length,callsBefore=modelCalls;await restart();let accepted=false,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});afterAccept=async()=>{accepted=true;await barrier;};
  try{
   await actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"approve",expectedDigest:review.reviewDigest});await dispatchTasksOnce(pool,{ingressUrl,adminUrl});await eventually(async()=>accepted);await restart();
   expect((await waitTask(f.task.id)).state).toBe("completed");expect(posts).toBe(1);expect(modelCalls).toBe(callsBefore);expect(httpRequests).toHaveLength(requestsBefore);
   const delivered=(await pool.query("SELECT payload FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows;expect(delivered).toHaveLength(1);expect(Buffer.from(delivered[0].payload.report.contentBase64,"base64").toString()).toBe(review.preview.content);expect((await actions.getReview(f.task.id,review.id)).state).toBe("delivered");
  }finally{release();afterAccept=undefined;await eventually(async()=>inFlight===0);}
 },60000);
 it.each([false,true])("persists trusted continuation across compaction and worker restart without repeating completed work (withdraw source: %s)",async(withdraw)=>{
  checkpointMode=true;partial=false;
  const gate=await pool.connect(),key=1500000+Math.floor(Math.random()*1000000);await gate.query("SELECT pg_advisory_lock($1)",[key]);let released=false;
  try{
   const f=await fixture(false);
   await pool.query(`CREATE FUNCTION agents_platform.fixture_continuation_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.task_id='${f.task.id}'::uuid AND NEW.kind='context.prepared' AND EXISTS(SELECT 1 FROM agents_platform.context_snapshots WHERE task_id=NEW.task_id AND step>=2 AND payload ? 'continuation') THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_continuation_gate BEFORE INSERT ON agents_platform.task_events FOR EACH ROW EXECUTE FUNCTION agents_platform.fixture_continuation_gate()`);
   await dispatchTasksOnce(pool,{ingressUrl,adminUrl});
   const snapshot=await eventually(async()=>{const row=(await pool.query("SELECT * FROM agents_platform.context_snapshots WHERE task_id=$1 AND step>=2 AND payload ? 'continuation' ORDER BY step LIMIT 1",[f.task.id])).rows[0];if(row)return row;const task=(await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];if(terminalTaskStates.has(task.state))throw Error(JSON.stringify({task,requests:modelSnapshots.filter(body=>JSON.stringify(body.messages).includes("ROOT_COORDINATOR")).map(body=>({bytes:Buffer.byteLength(JSON.stringify(body)),messages:body.messages.length}))}));return false;});
   expect(snapshot.payload.continuation.checkpoint.delegations).toHaveLength(1);expect(snapshot.payload.continuation.results).toHaveLength(2);
   expect(snapshot.payload.messages.some((message:any)=>message.role==="user"&&message.content.includes("No specialists have executed"))).toBe(true);
   expect(snapshot.payload.estimatedTokens).toBeLessThanOrEqual(6144);
   const reconstructed=await loadContinuation(pool,f.task.id,true,snapshot.payload.continuation.checkpoint.evidence);expect(reconstructed.checkpoint.delegations).toEqual(snapshot.payload.continuation.checkpoint.delegations);
   const ledgerBefore=(await pool.query("SELECT id,accounted_tokens FROM agents_platform.operations WHERE task_id IN(SELECT id FROM agents_platform.tasks WHERE root_task_id=$1) ORDER BY id",[f.task.id])).rows;
   const bytesBefore=JSON.stringify(snapshot.payload),readsBefore=httpRequests.length,callsBefore=modelCalls;
   if(withdraw)await f.sources[0]!.knowledge.setPolicy(f.scope,f.sources[0]!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
   await restart();await gate.query("SELECT pg_advisory_unlock($1)",[key]);released=true;
   const task=await waitTask(f.task.id);if(withdraw){expect(task.state).toBe("incomplete");expect(task.error_code).toBe("EVIDENCE_UNAVAILABLE");expect(modelCalls).toBe(callsBefore);}else{expect(task.state).toBe("completed");expect(task.output).toContain("Checkpoint synthesis");}
   expect((await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE id=$1",[snapshot.id])).rows[0].payload).toEqual(snapshot.payload);
   expect(JSON.stringify(snapshot.payload)).toBe(bytesBefore);expect(httpRequests).toHaveLength(readsBefore);
   expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.delegations WHERE parent_task_id=$1",[f.task.id])).rows[0].count).toBe(2);
   const priorIds=ledgerBefore.map(row=>row.id),ledgerAfter=(await pool.query("SELECT id,accounted_tokens FROM agents_platform.operations WHERE id=ANY($1::text[]) ORDER BY id",[priorIds])).rows;expect(ledgerAfter).toEqual(ledgerBefore);
  }finally{
   if(!released)await gate.query("SELECT pg_advisory_unlock($1)",[key]);gate.release();
   await pool.query("DROP TRIGGER IF EXISTS fixture_continuation_gate ON agents_platform.task_events; DROP FUNCTION IF EXISTS agents_platform.fixture_continuation_gate()");checkpointMode=false;
  }
 },60000);
 it("preserves known partial child outcomes and inherited citations without preparing a successful delivery",async()=>{
  partial=true;const f=await fixture(true),task=await waitTask(f.task.id);expect(task.state).toBe("incomplete");expect(task.error_code).toBe("CHILD_PARTIAL_FAILURE");expect(task.output).toContain("MCP result is partial");expect(modelCalls).toBe(10);expect(await actions.listForTask(f.scope,task.id)).toEqual([]);
  expect((await evidence.validateCitations(task.id,task.output)).length).toBeGreaterThanOrEqual(2);const states=(await pool.query("SELECT state FROM agents_platform.tasks WHERE parent_task_id=$1",[task.id])).rows.map(row=>row.state).sort();expect(states).toEqual(["completed","incomplete"]);
 },60000);
 it("keeps an orphaned connected read uncertain through the controller without sending or generating again",async()=>{
  orphanMode=true;partial=false;
  try{
   const f=await fixture(false),binding=activeBindings.find(binding=>binding.definition.providerOperation==="resolve_ref")!,args={repository:"approved/public"},operationId=`tool:${f.task.id}:0:0`;
   await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:{tool:binding.alias,arguments:JSON.stringify(args),version:"1",bindingDigest:binding.digest},reservedTokens:0,reservedMs:binding.limits.timeoutMs,retrySafe:true});
   await pool.query("INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state) VALUES($1,$2,$3,$2,$4,$5,$6,'started')",[operationId,f.task.id,f.scope.organizationId,binding.connection!.id,binding.id,requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args})]);
   const readsBefore=httpRequests.length,task=await waitTask(f.task.id);expect(task.state).toBe("uncertain");expect(task.error_code).toBe("CONNECTED_READ_UNCERTAIN");expect(modelCalls).toBe(1);expect(httpRequests).toHaveLength(readsBefore);
   const operation=(await pool.query("SELECT state,error_code,reserved_ms FROM agents_platform.operations WHERE id=$1",[operationId])).rows[0];expect(operation.state).toBe("uncertain");expect(operation.error_code).toBe("CONNECTED_READ_UNCERTAIN");expect(Number((await pool.query("SELECT active_ms FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0].active_ms)).toBeGreaterThanOrEqual(operation.reserved_ms);
   const read=(await pool.query("SELECT state,error_code FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0];expect(read).toEqual({state:"uncertain",error_code:"CONNECTED_READ_UNCERTAIN"});
   expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.connected_attempts WHERE operation_id=$1",[operationId])).rows[0].count).toBe(0);
  }finally{orphanMode=false;}
 },30000);
});
