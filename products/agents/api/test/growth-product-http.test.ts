import {writeFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer as httpServer} from "node:http";
import {createServer as http2Server} from "node:http2";
import {execFileSync,spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createInterface} from "node:readline";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {createServer as portServer} from "node:net";
import {HARNESS_RELEASE,WORKFLOW_NAME,ADAPTIVE_HARNESS_RELEASE,ADAPTIVE_WORKFLOW_NAME,SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME} from "../src/contracts/execution";
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
import {beginOperation,finishOperation,settleTask} from "../src/execution/lifecycle/execution";
import {readHistory} from "../src/execution/context/journal";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import {assertCurrentEvidence,taskEvidenceManifest} from "../src/execution/context/evidence-policy";
import {assertProductInformationForModel} from "../src/execution/products/product-information";
import {createDependencyManifest} from "../src/contracts/source-contracts";
import {requestDigest,terminalTaskStates} from "../src/contracts/contracts";

import {verifyGrowthBrowser} from "./support/growth-browser";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {transaction} from "../src/infrastructure/database";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {privateStoreFromEnvironment} from "../src/infrastructure/object-store";
import {loadExecution} from "../src/execution/lifecycle/state";
import {currentProductInformation} from "../src/execution/products/product-information";
import {startSpecialist} from "../src/execution/delegation/adaptive";
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
  const runtimeRoutes=()=>({[SHARED_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:restAdmin,workflowName:SHARED_WORKFLOW_NAME},[HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:restAdmin,workflowName:WORKFLOW_NAME},[ADAPTIVE_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:restAdmin,workflowName:ADAPTIVE_WORKFLOW_NAME}});
  let ingress:string,restAdmin:string,origin:string,runtime:GrowthProductRuntime,workerFactory:()=>ReturnType<typeof http2Server>;
  const workerSessions=new Set<import("node:http2").ServerHttp2Session>();
  function trackWorker(){worker.on("session",session=>{workerSessions.add(session);session.once("close",()=>workerSessions.delete(session));});}
  let loseCommitAcknowledgement=false,lostCommitAcknowledgements=0;
  let artifactHeld=false,releaseArtifact:()=>void=()=>{};
  const artifactBarrier=new Promise<void>(resolve=>{releaseArtifact=resolve;});
  let adaptiveHold:Promise<void>|null=null,capacityFailureCalls=0;
  let canonicalPublication:import("@kasitek-labs/contracts").GrowthAgentPublication,canonicalMode=false;
  let modelCalls=0,growthOrigin:string,objects:ReturnType<typeof httpServer>;const artifactBytes=Buffer.alloc(90000,65);const controls:any[]=[];
  const selectedContextInputs:string[]=[];
  const savedEffectInputs:string[]=[];
  const delegatedRequestContexts:any[][]=[];
  async function controlFixture(message:unknown,type:string){growth.stdin.write(JSON.stringify(message)+"\n");await until(async()=>controls.findIndex(item=>item.type===type)>=0?controls.splice(controls.findIndex(item=>item.type===type),1)[0]:false);}
  async function browser(path:string,body?:unknown,method=body===undefined?"GET":"POST"){return fetch(growthOrigin+path,{method,headers:{origin:growthOrigin,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  async function browserOk(path:string,body?:unknown){const response=await browser(path,body),value=await response.json();expect(response.status,JSON.stringify(value)).toBeLessThan(300);return value as any;}
  const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
  async function until<T>(fn:()=>Promise<T|false>,timeout=25000):Promise<T>{
    const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error("Bounded Growth integration wait expired");
  }
  async function listen(server:ReturnType<typeof httpServer>){await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));return "http://127.0.0.1:"+(server.address() as {port:number}).port;}
  function sharedCommand(command:GrowthAgentCommand):Record<string,unknown>|null{
    const base={version:"1",requestId:command.requestId,product:"growth",tenantId:command.tenantId,actor:command.actor};
    const target=(featureId:string)=>({target:{kind:"product_feature",featureId}});
    switch(command.operation){
      case "conversations.create":return{...base,operation:"conversations.create",input:{...target(command.input.featureId),...(command.input.title?{title:command.input.title}:{}),context:command.input.context??null}};
      case "conversations.get":return{...base,operation:"conversations.get",input:{conversationId:command.input.conversationId,...(command.input.cursor?{cursor:command.input.cursor}:{}),...(command.input.limit?{limit:command.input.limit}:{})}};
      case "conversations.list":return{...base,operation:"conversations.list",input:{...(command.input.featureId?target(command.input.featureId):{}),...(command.input.search?{search:command.input.search}:{}),...(command.input.cursor?{cursor:command.input.cursor}:{}),...(command.input.limit?{limit:command.input.limit}:{})}};
      case "conversations.context":return{...base,operation:"conversations.context",input:{conversationId:command.input.conversationId,context:command.input.context}};
      case "turns.submit":return{...base,operation:"runs.start",input:{conversationId:command.input.conversationId,message:command.input.text,...(command.input.context!==undefined?{context:command.input.context}:{})}};
      case "tasks.get":return{...base,operation:"runs.get",input:{taskId:command.input.taskId}};
      case "tasks.list":return{...base,operation:"runs.list",input:{...(command.input.conversationId?{conversationId:command.input.conversationId}:{}),...(command.input.state?{state:command.input.state}:{}),...(command.input.search?{search:command.input.search}:{}),...(command.input.cursor?{cursor:command.input.cursor}:{}),...(command.input.limit?{limit:command.input.limit}:{})}};
      case "tasks.observe":return{...base,operation:"runs.activity",input:{taskId:command.input.taskId,...(command.input.childTaskId?{childTaskId:command.input.childTaskId}:{}),...(command.input.cursor?{cursor:command.input.cursor}:{}),...(command.input.operationCursor?{operationCursor:command.input.operationCursor}:{}),...(command.input.limit?{limit:command.input.limit}:{})}};
      case "tasks.events":return{...base,operation:"runs.events",input:{taskId:command.input.taskId,...(command.input.cursor?{cursor:command.input.cursor}:{}),...(command.input.limit?{limit:command.input.limit}:{})}};
      case "tasks.instructions":return{...base,operation:"runs.steer",input:{taskId:command.input.taskId,instruction:command.input.instruction}};
      case "tasks.cancel":return{...base,operation:"runs.cancel",input:{taskId:command.input.taskId}};
      case "tasks.continue":return{...base,operation:"runs.continue",input:{taskId:command.input.taskId}};
      case "reviews.list":return{...base,operation:"reviews.list",input:{taskId:command.input.taskId}};
      case "reviews.decide":return{...base,operation:"reviews.decide",input:{taskId:command.input.taskId,reviewId:command.input.reviewId,payloadDigest:command.input.payloadDigest,decision:command.input.decision}};
      case "artifacts.list":return{...base,operation:"artifacts.list",input:{taskId:command.input.taskId,...(command.input.childTaskId?{childTaskId:command.input.childTaskId}:{})}};
      case "artifacts.get":return{...base,operation:"artifacts.get",input:{taskId:command.input.taskId,artifactId:command.input.artifactId,...(command.input.childTaskId?{childTaskId:command.input.childTaskId}:{}),...(command.input.offset!==undefined?{offset:command.input.offset}:{})}};
      case "tasks.export":return{...base,operation:"tasks.export",input:{taskId:command.input.taskId}};
      case "models.list":return{...base,operation:"models.list",input:target(command.input.featureId)};
      case "models.select":return{...base,operation:"models.select",input:{...target(command.input.featureId),expectedRevision:command.input.expectedRevision,selection:command.input.selection}};
      default:return null;
    }
  }
  async function signed(command:unknown,isControl=false){
    const now=Math.floor(Date.now()/1000);
    return new SignJWT({product:"growth",requestDigest:requestDigest(command)}).setProtectedHeader({alg:"RS256",kid:isControl?"control":"growth-v1"})
      .setIssuer(issuer).setSubject(isControl?"growth-control":"growth-api").setAudience("agents-product-api")
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+60).sign((isControl?control:keys).privateKey);
  }
  async function send(command:GrowthAgentCommand,isControl=false) {
    const shared=sharedCommand(command);
    const path=shared?"/internal/v1/products/growth/agent-gateway":"/internal/v1/products/growth/extensions";
    const body=shared??{version:"1",requestId:command.requestId,product:"growth",tenantId:command.tenantId,actor:command.actor,
      operation:`growth.${command.operation}`,input:command.input};
    return fetch(origin+path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+await signed(body,isControl)},body:JSON.stringify(body)});
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
    const storedObjects=new Map<string,Buffer>();
    objects=httpServer(async(req,res)=>{
      const path=req.url??"/";
      if(req.method==="PUT"){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));storedObjects.set(path,Buffer.concat(chunks));res.end();return;}
      if(req.method==="DELETE"){storedObjects.delete(path);res.end();return;}
      res.end(storedObjects.get(path)??artifactBytes);
    });
    const objectOrigin=await listen(objects);
    for(const [name,value] of Object.entries({AGENTS_S3_ENDPOINT:objectOrigin,AGENTS_S3_REGION:"test",AGENTS_S3_BUCKET:"growth-fixture",AGENTS_S3_ACCESS_KEY_ID:"fixture",AGENTS_S3_SECRET_ACCESS_KEY:"fixture"}))vi.stubEnv(name,value);
    canonicalPublication=ready.canonicalPublication;
    runtime=new GrowthProductRuntime(pool,new GrowthActionClient({origin:growthOrigin,issuer:"https://agents.fixture.test",keyId:"agents-v1",privateKey:await exportPKCS8(workerKeys.privateKey),environment:"test",fetch:async(url,init)=>{
      const response=await fetch(url,init),body=JSON.parse(String(init?.body??"{}"));
      if(loseCommitAcknowledgement&&body.control==="commit"&&response.ok){loseCommitAcknowledgement=false;lostCommitAcknowledgements++;await response.arrayBuffer();throw Error("Controlled lost commit acknowledgement");}
      return response;
    }}));
    await new GrowthExecutionService(pool,{issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}}).ensureTenant({tenantId,publication:ready.canonicalPublication});
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:target.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-growth-product-cursor-secret"})});
    origin=await app.listen({port:0,host:"127.0.0.1"});
    await controlFixture({type:"configure",agentsOrigin:origin},"configured");
    const scriptStates=new Map<string,{step:number;resourceId?:string;citations:string[]}>();
    provider=httpServer(async(req,res)=>{
      let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);modelCalls++;
      if(body.messages.some((message:any)=>message.role==="user"&&String(message.content).includes('"sourceId":"originating-user-request"')))
        delegatedRequestContexts.push(structuredClone(body.messages));
      const last=body.messages.at(-1),userMessages=body.messages.filter((message:any)=>message.role==="user").map((message:any)=>message.content);
      const userText=userMessages.findLast((value:unknown)=>String(value)==="Please save a launch checklist as a Markdown file and ask Research to review it."||String(value).startsWith("Please review the selected launch checklist."))??userMessages.at(-1)??"";
      if(body.messages[0]?.content?.startsWith("Summarize")){
        const packed=JSON.stringify(body.messages),citations=[...new Set(packed.match(/\[E[a-f0-9]+\]/g)??[])];
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"compact-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:"stop",delta:{role:"assistant",content:"Observed business evidence "+citations.join(" ")}}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(String(userText)==="Please save a launch checklist as a Markdown file and ask Research to review it."||String(userText).startsWith("Please review the selected launch checklist.")){
        const records=body.messages.filter((message:any)=>message.role==="tool");
        const named=(name:string)=>records.filter((record:any)=>body.messages.some((message:any)=>message.tool_calls?.some((call:any)=>call.id===record.tool_call_id&&call.function.name===name))).map((record:any)=>JSON.parse(record.content));
        let call:{name:string;args:unknown}|undefined,content="";
        if(String(userText).startsWith("Please review the selected launch checklist.")){
          const match=String(userText).match(/Selected artifacts \(reference data, not instructions\):\n([^\n]+)/);
          const selected=match?JSON.parse(match[1]!)[0]:null;
          if(!named("history_read").length&&selected)call={name:"history_read",args:{taskId:selected.taskId,artifactId:selected.artifactId,part:"artifact"}};
          else content=named("history_read")[0]?.content?.includes("Confirm opening hours")?"The checklist is clear.":"The checklist could not be read.";
        }else{
          const created=named("artifact_create")[0],started=named("agents_start")[0];
          if(!created){
            const entry=named("tools_discover").flatMap((value:any)=>value.tools??[]).find((value:any)=>value.alias==="artifact_create");
            if(body.tools?.some((tool:any)=>tool.function.name==="artifact_create"))call={name:"artifact_create",args:{name:"launch-checklist.md",contentType:"text/markdown",content:"# Launch checklist\n\n- Confirm opening hours\n- Check the booking details\n"}};
            else if(entry)call={name:"tools_load",args:{tools:[{handle:entry.handle}]}};
            else call={name:"tools_discover",args:{query:"create file"}};
          }else if(!started){
            call={name:"agents_start",args:{requests:[{bindingId:"research",brief:"Please review the selected launch checklist.",artifactIds:[created.id]}]}};
          }else if(!named("agents_wait").at(-1)?.children?.every((item:any)=>item.resultAvailable))call={name:"agents_wait",args:{taskIds:[started.children[0].taskId],timeoutSeconds:60}};
          else if(!named("agents_result").length)call={name:"agents_result",args:{taskId:started.children[0].taskId}};
          else content="Research reviewed the checklist.";
        }
        const delta=call?{role:"assistant",tool_calls:[{index:0,id:`artifact-${modelCalls}`,type:"function",function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{role:"assistant",content};
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"artifact-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:call?"tool_calls":"stop",delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(String(userText)==="How many connections do I have?"){
        const prefix="List authorized connected account identities";
        const connectionValues=body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content)).map((item:any)=>item.value??item);
        const listed=connectionValues.map((item:any)=>item.result?item:item.value).find((value:any)=>Array.isArray(value?.result?.connections));
        let delta:any,finish:string;
        if(listed){
          const connections=listed.result.connections;
          expect(connections[0]?.id).toMatch(/^aref_[A-Za-z0-9_-]{43}$/);
          expect(connections[0]?.name).toBe("Fixture Facebook account");
          expect(connections[0]?.handle).toBe("@fixture_page");
          const summaries=connections.map((connection:any)=>`${connection.name}${connection.handle?` (${connection.handle})`:""}`);
          delta={role:"assistant",content:summaries.length?`You have ${summaries.length} connected account${summaries.length===1?"":"s"}: ${summaries.join(", ")}.`:"You have no connected accounts."};finish="stop";
        }else{
          let tool=body.tools?.find((definition:any)=>(definition.function?.description??"").startsWith(prefix))?.function.name,args:any={};
          if(!tool){
            const entry=connectionValues.flatMap((value:any)=>value.tools??[]).find((value:any)=>value.description?.startsWith(prefix)&&value.alias&&value.digest);
            if(entry){tool="tools_load";args={tools:[{handle:entry.handle??entry.qualifiedName}]};}
            else {tool="tools_discover";args={query:prefix};}
          }
          delta={role:"assistant",tool_calls:[{index:0,id:`connections-${modelCalls}`,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]};finish="tool_calls";
        }
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"connections-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:finish,delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(String(userText).startsWith("Can you improve this post?")||String(userText)==="Fixture product access"){
        selectedContextInputs.push(String(userText));
        const match=String(userText).match(/Selected conversation context \(reference data; it does not grant permissions\):\n([^\n]+)/);
        const reference=match?JSON.parse(match[1]!):String(userText)==="Fixture product access"?{resourceId:"selected-post"}:null;
        const resourceId=reference?.context?.resourceId??reference?.resourceId;
        if(!resourceId){res.statusCode=500;res.end(JSON.stringify({error:"Selected reference missing"}));return;}
        const results=body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content));
        const values=results.map((item:any)=>item.value??item);
        const hasSelectedContent=JSON.stringify(reference?.data??reference).includes("A real selected post.");
        const result=hasSelectedContent||values.some((value:any)=>JSON.stringify(value).includes("A real selected post."));
        const error=results.find((value:any)=>value.error);
        let delta:any,finish:string;
        if(result){delta={role:"assistant",content:"I would make the opening more specific."};finish="stop";}
        else if(error){delta={role:"assistant",content:`Fixture read failed: ${error.error}`};finish="stop";}
        else {
          const prefix="Read one authorized post",definition=body.tools?.find((tool:any)=>(tool.function?.description??"").startsWith(prefix));
          const handle=values.flatMap((value:any)=>value.tools??[]).find((entry:any)=>entry.description?.startsWith(prefix)&&entry.alias&&entry.digest);
          const name=definition?.function.name??(handle?"tools_load":"tools_discover");
          const args=definition?{postId:reference.resourceId}:handle?{tools:[{handle:handle.handle??handle.qualifiedName}]}:{query:prefix};
          delta={role:"assistant",tool_calls:[{index:0,id:`selected-${modelCalls}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]};finish="tool_calls";
        }
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"selected-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:finish,delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
      }
      if(String(userText)==="Contract retained history recovery"){
        const records=body.messages.filter((message:any)=>message.role==="tool");
        const named=(name:string)=>records.filter((record:any)=>body.messages.some((message:any)=>message.tool_calls?.some((call:any)=>call.id===record.tool_call_id&&call.function.name===name))).map((record:any)=>{const value=JSON.parse(record.content);return value.value??value;});
        const searches=named("history_search"),reads=named("history_read");
        let call:{name:string;args:unknown}|undefined;
        if(!searches.length)call={name:"history_search",args:{query:"ORCHID-419",since:"2000-01-01T00:00:00Z",before:"2100-01-01T00:00:00Z"}};
        else if(!reads.length)call={name:"history_read",args:{taskId:searches[0].results[0]?.taskId}};
        else if(!named("tools_discover").length)call={name:"tools_discover",args:{}};
        else if(searches.length<2)call={name:"history_search",args:{part:"operations",query:"tools.discover"}};
        else if(reads.length<2)call={name:"history_read",args:{operationId:searches[1].results[0]?.operationId}};
        const delta=call?{role:"assistant",tool_calls:[{index:0,id:`history-${modelCalls}`,type:"function",function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{role:"assistant",content:"Recovered the retained ORCHID-419 turn and public discovery receipt."};
        res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"history-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:call?"tool_calls":"stop",delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");return;
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
      if(String(userText)==="Save a draft using canonical operations")savedEffectInputs.push(...body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>message.content));
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
        let tool=find(prefix);
        if(!tool){
          const handle=values.flatMap((value:any)=>value.tools??[]).find((entry:any)=>entry.description?.startsWith(prefix)&&entry.alias&&entry.digest);
          if(handle){tool="tools_load";args={tools:[{handle:handle.handle??handle.qualifiedName}]};}
          else {tool="tools_discover";args={query:prefix};}
          if(!body.tools?.some((definition:any)=>definition.function?.name===tool)){res.statusCode=500;res.end(JSON.stringify({error:"Required fixture operation is unavailable"}));return;}
        }else state.step++;
        delta={role:"assistant",tool_calls:[{index:0,id:"call-"+modelCalls,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]};finish="tool_calls";
      }else{
        if(String(userText).includes("Artifact fixture")){artifactHeld=true;await artifactBarrier;}
        const citations=state.citations.join(" ");
        delta={role:"assistant",content:write?"Saved the reviewed draft.":zero?"Hello without tools.":"Fixture business [internal reference] "+citations};finish="stop";
      }
      res.setHeader("content-type","text/event-stream");res.end("data: "+JSON.stringify({id:"growth-fixture-"+modelCalls,model:body.model,choices:[{index:0,finish_reason:finish,delta}],usage:{prompt_tokens:2050,completion_tokens:69}})+"\n\ndata: [DONE]\n\n");
    });
    const providerOrigin=await listen(provider);
    const artifactStore=new TaskArtifactStore(pool,privateStoreFromEnvironment());
    const workflow=(version?:{release:string;workflow:string})=>createBusinessWorkflow(pool,{modelProvider:new ModelProviderStore(pool,keyVault),product:runtime,evidence:runtime.evidence,artifacts:artifactStore,
      readRetainedArtifact:(taskId,originTaskId,artifactId)=>artifactStore.readRetainedForTask(taskId,originTaskId,artifactId),
      modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Model destination denied");await policy.beforeDispatch?.();return fetch(providerOrigin,init);}) as ModelFetch;network.markProgress=()=>{};return network;})}},version);
    workerFactory=()=>http2Server(createEndpointHandler({services:[workflow(),workflow({release:ADAPTIVE_HARNESS_RELEASE,workflow:ADAPTIVE_WORKFLOW_NAME}),workflow({release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME})]}));
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
  async function finished(taskId:string,state?:string,timeout=50000){
    return until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return (state?task.state===state:terminalTaskStates.has(task.state))?task:false;},timeout);
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
  it("persists scoped agent profiles and reauthorizes edits",async()=>{
    const profile=command("features.profile",{featureId:"content",name:"Muse",avatar:"muse"});
    const before=await ok(command("features.list",{}));
    const original=before.features.find((feature:any)=>feature.id==="content");
    try {
      expect(await ok(profile)).toMatchObject({name:"Muse",avatar:"muse"});
      expect(await ok(profile)).toMatchObject({name:"Muse",avatar:"muse"});
      const listed=await ok(command("features.list",{}));
      expect(listed.features.find((feature:any)=>feature.id==="content")).toMatchObject({name:"Muse",avatar:"muse"});
      expect((await send(command("features.profile",{featureId:"content",name:"Invalid",avatar:"invalid"}))).status).toBe(400);
      expect((await send(command("features.profile",{featureId:"content",name:"Other",avatar:"muse"},{tenantId:randomUUID()}))).status).toBeGreaterThanOrEqual(400);
      await controlFixture({type:"membership",enabled:false},"membership");
      try { expect((await send(command("features.profile",{featureId:"content",name:"Denied",avatar:"muse"}))).status).toBeGreaterThanOrEqual(400); }
      finally { await controlFixture({type:"membership",enabled:true},"membership"); }
    } finally { await ok(command("features.profile",{featureId:"content",name:original.name,avatar:original.avatar})); }
  });
  it("loads task list projections concurrently while preserving page order",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect((await browserOk("/api/agents/bootstrap")).features.every((feature:any)=>feature.ready)).toBe(true);
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation,taskIds:string[]=[];
    for(let index=0;index<5;index++){
      const task=(await ok(command("turns.submit",{conversationId:conversation.id,text:`Contract zero-tool task-list projection ${index}`}))).task;
      expect((await finished(task.id)).state).toBe("completed");taskIds.push(task.id);
    }
    const expected=(await pool.query(`SELECT t.id FROM agents_platform.tasks t
      JOIN agents_platform.product_task_contexts p ON p.task_id=t.id
      WHERE t.product='growth' AND p.tenant_id=$1 AND t.conversation_id=$2 AND t.parent_task_id IS NULL
      ORDER BY t.created_at DESC,t.id DESC`,[tenantId,conversation.id])).rows.map(row=>row.id);
    expect(new Set(expected)).toEqual(new Set(taskIds));

    const authorize=runtime.authorizeTask.bind(runtime);let active=0,peak=0;
    runtime.authorizeTask=async taskId=>{
      active++;peak=Math.max(peak,active);
      try{await new Promise(resolve=>setTimeout(resolve,40));await authorize(taskId);}
      finally{active--;}
    };
    try{
      const service=new GrowthExecutionService(pool,{issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}},runtime);
      const listed=await service.execute(command("tasks.list",{conversationId:conversation.id,limit:10})) as {tasks:Array<{id:string}>};
      expect(listed.tasks.map((task:any)=>task.id)).toEqual(expected);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);

      active=0;peak=0;
      const history=await service.execute(command("conversations.get",{conversationId:conversation.id,limit:10})) as {messages:Array<{role:string;taskId:string}>};
      expect(history.messages.filter(message=>message.role==="user").map(message=>message.taskId)).toEqual([...expected].reverse());
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
    }finally{runtime.authorizeTask=authorize;}
  },60000);
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

  it("validates retained conversation and operation history through the shared business workflow",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    const original=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract zero-tool ORCHID-419 retained seed"}))).task;
    expect((await finished(original.id)).state).toBe("completed");
    const current=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Contract retained history recovery"}))).task;
    const task=await finished(current.id);
    expect(task.harness_release).toBe(SHARED_HARNESS_RELEASE);
    expect(task.state,task.error_code).toBe("completed");
    expect(task.output).toContain("Recovered the retained ORCHID-419");
    const history=(await pool.query("SELECT name,state,output,error_code FROM agents_platform.operations WHERE task_id=$1 AND name IN ('history.search','history.read') ORDER BY started_at,id",[task.id])).rows;
    expect(history.map(row=>[row.name,row.state,row.error_code])).toEqual([["history.search","completed",null],["history.read","completed",null],["history.search","completed",null],["history.read","completed",null]]);
    expect(history[0].output.results[0].taskId).toBe(original.id);
    expect(history[1].output.content).toContain("ORCHID-419 retained seed");
    expect(history[2].output.results[0]).toMatchObject({name:"tools.discover",state:"completed"});
    expect(history[3].output.content).toContain('"name":"tools.discover"');
  },60000);

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
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
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
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const originalRequest="Growth adaptive HTTP child review. Create a Wheelhouse launch post, use the name Wheelhouse, do not invent offer details, and ask me if the current price is missing.";
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:originalRequest})).task;
    await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});return (await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state='waiting_review'",[task.id])).rowCount===1;},30000);
    const review=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];expect(review.taskId).toBe(task.id);
    const child=(await pool.query("SELECT task_id FROM agents_platform.product_review_projections WHERE review_id=$1",[review.id])).rows[0].task_id;expect(child).not.toBe(task.id);
    const activity=await browserOk(`/api/agents/tasks/${task.id}/activity?childTaskId=${child}`);
    expect(activity).toMatchObject({rootTaskId:task.id,parentTaskId:task.id,agentName:"Content",task:{id:child,state:"waiting_review",canSteer:false,canContinue:false}});
    expect(activity.task.input).toBe("Prepare reviewed draft");expect(activity.operations.length).toBeGreaterThan(0);
    const childPrompt=delegatedRequestContexts.find(messages=>messages.some((message:any)=>message.role==="user"&&String(message.content).includes('"sourceId":"originating-user-request"')));
    expect(childPrompt).toBeDefined();
    const childUserMessages=childPrompt.filter((message:any)=>message.role==="user");
    expect(childUserMessages[0].content).toContain("do not invent offer details");
    expect(childUserMessages[0].content).toContain("current price is missing");
    expect(childUserMessages[1].content).toContain("Parent coordinator assignment");
    expect(childUserMessages[1].content).toContain("Prepare reviewed draft");
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
  it("keeps separate product export identities within a single operation",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Export fixture"})).task;
    const artifacts=new TaskArtifactStore(pool,privateStoreFromEnvironment());
    for(const name of ["sandbox.analyze","skills.run"]){
      const operationId=`export:${name}:${task.id}`;
      const operation=await beginOperation(pool,task.id,{id:operationId,kind:"resource",name,request:{},reservedTokens:0,reservedMs:30000});
      if(operation.waiting)throw Error("Unexpected fixture capacity wait");
      const first={name:"summary.txt",contentType:"text/plain",content:Buffer.from("Summary")};
      const second={name:"details.txt",contentType:"text/plain",content:Buffer.from("Details")};
      const a=await artifacts.put(task.id,operationId,first),b=await artifacts.put(task.id,operationId,second);
      expect(a.id).not.toBe(b.id);
      expect((await artifacts.put(task.id,operationId,first)).id).toBe(a.id);
      expect((await artifacts.put(task.id,operationId,second)).id).toBe(b.id);
      await expect(artifacts.put(task.id,operationId,{...first,content:Buffer.from("Changed")})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
      await expect(artifacts.put(task.id,operationId,{...first,contentType:"text/markdown"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
      await finishOperation(pool,task.id,operationId,"completed",{},null,0,operation.operation.attempt_id);
    }
    for(const name of ["artifact.create","report.prepare"]){
      const operationId=`single:${name}:${task.id}`;
      const operation=await beginOperation(pool,task.id,{id:operationId,kind:"resource",name,request:{},reservedTokens:0,reservedMs:30000});
      if(operation.waiting)throw Error("Unexpected fixture capacity wait");
      const input={name:"report.txt",contentType:"text/plain",content:Buffer.from("Report")};
      const created=await artifacts.put(task.id,operationId,input);
      expect((await artifacts.put(task.id,operationId,input)).id).toBe(created.id);
      await expect(artifacts.put(task.id,operationId,{...input,name:"changed.txt"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
      await finishOperation(pool,task.id,operationId,"completed",{},null,0,operation.operation.attempt_id);
    }
  },90000);
  it("shows and downloads only the selected child's own file under current Growth authority",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const root=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Please prepare a research note."})).task;
    const artifacts=new TaskArtifactStore(pool,privateStoreFromEnvironment()),startId=`child-file-start:${root.id}`;
    const admission=await beginOperation(pool,root.id,{id:startId,kind:"delegation",name:"agents.start",request:{},reservedTokens:0,reservedMs:30000});
    if(admission.waiting)throw Error("Unexpected fixture capacity wait");
    const children=(await startSpecialist(pool,root.id,startId,{requests:[{bindingId:"research",brief:"Prepare a research note."},{bindingId:"campaigns",brief:"Review the launch."}]},runtime.evidence,artifacts)).children;
    const selected=children[0]!,sibling=children[1]!;
    const writeId=`child-file-write:${selected.taskId}`;
    const writeInput={id:writeId,kind:"resource" as const,name:"artifact.create",request:{},reservedTokens:0,reservedMs:30000,retrySafe:true};
    const write=await beginOperation(pool,selected.taskId,writeInput);
    if(write.waiting)throw Error("Unexpected fixture capacity wait");
    const file=await artifacts.put(selected.taskId,writeId,{name:"research-note.md",contentType:"text/markdown",content:Buffer.from("A private research note.\n")});
    const retry=await beginOperation(pool,selected.taskId,writeInput);
    if(retry.waiting)throw Error("Unexpected fixture capacity wait");
    expect(retry.replayed).toBe(false);expect(retry.operation.attempt_id).not.toBe(write.operation.attempt_id);
    expect((await artifacts.put(selected.taskId,writeId,{name:"research-note.md",contentType:"text/markdown",content:Buffer.from("A private research note.\n")})).id).toBe(file.id);
    await expect(artifacts.put(selected.taskId,writeId,{name:"changed.md",contentType:"text/markdown",content:Buffer.from("Changed")})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    const before=await taskEvidenceManifest(pool,root.id);
    const activity=await browserOk(`/api/agents/tasks/${root.id}/activity?childTaskId=${selected.taskId}`);
    expect(activity.task.results).toEqual([{id:file.id,kind:"artifact",title:"research-note.md",artifactId:file.id}]);
    expect((await taskEvidenceManifest(pool,root.id)).digest).toBe(before.digest);
    const preview=(await browserOk(`/api/agents/tasks/${root.id}/artifacts/${file.id}?childTaskId=${selected.taskId}`)).artifact;
    const download=await browser(preview.downloadPath);expect(download.status).toBe(200);expect(await download.text()).toBe("A private research note.\n");
    expect(download.headers.get("content-disposition")).toContain("research-note.md");
    expect((await browser(`/api/agents/tasks/${root.id}/artifacts/${file.id}?childTaskId=${sibling.taskId}`)).status).toBe(404);
    expect((await browser(`/api/agents/tasks/${root.id}/artifacts/${file.id}?childTaskId=${randomUUID()}`)).status).toBe(404);
    await controlFixture({type:"membership",enabled:false},"membership");
    expect((await browser(preview.downloadPath)).status).toBe(403);
    await controlFixture({type:"membership",enabled:true},"membership");
  },90000);
  it("creates a product file and shares it with Research",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const submitted=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Please save a launch checklist as a Markdown file and ask Research to review it."})).task;
    const done=await finished(submitted.id,undefined,110000);expect(done.state,done.error_code).toBe("completed");
    const created=(await pool.query("SELECT id,name,product_owner,account_id FROM agents_platform.artifacts WHERE task_id=$1 AND state='available'",[done.id])).rows;
    expect(created).toHaveLength(1);expect(created[0]).toMatchObject({name:"launch-checklist.md",product_owner:"growth",account_id:null});
    const children=(await pool.query("SELECT id,output FROM agents_platform.tasks WHERE parent_task_id=$1",[done.id])).rows;
    expect(children).toHaveLength(1);expect(children[0].output).toContain("checklist is clear");
    expect((await pool.query("SELECT 1 FROM agents_platform.task_artifact_transfers WHERE artifact_id=$1 AND target_task_id=$2",[created[0].id,children[0].id])).rowCount).toBe(1);
    const childRead=(await pool.query("SELECT output FROM agents_platform.operations WHERE task_id=$1 AND name='history.read' AND state='completed'",[children[0].id])).rows[0];
    expect(childRead.output.content).toBe("# Launch checklist\n\n- Confirm opening hours\n- Check the booking details\n");
    const manifest=await taskEvidenceManifest(pool,done.id),dependency=manifest.dependencies.find(value=>value.kind==="product_artifact"&&value.artifactId===created[0].id);
    expect(dependency).toMatchObject({kind:"product_artifact",product:"growth",tenantId,taskId:done.id,artifactId:created[0].id});
    await expect(assertProductInformationForModel(pool,done.id,manifest,"primary")).resolves.toBeUndefined();
    await expect(assertProductInformationForModel(pool,children[0].id,manifest,"delegated")).resolves.toBeUndefined();
    const restricted=structuredClone(dependency!);if(restricted.kind!=="product_artifact")throw Error("Missing artifact dependency");
    restricted.information.providers=restricted.information.providers.map(provider=>{
      const {destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;destination.endpoint="https://unapproved-provider.invalid/";
      return {...provider,endpoint:destination.endpoint,destinationDigest:requestDigest(destination)};
    });
    for(const [taskId,role] of [[done.id,"primary"],[done.id,"compaction"],[children[0].id,"delegated"]] as const)
      await expect(assertProductInformationForModel(pool,taskId,createDependencyManifest([restricted]),role)).rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    const results=(await browserOk(`/api/agents/tasks/${done.id}/artifacts`)).artifacts;
    const metadata=results.find((artifact:any)=>artifact.id===created[0].id);
    const download=await browser(metadata.downloadPath);expect(download.status).toBe(200);
    expect(await download.text()).toBe("# Launch checklist\n\n- Confirm opening hours\n- Check the booking details\n");
    expect((await send(command("artifacts.get",{taskId:done.id,artifactId:created[0].id},{actor:{...actor,subject:randomUUID()}}))).status).toBe(404);
    await controlFixture({type:"membership",enabled:false},"membership");
    expect((await browser(metadata.downloadPath)).status).toBe(403);
    await controlFixture({type:"membership",enabled:true},"membership");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
  },110000);
  it("downloads exact product-owned artifact bytes and rechecks private evidence without an Agents account",async()=>{
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"research"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Artifact fixture"})).task;
    const completing=finished(task.id);await until(async()=>artifactHeld);
    const row=(await pool.query("SELECT t.*,c.agent_id FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.id=$1",[task.id])).rows[0],context=(await pool.query("SELECT * FROM agents_platform.product_task_contexts WHERE task_id=$1",[task.id])).rows[0],artifactId=randomUUID();
    const digest=createHash("sha256").update(artifactBytes).digest("hex");
    await pool.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,product_owner,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name) VALUES($1,$2,$3,NULL,'growth','fixture:artifact',$4,$5,'application/octet-stream',$6,$4,'available',$7,$7,'Private report')",[artifactId,row.organization_id,row.agent_id,digest,"fixture/"+artifactId,artifactBytes.length,task.id]);
    await transaction(pool,async db=>runtime.evidence.deriveWithin(db,task.id,"artifact",artifactId,[{kind:"product",product:"growth",tenantId,taskId:task.id,contextRevision:context.sources.find((source:any)=>source.bindingId).revision,sourceId:context.sources.find((source:any)=>source.bindingId).id,bindingId:context.sources.find((source:any)=>source.bindingId).bindingId,bindingDigest:(await currentConfiguration("research")).productBindings.find((binding:any)=>binding.id===context.sources.find((source:any)=>source.bindingId).bindingId).digest},{kind:"product_artifact",version:"1",product:"growth",tenantId,taskId:task.id,artifactId,contentDigest:digest,name:"Private report",contentType:"application/octet-stream",bytes:artifactBytes.length,information:await currentProductInformation(db,await loadExecution(db,task.id))}]));
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
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    await controlFixture({type:"connected-account"},"connected-account");
    const result=await verifyGrowthBrowser({growthOrigin,tenantId,userId:actor.subject,
      configureFrontend:frontendOrigin=>controlFixture({type:"configure",frontendOrigin},"configured"),
      dispatch:async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin,runtimeRoutes:runtimeRoutes()});}});
    expect(result.taskIds).toHaveLength(3);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
  },90000);

  it("keeps canonical read custody private and fences later permission changes",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const trust={issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}};
    await new GrowthExecutionService(pool,trust,runtime).ensureTenant({tenantId,publication:canonicalPublication,defaultsRevision:canonicalPublication.manifest.revision,upgradeDefaults:true});
    await controlFixture({type:"selected-post"},"selected-post");
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Fixture product access"})).task;
    const done=await finished(task.id);expect(done.state,done.error_code).toBe("completed");
    const manifest=await taskEvidenceManifest(pool,task.id),access=manifest.dependencies.find(value=>value.kind==="product_access");
    expect(access).toMatchObject({kind:"product_access",product:"growth",tenantId,taskId:task.id});
    await expect(assertProductInformationForModel(pool,task.id,manifest,"primary")).resolves.toBeUndefined();
    await expect(assertProductInformationForModel(pool,task.id,manifest,"compaction")).resolves.toBeUndefined();
    const narrowed=structuredClone(access!);if(narrowed.kind!=="product_access")throw Error("Missing product access dependency");
    narrowed.information.providers=narrowed.information.providers.map(provider=>({...provider,endpoint:"https://unapproved.example/"})).map(provider=>{
      const {destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;return {...provider,destinationDigest:requestDigest(destination)};
    });
    await expect(assertProductInformationForModel(pool,task.id,createDependencyManifest([narrowed]),"primary")).rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    const receipt=(await pool.query(`SELECT a.*,o.output FROM agents_platform.product_operation_access a
      JOIN agents_platform.operations o ON o.id=a.operation_id WHERE a.task_id=$1`,[task.id])).rows[0];
    expect(receipt?.reference).toEqual(expect.any(String));expect(receipt?.scope_reference).toEqual(expect.any(String));
    await expect(pool.query("UPDATE agents_platform.product_operation_access SET result_digest=$2 WHERE operation_id=$1",[receipt.operation_id,"0".repeat(64)])).rejects.toMatchObject({code:"23514"});
    expect(JSON.stringify(receipt.output)).not.toContain(receipt.reference);
    const snapshots=(await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE task_id=$1",[task.id])).rows;
    expect(JSON.stringify(snapshots)).not.toContain(receipt.reference);
    await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).resolves.toBeUndefined();
    await controlFixture({type:"content-entitlement",enabled:false},"content-entitlement");
    try {
      await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      const unavailable=(await browserOk(`/api/agents/tasks/${task.id}`)).task;
      expect(unavailable.output).toBeNull();expect(unavailable.errorCode).toBe("EVIDENCE_UNAVAILABLE");
    } finally {await controlFixture({type:"content-entitlement",enabled:true},"content-entitlement");}
    await pool.query("DELETE FROM agents_platform.product_operation_access WHERE operation_id=$1",[receipt.operation_id]);
    const untracked=await browser(`/api/agents/tasks/${task.id}`);expect([403,409]).toContain(untracked.status);
    expect(await untracked.text()).not.toContain("A real selected post.");
  },45000);

  it("uses a task-pinned selected post through the real product worker and fences access changes",async()=>{
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    const trust={issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}};
    await new GrowthExecutionService(pool,trust,runtime).ensureTenant({tenantId,publication:canonicalPublication,defaultsRevision:canonicalPublication.manifest.revision,upgradeDefaults:true});
    await controlFixture({type:"selected-post"},"selected-post");
    const selection={kind:"content_post",resourceId:"selected-post"};
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant",context:selection})).conversation;
    const initial=selectedContextInputs.length;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Can you improve this post?"})).task;
    const done=await finished(task.id);expect(done.state,done.error_code).toBe("completed");
    expect((await browserOk(`/api/agents/tasks/${task.id}`)).task.sources).toEqual([]);
    expect(selectedContextInputs[initial]).toContain('"resourceId":"selected-post"');
    expect(selectedContextInputs[initial]).toContain("A real selected post.");
    expect(selectedContextInputs[initial]).not.toContain("selectedAccounts");
    expect(selectedContextInputs[initial]).not.toContain("channel_connection_id");
    const manifest=await taskEvidenceManifest(pool,task.id),dependency=manifest.dependencies.find(value=>value.kind==="product_context");
    expect(dependency).toMatchObject({kind:"product_context",taskId:task.id,product:"growth",tenantId});
    await expect(assertProductInformationForModel(pool,task.id,manifest,"primary")).resolves.toBeUndefined();
    await expect(assertProductInformationForModel(pool,task.id,manifest,"compaction")).resolves.toBeUndefined();
    const altered=structuredClone(dependency!);if(altered.kind!=="product_context")throw Error("Missing selected context dependency");
    const provider=altered.information.providers[0]!,{destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;
    destination.endpoint="https://other-provider.invalid/";provider.endpoint=destination.endpoint;provider.destinationDigest=requestDigest(destination);
    altered.information.providers=[provider];
    await expect(assertProductInformationForModel(pool,task.id,createDependencyManifest([altered]),"primary")).rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    await pool.query("UPDATE agents_platform.product_task_contexts SET selected_context=$2 WHERE task_id=$1",[task.id,{kind:"content_post",resourceId:"other-post"}]);
    await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).rejects.toBeDefined();
    await pool.query("UPDATE agents_platform.product_task_contexts SET selected_context=$2 WHERE task_id=$1",[task.id,selection]);
    await controlFixture({type:"content-entitlement",enabled:false},"content-entitlement");
    await expect(runtime.selectedContextReference(task.id)).rejects.toBeDefined();
    await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).rejects.toBeDefined();
    await controlFixture({type:"content-entitlement",enabled:true},"content-entitlement");
    const foreign=await browser("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant",context:{kind:"content_post",resourceId:"other-post"}});
    expect([403,404]).toContain(foreign.status);
    const pending=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Please continue."})).task;
    await settleTask(pool,pending.id,{state:"incomplete",output:"More work is needed.",errorCode:"ORCHESTRATION_STALLED"});
    await pool.query("UPDATE agents_platform.product_conversations SET context=$2 WHERE conversation_id=$1",[conversation.id,{kind:"content_post",resourceId:"other-post"}]);
    const continued=(await ok(command("tasks.continue",{taskId:pending.id}))).task;
    expect((await pool.query("SELECT selected_context FROM agents_platform.product_task_contexts WHERE task_id=$1",[continued.id])).rows[0].selected_context).toEqual(selection);
    const plain=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"assistant"})).conversation;
    const plainTask=(await browserOk(`/api/agents/conversations/${plain.id}/messages`,{requestId:randomUUID(),text:"Hi"})).task;
    await pool.query("UPDATE agents_platform.product_conversations SET context=$2 WHERE conversation_id=$1",[plain.id,selection]);
    expect(await runtime.selectedContextReference(plainTask.id)).toBeNull();
  },60000);
  it("executes the current canonical catalogue through actual shared worker review commit and replay",async()=>{
    canonicalMode=true;
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    await controlFixture({type:"configure",frontendOrigin:growthOrigin},"configured");
    const trust={issuer,actorIssuer:actor.issuer,keys:{fixture:await exportSPKI(keys.publicKey)}};
    await new GrowthExecutionService(pool,trust,runtime).ensureTenant({tenantId,publication:canonicalPublication,defaultsRevision:canonicalPublication.manifest.revision,upgradeDefaults:true});
    const before=(await browserOk("/__fixture/posts")).posts.length;
    const conversation=(await browserOk("/api/agents/conversations",{requestId:randomUUID(),featureId:"content"})).conversation;
    const task=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"Save a draft using canonical operations"})).task;
    await finished(task.id,"waiting_review");
    const review=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];
    expect(review.kind).toBe("operation");expect(review.operation).toBe("content.posts.draft.create");
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(before);
    const lostBefore=lostCommitAcknowledgements;
    loseCommitAcknowledgement=true;
    const decision=await fetch(`${growthOrigin}/api/operations/reviews/${review.id}/decision`,{method:"POST",headers:{origin:growthOrigin,"content-type":"application/json",cookie:`kasitek_session=fixture-dashboard-session; kasitek_active_org=${tenantId}`},body:JSON.stringify({decision:"approve",payloadDigest:review.payloadDigest})});
    expect(decision.status,await decision.text()).toBe(200);
    const complete=await finished(task.id);expect(complete.state,complete.error_code).toBe("completed");
    const after=(await browserOk("/__fixture/posts")).posts;
    expect(after).toHaveLength(before+1);
    expect(lostCommitAcknowledgements).toBe(lostBefore+1);
    expect(after.at(-1).content).toBe("Reviewed content");
    const visible=savedEffectInputs.map(value=>JSON.parse(value)).find(value=>value.value?.reviewId===review.id);
    expect(visible).toEqual({value:{state:"saved",reviewId:review.id}});
    expect(JSON.stringify(visible)).not.toContain("Reviewed content");
    const effect=(await pool.query(`SELECT a.*,o.output FROM agents_platform.product_operation_access a
      JOIN agents_platform.operations o ON o.id=a.operation_id WHERE a.task_id=$1`,[task.id])).rows[0];
    expect(JSON.stringify(effect.output)).toContain("Reviewed content");
    expect(effect.result_digest).toBe(requestDigest(effect.output.value));
    const manifest=await taskEvidenceManifest(pool,task.id),dependency=manifest.dependencies.find(value=>value.kind==="product_access");
    expect(dependency).toMatchObject({kind:"product_access",product:"growth",tenantId,taskId:task.id});
    await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).resolves.toBeUndefined();
    const narrowed=structuredClone(dependency!);if(narrowed.kind!=="product_access")throw Error("Missing effect access dependency");
    narrowed.information.providers=narrowed.information.providers.map(provider=>({...provider,endpoint:"https://unapproved.example/"})).map(provider=>{
      const {destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;return {...provider,destinationDigest:requestDigest(destination)};
    });
    await expect(assertProductInformationForModel(pool,task.id,createDependencyManifest([narrowed]),"primary")).rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    await controlFixture({type:"content-entitlement",enabled:false},"content-entitlement");
    try {await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});}
    finally {await controlFixture({type:"content-entitlement",enabled:true},"content-entitlement");}
    const saved=(await browserOk(`/api/agents/tasks/${task.id}/reviews`)).reviews[0];
    expect(saved.state).toBe("succeeded");
    expect((await ok(command("reviews.decide",{taskId:task.id,reviewId:review.id,payloadDigest:review.payloadDigest,decision:"approve"}))).reviewId).toBe(review.id);
    expect((await browserOk("/__fixture/posts")).posts).toHaveLength(before+1);
    const next=(await browserOk(`/api/agents/conversations/${conversation.id}/messages`,{requestId:randomUUID(),text:"What happened with that draft?"})).task;
    const historyOperation={id:`history:${next.id}`,kind:"tool" as const,name:"history.read",request:{},reservedTokens:0,reservedMs:30000};
    const historyAdmission=await beginOperation(pool,next.id,historyOperation);if(historyAdmission.waiting)throw Error("Unexpected history capacity wait");
    let offset=0,retained="";
    for(;;){const page=await readHistory(pool,next.id,{taskId:task.id,part:"operations",offset},runtime.evidence,historyOperation.id);
      retained+=page.content;if(page.nextOffset===null)break;offset=page.nextOffset;}
    expect(retained).toContain(review.id);expect(retained).not.toContain("Reviewed content");
    await expect(assertCurrentEvidence(pool,next.id,await taskEvidenceManifest(pool,next.id))).resolves.toBeUndefined();
    await pool.query("DELETE FROM agents_platform.product_operation_access WHERE operation_id=$1",[effect.operation_id]);
    await expect(assertCurrentEvidence(pool,task.id,manifest,{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(assertCurrentEvidence(pool,next.id,await taskEvidenceManifest(pool,next.id))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(runtime.authorizeTask(task.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(runtime.authorizeControl(task.id)).resolves.toBeUndefined();
    await expect(runtime.readReviewStatus(task.id,review.id)).resolves.toMatchObject({id:review.id,state:"succeeded",payloadDigest:review.payloadDigest});
    expect((await ok(command("reviews.decide",{taskId:task.id,reviewId:review.id,payloadDigest:review.payloadDigest,decision:"approve"}))).reviewId).toBe(review.id);
    expect((await pool.query("SELECT revision FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision=$2",[tenantId,canonicalPublication.manifest.revision])).rows[0].revision).toBe(canonicalPublication.manifest.revision);
  },60000);

});
