import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer as httpServer} from "node:http";
import {createServer as http2Server} from "node:http2";
import {execFileSync,spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createInterface} from "node:readline";
import {resolve} from "node:path";
import {generateKeyPair,exportSPKI,exportPKCS8,SignJWT,jwtVerify} from "jose";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
import {createEndpointHandler} from "@restatedev/restate-sdk";
import type {GrowthAgentCommand,GrowthAgentAction,GrowthAgentReview} from "@kasitek-labs/contracts";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {setupPlatformSchema} from "../src/composition/setup";
import {GrowthProductRuntime} from "../src/execution/products/growth-runtime";
import {GrowthActionClient} from "../src/adapters/products/growth-action-client";
import {GrowthExecutionService} from "../src/product/integrations/growth-execution";
import {provisionGrowthModel} from "../src/product/integrations/growth-model-provisioning";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {ModelProviderStore} from "../src/product/model-providers/store";
import {createBusinessWorkflow} from "../src/execution/business/business";
import {dispatchTasksOnce} from "../src/execution/lifecycle/dispatcher";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import {requestDigest,terminalTaskStates} from "../src/contracts/contracts";
import {growthFeatureConfiguration} from "../src/product/integrations/growth-features";
import {verifyGrowthBrowser} from "./support/growth-browser";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {transaction} from "../src/infrastructure/database";
import type {ModelFetch} from "../src/infrastructure/model-network";
const adminUrl=process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl?describe:describe.skip)("Growth authenticated product HTTP and durable worker",()=>{
  const database="agents_growth_product_http_"+randomUUID().replaceAll("-",""),container="growth-product-http-"+randomUUID();
  const issuer="https://growth.fixture.test",actor={issuer:issuer+"/identity",subject:randomUUID()},tenantId=randomUUID();
  const keyVault=new ModelCredentialVault(new ConnectionVault("test",{test:randomBytes(32).toString("base64")}));
  let admin:Pool,pool:Pool,keys:Awaited<ReturnType<typeof generateKeyPair>>,control:typeof keys,workerKeys:typeof keys;
  let app:Awaited<ReturnType<typeof buildPlatformApp>>,growth:ChildProcessWithoutNullStreams,provider:ReturnType<typeof httpServer>,worker:ReturnType<typeof http2Server>;
  let ingress:string,restAdmin:string,origin:string,runtime:GrowthProductRuntime,workerFactory:()=>ReturnType<typeof http2Server>;
  const workerSessions=new Set<import("node:http2").ServerHttp2Session>();
  function trackWorker(){worker.on("session",session=>{workerSessions.add(session);session.once("close",()=>workerSessions.delete(session));});}
  let modelCalls=0,growthOrigin:string,objects:ReturnType<typeof httpServer>;const artifactBytes=Buffer.alloc(90000,65);const controls:any[]=[];
  async function controlFixture(message:unknown,type:string){growth.stdin.write(JSON.stringify(message)+"\n");await until(async()=>controls.findIndex(item=>item.type===type)>=0?controls.splice(controls.findIndex(item=>item.type===type),1)[0]:false);}
  async function browser(path:string,body?:unknown,method=body===undefined?"GET":"POST"){return fetch(growthOrigin+path,{method,headers:{origin:growthOrigin,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  async function browserOk(path:string,body?:unknown){const response=await browser(path,body),value=await response.json();expect(response.status,JSON.stringify(value)).toBeLessThan(300);return value as any;}
  const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
  async function until<T>(fn:()=>Promise<T|false>,timeout=25000):Promise<T>{
    const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error("Bounded Growth integration wait expired");
  }
  async function listen(server:ReturnType<typeof httpServer>){await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));return "http://127.0.0.1:"+(server.address() as {port:number}).port;}
  async function signed(command:GrowthAgentCommand,isControl=false){
    const now=Math.floor(Date.now()/1000);
    return new SignJWT({product:"growth",requestDigest:requestDigest(command)}).setProtectedHeader({alg:"RS256",kid:isControl?"control":"growth-v1"})
      .setIssuer(issuer).setSubject(isControl?"growth-control":"growth-api").setAudience("agents-product-api")
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+60).sign((isControl?control:keys).privateKey);
  }
  async function send(command:GrowthAgentCommand,isControl=false) {
    return fetch(origin+"/internal/v1/products/growth/commands",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+await signed(command,isControl)},body:JSON.stringify(command)});
  }
  function command<K extends GrowthAgentCommand["operation"]>(operation:K,input:Extract<GrowthAgentCommand,{operation:K}>["input"],extra:Partial<GrowthAgentCommand>={}):GrowthAgentCommand{
    return {version:"1",requestId:randomUUID(),tenantId,actor,operation,input,...extra} as GrowthAgentCommand;
  }
  async function ok(cmd:GrowthAgentCommand,isControl=false){const response=await send(cmd,isControl),value=await response.json();expect(response.status,JSON.stringify(value)).toBe(200);return value as any;}
  beforeAll(async()=>{
    const target=new URL(adminUrl!);if(!["127.0.0.1","localhost","[::1]"].includes(target.hostname))throw Error("Disposable fixture needs a local PostgreSQL administrator");
    target.pathname="/postgres";admin=new Pool({connectionString:target.href});await admin.query('CREATE DATABASE "'+database+'"');
    target.pathname="/"+database;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);
    keys=await generateKeyPair("RS256",{extractable:true});control=await generateKeyPair("RS256",{extractable:true});workerKeys=await generateKeyPair("RS256",{extractable:true});
    growth=spawn(process.execPath,["--import",resolve("../../growth/api/node_modules/tsx/dist/loader.mjs"),resolve("../../growth/api/tests/support/growth-agent-fixture-server.ts")],{env:{...process.env,
      NODE_ENV:"test",GROWTH_AGENT_FIXTURE_ADMIN_URL:adminUrl!,GROWTH_AGENT_FIXTURE_TENANT_ID:tenantId,GROWTH_AGENT_FIXTURE_USER_ID:actor.subject,
      GROWTH_AGENTS_ISSUER:issuer,GROWTH_IDENTITY_ISSUER:actor.issuer,GROWTH_AGENTS_SIGNING_PRIVATE_KEY:await exportPKCS8(keys.privateKey),
      AGENTS_PRODUCT_ACTION_ISSUER:"https://agents.fixture.test",AGENTS_PRODUCT_ACTION_PUBLIC_KEY:await exportSPKI(workerKeys.publicKey)},stdio:"pipe"});
    let childFailure="";growth.stderr.on("data",chunk=>{childFailure+=String(chunk).slice(0,2000);});
    createInterface({input:growth.stdout}).on("line",line=>{try{controls.push(JSON.parse(line));}catch{}});
    const ready=await until(async()=>{if(growth.exitCode!==null)throw Error("Growth fixture exited: "+childFailure);return controls.find(item=>item.type==="ready")??false;});
    growthOrigin=ready.allowedOrigin;
    vi.stubEnv("GROWTH_AGENTS_ISSUER",issuer);vi.stubEnv("GROWTH_IDENTITY_ISSUER",actor.issuer);
    vi.stubEnv("GROWTH_AGENTS_PUBLIC_KEY",await exportSPKI(keys.publicKey));vi.stubEnv("GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON",JSON.stringify({control:await exportSPKI(control.publicKey)}));
    vi.stubEnv("GROWTH_PRODUCT_API_URL",growthOrigin);vi.stubEnv("AGENTS_PRODUCT_ACTION_PRIVATE_KEY",await exportPKCS8(workerKeys.privateKey));vi.stubEnv("AGENTS_PRODUCT_ACTION_ISSUER","https://agents.fixture.test");
    vi.stubEnv("NODE_ENV","test");vi.stubEnv("AGENTS_OIDC_CLIENT_SECRET","isolated-growth-product-cursor-secret");
    vi.stubEnv("AGENTS_SCHEDULING_POLICY_JSON",JSON.stringify({maxConcurrentRoots:10,dailyTokenAllowance:1000000}));
    objects=httpServer((_req,res)=>res.end(artifactBytes));
    const objectOrigin=await listen(objects);
    for(const [name,value] of Object.entries({AGENTS_S3_ENDPOINT:objectOrigin,AGENTS_S3_REGION:"test",AGENTS_S3_BUCKET:"growth-fixture",AGENTS_S3_ACCESS_KEY_ID:"fixture",AGENTS_S3_SECRET_ACCESS_KEY:"fixture"}))vi.stubEnv(name,value);
    runtime=new GrowthProductRuntime(pool,new GrowthActionClient({origin:growthOrigin,issuer:"https://agents.fixture.test",keyId:"agents-v1",privateKey:await exportPKCS8(workerKeys.privateKey),environment:"test"}));
    await new GrowthExecutionService(pool,{issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}}).ensureTenant({tenantId});
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:target.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-growth-product-cursor-secret"})});
    origin=await app.listen({port:0,host:"127.0.0.1"});
    await controlFixture({type:"configure",agentsOrigin:origin},"configured");
    provider=httpServer(async(req,res)=>{
      let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);modelCalls++;
      const last=body.messages.at(-1),write=body.tools?.some((tool:any)=>tool.function?.name==="growth_draft_prepare"),tool=write?"growth_draft_prepare":"growth_context_read";
      const args=write?{draft:{title:"Fixture draft",content:"Reviewed content",channels:["FACEBOOK"],channelSelections:{FACEBOOK:"fixture-account"}}}:{};
      let delta:any,finish:string;
      if(last.role!=="tool"){delta={role:"assistant",tool_calls:[{index:0,id:"call-"+modelCalls,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]};finish="tool_calls";}
      else {const observed=JSON.parse(last.content),citation=observed.passages?.[0]?.citation??"";delta={role:"assistant",content:write?"Saved the reviewed draft.":"Fixture business "+citation};finish="stop";}
      res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"growth-fixture-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:finish,delta}],usage:{prompt_tokens:100,completion_tokens:15}})+"\n\ndata: [DONE]\n\n");
    });
    const providerOrigin=await listen(provider);
    workerFactory=()=>http2Server(createEndpointHandler({services:[createBusinessWorkflow(pool,{modelProvider:new ModelProviderStore(pool,keyVault),product:runtime,evidence:runtime.evidence,
      modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Model destination denied");await policy.beforeDispatch?.();return fetch(providerOrigin,init);}) as ModelFetch;network.markProgress=()=>{};return network;})}})]}));
    worker=workerFactory();trackWorker();
    await new Promise<void>(resolve=>worker.listen(0,"0.0.0.0",resolve));
    docker("run","-d","--name",container,"--add-host=host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");
    ingress="http://"+docker("port",container,"8080/tcp");restAdmin="http://"+docker("port",container,"9070/tcp");
    await until(async()=>{try{return(await fetch(restAdmin+"/health")).ok;}catch{return false;}});
    expect((await fetch(restAdmin+"/deployments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:"http://host.docker.internal:"+(worker.address() as {port:number}).port})})).ok).toBe(true);
  },90000);
  afterAll(async()=>{
    try{docker("rm","-f",container);}catch{}
    app?.server.closeAllConnections();await app?.close();for(const session of workerSessions)session.destroy();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));
    for(const server of [provider,objects])if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    if(growth&&growth.exitCode===null){growth.stdin.end();await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{growth.kill("SIGTERM");reject(Error("Growth fixture teardown timed out"));},15000);growth.once("exit",()=>{clearTimeout(timeout);resolve();});});}
    await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}vi.unstubAllEnvs();
  },30000);
  async function finished(taskId:string,state?:string){
    return until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return (state?task.state===state:terminalTaskStates.has(task.state))?task:false;});
  }
  it("boots managed features and runs persistent scoped chat with zero standalone accounts",async()=>{
    expect((await browserOk("/api/agents/bootstrap")).features.every((f:any)=>!f.ready)).toBe(true);
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect((await browserOk("/api/agents/bootstrap")).features.every((f:any)=>f.ready)).toBe(true);
    const created=command("conversations.create",{featureId:"assistant"}),conversation=(await ok(created)).conversation;
    expect((await ok(created)).conversation.id).toBe(conversation.id);
    const turn=command("turns.submit",{conversationId:conversation.id,text:"Hello"}),first=await ok(turn),replay=await ok(turn);
    expect(replay.task.id).toBe(first.task.id);expect(replay.replayed).toBe(true);
    const task=await finished(first.task.id);expect(task.state,task.error_code).toBe("completed");
    const beforeRestart=modelCalls;
    await app.close();
    await new GrowthExecutionService(pool,{issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}}).ensureTenant({tenantId});
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:(pool.options as {connectionString:string}).connectionString,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-growth-product-cursor-secret"})});
    origin=await app.listen({port:0,host:"127.0.0.1"});await controlFixture({type:"configure",agentsOrigin:origin},"configured");
    expect((await ok(turn)).task.id).toBe(first.task.id);expect(modelCalls).toBe(beforeRestart);
    const history=await ok(command("conversations.get",{conversationId:conversation.id}));expect(history.messages.at(-1).text).toContain("Fixture business");
    const follow=await ok(command("turns.submit",{conversationId:conversation.id,text:"Follow up"}));expect((await finished(follow.task.id)).state).toBe("completed");
    await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"});
    const firstPage=await browserOk("/api/agents/conversations?limit=1");
    expect(firstPage.nextCursor.length).toBeGreaterThan(256);
    expect((await browserOk("/api/agents/conversations?limit=1&cursor="+encodeURIComponent(firstPage.nextCursor))).conversations).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
    const foreign=await send(command("conversations.get",{conversationId:conversation.id},{actor:{...actor,subject:randomUUID()}}));expect(foreign.status).toBe(404);
  },40000);
  it("waits durably for the one Growth decision and confirms a single draft receipt",async()=>{
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"content"})).conversation;
    const turn={requestId:randomUUID(),text:"Save a draft"},task=(await browserOk("/api/agents/conversations/"+conversation.id+"/messages",turn)).task;
    expect((await browserOk("/api/agents/conversations/"+conversation.id+"/messages",turn)).task.id).toBe(task.id);
    await finished(task.id,"waiting_review");
    const port=(worker.address() as {port:number}).port;
    for(const session of workerSessions)session.destroy();
    await new Promise<void>(resolve=>worker.close(()=>resolve()));worker=workerFactory();trackWorker();
    await new Promise<void>(resolve=>worker.listen(port,"0.0.0.0",resolve));
    const review=(await browserOk("/api/agents/tasks/"+task.id+"/reviews")).reviews[0];expect(review.state).toBe("proposed");expect(review.result).toBeNull();
    await browserOk("/api/agents/tasks/"+task.id+"/reviews/"+review.id+"/decision",{requestId:randomUUID(),payloadDigest:review.payloadDigest,decision:"approve"});
    const result=await finished(task.id);expect(result.state,result.error_code).toBe("completed");
    const projected=(await browserOk("/api/agents/tasks/"+task.id)).task;expect(projected.results).toHaveLength(1);
    const post=(await browserOk("/__fixture/posts/"+projected.results[0].id)).post;
    expect(post.content).toBe("Reviewed content");expect(post.status).toBe("DRAFT");expect(post.user_id).toBe(actor.subject);
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(1);
    expect((await browserOk("/api/agents/tasks/"+task.id+"/reviews")).reviews[0].state).toBe("saved");
  },40000);
  it("uses new configuration only for a new turn while authenticated retries stay pinned",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation,turn=command("turns.submit",{conversationId:conversation.id,text:"Pinned turn"});
    const first=(await ok(turn)).task,old=(await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[first.id])).rows[0].version_id;
    await ok(command("features.configure",{featureId:"assistant",configuration:{...growthFeatureConfiguration("assistant"),instructions:"Updated Growth instructions. Read the authorized context."}}),true);
    expect((await ok(turn)).task.id).toBe(first.id);
    const next=(await ok(command("turns.submit",{conversationId:conversation.id,text:"New settings"}))).task;
    expect((await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[next.id])).rows[0].version_id).not.toBe(old);
  });
  it("downloads exact product-owned artifact bytes and rechecks private evidence without an Agents account",async()=>{
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"research"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Artifact fixture"})).task;
    const row=(await pool.query("SELECT t.*,c.agent_id FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.id=$1",[task.id])).rows[0],context=(await pool.query("SELECT * FROM agents_platform.product_task_contexts WHERE task_id=$1",[task.id])).rows[0],artifactId=randomUUID();
    const digest=createHash("sha256").update(artifactBytes).digest("hex");
    await pool.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,product_owner,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name) VALUES($1,$2,$3,NULL,'growth','fixture:artifact',$4,$5,'application/octet-stream',$6,$4,'available',$7,$7,'Private report')",[artifactId,row.organization_id,row.agent_id,digest,"fixture/"+artifactId,artifactBytes.length,task.id]);
    await transaction(pool,db=>runtime.evidence.deriveWithin(db,task.id,"artifact",artifactId,[{kind:"product",product:"growth",tenantId,taskId:task.id,contextRevision:context.context_revision,sourceId:context.sources[0].id}]));
    const metadata=(await browserOk(`/api/agents/tasks/${task.id}/artifacts`)).artifacts[0];
    const download=await browser(metadata.downloadPath);expect(download.status).toBe(200);expect(Buffer.from(await download.arrayBuffer())).toEqual(artifactBytes);
    expect(download.headers.get("content-disposition")).toContain("attachment");expect(download.headers.get("cache-control")).toBe("no-store");
    await controlFixture({type:"membership",enabled:false},"membership");
    expect((await browser(metadata.downloadPath)).status).toBe(403);
    await controlFixture({type:"membership",enabled:true},"membership");
    await pool.query("UPDATE agents_platform.artifacts SET content_digest=$2 WHERE id=$1",[artifactId,"0".repeat(64)]);
    expect((await browser(metadata.downloadPath)).status).toBe(503);
    await pool.query("UPDATE agents_platform.product_task_contexts SET context_revision=$2 WHERE task_id=$1",[task.id,"0".repeat(64)]);
    const cancelled=(await browserOk(`/api/agents/tasks/${task.id}/cancel`,{requestId:randomUUID()})).task;
    expect(cancelled.state).toBe("cancel_requested");expect(cancelled.output).toBeNull();expect(cancelled.sources).toEqual([]);
  });
  it("serializes distinct concurrent configuration updates without version collisions",async()=>{
    const config=growthFeatureConfiguration("campaigns");
    await Promise.all([ok(command("features.configure",{featureId:"campaigns",configuration:{...config,instructions:"First permitted update"}}),true),
      ok(command("features.configure",{featureId:"campaigns",configuration:{...config,instructions:"Second permitted update"}}),true)]);
    const versions=await pool.query("SELECT v.number FROM agents_platform.agent_versions v JOIN agents_platform.product_execution_features f ON f.agent_id=v.agent_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id='campaigns' ORDER BY v.number",[tenantId]);
    expect(versions.rows.map(row=>row.number)).toEqual([1,2,3]);
  });
  it("rejects malformed signatures and revokes current reads without leaking cached text",async()=>{
    const cmd=command("features.list",{}),response=await fetch(origin+"/internal/v1/products/growth/commands",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer bad.token.value"},body:JSON.stringify(cmd)});
    expect(response.status).toBe(401);
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    await controlFixture({type:"membership",enabled:false},"membership");
    expect((await send(command("conversations.get",{conversationId:conversation.id}))).status).toBe(403);
    await controlFixture({type:"membership",enabled:true},"membership");
  });
  it("runs the actual Growth UI and quick access through both backends without agent route mocks",async()=>{
    const result=await verifyGrowthBrowser({growthOrigin,tenantId,userId:actor.subject,
      configureFrontend:frontendOrigin=>controlFixture({type:"configure",frontendOrigin},"configured"),
      dispatch:async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin});}});
    expect(result.taskIds).toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
  },90000);

});
