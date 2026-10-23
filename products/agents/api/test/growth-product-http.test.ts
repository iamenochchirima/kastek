import {randomBytes,randomUUID} from "node:crypto";
import {createServer as httpServer} from "node:http";
import {createServer as http2Server} from "node:http2";
import {execFileSync} from "node:child_process";
import {generateKeyPair,exportSPKI,exportPKCS8,SignJWT,jwtVerify} from "jose";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
import {createEndpointHandler} from "@restatedev/restate-sdk";
import type {GrowthAgentCommand,GrowthAgentAction,GrowthAgentReview} from "@kasitek-labs/contracts";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {setupPlatformSchema} from "../src/composition/setup";
import {GrowthProductRuntime} from "../src/adapters/products/growth-runtime";
import {GrowthActionClient} from "../src/adapters/products/growth-action-client";
import {provisionGrowthModel} from "../src/adapters/products/growth-model-provisioning";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {ModelProviderStore} from "../src/product/model-providers/store";
import {createBusinessWorkflow} from "../src/execution/business/business";
import {dispatchTasksOnce} from "../src/execution/lifecycle/dispatcher";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import {requestDigest,terminalTaskStates} from "../src/contracts/contracts";
import {growthFeatureConfiguration} from "../src/adapters/products/growth-features";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import type {ModelFetch} from "../src/infrastructure/model-network";
const adminUrl=process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl?describe:describe.skip)("Growth authenticated product HTTP and durable worker",()=>{
  const database="agents_growth_product_http_"+randomUUID().replaceAll("-",""),container="growth-product-http-"+randomUUID();
  const issuer="https://growth.fixture.test",actor={issuer:issuer+"/identity",subject:randomUUID()},tenantId=randomUUID();
  const keyVault=new ModelCredentialVault(new ConnectionVault("test",{test:randomBytes(32).toString("base64")}));
  let admin:Pool,pool:Pool,keys:Awaited<ReturnType<typeof generateKeyPair>>,control:typeof keys,workerKeys:typeof keys;
  let app:Awaited<ReturnType<typeof buildPlatformApp>>,growth:ReturnType<typeof httpServer>,provider:ReturnType<typeof httpServer>,worker:ReturnType<typeof http2Server>;
  let ingress:string,restAdmin:string,origin:string,runtime:GrowthProductRuntime;
  let modelCalls=0,denied=false;const reviews=new Map<string,GrowthAgentReview>();
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
    growth=httpServer(async(req,res)=>{
      try{
        let raw="";for await(const chunk of req)raw+=chunk;const action=JSON.parse(raw) as GrowthAgentAction;
        const claims=await jwtVerify(req.headers.authorization!.slice(7),workerKeys.publicKey,{issuer:"https://agents.fixture.test",audience:"growth-agent-actions",algorithms:["RS256"]});
        if(claims.payload.requestDigest!==requestDigest(action)||claims.payload.sub!=="agents-worker")throw Error("Action signature mismatch");
        res.setHeader("content-type","application/json");
        if(denied){res.statusCode=403;res.end(JSON.stringify({error:"Access withdrawn",code:"agent_scope_denied"}));return;}
        const context=action.context??{kind:"workspace",resourceId:action.tenantId},data={businessId:action.tenantId,name:"Fixture business"},revision=requestDigest(data);
        if(action.contextRevision&&action.contextRevision!==revision){res.statusCode=409;res.end(JSON.stringify({error:"Context changed",code:"agent_context_changed"}));return;}
        if(action.operation==="authorization.check"){res.end(JSON.stringify({authorized:true}));return;}
        if(action.operation==="workspace.read"||action.operation==="context.read"){res.end(JSON.stringify({context,revision,data,sources:[{id:"workspace:"+action.tenantId,title:"Fixture business",route:"/workspace/settings",revision}]}));return;}
        if(action.operation==="draft.prepare"){
          let review=[...reviews.values()].find(r=>r.taskId===action.taskId);
          if(!review){review={id:randomUUID(),taskId:action.taskId,conversationId:action.conversationId,featureId:action.featureId,kind:"content_draft",payloadDigest:requestDigest(action.input.draft),state:"proposed",draft:action.input.draft,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),result:null};reviews.set(review.id,review);}
          res.end(JSON.stringify({review}));return;
        }
        const review=reviews.get(action.input.reviewId);if(!review)throw Error("Missing exact review");
        if(action.operation==="draft.commit"){
          if(review.state!=="approved"&&review.state!=="saved"||action.input.payloadDigest!==review.payloadDigest)throw Error("Unapproved effect");
          if(!review.result){review.result={operationId:action.operationId,reviewId:review.id,payloadDigest:review.payloadDigest,recordId:randomUUID(),revision:"1",route:"/content/posts/fixture",state:"saved",actorId:action.actor.subject};review.state="saved";}
        }
        res.end(JSON.stringify({review,result:review.result}));
      }catch{res.statusCode=403;res.end(JSON.stringify({error:"Fixture action denied",code:"agent_action_denied"}));}
    });
    const growthOrigin=await listen(growth);
    vi.stubEnv("GROWTH_AGENTS_ISSUER",issuer);vi.stubEnv("GROWTH_IDENTITY_ISSUER",actor.issuer);
    vi.stubEnv("GROWTH_AGENTS_PUBLIC_KEY",await exportSPKI(keys.publicKey));vi.stubEnv("GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON",JSON.stringify({control:await exportSPKI(control.publicKey)}));
    vi.stubEnv("GROWTH_PRODUCT_API_URL",growthOrigin);vi.stubEnv("AGENTS_PRODUCT_ACTION_PRIVATE_KEY",await exportPKCS8(workerKeys.privateKey));vi.stubEnv("AGENTS_PRODUCT_ACTION_ISSUER","https://agents.fixture.test");
    vi.stubEnv("NODE_ENV","test");vi.stubEnv("AGENTS_OIDC_CLIENT_SECRET","isolated-growth-product-cursor-secret");
    vi.stubEnv("AGENTS_SCHEDULING_POLICY_JSON",JSON.stringify({maxConcurrentRoots:10,dailyTokenAllowance:1000000}));
    runtime=new GrowthProductRuntime(pool,new GrowthActionClient({origin:growthOrigin,issuer:"https://agents.fixture.test",keyId:"agents-v1",privateKey:await exportPKCS8(workerKeys.privateKey),environment:"test"}));
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:target.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-growth-product-cursor-secret"})});
    origin=await app.listen({port:0,host:"127.0.0.1"});
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
    worker=http2Server(createEndpointHandler({services:[createBusinessWorkflow(pool,{modelProvider:new ModelProviderStore(pool,keyVault),product:runtime,evidence:runtime.evidence,
      modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Model destination denied");await policy.beforeDispatch?.();return fetch(providerOrigin,init);}) as ModelFetch;network.markProgress=()=>{};return network;})}})]}));
    await new Promise<void>(resolve=>worker.listen(0,"0.0.0.0",resolve));
    docker("run","-d","--name",container,"--add-host=host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");
    ingress="http://"+docker("port",container,"8080/tcp");restAdmin="http://"+docker("port",container,"9070/tcp");
    await until(async()=>{try{return(await fetch(restAdmin+"/health")).ok;}catch{return false;}});
    expect((await fetch(restAdmin+"/deployments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:"http://host.docker.internal:"+(worker.address() as {port:number}).port})})).ok).toBe(true);
  },90000);
  afterAll(async()=>{
    try{docker("rm","-f",container);}catch{}
    await app?.close();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));
    for(const server of [growth,provider])if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}vi.unstubAllEnvs();
  },30000);
  async function finished(taskId:string,state?:string){
    return until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return (state?task.state===state:terminalTaskStates.has(task.state))?task:false;});
  }
  it("boots managed features and runs persistent scoped chat with zero standalone accounts",async()=>{
    expect((await ok(command("features.list",{}))).features.every((f:any)=>!f.ready)).toBe(true);
    await provisionGrowthModel(pool,keyVault,{tenantId,providerId:"openrouter",modelId:"fixture/growth",apiKey:"fixture-only-key"},{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/growth",name:"Fixture Growth model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect((await ok(command("features.list",{}))).features.every((f:any)=>f.ready)).toBe(true);
    const created=command("conversations.create",{featureId:"assistant"}),conversation=(await ok(created)).conversation;
    expect((await ok(created)).conversation.id).toBe(conversation.id);
    const turn=command("turns.submit",{conversationId:conversation.id,text:"Hello"}),first=await ok(turn),replay=await ok(turn);
    expect(replay.task.id).toBe(first.task.id);expect(replay.replayed).toBe(true);
    const task=await finished(first.task.id);expect(task.state,task.error_code).toBe("completed");
    const history=await ok(command("conversations.get",{conversationId:conversation.id}));expect(history.messages.at(-1).text).toContain("Fixture business");
    const follow=await ok(command("turns.submit",{conversationId:conversation.id,text:"Follow up"}));expect((await finished(follow.task.id)).state).toBe("completed");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships")).rows[0].n).toBe(0);
    const foreign=await send(command("conversations.get",{conversationId:conversation.id},{actor:{...actor,subject:randomUUID()}}));expect(foreign.status).toBe(404);
  },40000);
  it("waits durably for the one Growth decision and confirms a single draft receipt",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"content"}))).conversation;
    const task=(await ok(command("turns.submit",{conversationId:conversation.id,text:"Save a draft"}))).task;
    await finished(task.id,"waiting_review");
    const review=[...reviews.values()].find(r=>r.taskId===task.id)!;expect(review.state).toBe("proposed");expect(review.result).toBeNull();
    review.state="approved";
    await ok(command("reviews.decide",{taskId:task.id,reviewId:review.id,payloadDigest:review.payloadDigest,decision:"approve"}));
    const result=await finished(task.id);expect(result.state,result.error_code).toBe("completed");
    expect(review.state).toBe("saved");expect((await ok(command("tasks.get",{taskId:task.id}))).task.results).toHaveLength(1);
    expect([...reviews.values()].filter(r=>r.taskId===task.id&&r.result)).toHaveLength(1);
  },40000);
  it("uses new configuration only for a new turn while authenticated retries stay pinned",async()=>{
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation,turn=command("turns.submit",{conversationId:conversation.id,text:"Pinned turn"});
    const first=(await ok(turn)).task,old=(await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[first.id])).rows[0].version_id;
    await ok(command("features.configure",{featureId:"assistant",configuration:{...growthFeatureConfiguration("assistant"),instructions:"Updated Growth instructions. Read the authorized context."}}),true);
    expect((await ok(turn)).task.id).toBe(first.id);
    const next=(await ok(command("turns.submit",{conversationId:conversation.id,text:"New settings"}))).task;
    expect((await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[next.id])).rows[0].version_id).not.toBe(old);
  });
  it("rejects malformed signatures and revokes current reads without leaking cached text",async()=>{
    const cmd=command("features.list",{}),response=await fetch(origin+"/internal/v1/products/growth/commands",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer bad.token.value"},body:JSON.stringify(cmd)});
    expect(response.status).toBe(401);
    const conversation=(await ok(command("conversations.create",{featureId:"assistant"}))).conversation;
    denied=true;
    expect((await send(command("conversations.get",{conversationId:conversation.id}))).status).toBe(403);
    denied=false;
  });
});
