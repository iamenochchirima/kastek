import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createPortServer } from "node:net";
import { createServer, type ServerHttp2Session } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { beginOperation, finishOperation, loadExecution, settleTask } from "../src/execution/lifecycle/execution";
import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { EvidenceStore } from "../src/execution/context/evidence";
import { searchHistory, readHistory, toolReceiptPreview } from "../src/execution/context/journal";
import { adoptCompactionCheckpoint, loadContinuityCheckpoint, prepareCompactionJob, readCompactionJobOutcome, retireQueuedBackgroundCompaction } from "../src/execution/lifecycle/checkpoints";
import { createContextCompactionWorkflow, CONTEXT_COMPACTION_WORKFLOW } from "../src/execution/context/compaction-workflow";
import { instructionHead } from "../src/execution/context/instruction-state";
import { prepareCompaction, type ContextGroup } from "../src/execution/context/context";
import { compactionForecast } from "../src/execution/context/compaction-progress";
import { requestDigest as modelRequestDigest, type ModelRequest } from "../src/execution/business/model";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../src/contracts/execution";
import type { ModelFetch } from "../src/infrastructure/model-network";
import { publishFixtureSource } from "./knowledge-fixture";
import { invokeTaskModel } from "../src/execution/models/runtime";
import type { BoundModelDispatchInput } from "../src/execution/models/dispatch";

const url=process.env.AGENTS_TEST_DATABASE_URL;
const binary=process.env.AGENTS_TEST_RESTATE_BINARY;
(url?describe:describe.skip)("retained context journal and model response fencing",()=>{
  const database=`agents_context_journal_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool,store:PlatformStore;
  let native:ChildProcess|undefined,directory:string|undefined,ingressUrl:string,adminUrl:string;
  let worker:ReturnType<typeof createServer>|undefined,nativeOutput="";
  const sessions=new Set<ServerHttp2Session>();
  let compactionProvider:((body:any)=>Promise<string>)|undefined;
  async function eventually<T>(check:()=>Promise<T|false>,timeout=20000):Promise<T>{
    const end=Date.now()+timeout;
    while(Date.now()<end){const value=await check();if(value!==false)return value;await new Promise(resolve=>setTimeout(resolve,30));}
    throw Error(`Native compaction timed out: ${nativeOutput.slice(-3000)}`);
  }
  async function freePort(){const server=createPortServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
    await setupPlatformSchema(pool);store=new PlatformStore(pool);
    if(binary){
      expect(execFileSync(binary,["--version"],{encoding:"utf8"})).toContain("1.7.13");
      directory=await mkdtemp(join(tmpdir(),"kasitek-context-compaction-"));
      const ingress=await freePort(),administration=await freePort(),internal=await freePort();
      ingressUrl=`http://127.0.0.1:${ingress}`;adminUrl=`http://127.0.0.1:${administration}`;
      const config=join(directory,"restate.toml"),template=await readFile(join(__dirname,"scheduling-restate.toml"),"utf8");
      await writeFile(config,`${template}\n[ingress]\nbind-address="127.0.0.1:${ingress}"\n[admin]\nbind-address="127.0.0.1:${administration}"\n`);
      native=spawn(binary,["--config-file",config,"--base-dir",join(directory,"data"),"--bind-address",`127.0.0.1:${internal}`,"--advertised-host","127.0.0.1","--node-name","context-compaction","--no-logo"],{stdio:["ignore","pipe","pipe"]});
      native.stdout?.on("data",chunk=>{nativeOutput+=chunk.toString();});native.stderr?.on("data",chunk=>{nativeOutput+=chunk.toString();});
      await eventually(async()=>{try{return(await fetch(`${adminUrl}/health`)).ok;}catch{return false;}});
      const workflow=createContextCompactionWorkflow(pool,{evidence:new EvidenceStore(pool),modelProvider:fixtureModelProviders(pool),
        modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{
          const network=(async(url,request)=>{
            if(!policy.authorizeUrl(new URL(String(url))))throw Error("Fixture destination denied");
            await policy.beforeDispatch?.();const body=JSON.parse(String(request?.body));
            const content=await compactionProvider!(body);
            return new Response(`data: ${JSON.stringify({id:"frozen-prefix-fixture",model:body.model,choices:[{index:0,delta:{role:"assistant",content},finish_reason:"stop"}],usage:{prompt_tokens:41,completion_tokens:9}})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
          }) as ModelFetch;network.markProgress=()=>{};return network;
        })}});
      worker=createServer(createEndpointHandler({services:[workflow]}));
      worker.on("session",session=>{sessions.add(session);session.once("close",()=>sessions.delete(session));});
      await new Promise<void>(resolve=>worker!.listen(0,"127.0.0.1",resolve));
      const port=(worker.address() as {port:number}).port;
      const registration=await fetch(`${adminUrl}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://127.0.0.1:${port}`,force:false})});
      expect(registration.ok,await registration.text()).toBe(true);
    }
  },60000);
  afterAll(async()=>{
    for(const session of sessions)session.destroy();if(worker)await new Promise<void>(resolve=>worker!.close(()=>resolve()));
    if(native&&native.exitCode===null){native.kill("SIGTERM");await new Promise<void>(resolve=>native!.once("exit",()=>resolve()));}
    if(directory)await rm(directory,{recursive:true,force:true});
    await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}
  });
  async function fixture(input="Plan the launch",withSource=false){
    const account=await store.ensureAccount({issuer:"https://context.fixture",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const org=await store.createOrganization(account.id,"Journal fixture"),scope={accountId:account.id,organizationId:org.id};
    await connectFixtureModel(pool,account.id,org.id);
    const configuration=defaultBusinessConfiguration();
    const source=withSource?await publishFixtureSource(pool,{...scope,title:"Launch fact",content:"The confirmed launch is Tuesday.",visibility:"private"}):undefined;
    if(source){configuration.sourceRevisionIds=[source.id];configuration.tools=["knowledge.read"];}
    const agent=await store.createAgent({...scope,name:"Assistant",configuration});
    const version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
    const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read"],sourceRevisionIds:configuration.sourceRevisionIds,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),rootTokenLimit:null,expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});
    await store.createGrant({accountId:account.id,grant});
    const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input});
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[task.id]);
    return {task,account,scope,authority,grant,version,source};
  }
  async function next(f:Awaited<ReturnType<typeof fixture>>,input:string){const {task}=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input});await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[task.id]);return task;}
  async function tool(taskId:string,name:string){const id=`tool:${randomUUID()}`;await beginOperation(pool,taskId,{id,kind:"tool",name,request:{},reservedTokens:0,reservedMs:30000,retrySafe:true});return id;}
  async function background(f:Awaited<ReturnType<typeof fixture>>,suffix="one"){
    const execution=await loadExecution(pool,f.task.id),route=execution.models.compaction,policy=route.policy;
    const groups:ContextGroup[]=[{id:"frozen-prefix",messages:[{role:"user",content:"Original launch requirement: use Wheelhouse. ".repeat(45)}]},
      {id:"recent-tail",messages:[{role:"user",content:"Keep this recent correction in the foreground."}]}];
    const plan=prepareCompaction(groups,{retainRecent:1,model:route.binding.modelId,modelPolicy:{modelId:route.binding.modelId,revision:policy.digest,
      counterRevision:"serialized-utf8-estimate-v1",maxDurationSeconds:policy.maxCallDurationMs/1000,contextWindowTokens:policy.contextTokens,
      maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens,safetyTokens:policy.safetyTokens,maxMessages:policy.maxMessages,
      maxTools:policy.maxTools,maxRequestBytes:policy.maxRequestBytes,estimateRequestTokens:request=>Buffer.byteLength(JSON.stringify(request))}});
    const request:ModelRequest={messages:plan.messages,model:route.binding.modelId,maxDurationSeconds:policy.maxCallDurationMs/1000,
      maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens};
    const snapshotId=`context:background:${f.task.id}:${suffix}`,id=`compact:background:${f.task.id}:${suffix}`;
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff)
      VALUES($1,$2,-1,$3,$4,0)`,[snapshotId,f.task.id,modelRequestDigest(request),{messages:request.messages,estimatedTokens:plan.estimatedTokens,
      instructionHead:await instructionHead(pool,f.task.id),historyGroupIds:[]}]);
    const evidence=new EvidenceStore(pool);await evidence.supplyContext(f.task.id,snapshotId,[]);
    const input={id,taskId:f.task.id,mode:"background" as const,snapshotId,groups:groups.filter(group=>plan.compactedGroupIds.includes(group.id)),
      inputDigest:plan.inputDigest,historyIds:[],manifest:await evidence.taskManifest(f.task.id)};
    await prepareCompactionJob(pool,input);
    await pool.query("UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=$1",[f.task.id]);
    let invocationId:string;
    const send=async()=>{const response=await fetch(`${ingressUrl}/restate/send/${CONTEXT_COMPACTION_WORKFLOW}/${encodeURIComponent(id)}/run`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobId:id,taskId:f.task.id})});
      const result=await response.json() as {invocationId:string};expect(response.ok,JSON.stringify(result)).toBe(true);invocationId=result.invocationId;};
    const settled=async()=>{
      await eventually(async()=>{const response=await fetch(`${ingressUrl}/restate/output/${invocationId}`);await response.body?.cancel();return response.status===200;});
      return readCompactionJobOutcome(pool,id,f.task.id);
    };
    return {id,snapshotId,groups,input,send,settled};
  }

  it("runs one background compaction at the 85% threshold and retains the recent 15k window", async () => {
    const f=await fixture("Compact the long launch conversation"),execution=await loadExecution(pool,f.task.id),route=execution.models.compaction,policy=route.policy;
    const modelPolicy={modelId:route.binding.modelId,revision:policy.digest,counterRevision:"serialized-utf8-estimate-v1",
      maxDurationSeconds:policy.maxCallDurationMs/1000,contextWindowTokens:policy.contextTokens,maxInputTokens:policy.maxInputTokens,
      maxOutputTokens:policy.maxOutputTokens,safetyTokens:policy.safetyTokens,maxMessages:policy.maxMessages,maxTools:policy.maxTools,
      maxRequestBytes:policy.maxRequestBytes,estimateRequestTokens:(request:ModelRequest)=>Buffer.byteLength(JSON.stringify(request))};
    const groups:ContextGroup[]=Array.from({length:20},(_,index)=>({id:`old-${index}`,
      messages:[{role:"user" as const,content:`${index}:`+"x".repeat(20_000)}]}));
    groups.push({id:"recent-window",messages:[{role:"user",content:"Keep this recent correction. ".repeat(700)}]});
    const current=Buffer.byteLength(JSON.stringify(groups.map(group=>group.messages)));
    expect(compactionForecast({maxInputTokens:policy.maxInputTokens,compactAtTokens:policy.compactAtTokens,safetyTokens:policy.safetyTokens},current).requested).toBe(true);
    const plan=prepareCompaction(groups,{model:route.binding.modelId,modelPolicy,retainRecentTokens:15_000,
      maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens});
    expect(plan.recentGroups.map(group=>group.id)).toEqual(["recent-window"]);
    expect(plan.compactedGroupIds).not.toContain("recent-window");
    expect(plan.compactedGroupIds.length).toBeGreaterThan(0);
    const request:ModelRequest={messages:plan.messages,model:route.binding.modelId,maxDurationSeconds:policy.maxCallDurationMs/1000,
      maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens};
    const snapshotId=`context:background:${f.task.id}:threshold`,id=`compact:background:${f.task.id}:threshold`;
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff)
      VALUES($1,$2,-1,$3,$4,0)`,[snapshotId,f.task.id,modelRequestDigest(request),{messages:request.messages,estimatedTokens:plan.estimatedTokens,historyGroupIds:[]}]);
    const evidence=new EvidenceStore(pool);await evidence.supplyContext(f.task.id,snapshotId,[]);
    await prepareCompactionJob(pool,{id,taskId:f.task.id,mode:"background",snapshotId,
      groups:groups.filter(group=>plan.compactedGroupIds.includes(group.id)),inputDigest:plan.inputDigest,historyIds:[],manifest:await evidence.taskManifest(f.task.id)});
    let calls=0;compactionProvider=async()=>{calls++;return "Earlier launch context summarized; the recent correction is retained verbatim.";};
    const response=await fetch(`${ingressUrl}/restate/send/${CONTEXT_COMPACTION_WORKFLOW}/${encodeURIComponent(id)}/run`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobId:id,taskId:f.task.id})});
    const sent=await response.json() as {invocationId:string};expect(response.ok,JSON.stringify(sent)).toBe(true);
    await eventually(async()=>{const output=await fetch(`${ingressUrl}/restate/output/${sent.invocationId}`);await output.body?.cancel();return output.status===200;});
    const outcome=await readCompactionJobOutcome(pool,id,f.task.id);
    expect(outcome.state).toBe("adopted");
    expect(calls).toBe(1);
    expect(outcome.compactedGroupIds).not.toContain("recent-window");
    expect(outcome.checkpoint?.summary.content).toContain("recent correction");
    const stored=(await pool.query("SELECT source_groups FROM agents_platform.context_compaction_jobs WHERE id=$1",[id])).rows[0].source_groups as ContextGroup[];
    expect(stored.map(group=>group.id)).not.toContain("recent-window");
  },30000);

  it("recovers an exact first-turn detail beyond 1,000 generated turns and pages complete Unicode records",async()=>{
    const f=await fixture("The customer code is ORCHID-419. "+"😀source ".repeat(650));
    await settleTask(pool,f.task.id,{state:"completed",output:"Customer code recorded in this conversation."});
    // Generated retained records exercise custody and pagination without 1,000 live model calls.
    await pool.query(`WITH source AS(SELECT to_jsonb(t) AS value FROM agents_platform.tasks t WHERE id=$1),
      generated AS(SELECT jsonb_populate_record(NULL::agents_platform.tasks,value||jsonb_build_object(
        'id',gen_random_uuid(),'root_task_id',NULL,'work_id',NULL,'request_key',gen_random_uuid()::text,
        'turn_sequence',n,'input','Retained fixture turn '||n,'output','Recorded fixture result '||n,
        'runtime_invocation_id',NULL,'prior_task_id',NULL)) AS task FROM source CROSS JOIN generate_series(2,1001)n)
      INSERT INTO agents_platform.tasks SELECT (task).* FROM generated`,[f.task.id]);
    await pool.query(`INSERT INTO agents_platform.task_model_routes(task_id,organization_id,routes,snapshot_digest)
      SELECT t.id,t.organization_id,r.routes,r.snapshot_digest FROM agents_platform.tasks t
      JOIN agents_platform.task_model_routes r ON r.task_id=$1 WHERE t.conversation_id=$2 AND t.id<>$1`,[f.task.id,f.task.conversation_id]);
    await pool.query("UPDATE agents_platform.conversations SET next_sequence=1002 WHERE id=$1",[f.task.conversation_id]);
    const current=await next(f,"What was that customer code?"),evidence=new EvidenceStore(pool);
    const found=await searchHistory(pool,current.id,{query:"ORCHID-419"},evidence,await tool(current.id,"history.search"));
    expect(found.results.map(row=>row.taskId)).toEqual([f.task.id]);
    let offset=0,recovered="";
    do{const page=await readHistory(pool,current.id,{taskId:f.task.id,offset},evidence,await tool(current.id,"history.read"));
      expect(page.content).not.toContain("�");recovered+=page.content;offset=page.nextOffset??-1;
    }while(offset>=0);
    expect(JSON.parse(recovered)[0].content).toBe(f.task.input);
    const foreign=await fixture("Same ORCHID-419 phrase belongs to a different person");
    await expect(readHistory(pool,foreign.task.id,{taskId:f.task.id},evidence,await tool(foreign.task.id,"history.read"))).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
    const receiptId=await tool(current.id,"records.search"),receipt={zDecisive:"RECOVER-PAST-PREVIEW",notes:"😀receipt ".repeat(1200)};
    const preview=toolReceiptPreview(receiptId,"records.search",{...receipt,optional:undefined},JSON.stringify(receipt));
    await finishOperation(pool,current.id,receiptId,"completed",receipt,null,0);
    const receipts=await searchHistory(pool,current.id,{part:"operations",query:"RECOVER-PAST-PREVIEW"},evidence,await tool(current.id,"history.search"));
    expect(receipts.results.map(row=>row.operationId)).toEqual([receiptId]);
    expect(receipts.results[0]!.preview).not.toContain("RECOVER-PAST-PREVIEW");
    offset=0;recovered="";
    do{const page=await readHistory(pool,current.id,{operationId:receiptId,offset},evidence,await tool(current.id,"history.read"));
      expect(page.content).not.toContain("�");recovered+=page.content;offset=page.nextOffset??-1;
      expect(page.digest).toBe(preview.digest);expect(page.totalBytes).toBe(preview.totalBytes);
    }while(offset>=0);
    expect(JSON.parse(recovered).output).toEqual(receipt);
    await expect(readHistory(pool,foreign.task.id,{operationId:receiptId},evidence,await tool(foreign.task.id,"history.read"))).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
    await expect(readHistory(pool,current.id,{operationId:`model:${current.id}:0`},evidence,await tool(current.id,"history.read"))).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
    const unsupplied=await fixture("Check the launch",true),sourceRead=await tool(unsupplied.task.id,"knowledge.read");
    const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[unsupplied.source!.id])).rows[0];
    const passage=await evidence.recordChunk(unsupplied.task.id,sourceRead,chunk.id);
    await finishOperation(pool,unsupplied.task.id,sourceRead,"completed",{text:passage.text,citation:`[${passage.label}]`},null,0);
    expect((await evidence.taskManifest(unsupplied.task.id)).dependencies).toEqual([]);
    await unsupplied.source!.knowledge.setPolicy(unsupplied.scope,unsupplied.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
    await expect(readHistory(pool,unsupplied.task.id,{operationId:sourceRead},evidence,await tool(unsupplied.task.id,"history.read"))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    expect((await searchHistory(pool,unsupplied.task.id,{part:"operations",query:"Tuesday"},evidence,await tool(unsupplied.task.id,"history.search"))).results).toEqual([]);
    await settleTask(pool,unsupplied.task.id,{state:"cancelled"});
    const afterStop=await next(unsupplied,"Recover the old public receipts");
    await expect(readHistory(pool,afterStop.id,{taskId:unsupplied.task.id,part:"operations"},evidence,await tool(afterStop.id,"history.read"))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  },120000);

  it("adopts one prefix with compare-and-swap, preserves appended turns, and restores the same checkpoint",async()=>{
    const f=await fixture("Original requirement ".repeat(100));await settleTask(pool,f.task.id,{state:"completed",output:"Original retained result"});
    const current=await next(f,"Continue the plan"),groups=[{id:f.task.id,messages:[{role:"user" as const,content:f.task.input},{role:"assistant" as const,content:"Original retained result"}]}];
    const one={id:`compact:${current.id}:one`,taskId:current.id,groups,inputDigest:requestDigest(groups),historyIds:[f.task.id]};
    await prepareCompactionJob(pool,one);await prepareCompactionJob(pool,{...one,id:`compact:${current.id}:two`});
    let accepted=await adoptCompactionCheckpoint(pool,{jobId:`compact:${current.id}:two`,taskId:current.id,summary:"Original requirement remains applicable. Exact original is recoverable.",finishReason:"stop"});
    expect(accepted?.revision).toBe(1);
    expect(await adoptCompactionCheckpoint(pool,{jobId:one.id,taskId:current.id,summary:"Stale earlier candidate",finishReason:"stop"})).toBeUndefined();
    expect((await pool.query("SELECT state FROM agents_platform.context_compaction_jobs WHERE id=$1",[one.id])).rows[0].state).toBe("superseded");
    for(let revision=2;revision<=3;revision++){
      const groups=[{id:`round:${revision}`,messages:[{role:"user" as const,content:"Retained work record ".repeat(100)}]}],id=`compact:${current.id}:revision${revision}`;
      await prepareCompactionJob(pool,{id,taskId:current.id,groups,inputDigest:requestDigest({groups,revision}),historyIds:[],previous:accepted});
      accepted=await adoptCompactionCheckpoint(pool,{jobId:id,taskId:current.id,summary:`Original requirement remains applicable. Current checkpoint ${revision}.`,finishReason:"stop",previousSummary:accepted!.summary.content});
    }
    expect(accepted?.revision).toBe(3);
    await settleTask(pool,current.id,{state:"completed",output:"Plan complete"});
    const tail=await next(f,"Correction: use the new customer name.");
    const restored=await loadContinuityCheckpoint(pool,tail.id,new EvidenceStore(pool));
    expect(restored).toEqual(accepted);
    expect(restored?.coveredHistoryIds).not.toContain(tail.id);
    expect((await pool.query("SELECT input FROM agents_platform.tasks WHERE id=$1",[tail.id])).rows[0].input).toContain("new customer name");
    await expect(pool.query("UPDATE agents_platform.context_continuity_checkpoints SET summary='changed' WHERE id=$1",[accepted!.id])).rejects.toMatchObject({code:"23514"});
  });

  it("rejects a nonreducing candidate while keeping the original records and usable checkpoint",async()=>{
    const f=await fixture(),groups=[{id:"round:one",messages:[{role:"user" as const,content:"Brief"}]}];
    await prepareCompactionJob(pool,{id:`compact:${f.task.id}:large`,taskId:f.task.id,groups,inputDigest:requestDigest(groups),historyIds:[]});
    expect(await adoptCompactionCheckpoint(pool,{jobId:`compact:${f.task.id}:large`,taskId:f.task.id,summary:"larger ".repeat(100),finishReason:"stop"})).toBeUndefined();
    expect((await pool.query("SELECT source_groups,state FROM agents_platform.context_compaction_jobs WHERE task_id=$1",[f.task.id])).rows[0]).toMatchObject({state:"rejected",source_groups:[{id:"round:one"}]});
  });

  it("keeps a background job with its original task and classifies interrupted terminal origins conservatively",async()=>{
    for(const dispatched of [false,true]){
      const f=await fixture(),original=await background(f);
      if(dispatched)await beginOperation(pool,f.task.id,{id:original.id,kind:"compaction",name:"context.compact",workload:"background",request:{},reservedTokens:100,reservedMs:30000});
      await settleTask(pool,f.task.id,{state:"incomplete",errorCode:"TEST_INTERRUPTED"});
      const current=await next(f,"Continue the original request"),replacement=await background({...f,task:current});
      expect(await readCompactionJobOutcome(pool,original.id,f.task.id)).toMatchObject({taskId:f.task.id,state:dispatched?"uncertain":"failed",code:"TASK_SETTLED"});
      expect(await readCompactionJobOutcome(pool,replacement.id,current.id)).toMatchObject({taskId:current.id,state:"pending"});
      expect((await pool.query("SELECT task_id FROM agents_platform.context_compaction_jobs WHERE id=$1",[original.id])).rows[0].task_id).toBe(f.task.id);
    }
  });

  it("declines optional background work atomically while a finite allowance can still finish the foreground",async()=>{
    const previous=process.env.AGENTS_MODEL_POLICY_JSON;
    try{
      for(const candidate of [{policy:{maxModelCalls:1},code:"MODEL_CALL_LIMIT"},{policy:{maxRootModelCalls:1},code:"ROOT_MODEL_CALL_LIMIT"},
        {policy:{maxRootTokens:14000},code:"ROOT_TOKEN_LIMIT"},{policy:{maxDurationMs:180000},code:"ROOT_DURATION_LIMIT"}]){
        process.env.AGENTS_MODEL_POLICY_JSON=JSON.stringify({...JSON.parse(previous??"{}"),maxInputTokens:8192,maxOutputTokens:4096,compactAtTokens:6144,
          maxModelCalls:null,maxRootModelCalls:null,maxRootTokens:null,maxDurationMs:null,...candidate.policy});
        const f=await fixture(),id=`background:${f.task.id}:optional`,primaryReserve={tokens:9000,activeMs:120000};
        await expect(beginOperation(pool,f.task.id,{id,kind:"compaction",name:"context.compact",workload:"background",request:{},
          reservedTokens:6000,reservedMs:120000,primaryReserve})).rejects.toMatchObject({code:candidate.code});
        expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1",[f.task.id])).rows[0].count).toBe(0);
        expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.capacity_requests WHERE task_id=$1",[f.task.id])).rows[0].count).toBe(0);
        const foreground=await beginOperation(pool,f.task.id,{id:`model:${f.task.id}:finish`,kind:"model",name:"model.generate",request:{},
          reservedTokens:primaryReserve.tokens,reservedMs:primaryReserve.activeMs});
        expect(foreground).toMatchObject({replayed:false,operation:{state:"started"}});
      }
    }finally{if(previous===undefined)delete process.env.AGENTS_MODEL_POLICY_JSON;else process.env.AGENTS_MODEL_POLICY_JSON=previous;}
  });

  it("carries a checkpoint's frozen source into the next model guard and quarantines withdrawal during inference",async()=>{
    const f=await fixture("Retain the confirmed launch date",true),evidence=new EvidenceStore(pool,f.source!.storage);
    const read=await tool(f.task.id,"knowledge.read"),chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0];
    const passage=await evidence.recordChunk(f.task.id,read,chunk.id);
    await finishOperation(pool,f.task.id,read,"completed",{},null,0);
    const frozenSnapshot=`context:compact:${f.task.id}:frozen`,jobId=`compact:${f.task.id}:frozen`;
    const groups=[{id:"frozen-source",messages:[{role:"user" as const,content:`${passage.text} [${passage.label}] `.repeat(30)}]}];
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff)
      VALUES($1,$2,-1,$3,$4,0)`,[frozenSnapshot,f.task.id,requestDigest(groups),{messages:groups[0].messages,historyGroupIds:[]}]);
    await evidence.supplyContext(f.task.id,frozenSnapshot,[passage.reference.id]);
    await prepareCompactionJob(pool,{id:jobId,taskId:f.task.id,snapshotId:frozenSnapshot,groups,inputDigest:requestDigest(groups),historyIds:[],manifest:await evidence.taskManifest(f.task.id)});
    const adopted=await adoptCompactionCheckpoint(pool,{jobId,taskId:f.task.id,summary:"The confirmed launch is Tuesday.",finishReason:"stop"});
    expect(adopted).toBeDefined();
    // A committed foreground checkpoint remains safe if a worker stopped before its summary node.
    await settleTask(pool,f.task.id,{state:"completed",output:"Launch date retained."});
    const current=await next(f,"What was the confirmed launch date?"),loaded=await loadContinuityCheckpoint(pool,current.id,evidence);
    expect(loaded).toEqual(adopted);
    expect(await loadContinuityCheckpoint(pool,current.id,evidence)).toEqual(loaded);
    expect((await evidence.taskManifest(current.id)).dependencies).toContainEqual(expect.objectContaining({kind:"source",revisionId:f.source!.id}));
    const contextId=`context:${current.id}:0`,operationId=`model:${current.id}:checkpoint`,messages=[{role:"user" as const,content:loaded!.summary.content}];
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,history_cutoff)
      VALUES($1,$2,0,$3,$4,$5,0)`,[contextId,current.id,requestDigest(messages),{messages,historyGroupIds:[],instructionHead:await instructionHead(pool,current.id)},JSON.stringify([{id:loaded!.id,revision:loaded!.revision,kind:"summary"}])]);
    await evidence.inheritHistory(current.id,contextId,[]);await evidence.supplyContext(current.id,contextId,[]);
    await beginOperation(pool,current.id,{id:operationId,kind:"model",name:"model.generate",request:{},reservedTokens:16000,reservedMs:30000});
    const onText=vi.fn(),response=await invokeTaskModel({pool,execution:await loadExecution(pool,current.id),providerStore:fixtureModelProviders(pool),
      operationId,role:"primary",contextSnapshotId:contextId,messages,maxRequestBytes:100000,onText},{dispatch:async request=>{
        await request.beforeDispatch?.();request.onText?.("WITHDRAWN SUMMARY RESPONSE");
        await f.source!.knowledge.setPolicy(f.scope,f.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
        return {message:{role:"assistant",content:"WITHDRAWN SUMMARY RESPONSE"},finishReason:"stop",usage:{observed:true,inputTokens:23,outputTokens:5},
          nativeState:{provider:request.accepted.binding.providerId,protocol:request.accepted.binding.protocol,model:request.accepted.binding.modelId,
            baseUrl:request.accepted.binding.endpoint,credentialRevision:String(request.accepted.binding.credentialRevision),assistant:{private:"WITHDRAWN SUMMARY RESPONSE"}}};
      }});
    expect(response).toMatchObject({contextDisposition:"quarantined",message:{content:null},usage:{inputTokens:23,outputTokens:5}});
    expect(onText).not.toHaveBeenCalled();
    const saved=(await pool.query("SELECT native_state,response_guard FROM agents_platform.private_model_continuations WHERE operation_id=$1",[operationId])).rows[0];
    expect(saved).toMatchObject({native_state:null,response_guard:{disposition:"quarantined"}});
    expect(JSON.stringify(saved)).not.toContain("WITHDRAWN SUMMARY RESPONSE");
  });

  it("quarantines text and opaque continuation revoked during inference while retaining observed usage",async()=>{
    const f=await fixture(),execution=await loadExecution(pool,f.task.id),id=`model:${f.task.id}:guard`;
    await beginOperation(pool,f.task.id,{id,kind:"model",name:"model.generate",request:{},reservedTokens:16000,reservedMs:30000});
    const onText=vi.fn();
    const response=await invokeTaskModel({pool,execution,providerStore:fixtureModelProviders(pool),operationId:id,role:"primary",messages:[{role:"user",content:"Read my data"}],maxRequestBytes:100000,onText},{
      dispatch:async(request:BoundModelDispatchInput)=>{
        await request.beforeDispatch?.();request.onText?.("PRIVATE DERIVED TEXT");
        await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.scope.organizationId,f.account.id]);
        return {message:{role:"assistant",content:"PRIVATE DERIVED TEXT"},finishReason:"stop",usage:{observed:true,inputTokens:20,outputTokens:7},nativeState:{provider:request.accepted.binding.providerId,protocol:request.accepted.binding.protocol,model:request.accepted.binding.modelId,baseUrl:request.accepted.binding.endpoint,credentialRevision:String(request.accepted.binding.credentialRevision),assistant:{private:"OPAQUE DERIVED STATE"}}};
      },
    });
    expect(response).toMatchObject({contextDisposition:"quarantined",message:{content:null},usage:{inputTokens:20,outputTokens:7}});
    expect(onText).not.toHaveBeenCalled();
    const saved=(await pool.query("SELECT state,native_state,response_guard FROM agents_platform.private_model_continuations WHERE operation_id=$1",[id])).rows[0];
    expect(saved).toMatchObject({state:"rejected",native_state:null,response_guard:{disposition:"quarantined",usage:{outputTokens:7}}});
    expect(JSON.stringify(saved)).not.toMatch(/PRIVATE DERIVED TEXT|OPAQUE DERIVED STATE/);
  });
  it("rebuilds preparation when a newer correction arrives before physical dispatch",async()=>{
    const f=await fixture(),execution=await loadExecution(pool,f.task.id),snapshotId=`context:${f.task.id}:0`,id=`model:${f.task.id}:stale`;
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff)
      VALUES($1,$2,0,$3,$4,0)`,[snapshotId,f.task.id,requestDigest({input:f.task.input}),{instructionHead:"0",messages:[{role:"user",content:f.task.input}],historyGroupIds:[]}]);
    await pool.query("INSERT INTO agents_platform.orchestration_instructions(task_id,request_key,instruction) VALUES($1,$2,'Correction: the business name is Wheelhouse')",[f.task.id,randomUUID()]);
    await beginOperation(pool,f.task.id,{id,kind:"model",name:"model.generate",request:{},reservedTokens:16000,reservedMs:30000});
    const dispatch=vi.fn();
    await expect(invokeTaskModel({pool,execution,providerStore:fixtureModelProviders(pool),operationId:id,role:"primary",contextSnapshotId:snapshotId,messages:[{role:"user",content:f.task.input}],maxRequestBytes:100000},{dispatch})).rejects.toMatchObject({code:"CONTEXT_PREPARATION_STALE",outcome:"rejected"});
    expect(dispatch).not.toHaveBeenCalled();
    expect((await pool.query("SELECT instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1",[f.task.id])).rows[0].instruction).toContain("Wheelhouse");
  });

  it.skipIf(!binary)("retires queued optional compaction for foreground recovery without admitting a late physical attempt",async()=>{
    const previous=process.env.AGENTS_SCHEDULING_POLICY_JSON;
    process.env.AGENTS_SCHEDULING_POLICY_JSON=JSON.stringify({...JSON.parse(previous??"{}"),modelActive:1});
    try{
      const f=await fixture(),job=await background(f),blocker=`model:${f.task.id}:foreground`;
      const active=await beginOperation(pool,f.task.id,{id:blocker,kind:"model",name:"model.generate",request:{},reservedTokens:100,reservedMs:30000});
      expect(active.waiting).not.toBe(true);
      let calls=0;compactionProvider=async()=>{calls++;return "This optional request must never dispatch.";};
      await job.send();
      await eventually(async()=>{const row=(await pool.query("SELECT state FROM agents_platform.capacity_requests WHERE id=$1",[job.id])).rows[0];return row?.state==="waiting";});
      expect(await retireQueuedBackgroundCompaction(pool,f.task.id,job.id)).toBe(true);
      expect(await retireQueuedBackgroundCompaction(pool,f.task.id,job.id)).toBe(false);
      await expect(beginOperation(pool,f.task.id,{id:job.id,kind:"compaction",name:"context.compact",workload:"background",request:{},reservedTokens:100,reservedMs:30000}))
        .rejects.toMatchObject({code:"COMPACTION_FOREGROUND_REQUIRED"});
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:{[SHARED_HARNESS_RELEASE]:{ingressUrl,adminUrl,workflowName:SHARED_WORKFLOW_NAME}}});
      expect(await job.settled()).toMatchObject({state:"failed",code:"COMPACTION_FOREGROUND_REQUIRED"});
      expect(calls).toBe(0);
      expect((await pool.query("SELECT state FROM agents_platform.capacity_requests WHERE id=$1",[job.id])).rows[0]).toEqual({state:"released"});
      expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE id=$1",[job.id])).rows[0].count).toBe(0);
      const retained=(await pool.query("SELECT source_groups FROM agents_platform.context_compaction_jobs WHERE id=$1",[job.id])).rows[0].source_groups;
      expect(retained.map(({id,messages}:ContextGroup)=>({id,messages}))).toEqual(job.input.groups.map(({id,messages})=>({id,messages})));
      await finishOperation(pool,f.task.id,blocker,"completed",{content:"Foreground continued"},null,3,active.waiting?undefined:active.operation.attempt_id);
      const foreground=`compact:${f.task.id}:foreground-recovery`;
      await prepareCompactionJob(pool,{...job.input,id:foreground,mode:"foreground",snapshotId:undefined});
      const admitted=await beginOperation(pool,f.task.id,{id:foreground,kind:"compaction",name:"context.compact",request:{},reservedTokens:100,reservedMs:30000});
      expect(admitted).toMatchObject({replayed:false,operation:{state:"started"}});
      await finishOperation(pool,f.task.id,foreground,"completed",{content:"Wheelhouse remains the confirmed business."},null,5,admitted.waiting?undefined:admitted.operation.attempt_id);
      expect(await adoptCompactionCheckpoint(pool,{jobId:foreground,taskId:f.task.id,summary:"Wheelhouse remains the confirmed business.",finishReason:"stop"})).toMatchObject({revision:1});
      expect((await pool.query("SELECT tokens_used,tokens_reserved,model_calls FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toEqual({tokens_used:8,tokens_reserved:0,model_calls:2});
    }finally{if(previous===undefined)delete process.env.AGENTS_SCHEDULING_POLICY_JSON;else process.env.AGENTS_SCHEDULING_POLICY_JSON=previous;}
  },30000);

  it.skipIf(!binary)("native background compaction resumes through shared capacity and adopts only its frozen prefix once",async()=>{
    const previous=process.env.AGENTS_SCHEDULING_POLICY_JSON;
    process.env.AGENTS_SCHEDULING_POLICY_JSON=JSON.stringify({...JSON.parse(previous??"{}"),modelActive:1});
    try{
      const f=await fixture(),job=await background(f),blocker=`model:${f.task.id}:foreground`;
      await beginOperation(pool,f.task.id,{id:blocker,kind:"model",name:"model.generate",request:{},reservedTokens:100,reservedMs:30000});
      let calls=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
      const bodies:any[]=[];compactionProvider=async body=>{calls++;bodies.push(body);await barrier;return "Wheelhouse is the confirmed business. Original records remain available.";};
      await job.send();
      await eventually(async()=>{const row=(await pool.query("SELECT state,workload FROM agents_platform.capacity_requests WHERE id=$1",[job.id])).rows[0];return row?.state==="waiting"?row:false;});
      expect(calls).toBe(0);
      expect(await prepareCompactionJob(pool,{...job.input,id:`${job.id}:duplicate`})).toMatchObject({id:job.id});
      const claimed=(await pool.query("SELECT attempt_id FROM agents_platform.operations WHERE id=$1",[blocker])).rows[0];
      await finishOperation(pool,f.task.id,blocker,"completed",{content:"Foreground continued"},null,3,claimed.attempt_id);
      await eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:{[SHARED_HARNESS_RELEASE]:{ingressUrl,adminUrl,workflowName:SHARED_WORKFLOW_NAME}}});return calls===1;});
      expect(await retireQueuedBackgroundCompaction(pool,f.task.id,job.id)).toBe(false);
      expect((await pool.query("SELECT state FROM agents_platform.context_compaction_jobs WHERE id=$1",[job.id])).rows[0].state).toBe("prepared");
      await pool.query("INSERT INTO agents_platform.orchestration_instructions(task_id,request_key,instruction) VALUES($1,$2,'Appended correction: retain NEW_TAIL_FACT')",[f.task.id,randomUUID()]);
      expect(JSON.stringify(bodies)).not.toContain("NEW_TAIL_FACT");
      expect(JSON.stringify(bodies)).not.toContain("Keep this recent correction");
      release();const outcome=await job.settled();
      expect(outcome).toMatchObject({state:"adopted",compactedGroupIds:["frozen-prefix"],checkpoint:{revision:1}});
      expect((await pool.query("SELECT state,workload FROM agents_platform.capacity_requests WHERE id=$1",[job.id])).rows[0]).toEqual({state:"released",workload:"background"});
      expect((await pool.query("SELECT tokens_used,tokens_reserved FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toEqual({tokens_used:53,tokens_reserved:0});
      expect((await pool.query("SELECT source_groups FROM agents_platform.context_compaction_jobs WHERE id=$1",[job.id])).rows[0].source_groups[0].messages).toEqual(job.groups[0].messages);
      expect((await pool.query("SELECT instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1",[f.task.id])).rows[0].instruction).toContain("NEW_TAIL_FACT");
      await job.send();await job.settled();expect(calls).toBe(1);
    }finally{if(previous===undefined)delete process.env.AGENTS_SCHEDULING_POLICY_JSON;else process.env.AGENTS_SCHEDULING_POLICY_JSON=previous;}
  },30000);

  it.skipIf(!binary)("native background candidate cannot replace a checkpoint adopted while it was running",async()=>{
    const f=await fixture(),job=await background(f);let calls=0,release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});compactionProvider=async()=>{calls++;await barrier;return "Earlier background candidate.";};
    await job.send();await eventually(async()=>calls===1);
    const foreground=`compact:${f.task.id}:foreground`;
    await prepareCompactionJob(pool,{...job.input,id:foreground,mode:"foreground",snapshotId:undefined});
    const current=await adoptCompactionCheckpoint(pool,{jobId:foreground,taskId:f.task.id,summary:"Current foreground checkpoint.",finishReason:"stop"});
    expect(current?.revision).toBe(1);release();
    expect(await job.settled()).toMatchObject({state:"superseded"});
    expect(await loadContinuityCheckpoint(pool,f.task.id,new EvidenceStore(pool))).toEqual(current);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.context_continuity_checkpoints WHERE conversation_id=$1",[f.task.conversation_id])).rows[0].count).toBe(1);
  },30000);

  it.skipIf(!binary)("native background response revoked during inference is quarantined with its real usage",async()=>{
    const f=await fixture(),job=await background(f);let calls=0,release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});compactionProvider=async()=>{calls++;await barrier;return "PRIVATE SUMMARY MUST NOT BE ADOPTED";};
    await job.send();await eventually(async()=>calls===1);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.scope.organizationId,f.account.id]);
    release();expect(await job.settled()).toMatchObject({state:"rejected"});
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.context_continuity_checkpoints WHERE conversation_id=$1",[f.task.conversation_id])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT tokens_used,tokens_reserved FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toEqual({tokens_used:50,tokens_reserved:0});
    const privateState=(await pool.query("SELECT state,native_state,response_guard FROM agents_platform.private_model_continuations WHERE operation_id=$1",[job.id])).rows[0];
    expect(privateState).toMatchObject({state:"rejected",native_state:null,response_guard:{disposition:"quarantined",usage:{outputTokens:9}}});
    expect(JSON.stringify(privateState)).not.toContain("PRIVATE SUMMARY");
  },30000);
});
