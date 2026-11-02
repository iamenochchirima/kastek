import {writeFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer as httpServer} from "node:http";
import {createServer as http2Server} from "node:http2";
import {execFileSync,spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createInterface} from "node:readline";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {createServer as portServer} from "node:net";
import {HARNESS_RELEASE,WORKFLOW_NAME,ADAPTIVE_HARNESS_RELEASE,ADAPTIVE_WORKFLOW_NAME} from "../src/contracts/execution";
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
import {settleTask} from "../src/execution/lifecycle/execution";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import {assertCurrentEvidence,taskEvidenceManifest} from "../src/execution/context/evidence-policy";
import {requestDigest,terminalTaskStates} from "../src/contracts/contracts";

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
  let native:ReturnType<typeof spawn>|undefined,nativeDirectory:string|undefined;
  const binary=process.env.AGENTS_TEST_RESTATE_BINARY;
  const runtimeRoutes=()=>({[HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:restAdmin,workflowName:WORKFLOW_NAME},[ADAPTIVE_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:restAdmin,workflowName:ADAPTIVE_WORKFLOW_NAME}});
  let ingress:string,restAdmin:string,origin:string,runtime:GrowthProductRuntime,workerFactory:()=>ReturnType<typeof http2Server>;
  const workerSessions=new Set<import("node:http2").ServerHttp2Session>();
  function trackWorker(){worker.on("session",session=>{workerSessions.add(session);session.once("close",()=>workerSessions.delete(session));});}
  let loseCommitAcknowledgement=false,lostCommitAcknowledgements=0;
  let artifactHeld=false,releaseArtifact:()=>void=()=>{};
  const artifactBarrier=new Promise<void>(resolve=>{releaseArtifact=resolve;});
  let adaptiveHold:Promise<void>|null=null,capacityFailureCalls=0;
  let canonicalPublication:import("@kasitek-labs/contracts").GrowthAgentPublication,canonicalMode=false;
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
    vi.stubEnv("AGENTS_MODEL_POLICY_JSON",JSON.stringify({maxRootTokens:300000}));
    vi.stubEnv("AGENTS_SCHEDULING_POLICY_JSON",JSON.stringify({maxConcurrentRoots:10,dailyTokenAllowance:100000000}));
    objects=httpServer((_req,res)=>res.end(artifactBytes));
    const objectOrigin=await listen(objects);
    for(const [name,value] of Object.entries({AGENTS_S3_ENDPOINT:objectOrigin,AGENTS_S3_REGION:"test",AGENTS_S3_BUCKET:"growth-fixture",AGENTS_S3_ACCESS_KEY_ID:"fixture",AGENTS_S3_SECRET_ACCESS_KEY:"fixture"}))vi.stubEnv(name,value);
    canonicalPublication=ready.canonicalPublication;
    runtime=new GrowthProductRuntime(pool,new GrowthActionClient({origin:growthOrigin,issuer:"https://agents.fixture.test",keyId:"agents-v1",privateKey:await exportPKCS8(workerKeys.privateKey),environment:"test",fetch:async(url,init)=>{
      const response=await fetch(url,init),body=JSON.parse(String(init?.body??"{}"));
      if(loseCommitAcknowledgement&&body.control==="commit"&&response.ok){loseCommitAcknowledgement=false;lostCommitAcknowledgements++;await response.arrayBuffer();throw Error("Controlled lost commit acknowledgement");}
      return response;
    }}));
    await new GrowthExecutionService(pool,{issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}}).ensureTenant({tenantId,publication:ready.publication});
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:target.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-growth-product-cursor-secret"})});
    origin=await app.listen({port:0,host:"127.0.0.1"});
    await controlFixture({type:"configure",agentsOrigin:origin},"configured");
    const scriptStates=new Map<string,{step:number;resourceId?:string;citations:string[]}>();
    provider=httpServer(async(req,res)=>{
      let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);modelCalls++;
      const last=body.messages.at(-1),userText=body.messages.filter((message:any)=>message.role==="user").at(-1)?.content??"";
      if(body.messages[0]?.content?.startsWith("Summarize")){
        const packed=JSON.stringify(body.messages),citations=[...new Set(packed.match(/\[E[a-f0-9]+\]/g)??[])];
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"compact-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:"stop",delta:{role:"assistant",content:"Observed business evidence "+citations.join(" ")}}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(String(userText).includes("Growth adaptive HTTP")){
        const records=body.messages.filter((message:any)=>message.role==="tool");
        const named=(name:string)=>records.filter((record:any)=>body.messages.some((message:any)=>message.tool_calls?.some((call:any)=>call.id===record.tool_call_id&&call.function.name===name))).map((record:any)=>JSON.parse(record.content));
        const started=named("agents_start"),first=started[0]?.children??[],second=started[1]?.children??[],follow=named("agents_followup")[0]?.children??[];
        let calls:{name:string,args:unknown}[]=[],content="";
        if(String(userText).includes("child review")) {
          if(!first.length)calls=[{name:"agents_start",args:{requests:[{bindingId:"content",brief:"Prepare reviewed draft"}]}}];
          else if(!named("agents_wait").length)calls=[{name:"agents_wait",args:{taskIds:[first[0].taskId],timeoutSeconds:10}}];
          else if(!named("agents_result").length&&(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[first[0].taskId])).rows[0].state==="completed")calls=[{name:"agents_result",args:{taskId:first[0].taskId}}];
          else content="The specialist draft was reviewed.";
        } else if(!named("agents_discover").length)calls=[{name:"agents_discover",args:{query:"research content campaigns"}}];
        else if(!named("agents_discover").at(-1).specialists.length){
          expect(named("agents_discover").at(-1).discoveryNotice?.code).toBe("LITERAL_FILTER_NO_MATCH");
          calls=[{name:"agents_discover",args:{}}];
        }
        else if(!first.length)calls=[{name:"agents_start",args:{requests:[{bindingId:"research",brief:"Read the business profile and return the findings."},{bindingId:"content",brief:"Read the business profile and produce a draft recommendation."}]}}];
        else if(!named("agents_wait").length)calls=[{name:"agents_wait",args:{taskIds:first.map((c:any)=>c.taskId),mode:"all",timeoutSeconds:10}}];
        else if(!named("agents_result").length)calls=first.map((c:any)=>({name:"agents_result",args:{taskId:c.taskId}}));
        else if(!follow.length)calls=[{name:"agents_followup",args:{taskId:first[1].taskId,brief:"Refine the draft recommendation from your earlier findings."}},{name:"agents_start",args:{requests:[{bindingId:"campaigns",brief:"Read the business profile and recommend a campaign."}]}}];
        else if(named("agents_wait").length<2)calls=[{name:"agents_wait",args:{taskIds:[follow[0].taskId,second[0].taskId],mode:"all",timeoutSeconds:10}}];
        else if(named("agents_result").length<4)calls=[...follow,...second].map((c:any)=>({name:"agents_result",args:{taskId:c.taskId}}));
        else if(!named("work_update").length)calls=[{name:"work_update",args:{expectedRevision:0,record:{objective:"Combine specialist findings",steps:[{id:"combine",title:"Combine findings",state:"completed"}],questions:[],evidenceTaskIds:[...first,...second,...follow].map((c:any)=>c.taskId)}}}];
        else content="Combined findings from all three Growth specialists.";
        const delta=calls.length?{role:"assistant",tool_calls:calls.map((call,index)=>({index,id:`adaptive-${modelCalls}-${index}`,type:"function",function:{name:call.name,arguments:JSON.stringify(call.args)}}))}:{role:"assistant",content};
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"growth-adaptive-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:calls.length?"tool_calls":"stop",delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(adaptiveHold)await adaptiveHold;
      if(String(userText).startsWith("Controlled capacity failure")){capacityFailureCalls++;res.destroy();return;}
      const state=scriptStates.get(String(userText))??{step:0,citations:[]};scriptStates.set(String(userText),state);
      const observations=body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content));
      const values=observations.map((item:any)=>item.value??item);
      state.resourceId=values.find((value:any)=>value.data?.items)?.data.items?.[0]?.context.resourceId??state.resourceId;
      state.citations=[...new Set([...state.citations,...values.flatMap((value:any)=>value.passages??[]).map((passage:any)=>passage.citation)])];
      const find=(prefix:string)=>body.tools?.find((tool:any)=>(tool.function?.description??"").startsWith(prefix))?.function.name;
      const write=/save a draft|prepare reviewed draft/i.test(userText);
      const multi=String(userText).includes("Contract multi-tool"),correct=String(userText).includes("Contract correct arguments")||String(userText).includes("produce a draft recommendation"),zero=String(userText).includes("Contract zero-tool");
      let prefix=canonicalMode?(write?"Prepare a new content draft":"Read this workspace"):(write?"Prepare an exact content draft":"Read the current business profile");
      let args:any=write?{draft:{title:"Fixture draft",content:"Reviewed content",channels:["FACEBOOK"],channelSelections:{FACEBOOK:"fixture-account"}}}:{};
      let wantsTool=state.step===0;
      if(multi){
        const discovered=state.resourceId;
        const sequence=["Find permitted content posts","Read a content post","Read the current business profile","Read a content post"];
        wantsTool=state.step<sequence.length;prefix=sequence[state.step]??prefix;
        args=prefix==="Read a content post"?{resourceId:discovered}:{};
      }
      if(correct){wantsTool=state.step<2;args=state.step?{}:{unexpected:true};}
      if(zero)wantsTool=false;
      let delta:any,finish:string;
      if(wantsTool){
        const tool=find(prefix);if(!tool){res.statusCode=500;res.end(JSON.stringify({error:"Required fixture operation is unavailable"}));return;}
        state.step++;delta={role:"assistant",tool_calls:[{index:0,id:"call-"+modelCalls,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]};finish="tool_calls";
      }else{
        if(String(userText).includes("Artifact fixture")){artifactHeld=true;await artifactBarrier;}
        const citations=state.citations.join(" ");
        delta={role:"assistant",content:write?"Saved the reviewed draft.":zero?"Hello without tools.":"Fixture business "+citations};finish="stop";
      }
      res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"growth-fixture-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:finish,delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");
    });
    const providerOrigin=await listen(provider);
    const workflow=(version?:{release:string;workflow:string})=>createBusinessWorkflow(pool,{modelProvider:new ModelProviderStore(pool,keyVault),product:runtime,evidence:runtime.evidence,
      modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Model destination denied");await policy.beforeDispatch?.();return fetch(providerOrigin,init);}) as ModelFetch;network.markProgress=()=>{};return network;})}},version);
    workerFactory=()=>http2Server(createEndpointHandler({services:[workflow(),workflow({release:ADAPTIVE_HARNESS_RELEASE,workflow:ADAPTIVE_WORKFLOW_NAME})]}));
    worker=workerFactory();trackWorker();
    await new Promise<void>(resolve=>worker.listen(0,"0.0.0.0",resolve));
    let workerHost="host.docker.internal";
    if(binary){
      async function freePort(){const server=portServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
      const ingressPort=await freePort(),adminPort=await freePort(),internal=await freePort();
      nativeDirectory=mkdtempSync(join(tmpdir(),"kasitek-growth-runtime-"));const config=join(nativeDirectory,"restate.toml");
      writeFileSync(config,readFileSync(resolve("test/scheduling-restate.toml"),"utf8")+`\n[ingress]\nbind-address="127.0.0.1:${ingressPort}"\n[admin]\nbind-address="127.0.0.1:${adminPort}"\n`);
      native=spawn(binary,["--config-file",config,"--base-dir",join(nativeDirectory,"data"),"--bind-address",`127.0.0.1:${internal}`,"--advertised-host","127.0.0.1","--node-name","growth-fixture","--no-logo"],{stdio:"ignore"});
      ingress=`http://127.0.0.1:${ingressPort}`;restAdmin=`http://127.0.0.1:${adminPort}`;workerHost="127.0.0.1";
    }else{
      docker("run","-d","--name",container,"--add-host=host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");
      ingress="http://"+docker("port",container,"8080/tcp");restAdmin="http://"+docker("port",container,"9070/tcp");
    }
    await until(async()=>{try{return(await fetch(restAdmin+"/health")).ok;}catch{return false;}});
    expect((await fetch(restAdmin+"/deployments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:"http://"+workerHost+":"+(worker.address() as {port:number}).port})})).ok).toBe(true);
  },90000);
  afterAll(async()=>{
    if(native){native.kill("SIGTERM");await new Promise<void>(resolve=>native!.once("exit",()=>resolve()));if(nativeDirectory)rmSync(nativeDirectory,{recursive:true,force:true});}else if(!binary){try{docker("rm","-f",container);}catch{}}
    app?.server.closeAllConnections();await app?.close();for(const session of workerSessions)session.destroy();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));
    for(const server of [provider,objects])if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    if(growth&&growth.exitCode===null){growth.stdin.end();await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{growth.kill("SIGTERM");reject(Error("Growth fixture teardown timed out"));},15000);growth.once("exit",()=>{clearTimeout(timeout);resolve();});});}
    await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}vi.unstubAllEnvs();
  },30000);
  async function currentConfiguration(featureId:string){
    return (await pool.query("SELECT v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id=$2",[tenantId,featureId])).rows[0].configuration;
  }
  async function finished(taskId:string,state?:string){
    return until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return (state?task.state===state:terminalTaskStates.has(task.state))?task:false;},50000);
  }
  it("boots managed features and runs persistent scoped chat with zero standalone accounts",async()=>{
    expect((await browserOk("/api/agents/bootstrap")).features.every((f:any)=>!f.ready)).toBe(true);
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect((await browserOk("/api/agents/bootstrap")).features.every((f:any)=>f.ready)).toBe(true);
    const coordinator=await currentConfiguration("assistant"),specialist=await currentConfiguration("content");
    expect((await send(command("features.configure",{featureId:"content",configuration:{...specialist,capabilities:{...specialist.capabilities,delegation:coordinator.capabilities.delegation}}}),true)).status).toBe(409);
    const created=command("conversations.create",{featureId:"assistant"}),conversation=(await ok(created)).conversation;
    expect((await ok(created)).conversation.id).toBe(conversation.id);
    const turn=command("turns.submit",{conversationId:conversation.id,text:"Hello"}),first=await ok(turn),replay=await ok(turn);
    expect(replay.task.id).toBe(first.task.id);expect(replay.replayed).toBe(true);
    const task=await finished(first.task.id);expect(task.state,task.error_code).toBe("completed");
    const bootstrap=JSON.parse(execFileSync(process.execPath,["--import",resolve("node_modules/tsx/dist/loader.mjs"),resolve("test/support/product-publication-bootstrap.ts")],{env:{...process.env,AGENTS_PUBLICATION_FIXTURE_DATABASE_URL:(pool.options as {connectionString:string}).connectionString,AGENTS_PUBLICATION_FIXTURE_TASK_ID:task.id},encoding:"utf8",timeout:10000}));
    expect(bootstrap).toEqual({program:{id:"tool-directed",version:"4"},bindings:7});
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
  it("does not advertise orchestration controls when a v4 Growth configuration disables delegation",async()=>{
    const original=await currentConfiguration("assistant");
    try {
      await ok(command("features.configure",{featureId:"assistant",configuration:{...original,tools:[],capabilities:{...original.capabilities,delegation:{enabled:false}}}}),true);
      const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
      const task=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool disabled delegation"}))).task;
      const dto=(await ok(command("tasks.get",{taskId:task.id}))).task;
      expect(dto.canSteer??false).toBe(false);expect(dto.orchestration).toBeUndefined();expect(dto.children).toBeUndefined();
      const response=await send(command("tasks.instructions",{taskId:task.id,instruction:"Additional input"}));
      expect(response.status).toBe(403);expect((await response.json() as any).code).toBe("ORCHESTRATION_DENIED");
      expect((await finished(task.id)).state).toBe("completed");
    }finally{await ok(command("features.configure",{featureId:"assistant",configuration:original}),true);}
  },30000);

  it("runs real Growth specialist HTTP calls with pinned product authority and idempotent replay",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    const submission=command("turns.submit",{conversationId:conversation.id,text:"Growth adaptive HTTP"});
    const first=await ok(submission);expect((await ok(submission)).task.id).toBe(first.task.id);
    const completed=await finished(first.task.id);expect(completed.state,completed.error_code).toBe("completed");
    expect(completed.root_token_limit).toBe(300000);
    const discoveries=(await pool.query("SELECT output FROM agents_platform.operations WHERE task_id=$1 AND name='agents.discover' ORDER BY started_at",[first.task.id])).rows;
    expect(discoveries[0].output).toEqual({specialists:[],nextOffset:null});
    expect(discoveries[1].output.specialists).toHaveLength(3);
    expect(discoveries.every(row=>!Object.hasOwn(row.output,"discoveryNotice"))).toBe(true);
    const allocation=(await pool.query("SELECT root_token_limit FROM agents_platform.tasks WHERE parent_task_id=$1",[first.task.id])).rows;expect(allocation.every(row=>row.root_token_limit===null)).toBe(true);
    expect((await pool.query("SELECT 1 FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id WHERE t.parent_task_id=$1 AND o.error_code='TOOL_ARGUMENTS_INVALID'",[first.task.id])).rowCount).toBeGreaterThan(0);
    const dto=(await ok(command("tasks.get",{taskId:first.task.id}))).task;
    expect(dto.children).toHaveLength(4);expect(dto.children.every((child:any)=>child.state==="completed"),JSON.stringify(dto.children)).toBe(true);
    expect(dto.orchestration.record.evidenceTaskIds).toHaveLength(4);expect(dto.canSteer).toBe(false);
    expect(new Set((await pool.query("SELECT v.agent_id FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.parent_task_id=$1",[first.task.id])).rows.map(row=>row.agent_id)).size).toBe(3);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operations r JOIN agents_platform.tasks t ON t.id=r.task_id WHERE t.root_task_id=$1 AND t.parent_task_id IS NOT NULL AND r.kind='tool'",[first.task.id])).rows[0].count).toBeGreaterThan(0);
    const child=dto.children.find((item:any)=>item.name==="Research");
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE tenant_id=$1 AND feature_id='research'",[tenantId]);
    await expect(runtime.authorizeTask(child.id)).rejects.toMatchObject({code:"PRODUCT_AUTHORITY_INACTIVE"});
    await expect(assertCurrentEvidence(pool,child.id,await taskEvidenceManifest(pool,child.id),{requireActiveTask:false})).rejects.toMatchObject({code:"PRODUCT_AUTHORITY_INACTIVE"});
    expect((await ok(command("tasks.get",{taskId:first.task.id}))).task.output).toBeNull();
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=true WHERE tenant_id=$1 AND feature_id='research'",[tenantId]);
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[completed.grant_id]);
    await expect(runtime.authorizeTask(child.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    expect((await send(command("tasks.get",{taskId:first.task.id}))).status).toBe(403);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.accounts")).rows[0].count).toBe(0);
  },60000);

  it("queues signed user steering once and cancels the complete Growth child tree",async()=>{
    let release=()=>{};adaptiveHold=new Promise<void>(resolve=>{release=resolve;});
    try {
      const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
      const turn=await ok(command("turns.submit",{conversationId:conversation.id,text:"Growth adaptive HTTP cancellation"}));
      await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});return (await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id=$1 AND state='running'",[turn.task.id])).rows[0].n===2;},30000);
      const steering=command("tasks.instructions",{taskId:turn.task.id,instruction:"Keep the answer concise."});
      expect(await ok(steering)).toEqual({accepted:true});expect(await ok(steering)).toEqual({accepted:true});
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.orchestration_instructions WHERE task_id=$1",[turn.task.id])).rows[0].n).toBe(1);
      expect((await ok(command("conversations.get",{conversationId:conversation.id}))).messages.filter((m:any)=>m.text==="Keep the answer concise.")).toHaveLength(1);
      await ok(command("tasks.cancel",{taskId:turn.task.id}));release();adaptiveHold=null;
      expect((await finished(turn.task.id)).state).toBe("cancelled");
      expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE root_task_id=$1",[turn.task.id])).rows.every(row=>row.state==="cancelled")).toBe(true);
    }finally{release();adaptiveHold=null;}
  },60000);

  it("carries an active user correction into the next root once without exposing it to specialists",async()=>{
    const correction="Keep the response limited to confirmed facts: no invented prices.";
    let release=()=>{};adaptiveHold=new Promise<void>(resolve=>{release=resolve;});
    const userCopies=(snapshot:any)=>snapshot.messages.filter((message:any)=>message.role==="user"&&typeof message.content==="string"&&message.content.includes(correction));
    const snapshots=async(taskId:string)=>(await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE task_id=$1 ORDER BY step",[taskId])).rows.map(row=>row.payload);
    try {
      const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
      const original=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Growth adaptive HTTP active correction"}))).task;
      await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});return (await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id=$1 AND state='running'",[original.id])).rows[0].n===2;},30000);
      const instruction=command("tasks.instructions",{taskId:original.id,instruction:correction});await ok(instruction);await ok(instruction);
      release();adaptiveHold=null;
      expect((await finished(original.id)).state).toBe("completed");
      const originalContexts=await snapshots(original.id);expect(originalContexts.some(context=>userCopies(context).length===1)).toBe(true);
      expect(originalContexts.every(context=>userCopies(context).length<=1)).toBe(true);
      for(const child of (await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1",[original.id])).rows)expect((await snapshots(child.id)).every(context=>userCopies(context).length===0)).toBe(true);
      const followup=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool history followup"}))).task;
      expect((await finished(followup.id)).state).toBe("completed");
      const followupContexts=await snapshots(followup.id);expect(followupContexts.length).toBeGreaterThan(0);
      for(const context of followupContexts){expect(userCopies(context)).toHaveLength(1);expect(userCopies(context)[0].content).toBe(correction);expect(context.messages.filter((message:any)=>message.role==="system").some((message:any)=>message.content.includes(correction))).toBe(false);}
      const other=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
      const separate=(await ok(command("turns.submit",{conversationId:other.id,text:"Contract zero-tool separate conversation"}))).task;
      expect((await finished(separate.id)).state).toBe("completed");expect((await snapshots(separate.id)).every(context=>userCopies(context).length===0)).toBe(true);
    }finally{release();adaptiveHold=null;}
  },90000);

  it("reclaims expired uncertain model slots and dispatches a new root without changing uncertainty or charges",async()=>{
    const original=await currentConfiguration("assistant");
    try {
      await ok(command("features.configure",{featureId:"assistant",configuration:{...original,model:{...original.model,maxDurationSeconds:10}}}),true);
      const bad:string[]=[];
      for(const label of ["A","B"]){const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;bad.push((await ok(command("turns.submit",{conversationId:conversation.id,text:"Controlled capacity failure "+label}))).task.id);}
      await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});return (await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) AND state='uncertain'",[bad])).rows[0].n===2;},20000);
      expect(capacityFailureCalls).toBe(2);
      const accounting=async()=>({
        tasks:(await pool.query("SELECT id,state,error_code,tokens_used,tokens_reserved,root_token_limit FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) ORDER BY id",[bad])).rows,
        operations:(await pool.query("SELECT id,state,error_code,accounted_tokens,reserved_tokens FROM agents_platform.operations WHERE task_id=ANY($1::uuid[]) ORDER BY id",[bad])).rows,
        usage:(await pool.query("SELECT u.* FROM agents_platform.operation_usage u JOIN agents_platform.operations o ON o.id=u.operation_id WHERE o.task_id=ANY($1::uuid[]) ORDER BY o.id",[bad])).rows,
        costs:(await pool.query("SELECT * FROM agents_platform.model_cost_reservations WHERE task_id=ANY($1::uuid[]) ORDER BY operation_id",[bad])).rows,
        costAccounts:(await pool.query("SELECT * FROM agents_platform.root_model_accounts WHERE root_task_id=ANY($1::uuid[]) ORDER BY root_task_id",[bad])).rows,
      });
      const before=await accounting();
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_requests WHERE task_id=ANY($1::uuid[]) AND state='uncertain'",[bad])).rows[0].n).toBe(2);
      const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
      const next=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool after uncertain generation"}))).task;
      await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});
      await until(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.capacity_requests WHERE task_id=$1 AND state='waiting'",[next.id])).rowCount));
      expect((await pool.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1",[next.id])).rowCount).toBe(0);
      expect((await finished(next.id)).state).toBe("completed");
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_requests WHERE task_id=ANY($1::uuid[]) AND state='released'",[bad])).rows[0].n).toBe(2);
      expect(await accounting()).toEqual(before);expect(capacityFailureCalls).toBe(2);
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.task_events WHERE task_id=ANY($1::uuid[]) AND kind='resource.capacity_released'",[bad])).rows[0].n).toBe(2);
    }finally{await ok(command("features.configure",{featureId:"assistant",configuration:original}),true);}
  },60000);

  it("renews signed Growth authority without increasing the admitted root budget",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    const task=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool continuation"}))).task;
    const before=(await pool.query("SELECT grant_id,root_token_limit,deadline_at FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0];
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=created_at+interval '1 millisecond' WHERE id=$1",[before.grant_id]);
    await finished(task.id,"waiting_authority");
    const renewal=command("tasks.continue",{taskId:task.id});await ok(renewal);await ok(renewal);
    const resumed=await finished(task.id);expect(resumed.state,resumed.error_code).toBe("completed");
    expect(resumed.grant_id).not.toBe(before.grant_id);expect(resumed.root_token_limit).toBe(before.root_token_limit);expect(resumed.deadline_at).toEqual(before.deadline_at);
    expect((await pool.query("SELECT root_token_limit FROM agents_platform.execution_grants WHERE id=$1",[resumed.grant_id])).rows[0].root_token_limit).toBe(before.root_token_limit);
  },30000);

  it("continues one immutable terminal Growth segment with signed authority and retained corrections",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    const task=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool terminal continuation"}))).task;
    await ok(command("tasks.instructions",{taskId:task.id,instruction:"Keep the agreed Cedar Finch wording."}));
    await settleTask(pool,task.id,{state:"incomplete",output:"The remaining response still needs completion.",errorCode:"ORCHESTRATION_STALLED"});
    const prior=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0];
    expect((await ok(command("tasks.get",{taskId:task.id}))).task.canContinue).toBe(true);
    const request=command("tasks.continue",{taskId:task.id}),continued=(await ok(request)).task;
    expect(continued.id).not.toBe(task.id);expect(continued.workId).toBe(task.id);expect(continued.priorTaskId).toBe(task.id);
    expect((await ok(request)).task.id).toBe(continued.id);
    expect((await ok(command("tasks.get",{taskId:task.id}))).task.canContinue).toBe(false);
    const result=await finished(continued.id);expect(result.state,result.error_code).toBe("completed");
    expect((await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0]).toEqual(prior);
    expect(result.deadline_at).toEqual(prior.deadline_at);expect(result.root_token_limit).toBe(prior.root_token_limit);
    const contexts=(await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE task_id=$1 ORDER BY step",[continued.id])).rows;
    expect(JSON.stringify(contexts)).toContain("Keep the agreed Cedar Finch wording.");
    expect(JSON.stringify(contexts)).toContain("Prior execution segment");
  },30000);

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
    loseCommitAcknowledgement=true;
    await browserOk("/api/agents/tasks/"+task.id+"/reviews/"+review.id+"/decision",{requestId:randomUUID(),payloadDigest:review.payloadDigest,decision:"approve"});
    const result=await finished(task.id);expect(result.state,result.error_code).toBe("completed");
    const projected=(await browserOk("/api/agents/tasks/"+task.id)).task;expect(projected.results).toHaveLength(1);
    const post=(await browserOk("/__fixture/posts/"+projected.results[0].id)).post;
    expect(post.content).toBe("Reviewed content");expect(post.status).toBe("DRAFT");expect(post.user_id).toBe(actor.subject);
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(1);expect(lostCommitAcknowledgements).toBe(1);
    expect((await browserOk("/api/agents/tasks/"+task.id+"/reviews")).reviews[0].state).toBe("saved");
  },40000);
  it("surfaces a specialist review on the root and wakes only its exact child after approval",async()=>{
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Growth adaptive HTTP child review"})).task;
    await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});return (await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state='waiting_review'",[task.id])).rowCount===1;},30000);
    const review=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];expect(review.taskId).toBe(task.id);
    const child=(await pool.query("SELECT task_id FROM agents_platform.product_review_projections WHERE review_id=$1",[review.id])).rows[0].task_id;expect(child).not.toBe(task.id);
    const activity=await browserOk(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}`);
    expect(activity).toMatchObject({rootTaskId:task.id,parentTaskId:task.id,agentName:"Content",task:{id:child,state:"waiting_review",canSteer:false,canContinue:false}});
    expect(activity.task.input).toBeTruthy();expect(activity.operations.length).toBeGreaterThan(0);
    expect(activity.operations.every((operation:any)=>operation.taskId===child)).toBe(true);
    expect(JSON.stringify(activity)).not.toMatch(/privateModel|nativeState|authorizationHeader|request_digest|requestDigest|tool_calls/);
    const rootActivity=await browserOk(`/api/agents/tasks/${task.id}/activity`);
    expect(rootActivity.task.children).toEqual(expect.arrayContaining([expect.objectContaining({id:child,assignment:expect.any(String)})]));
    const childStream=await browser(`/api/agents/tasks/${task.id}/activity/live?childTaskId=${child}`);
    expect(childStream.headers.get("content-type")).toContain("text/event-stream");
    const childReader=childStream.body!.getReader();
    const childFrame=new TextDecoder().decode((await childReader.read()).value);
    expect(childFrame).toContain("event: observation");expect(childFrame).toContain(child);
    await childReader.cancel();

    const other=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const foreign=(await browserOk(`/api/agents/conversations/${other.id}/messages`,{requestId:randomUUID(),text:"Contract zero-tool"})).task;
    expect((await browser(`/api/agents/tasks/${foreign.id}/reviews/${review.id}/decision`,{requestId:randomUUID(),payloadDigest:review.payloadDigest,decision:"approve"})).status).toBe(404);
    expect((await browser(`/api/agents/tasks/${foreign.id}/activity?childTaskId=${child}`)).status).toBe(404);
    expect((await send(command("tasks.observe",{taskId:task.id,childTaskId:child},{actor:{...actor,subject:randomUUID()}}))).status).toBe(404);

    await browserOk(`/api/agents/tasks/${task.id}/reviews/${review.id}/decision`,{requestId:randomUUID(),payloadDigest:review.payloadDigest,decision:"approve"});
    const childDecision={taskId:child,reviewId:review.id,payloadDigest:review.payloadDigest,decision:"approve" as const};
    expect((await send(command("tasks.get",{taskId:child}))).status).toBe(404);
    expect((await send(command("reviews.decide",childDecision,{actor:{...actor,subject:randomUUID()}}))).status).toBe(404);
    expect((await ok(command("reviews.decide",childDecision))).reviewId).toBe(review.id);
    expect((await finished(task.id)).state).toBe("completed");
    const saved=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];expect(saved.state).toBe("saved");
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[child])).rows[0].state).toBe("completed");
    const finishedActivity=await browserOk(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}`);
    expect(finishedActivity.task).toMatchObject({id:child,state:"completed",output:expect.any(String)});
    const nativeOperationIds=(await pool.query("SELECT id FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at DESC,md5(id) DESC",[child])).rows.map(row=>row.id);
    const inspectedOperationIds:string[]=[];let operationCursor:string|undefined;
    do {
      const inspected=await browserOk(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}&limit=1${operationCursor?`&operationCursor=${encodeURIComponent(operationCursor)}`:""}`);
      inspectedOperationIds.push(...inspected.operations.map((operation:any)=>operation.id));operationCursor=inspected.nextOperationCursor??undefined;
    }while(operationCursor&&inspectedOperationIds.length<100);
    expect(inspectedOperationIds).toEqual(nativeOperationIds);
    const childConversation=(await pool.query("SELECT conversation_id FROM agents_platform.tasks WHERE id=$1",[child])).rows[0].conversation_id;
    await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[childConversation]);
    try {
      const unavailable=await browser(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}`);
      expect([403,404]).toContain(unavailable.status);expect(await unavailable.text()).not.toContain(activity.task.input);
    }finally {await pool.query("UPDATE agents_platform.conversations SET deleted_at=NULL WHERE id=$1",[childConversation]);}

    if(activity.nextCursor)expect((await browserOk(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}&cursor=${encodeURIComponent(activity.nextCursor)}`)).events.every((event:any)=>BigInt(event.id)>BigInt(activity.events.at(-1).id))).toBe(true);

  },60000);

  it("lets presets share tools, change read order, correct arguments and answer without tools",async()=>{
    for(const [featureId,text] of [["assistant","Contract zero-tool"],["content","Contract correct arguments"],["research","Contract multi-tool"],["campaigns","Contract multi-tool"]] as const){
      const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId})).conversation;
      const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:text+" "+featureId})).task;
      const done=await finished(task.id);expect(done.state,done.error_code).toBe("completed");
      const {capture}=await browserOk(`/api/agents/tasks/${task.id}/export`);
      expect(capture.rootTaskId).toBe(task.id);expect(capture.conversationId).toBe(conversation.id);
      expect(capture.effectiveComposition.programVersion).toBe(featureId==="assistant"?"4":"3");expect(capture.modelRoutesDigest).toMatch(/^[a-f0-9]{64}$/);
      const root=capture.tasks.find((item:any)=>item.id===task.id);
      expect(root.productBindings.length).toBeGreaterThan(0);
      const tools=root.modelCalls.flatMap((call:any)=>call.toolResults);
      if(text.includes("zero-tool"))expect(tools).toHaveLength(0);
      if(text.includes("correct")){expect(tools).toHaveLength(2);expect(JSON.stringify(tools[0])).toContain("TOOL_ARGUMENTS_INVALID");}
      if(text.includes("multi-tool")){
        expect(tools).toHaveLength(4);
        const names=(await pool.query("SELECT request->>'productOperation' name FROM agents_platform.operations WHERE task_id=$1 AND kind='tool' ORDER BY id",[task.id])).rows.map(row=>row.name);
        expect(names).toEqual(["content.list","content.read","workspace.read","content.read"]);
        expect(root.output).toMatch(/\[E[a-f0-9]+\]/);
        expect(capture.coverage.modelInputs.status).toBe("complete");
        mkdirSync(resolve("../../../.audit"),{recursive:true});
        writeFileSync(resolve("../../../.audit/product-capabilities-native-capture.json"),JSON.stringify(capture),{mode:0o600});
      }
      await controlFixture({type:"membership",enabled:false},"membership");
      expect((await browser(`/api/agents/tasks/${task.id}/export`)).status).toBe(403);
      await controlFixture({type:"membership",enabled:true},"membership");
    }
  },40000);
  it("uses new configuration only for a new turn while authenticated retries stay pinned",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation,turn=command("turns.submit",{conversationId:conversation.id,text:"Pinned turn"});
    const first=(await ok(turn)).task,old=(await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[first.id])).rows[0].version_id;
    await ok(command("features.configure",{featureId:"assistant",configuration:{...await currentConfiguration("assistant"),instructions:"Updated Growth instructions. Read the authorized context."}}),true);
    expect((await ok(turn)).task.id).toBe(first.id);
    const next=(await ok(command("turns.submit",{conversationId:conversation.id,text:"New settings"}))).task;
    expect((await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[next.id])).rows[0].version_id).not.toBe(old);
  });
  it("downloads exact product-owned artifact bytes and rechecks private evidence without an Agents account",async()=>{
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"research"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Artifact fixture"})).task;
    const completing=finished(task.id);await until(async()=>artifactHeld);
    const row=(await pool.query("SELECT t.*,c.agent_id FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.id=$1",[task.id])).rows[0],context=(await pool.query("SELECT * FROM agents_platform.product_task_contexts WHERE task_id=$1",[task.id])).rows[0],artifactId=randomUUID();
    const digest=createHash("sha256").update(artifactBytes).digest("hex");
    await pool.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,product_owner,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name) VALUES($1,$2,$3,NULL,'growth','fixture:artifact',$4,$5,'application/octet-stream',$6,$4,'available',$7,$7,'Private report')",[artifactId,row.organization_id,row.agent_id,digest,"fixture/"+artifactId,artifactBytes.length,task.id]);
    await transaction(pool,async db=>runtime.evidence.deriveWithin(db,task.id,"artifact",artifactId,[{kind:"product",product:"growth",tenantId,taskId:task.id,contextRevision:context.sources.find((source:any)=>source.bindingId).revision,sourceId:context.sources.find((source:any)=>source.bindingId).id,bindingId:context.sources.find((source:any)=>source.bindingId).bindingId,bindingDigest:(await currentConfiguration("research")).productBindings.find((binding:any)=>binding.id===context.sources.find((source:any)=>source.bindingId).bindingId).digest}]));
    releaseArtifact();expect((await completing).state).toBe("completed");
    const metadata=(await browserOk(`/api/agents/tasks/${task.id}/artifacts`)).artifacts[0];
    const download=await browser(metadata.downloadPath);expect(download.status).toBe(200);expect(Buffer.from(await download.arrayBuffer())).toEqual(artifactBytes);
    expect(download.headers.get("content-disposition")).toContain("attachment");expect(download.headers.get("cache-control")).toBe("no-store");
    await controlFixture({type:"membership",enabled:false},"membership");
    expect((await browser(metadata.downloadPath)).status).toBe(403);
    await controlFixture({type:"membership",enabled:true},"membership");
    await pool.query("UPDATE agents_platform.artifacts SET content_digest=$2 WHERE id=$1",[artifactId,"0".repeat(64)]);
    expect((await browser(metadata.downloadPath)).status).toBe(503);
    await controlFixture({type:"profile",name:"Withdrawn original workspace source"},"profile");
    const withdrawn=(await browserOk(`/api/agents/tasks/${task.id}`)).task;
    expect(withdrawn.output).toBeNull();expect(withdrawn.sources).toEqual([]);
    const {capture}=await browserOk(`/api/agents/tasks/${task.id}/export`);
    expect(capture.tasks[0].input).toBeNull();expect(capture.tasks[0].modelCalls).toEqual([]);
    expect(capture.coverage.modelInputs.status).toBe("partial");
  },15000);
  it("serializes distinct concurrent configuration updates without version collisions",async()=>{
    const config=await currentConfiguration("campaigns");
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
      dispatch:async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});}});
    expect(result.taskIds).toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
  },90000);

  it("executes the current canonical catalogue through actual shared worker review commit and replay",async()=>{
    canonicalMode=true;
    await controlFixture({type:"configure",frontendOrigin:growthOrigin},"configured");
    const trust={issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}};
    await new GrowthExecutionService(pool,trust,runtime).ensureTenant({tenantId,publication:canonicalPublication,defaultsRevision:"6",upgradeDefaults:true});
    const before=(await browserOk("/__fixture/posts")).posts.length;
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"content"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Save a draft using canonical operations"})).task;
    await finished(task.id,"waiting_review");
    const review=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];
    expect(review.kind).toBe("operation");expect(review.operation).toBe("content.posts.draft.create");
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(before);
    loseCommitAcknowledgement=true;
    const decision=await fetch(`${growthOrigin}/api/operations/reviews/${review.id}/decision`,{method:"POST",headers:{origin:growthOrigin,"content-type":"application/json",cookie:`kasitek_session=fixture-dashboard-session; kasitek_active_org=${tenantId}`},body:JSON.stringify({decision:"approve",payloadDigest:review.payloadDigest})});
    expect(decision.status,await decision.text()).toBe(200);
    const complete=await finished(task.id);expect(complete.state,complete.error_code).toBe("completed");
    const after=(await browserOk("/__fixture/posts")).posts;
    expect(after).toHaveLength(before+1);
    expect(after.at(-1).content).toBe("Reviewed content");
    const saved=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];
    expect(saved.state).toBe("succeeded");
    expect((await ok(command("reviews.decide",{taskId:task.id,reviewId:review.id,payloadDigest:review.payloadDigest,decision:"approve"}))).reviewId).toBe(review.id);
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(before+1);
    expect((await pool.query("SELECT revision FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision='6'",[tenantId])).rows[0].revision).toBe("6");
  },60000);

});
