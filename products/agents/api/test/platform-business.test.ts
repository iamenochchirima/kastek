import {publishFixtureSource} from "./knowledge-fixture";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusinessWorkflow, type BusinessOptions } from "../src/execution/business/business";
import { defaultBusinessConfiguration, terminalTaskStates, type AgentConfiguration, type AdmissionAuthority, type ExecutionGrant } from "../src/contracts/contracts";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { beginOperation, finishOperation, settleTask, requestTreeCancellation, reconcilePendingRoots, WORKFLOW_NAME } from "../src/execution/lifecycle/execution";
import { admitChildren, readChildResults } from "../src/execution/delegation/delegation";
import {ActionService} from "../src/workflows/report-delivery/actions";
import {ConnectionStore} from "../src/product/connections/connections";
import {ConnectionVault} from "../src/infrastructure/vault";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {createReportReceiver,initializeReportReceiver} from "../src/acceptance/report-receiver";
import { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { KnowledgeRuntime } from "../src/capabilities/knowledge/knowledge-runtime";
import { EvidenceStore } from "../src/execution/context/evidence";
import { textDigest } from "../src/contracts/source-contracts";
import { MemoryStore } from "../src/execution/memory/memory";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { toolsFor } from "../src/capabilities/tools";
import { estimateRequestTokens, validateMessageGroups, requestDigest as modelRequestDigest, type ModelRequest } from "../src/execution/business/model";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("common harness with real PostgreSQL/Restate and fixture model", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, memory: MemoryStore;
  let receiver:ReturnType<typeof createReportReceiver>,actions:ActionService,connections:ConnectionStore,artifacts:TaskArtifactStore;
  const receiverKey=randomUUID(),objects=new Map<string,Uint8Array>();
  let afterAccept:((id:string)=>Promise<void>)|undefined;
  let inFlightActionCalls=0;
  let afterReviewRead:((review:Awaited<ReturnType<ActionService["getReview"]>>)=>Promise<void>)|undefined;
  let server: ReturnType<typeof createServer>;
  let workflow: ReturnType<typeof createBusinessWorkflow>;
  let businessOptions: BusinessOptions;
  let ingressUrl: string, adminUrl: string;
  let containerStarted = false;
  const sessions = new Set<ServerHttp2Session>();
  const databaseName = `agents_harness_test_${randomUUID().replaceAll("-", "")}`;
  const containerName = `agents-harness-test-${randomUUID()}`;
  const calls: ModelRequest[] = [];
  let provider: (body: any, request: RequestInit) => Promise<Response>;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  function reply(content = "Open at nine.", finish = "stop", toolCalls?: unknown[]) {
    return Response.json({ id: "fixture-provider", choices: [{ finish_reason: finish, message: {
      role: "assistant", content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}),
    } }], usage: { prompt_tokens: 52, completion_tokens: 4 } });
  }
  const tool = (name: string, args: object, id = "call1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  async function eventually<T>(check: () => Promise<T | false>, timeout = 20_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await check(); if (result !== false) return result; await new Promise(resolve => setTimeout(resolve, 75)); }
    throw new Error("Harness verification timed out");
  }
  async function listen(port = 0) {
    server = createServer(createEndpointHandler({ services: [workflow] }));
    server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve));
  }
  async function restart() {
    const port = (server.address() as { port: number }).port;
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await listen(port);
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool); memory = new MemoryStore(pool);
    await initializeReportReceiver(pool);
    receiver=createReportReceiver({pool,keys:[{apiKey:receiverKey,resource:"reports:controller"}],afterAccept:async id=>{await afterAccept?.(id);}});
    const address=await receiver.listen({host:"127.0.0.1",port:0});
    const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),targets=[{id:"reports",label:"Reports",url:address+"/deliveries",resource:"reports:controller"}];
    artifacts=new TaskArtifactStore(pool,{async put(key,value){objects.set(key,Buffer.from(value));},async get(key){const value=objects.get(key);if(!value)throw Error("Missing fixture object");return value;},async delete(key){objects.delete(key);}});
    connections=new ConnectionStore(pool,vault,targets);actions=new ActionService(pool,{vault,targets,artifacts});
    businessOptions = {evidence:new EvidenceStore(pool,artifacts.objects),knowledgeRuntime:new KnowledgeRuntime(pool,new EvidenceStore(pool,artifacts.objects)),actions:{prepare:(...args)=>actions.prepare(...args),getReview:async(...args)=>{const review=await actions.getReview(...args);await afterReviewRead?.(review);return review;},reconcile:(...args)=>actions.reconcile(...args),execute:async(...args)=>{inFlightActionCalls++;try{return await actions.execute(...args);}finally{inFlightActionCalls--;}}},selectReportArtifact:(...args)=>artifacts.prepareReport(...args), openRouterApiKey: "fixture", fetch: async (_url, request) => {
      const body = JSON.parse(String(request?.body)); calls.push(body); return provider(body, request!);
    } };
    workflow = createBusinessWorkflow(pool,businessOptions);
    await listen();
    const port = (server.address() as { port: number }).port;
    docker("run", "-d", "--name", containerName, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway",
      "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13");
    containerStarted = true;
    ingressUrl = `http://${docker("port", containerName, "8080/tcp")}`; adminUrl = `http://${docker("port", containerName, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } });
    const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: `http://host.docker.internal:${port}`, force: false }) });
    expect(registration.ok, await registration.text()).toBe(true);
  }, 60_000);
  afterAll(async () => {
    for (const session of sessions) session.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (containerStarted) docker("rm", "-f", containerName);
    await receiver?.close();
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  });
  async function fixture(changes: Partial<AgentConfiguration> = {}, rootTokenLimit = 32000, sourceContent = "Opening hours. Open at nine.") {
    provider = async () => reply(); calls.length = 0;
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/test", subject: randomUUID(), email: "fixture@example.com", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Harness fixture");
    const source = await publishFixtureSource(pool,{ accountId: account.id, organizationId: org.id, title: "Hours", content: sourceContent, visibility: "public" }, artifacts.objects);
    const config = { ...defaultBusinessConfiguration(), sourceRevisionIds: [source.id], ...changes };
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: version.id,
      operations: config.memory.enabled ? ["model.reply", "knowledge.read", "memory.read", "memory.propose"] : ["model.reply", "knowledge.read"],
      sourceRevisionIds: config.sourceRevisionIds, connectedToolBindingIds: config.connectedToolBindingIds, maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens,
      maxContextTokens: config.context.maxInputTokens, rootTokenLimit, expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    const request = { authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "What are the opening hours?" };
    const { task } = await store.admitTask(request);
    return { task, grant, request, account, org, agent, config, source,
      managed: { accountId: account.id, organizationId: org.id, agentId: agent.id },
      scoped: { organizationId: org.id, agentId: agent.id, principal: authority.principal } };
  }
  async function execute(taskId: string) {
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    return eventually(async () => { await dispatchTasksOnce(pool,{ingressUrl,adminUrl}); const row = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0]; return terminalTaskStates.has(row.state) ? row : false; });
  }
  function holdPreparedContext(taskId:string,compact=false){
    const evidence=businessOptions.evidence!,original=evidence.supplyContext.bind(evidence);let release!:()=>void,entered!:()=>void,held=false;
    const barrier=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
    evidence.supplyContext=async(...args)=>{await original(...args);if(!held&&args[0]===taskId&&args[1].startsWith("context:compact:")===compact){held=true;entered();await barrier;}};
    return{ready,release,restore(){release();evidence.supplyContext=original;}};
  }
  async function acceptedMemory(f: Awaited<ReturnType<typeof fixture>>, content: string, expiresAt?: string) {
    const candidate = await memory.proposeManaged(f.managed, { operationId: randomUUID(), kind: "semantic", content, expiresAt });
    return memory.mutate(f.managed, candidate.id, { operationId: randomUUID(), expectedRevision: candidate.revision, action: "accept" });
  }
  async function researchFixture(enableMemory=false) {
    const f=await fixture(); await settleTask(pool,f.task.id,{state:"cancelled"});
    const versions=[];
    for(const name of ["FIRST","SECOND"]) {
      const agent=await store.createAgent({accountId:f.account.id,organizationId:f.org.id,name,configuration:{...defaultBusinessConfiguration(),instructions:`SPECIALIST_${name}: Answer from the provided source.`,sourceRevisionIds:[f.source.id],tools:["knowledge.search","knowledge.read"]}});
      versions.push(await store.createVersion({accountId:f.account.id,organizationId:f.org.id,agentId:agent.id,expectedRevision:1}));
    }
    const config:AgentConfiguration={...defaultBusinessConfiguration(),instructions:"ROOT_RESEARCH: Delegate work to both approved specialists, then synthesize their confirmed evidence.",memory:{enabled:enableMemory},sourceRevisionIds:[f.source.id],tools:["agents.delegate"],
      capabilities:{...defaultBusinessConfiguration().capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:versions.map((version,index)=>({id:index===0?"first":"second",versionId:version.id,sourceRevisionIds:[f.source.id],connectedToolBindingIds:[],tools:["knowledge.search"],maxTokens:8000,maxActiveMs:240000}))}}};
    const agent=await store.createAgent({accountId:f.account.id,organizationId:f.org.id,name:"Research",configuration:config});
    const version=await store.createVersion({accountId:f.account.id,organizationId:f.org.id,agentId:agent.id,expectedRevision:1});
    const authority={...f.request.authority,resourceId:agent.id};
    const grant:ExecutionGrant={...f.grant,...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","delegation.execute",...(enableMemory?["memory.read" as const,"memory.propose" as const]:[])]};
    await store.createGrant({accountId:f.account.id,grant});
    const request={...f.request,authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Research our opening hours using both specialists"};
    const {task}=await store.admitTask(request);
    return {...f,task,request,grant,agent,version,config,versions,managed:{...f.managed,agentId:agent.id},scoped:{...f.scoped,agentId:agent.id}};
  }
  async function reportFixture(enableMemory=false) {
    const f=await fixture({memory:{enabled:enableMemory}});await settleTask(pool,f.task.id,{state:"cancelled"});
    const scope={accountId:f.account.id,organizationId:f.org.id};
    const connection=await connections.create(scope,{operationId:randomUUID(),name:"Reports",targetId:"reports",apiKey:receiverKey});
    const config:AgentConfiguration={...f.config,capabilities:{...f.config.capabilities,workflows:{enabled:true,profileId:"report-delivery-v1",connectionId:connection.id,reportArtifactName:"report.md",title:"Opening hours report"}}};
    const agent=await store.createAgent({...scope,name:"Report agent",configuration:config});
    const version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const authority={...f.request.authority,resourceId:agent.id};
    const grant:ExecutionGrant={...f.grant,...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","effect.deliver","artifact.read","artifact.write",...(enableMemory?["memory.read" as const,"memory.propose" as const]:[])]};
    await store.createGrant({...scope,grant});
    const request={...f.request,authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID()};const{task}=await store.admitTask(request);
    return{...f,task,grant,request,config,scope,connection,agent,managed:{...f.managed,agentId:agent.id},scoped:{...f.scoped,agentId:agent.id}};
  }
  async function waitForReview(taskId:string) {
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl});
    return eventually(async()=>{const task=(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(task.state!=="waiting_review")return false;const action=(await pool.query("SELECT id FROM agents_platform.actions WHERE task_id=$1",[taskId])).rows[0];return action?actions.getReview(taskId,action.id):false;});
  }
  async function finishWithControls(taskId:string) {
    return eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return terminalTaskStates.has(task.state)?task:false;});
  }
  async function groundedFixture() {
    const f=await fixture(); await settleTask(pool,f.task.id,{state:"cancelled"});
    const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing fixture object");return value;},async delete(key:string){objects.delete(key);}};
    const knowledge=new KnowledgeStore(pool,storage),evidence=new EvidenceStore(pool,storage),scope={accountId:f.account.id,organizationId:f.org.id};
    const text="An irrelevant introduction.\n".repeat(100)+"The decisive opening hour is 09:17. The tail includes Unicode 🧪.";
    const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Opening hours guide",contentType:"text/markdown",content:Buffer.from(text),parserRelease:"test-document-v1"});
    await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
    const start=text.indexOf("The decisive"),body=text.slice(start);
    await knowledge.publishExtraction(job.id,{text,acquiredAt:new Date().toISOString(),normalizerRelease:"test-normalizer-v1",chunks:[{id:randomUUID(),revisionId:job.revisionId,ordinal:0,start,end:text.length,page:3,section:null,text:body,digest:textDigest(body),tokens:30}]});
    await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
    const config={...defaultBusinessConfiguration(),instructions:"Answer only from supplied passages; cite their exact bracketed evidence labels.",sourceRevisionIds:[job.revisionId],tools:["knowledge.search" as const,"knowledge.read" as const]};
    const agent=await store.createAgent({...scope,name:"Grounded controller",configuration:config});
    const version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const authority={...f.request.authority,resourceId:agent.id},grant={...f.grant,...authority,id:randomUUID(),versionId:version.id,sourceRevisionIds:[job.revisionId],connectedToolBindingIds:[]};
    await store.createGrant({accountId:f.account.id,grant});
    const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"What is the decisive opening hour?"});
    businessOptions.evidence=evidence;businessOptions.knowledgeRuntime=new KnowledgeRuntime(pool,evidence);
    return{...f,task,job,knowledge,evidence,scope};
  }
  function resetGrounding(){businessOptions.evidence=new EvidenceStore(pool,artifacts.objects);businessOptions.knowledgeRuntime=new KnowledgeRuntime(pool,businessOptions.evidence);}
  it("uses indexed tail evidence in the same controller, with immutable tools, citations and budgeted retrieval",async()=>{
    const f=await groundedFixture();
    try {
      let label="";
      provider=async body=>{
        const packed=JSON.stringify(body.messages);expect(packed).toContain("09:17");expect(packed).not.toContain("An irrelevant introduction");
        label=packed.match(/E[a-f0-9]{32}/)![0];return reply(`Open at 09:17 [${label}]`);
      };
      const task=await execute(f.task.id);expect(task.state).toBe("completed");expect(task.output).toContain(`[${label}]`);
      const operations=(await pool.query("SELECT name,state FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at",[task.id])).rows;
      expect(operations).toEqual([{name:"knowledge.search",state:"completed"},{name:"model.generate",state:"completed"}]);
      const snapshot=(await pool.query("SELECT payload,source_references FROM agents_platform.context_snapshots WHERE task_id=$1",[task.id])).rows[0];
      expect(snapshot.payload.tools.map((tool:any)=>tool.function.name)).toEqual(["knowledge_search","knowledge_read"]);
      expect(snapshot.source_references.some((reference:any)=>reference.revision===f.job.revisionId&&reference.evidenceId)).toBe(true);
      expect((await f.evidence.taskManifest(task.id)).dependencies).toMatchObject([{kind:"source",revisionId:f.job.revisionId}]);
    } finally {resetGrounding();}
  });
  it("does not publish a final model answer when its source was withdrawn while generation was in flight",async()=>{
    const f=await groundedFixture();
    try {
      provider=async body=>{const label=JSON.stringify(body.messages).match(/E[a-f0-9]{32}/)![0];await f.knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});return reply(`Open at 09:17 [${label}]`);};
      const task=await execute(f.task.id);expect(task.state).not.toBe("completed");expect(task.output).toBeNull();expect(task.error_code).toBe("EVIDENCE_UNAVAILABLE");
      expect((await pool.query("SELECT id FROM agents_platform.actions WHERE task_id=$1",[task.id])).rowCount).toBe(0);
    } finally {resetGrounding();}
  });
  it("rejects invented answer citations before task publication",async()=>{
    const f=await groundedFixture();
    try{provider=async()=>reply("An unsupported fact [E12345]");const task=await execute(f.task.id);expect(task.state).toBe("failed");expect(task.error_code).toBe("CITATION_UNKNOWN");expect(task.output).toBeNull();}
    finally{resetGrounding();}
  });
  it("does not prepare a report from memory forgotten while the final model call was in flight",async()=>{
    const f=await reportFixture(true),saved=await acceptedMemory(f,"Private report dependency.");
    provider=async()=>{await memory.mutate(f.managed,saved.id,{operationId:randomUUID(),expectedRevision:saved.revision,action:"forget"});return reply("A report derived from the private dependency.");};
    expect(await execute(f.task.id)).toMatchObject({state:"failed",error_code:"CONTEXT_INVALIDATED"});expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.actions WHERE task_id=$1",[f.task.id])).rows[0].count).toBe(0);
    expect((await artifacts.listForRoot(f.task.id))).toHaveLength(0);
  },30000);
  it("expires a pending exact review through a durable timer without keeping a provider slot",async()=>{
    const f=await reportFixture();await pool.query("UPDATE agents_platform.tasks SET deadline_at=now()+interval '3 seconds' WHERE id=$1",[f.task.id]);
    const review=await waitForReview(f.task.id);
    const task=await eventually(async()=>{const row=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];return terminalTaskStates.has(row.state)?row:false;});
    expect(task).toMatchObject({state:"incomplete",error_code:"ACTION_EXPIRED"});expect(calls).toHaveLength(1);
    expect((await actions.getReview(f.task.id,review.id)).state).toBe("expired");
    expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(0);
  },30000);
  it("cancels an exact review wait and prevents a later approval from starting delivery",async()=>{
    const f=await reportFixture(),review=await waitForReview(f.task.id);await requestTreeCancellation(pool,f.task.id);
    expect((await finishWithControls(f.task.id)).state).toBe("cancelled");expect(calls).toHaveLength(1);
    await expect(actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"approve",expectedDigest:review.reviewDigest})).rejects.toMatchObject({code:"TASK_SETTLED"});
    expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(0);
  },30000);
  it.each(["approve","reject"] as const)("does not lose a %s decision between reading pending review and installing its durable wait",async decision=>{
    const f=await reportFixture();let entered=false,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    let captured:Awaited<ReturnType<ActionService["getReview"]>>|undefined;
    afterReviewRead=async review=>{if(!entered&&review.state==="pending_review"){entered=true;captured=review;await barrier;}};
    try {
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});await eventually(async()=>entered);
      await actions.decide(f.scope,f.task.id,captured!.id,{operationId:randomUUID(),decision,expectedDigest:captured!.reviewDigest});
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});release();
      const task=await finishWithControls(f.task.id);
      expect(task.state).toBe(decision==="approve"?"completed":"incomplete");
      expect((await actions.getReview(f.task.id,captured!.id)).state).toBe(decision==="approve"?"delivered":"rejected");expect(calls).toHaveLength(1);
    } finally {release();afterReviewRead=undefined;}
  },30000);
  it("resumes the same exact report after worker restart and records one actual HTTP delivery",async()=>{
    const f=await reportFixture(),review=await waitForReview(f.task.id);expect(calls).toHaveLength(1);
    expect(review.preview.content).toBe("Open at nine.");
    const capacity=(await pool.query("SELECT active_reserved_ms FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0];expect(capacity.active_reserved_ms).toBe(0);
    await restart();await actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"approve",expectedDigest:review.reviewDigest});
    expect((await finishWithControls(f.task.id)).state).toBe("completed");expect(calls).toHaveLength(1);
    const rows=(await pool.query("SELECT payload FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows;expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].payload.report.contentBase64,"base64").toString()).toBe("Open at nine.");
    expect((await actions.getReview(f.task.id,review.id)).state).toBe("delivered");
  },30000);
  it("reconciles an already accepted report after response loss, restart and grant revocation without resending",async()=>{
    const f=await reportFixture(),review=await waitForReview(f.task.id);
    let accepted=false,posts=0,release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    afterAccept=async id=>{if(id===review.id){posts++;accepted=true;await blocked;}};
    try {
      await actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"approve",expectedDigest:review.reviewDigest});
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});await eventually(async()=>accepted);
      await store.revokeGrant(f.account.id,f.org.id,f.grant.id);await restart();
      const result=await eventually(async()=>{const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];return terminalTaskStates.has(task.state)?task:false;});
      expect(result.state).toBe("completed");expect(posts).toBe(1);expect(calls).toHaveLength(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(1);
      expect((await actions.getReview(f.task.id,review.id)).state).toBe("delivered");
    } finally {release();afterAccept=undefined;await eventually(async()=>inFlightActionCalls===0);}
  },30000);
  it("accepts an exact rejection after grant revocation without dispatch or report regeneration",async()=>{
    const f=await reportFixture(),review=await waitForReview(f.task.id);
    await actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"reject",expectedDigest:review.reviewDigest});
    await store.revokeGrant(f.account.id,f.org.id,f.grant.id);
    expect(await finishWithControls(f.task.id)).toMatchObject({state:"incomplete",error_code:"ACTION_REJECTED"});expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(0);
  },30000);
  const childRequests={requests:[{bindingId:"first",brief:"Read the approved source and identify opening hours."},{bindingId:"second",brief:"Independently verify opening hours from your approved source."}]};
  function researchProvider() {
    provider=async body=>body.messages[0].content.startsWith("ROOT_RESEARCH") ?
      body.messages.some((message:any)=>message.role==="tool") ? reply("Both approved specialists confirm opening at nine.") : reply("","tool_calls",[tool("agents_delegate",childRequests)]) : reply("Approved source says open at nine.");
  }
  it("runs two pinned business specialists concurrently and charges the root tree exactly once",async()=>{
    const f=await researchFixture(); researchProvider();
    expect(await execute(f.task.id)).toMatchObject({state:"completed",output:"Both approved specialists confirm opening at nine."});
    expect(calls).toHaveLength(4);
    const delegateDefinition=calls[0]!.tools!.find(tool=>tool.function.name==="agents_delegate")!;
    expect(delegateDefinition.function.description).toContain('"name":"FIRST"');
    expect(delegateDefinition.function.description).toContain('"purpose":"SPECIALIST_FIRST: Answer from the provided source."');
    expect(delegateDefinition.function.description).not.toContain("maxTokens");
    expect((delegateDefinition.function.parameters as any).properties.requests.items.properties).toEqual({bindingId:{type:"string",enum:["first","second"]},brief:{type:"string",minLength:1,maxLength:8192}});
    const roleConfig=structuredClone(f.config);roleConfig.capabilities.delegation.bindings[0]!.description="x".repeat(256);
    const roleTool=toolsFor(roleConfig).find(tool=>tool.function.name==="agents_delegate")!;
    const roles=JSON.parse(roleTool.function.description.split("Available roles: ")[1]!);expect(roles[0]).toEqual({bindingId:"first",name:"first",purpose:"x".repeat(128)});
    const children=(await pool.query("SELECT * FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id",[f.task.id])).rows;
    expect(children).toHaveLength(2);
    expect(children.every(child=>child.root_task_id===f.task.id&&child.depth===1&&child.state==="completed"&&child.allocation_released)).toBe(true);
    expect(children.every(child=>child.conversation_id!==f.task.conversation_id&&child.effective_configuration.memory.enabled===false)).toBe(true);
    for(const child of children){const binding=f.config.capabilities.delegation.bindings.find(binding=>binding.versionId===child.version_id)!;
      expect(child.root_token_limit).toBe(binding.maxTokens);expect(child.allocation_active_ms).toBe(binding.maxActiveMs);
      expect(child.effective_configuration.sourceRevisionIds).toEqual(binding.sourceRevisionIds);expect(child.effective_configuration.connectedToolBindingIds).toEqual(binding.connectedToolBindingIds);expect(child.effective_configuration.tools).toEqual(binding.tools);
      const grant=(await pool.query("SELECT root_token_limit,source_revision_ids,connected_tool_binding_ids FROM agents_platform.execution_grants WHERE id=$1",[child.grant_id])).rows[0];
      expect(grant).toEqual({root_token_limit:binding.maxTokens,source_revision_ids:binding.sourceRevisionIds,connected_tool_binding_ids:binding.connectedToolBindingIds});}
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.usage_reservations WHERE task_id=ANY($1::uuid[])",[children.map(child=>child.id)])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1",[f.task.id])).rows[0].accounted_tokens).toBe(224);
    const aggregate=(await pool.query("SELECT tokens_used,tokens_reserved,child_reserved_tokens,model_calls FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0];
    expect(aggregate).toEqual({tokens_used:224,tokens_reserved:0,child_reserved_tokens:0,model_calls:4});
    const resultMessage=calls.find(call=>call.messages[0]!.content?.startsWith("ROOT_RESEARCH")&&call.messages.some(message=>message.role==="tool"))!.messages.find(message=>message.role==="tool")!;
    expect(JSON.parse(resultMessage.content!).children.map((child:any)=>child.bindingId)).toEqual(["first","second"]);
  },30000);
  it("keeps SDK child submission exclusive while root outbox acceptance is lost and retried",async()=>{
    const f=await researchFixture();researchProvider();const normal=provider;
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    provider=async(body,request)=>{if(body.messages[0].content.startsWith("SPECIALIST"))await barrier;return normal(body,request);};
    const submissions:string[]=[],acceptedIds:string[]=[];
    const observed:typeof fetch=async(url,init)=>{
      if(String(url).includes("/restate/send/"))submissions.push(String(url));
      const response=await fetch(url,init);
      if(String(url).includes("/restate/send/"))acceptedIds.push((await response.clone().json() as {invocationId:string}).invocationId);
      return response;
    };
    try{
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl,fetch:async(url,init)=>{const response=await observed(url,init);if(String(url).includes("/restate/send/")){await response.text();throw new TypeError("Controlled lost root acceptance ACK");}return response;}});
      await eventually(async()=>calls.filter(call=>call.messages[0]!.content?.startsWith("SPECIALIST")).length===2);
      const children=(await pool.query("SELECT id,runtime_invocation_id,state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id",[f.task.id])).rows;
      expect(children).toHaveLength(2);expect(children.every(child=>child.runtime_invocation_id?.startsWith("inv_")&&child.state==="running")).toBe(true);
      await pool.query("UPDATE agents_platform.task_outbox SET available_at=now(),lease_until=NULL WHERE task_id=$1",[f.task.id]);
      for(let attempt=0;attempt<5;attempt++)await dispatchTasksOnce(pool,{ingressUrl,adminUrl,fetch:observed});
      expect(submissions.length).toBeGreaterThanOrEqual(2);expect(acceptedIds).toHaveLength(submissions.length);
      expect(submissions.every(url=>url.endsWith(`/${f.task.id}/run`)),JSON.stringify(submissions)).toBe(true);
      const canonical=(await pool.query("SELECT t.runtime_invocation_id,o.dispatched_at,o.last_error_code FROM agents_platform.tasks t JOIN agents_platform.task_outbox o ON o.task_id=t.id WHERE t.id=$1",[f.task.id])).rows[0];
      expect(canonical.runtime_invocation_id).toBe(acceptedIds[0]);expect(canonical.dispatched_at).not.toBeNull();expect(canonical.last_error_code).toBeNull();
      expect(acceptedIds.every(id=>id===canonical.runtime_invocation_id)).toBe(true);

      const after=(await pool.query("SELECT id,runtime_invocation_id,state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id",[f.task.id])).rows;
      expect(after).toEqual(children);expect(calls).toHaveLength(3);
      release();expect(await finishWithControls(f.task.id)).toMatchObject({state:"completed",output:"Both approved specialists confirm opening at nine."});
      expect(calls).toHaveLength(4);
      expect((await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE parent_task_id=$1",[f.task.id])).rows).toEqual([{state:"completed",error_code:null},{state:"completed",error_code:null}]);
      expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE task_id=ANY($1::uuid[]) AND kind='model'",[children.map(child=>child.id)])).rows[0].count).toBe(2);
    }finally{release();}
  },30000);
  it("recovers stable child slots after repeated admission and children do not consume root admission slots",async()=>{
    const f=await researchFixture(); const operationId=`delegation:${randomUUID()}`;
    const first=await admitChildren(pool,f.task.id,operationId,childRequests);
    expect(await admitChildren(pool,f.task.id,operationId,childRequests)).toEqual(first);
    await expect(admitChildren(pool,f.task.id,operationId,{requests:[{...childRequests.requests[0],brief:"changed"}]})).rejects.toMatchObject({code:"OPERATION_CONFLICT"});
    const another=await store.admitTask({...f.request,requestKey:randomUUID(),input:"Second independent root"});
    expect(another.task.parent_task_id).toBeNull();
    await expect(store.admitTask({...f.request,requestKey:randomUUID(),input:"Third independent root"})).rejects.toMatchObject({code:"CONCURRENCY_LIMIT"});
    await requestTreeCancellation(pool,f.task.id); await settleTask(pool,f.task.id,{state:"cancelled"});
    expect((await pool.query("SELECT disposition FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].disposition).toBe("pending_children");
    for(const child of first) await settleTask(pool,child.taskId,{state:"cancelled"});
    await reconcilePendingRoots(pool); await settleTask(pool,another.task.id,{state:"cancelled"});
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].state).toBe("cancelled");
  },30000);
  it.each([{maxTokens:2048},{sourceRevisionIds:[]},{connectedToolBindingIds:[]}])("rejects model delegation overrides before admission: %j",async override=>{
    const f=await researchFixture();let rootCalls=0;
    provider=async body=>{
      if(!body.messages[0].content.startsWith("ROOT_RESEARCH"))return reply("Approved source says open at nine.");
      rootCalls++;
      if(rootCalls===1)return reply("","tool_calls",[tool("agents_delegate",{requests:[{...childRequests.requests[0],...override}]})]);
      if(rootCalls===2){
        expect(JSON.parse(body.messages.filter((message:any)=>message.role==="tool").at(-1).content)).toEqual({error:"TOOL_ARGUMENTS_INVALID"});
        expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE parent_task_id=$1",[f.task.id])).rows[0].count).toBe(0);
        return reply("","tool_calls",[tool("agents_delegate",childRequests,"corrected")]);
      }
      return reply("Published specialists completed their work.");
    };
    const result=await execute(f.task.id);expect(result.state,result.error_code).toBe("completed");
    const children=(await pool.query("SELECT root_token_limit,effective_configuration FROM agents_platform.tasks WHERE parent_task_id=$1",[f.task.id])).rows;
    expect(children).toHaveLength(2);for(const child of children){expect(child.root_token_limit).toBe(8000);expect(child.effective_configuration.sourceRevisionIds).toEqual([f.source.id]);expect(child.effective_configuration.connectedToolBindingIds).toEqual([]);expect(child.effective_configuration.tools).toEqual(["knowledge.search"]);}
    const failed=(await pool.query("SELECT error_code FROM agents_platform.operations WHERE task_id=$1 AND kind='delegation' AND state='failed'",[f.task.id])).rows;expect(failed).toEqual([{error_code:"TOOL_ARGUMENTS_INVALID"}]);
  },30000);
  it("does not inherit parent memory or unbound specialist tools",async()=>{
    const f=await researchFixture(true); await acceptedMemory(f,"Private parent marker secret-language-preference.");researchProvider();
    expect((await execute(f.task.id)).state).toBe("completed");
    const specialistCalls=calls.filter(call=>call.messages[0]!.content?.startsWith("SPECIALIST"));expect(specialistCalls).toHaveLength(2);
    for(const call of specialistCalls){expect(JSON.stringify(call.messages)).not.toContain("secret-language-preference");expect(call.tools!.map(tool=>tool.function.name)).toEqual(["knowledge_search"]);}
  },30000);
  it("retains explicit allocation and source narrowing for trusted child admission",async()=>{
    const f=await researchFixture();const children=await admitChildren(pool,f.task.id,randomUUID(),{requests:[{bindingId:"first",brief:"Use the intentionally narrowed trusted scope.",maxTokens:4096,sourceRevisionIds:[],connectedToolBindingIds:[]}]});
    const child=(await pool.query("SELECT root_token_limit,effective_configuration,grant_id FROM agents_platform.tasks WHERE id=$1",[children[0]!.taskId])).rows[0];
    expect(child.root_token_limit).toBe(4096);expect(child.effective_configuration.sourceRevisionIds).toEqual([]);expect(child.effective_configuration.tools).toEqual(["knowledge.search"]);
    const grant=(await pool.query("SELECT root_token_limit,source_revision_ids FROM agents_platform.execution_grants WHERE id=$1",[child.grant_id])).rows[0];expect(grant).toEqual({root_token_limit:4096,source_revision_ids:[]});
    await requestTreeCancellation(pool,f.task.id);await settleTask(pool,children[0]!.taskId,{state:"cancelled"});await settleTask(pool,f.task.id,{state:"cancelled"});
  },30000);
  it("denies forbidden bindings, scope expansion and grandchildren before allocating work",async()=>{
    const f=await researchFixture();
    await expect(admitChildren(pool,f.task.id,randomUUID(),{requests:[{bindingId:"forbidden",brief:"work"}]})).rejects.toMatchObject({code:"DELEGATION_BINDING_DENIED"});
    await expect(admitChildren(pool,f.task.id,randomUUID(),{requests:[{bindingId:"first",brief:"work",maxTokens:9000}]})).rejects.toMatchObject({code:"DELEGATION_SCOPE_DENIED"});
    const children=await admitChildren(pool,f.task.id,randomUUID(),childRequests);
    await expect(admitChildren(pool,children[0]!.taskId,randomUUID(),childRequests)).rejects.toMatchObject({code:"DELEGATION_DENIED"});
    await requestTreeCancellation(pool,f.task.id);for(const child of children)await settleTask(pool,child.taskId,{state:"cancelled"});await settleTask(pool,f.task.id,{state:"cancelled"});
  },30000);
  it("rechecks current root authority before every delegated model operation",async()=>{
    const f=await researchFixture();const children=await admitChildren(pool,f.task.id,randomUUID(),childRequests);
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.grant.id]);
    await expect(beginOperation(pool,children[0]!.taskId,{id:randomUUID(),kind:"model",name:"model.generate",request:{},reservedTokens:1000,reservedMs:1000})).rejects.toMatchObject({code:"GRANT_REVOKED"});
    expect((await pool.query("SELECT model_calls FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0].model_calls).toBe(0);
    await requestTreeCancellation(pool,f.task.id);for(const child of children)await settleTask(pool,child.taskId,{state:"cancelled"});await settleTask(pool,f.task.id,{state:"cancelled"});
  },30000);
  it("labels truncated specialist results as partial and never cuts a citation label",async()=>{
    const f=await researchFixture(),children=await admitChildren(pool,f.task.id,randomUUID(),childRequests);
    const original="x".repeat(2040)+"[E"+"a".repeat(32)+"] Missing source: quarterly figures unavailable.";
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=ANY($1::uuid[])",[children.map(child=>child.taskId)]);
    for(const child of children)await settleTask(pool,child.taskId,{state:"completed",output:original});
    const joined=await readChildResults(pool,f.task.id,children);expect(joined.partial).toBe(true);
    for(const child of joined.children){expect(child.outputTruncated).toBe(true);expect(child.originalBytes).toBe(Buffer.byteLength(original));expect(child.output).toBe("x".repeat(2040));expect(child.output).not.toMatch(/\[E[a-f0-9]*$/);}
    await settleTask(pool,f.task.id,{state:"incomplete",errorCode:"CHILD_OUTPUT_TRUNCATED"});
  });
  it("fences cached specialist results when branch history is deleted before parent synthesis",async()=>{
    const f=await researchFixture();const children=await admitChildren(pool,f.task.id,randomUUID(),childRequests);
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=ANY($1::uuid[])",[children.map(child=>child.taskId)]);
    for(const child of children) await settleTask(pool,child.taskId,{state:"completed",output:"Private specialist evidence"});
    const cached=await readChildResults(pool,f.task.id,children);
    expect(cached.children).toHaveLength(2);
    const child=(await pool.query("SELECT conversation_id,resource_id FROM agents_platform.tasks WHERE id=$1",[children[0]!.taskId])).rows[0];
    await memory.deleteConversationSources({...f.managed,agentId:child.resource_id},child.conversation_id);
    await expect(beginOperation(pool,f.task.id,{id:randomUUID(),kind:"model",name:"model.generate",request:{cached},reservedTokens:1000,reservedMs:1000})).rejects.toMatchObject({code:"CHILD_RESULT_UNAVAILABLE"});
    await expect(readChildResults(pool,f.task.id,children)).rejects.toMatchObject({code:"CHILD_RESULT_UNAVAILABLE"});
    expect((await pool.query("SELECT model_calls FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0].model_calls).toBe(0);
    await settleTask(pool,f.task.id,{state:"failed",errorCode:"CHILD_RESULT_UNAVAILABLE"});
  },30000);
  it("stops the whole tree after an uncertain child instead of delegating replacement work",async()=>{
    const f=await researchFixture();researchProvider();const normal=provider;
    provider=async(body,request)=>{if(body.messages[0].content.startsWith("SPECIALIST_FIRST"))throw new TypeError("unknown specialist response");return normal(body,request);};
    expect(await execute(f.task.id)).toMatchObject({state:"uncertain",error_code:"CHILD_OUTCOME_UNCERTAIN"});
    expect(calls).toHaveLength(3);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.delegations WHERE parent_task_id=$1",[f.task.id])).rows[0].count).toBe(2);
    expect(calls.filter(call=>call.messages[0]!.content?.startsWith("ROOT_RESEARCH"))).toHaveLength(1);
  },30000);
  it("lets two roots join four specialists under two shared provider slots without deadlock",async()=>{
    const f=await researchFixture();const second=await store.admitTask({...f.request,requestKey:randomUUID(),input:"Second research root"});researchProvider();const normal=provider;
    let active=0,peak=0;
    provider=async(body,request)=>{
      if(body.messages[0].content.startsWith("SPECIALIST")){active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,350));return await normal(body,request);}finally{active--;}}
      return normal(body,request);
    };
    const outcomes=await Promise.all([execute(f.task.id),execute(second.task.id)]);
    expect(outcomes.map(task=>task.state)).toEqual(["completed","completed"]);expect(peak).toBe(2);expect(calls).toHaveLength(8);
    const children=(await pool.query("SELECT root_task_id,count(*)::int AS count FROM agents_platform.tasks WHERE parent_task_id=ANY($1::uuid[]) GROUP BY root_task_id",[[f.task.id,second.task.id]])).rows;
    expect(children).toHaveLength(2);expect(children.every(row=>row.count===2)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE error_code='PROVIDER_BUSY' AND task_id IN (SELECT id FROM agents_platform.tasks WHERE root_task_id=ANY($1::uuid[]))",[[f.task.id,second.task.id]])).rows[0].count).toBe(0);
  },30000);
  it("reports specialist failure as partial completion instead of trusting an optimistic parent answer",async()=>{
    const f=await researchFixture(); researchProvider(); const normal=provider;
    provider=async(body,request)=>body.messages[0].content.startsWith("SPECIALIST_FIRST")?new Response("rejected",{status:400}):normal(body,request);
    expect(await execute(f.task.id)).toMatchObject({state:"incomplete",error_code:"CHILD_PARTIAL_FAILURE"});
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY state",[f.task.id])).rows.map(row=>row.state)).toEqual(["completed","failed"]);
  },30000);
  it("cascades cancellation and retains root settlement until both child effects are accounted for",async()=>{
    const f=await researchFixture(); researchProvider(); const normal=provider;
    provider=async(body,request)=>{
      if(body.messages[0].content.startsWith("SPECIALIST")) await new Promise<void>((_resolve,reject)=>request.signal?.addEventListener("abort",()=>reject(new Error("child transport cancelled")),{once:true}));
      return normal(body,request);
    };
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl}); await eventually(async()=>calls.length===3);
    await requestTreeCancellation(pool,f.task.id);
    const task=await eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl});const row=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];return terminalTaskStates.has(row.state)?row:false;});
    expect(task.state).toBe("uncertain"); expect(task.disposition).toBe("settled"); expect(calls).toHaveLength(3);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[f.task.id])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT reserved_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1",[f.org.id])).rows[0].reserved_tokens).toBe(0);
  },30000);
  it("runs minimal FAQ through common operations/snapshots and settles once", async () => {
    const f = await fixture();
    expect(await execute(f.task.id)).toMatchObject({ state: "completed", output: "Open at nine.", turn_sequence: "1" });
    expect(calls).toHaveLength(1); expect(calls[0]!.tools).toBeUndefined();
    expect((await store.admitTask(f.request)).task.id).toBe(f.task.id);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows).toEqual([{ accounted_tokens: 56 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.context_snapshots WHERE task_id=$1", [f.task.id])).rows[0].count).toBe(1);
  }, 30_000);
  it("executes multiple model/tool rounds with validated structured tool results", async () => {
    const f = await fixture({ tools: ["knowledge.search", "knowledge.read"] });
    provider = async body => calls.length === 1 ? reply("", "tool_calls", [tool("knowledge_search", { query: "open" })]) :
      calls.length === 2 ? reply("", "tool_calls", [tool("knowledge_read", { evidenceId: JSON.parse(body.messages.findLast((message:any)=>message.role==="tool").content).passages[0].evidenceId }, "call2")]) : reply("Open at nine, from the approved source.");
    expect((await execute(f.task.id)).state).toBe("completed");
    expect(calls).toHaveLength(3);
    expect((calls[1]!.messages as any[]).some(m => m.role === "tool" && m.content.includes("Open at nine"))).toBe(true);
    expect((await pool.query("SELECT kind,count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1 GROUP BY kind ORDER BY kind", [f.task.id])).rows)
      .toEqual([{ kind: "model", count: 3 }, { kind: "tool", count: 3 }]);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(168);
  }, 30_000);
  it("serializes concurrent conversation turns and includes predecessor context", async () => {
    const f = await fixture();
    const second = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: "And what did I just ask?" });
    let release!: () => void;
    provider = async () => { if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; }); return reply(calls.length === 1 ? "Opening hours are nine." : "You asked about opening hours."); };
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    await eventually(async () => calls.length === 1);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [second.task.id])).rows[0].state).toBe("accepted");
    release();
    expect((await execute(second.task.id)).state).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.some(m => m.role === "assistant" && m.content === "Opening hours are nine.")).toBe(true);
    expect((await pool.query("SELECT turn_sequence,history_cutoff FROM agents_platform.tasks WHERE id=$1", [second.task.id])).rows[0])
      .toEqual({ turn_sequence: "2", history_cutoff: "1" });
  }, 30_000);
  it("reuses the same workflow after lost outbox acceptance without repeating the model", async () => {
    const f = await fixture();
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, fetch: async (url, init) => {
      const result = await fetch(url, init); if (String(url).includes("/restate/send/")) { await result.text(); throw new TypeError("lost acceptance"); } return result;
    } });
    expect((await execute(f.task.id)).state).toBe("completed");
    await pool.query("UPDATE agents_platform.task_outbox SET available_at=now() WHERE task_id=$1", [f.task.id]);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl }); expect(calls).toHaveLength(1);
  }, 30_000);
  it("never regenerates an unknown model outcome and charges only its operation reservation", async () => {
    const f = await fixture(); provider = async () => { throw new TypeError("lost provider response"); };
    expect(await execute(f.task.id)).toMatchObject({ state: "uncertain", error_code: "MODEL_OUTCOME_UNCERTAIN" });
    expect(calls).toHaveLength(1);
    const op = (await pool.query("SELECT reserved_tokens,accounted_tokens,state FROM agents_platform.operations WHERE task_id=$1 AND kind='model'", [f.task.id])).rows[0];
    expect(op.state).toBe("uncertain"); expect(op.accounted_tokens).toBe(op.reserved_tokens); expect(op.reserved_tokens).toBeLessThan(32000);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl }); expect(calls).toHaveLength(1);
  }, 30_000);
  it.each([400, 429, 500])("accounts definitive versus uncertain provider HTTP %i outcomes", async status => {
    const f = await fixture(); provider = async () => new Response("private provider detail", { status });
    const outcome = await execute(f.task.id); expect(outcome.state).toBe(status === 500 ? "uncertain" : "failed");
    expect(calls).toHaveLength(1);
    const charged = (await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens;
    expect(status === 500 ? charged > 0 : charged === 0).toBe(true);
  }, 30_000);
  it("cancels before dispatch without starting an operation", async () => {
    const f = await fixture(); await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1", [f.task.id]);
    expect((await execute(f.task.id)).state).toBe("cancelled"); expect(calls).toHaveLength(0);
  }, 30_000);
  it("reports an in-flight cancelled model as uncertain without starting another request", async () => {
    const f = await fixture();
    let release!: () => void;
    provider = async (_body, request) => {
      await new Promise<void>((resolve, reject) => { release = resolve; request.signal?.addEventListener("abort", () => reject(new Error("cancelled transport")), { once: true }); });
      return reply();
    };
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl }); await eventually(async () => calls.length === 1);
    await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1", [f.task.id]);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    const result = await execute(f.task.id); release?.();
    expect(result.state).toBe("uncertain"); expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operation_usage u JOIN agents_platform.operations o ON o.id=u.operation_id WHERE u.task_id=$1 AND o.kind='model'", [f.task.id])).rows[0].count).toBe(1);
  }, 30_000);
  it("ends truthfully when root budget cannot admit even the first model request", async () => {
    const f = await fixture({ instructions: "Mandatory policy ".repeat(100) }, 2048);
    expect(await execute(f.task.id)).toMatchObject({ state: "incomplete", error_code: "ROOT_LIMIT" }); expect(calls).toHaveLength(0);
  }, 30_000);
  it("does not dispatch with a revoked grant", async () => {
    const f = await fixture(); await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [f.grant.id]);
    expect(await execute(f.task.id)).toMatchObject({ state: "failed", error_code: "GRANT_REVOKED" }); expect(calls).toHaveLength(0);
  }, 30_000);
  it("reuses confirmed operation receipts and detects started operations without repeating effects", async () => {
    const f = await fixture();
    const input = { id: `fixture:${f.task.id}`, kind: "model" as const, name: "model.generate", request: { immutable: true }, reservedTokens: 300, reservedMs: 1000 };
    expect((await beginOperation(pool, f.task.id, input)).replayed).toBe(false);
    await finishOperation(pool, f.task.id, input.id, "completed", { result: "recorded" }, null, 42);
    expect((await beginOperation(pool, f.task.id, input)).operation).toMatchObject({ state: "completed", output: { result: "recorded" } });
    await finishOperation(pool, f.task.id, input.id, "completed", { result: "other" }, null, 99);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.operation_usage WHERE operation_id=$1", [input.id])).rows[0].accounted_tokens).toBe(42);
    const unknown = { ...input, id: input.id + ':unknown' };
    await beginOperation(pool, f.task.id, unknown);
    expect((await beginOperation(pool, f.task.id, unknown)).operation.state).toBe("uncertain");
    await settleTask(pool, f.task.id, { state: "uncertain" }); expect(calls).toHaveLength(0);
  });
  it("enforces root allocation atomically across competing operations", async () => {
    const f = await fixture({}, 2048);
    const claim = (suffix: string) => beginOperation(pool, f.task.id, { id: `budget:${f.task.id}:${suffix}`, kind: "model", name: "generate",
      request: { suffix }, reservedTokens: 1500, reservedMs: 1000 });
    const outcomes = await Promise.allSettled([claim("a"), claim("b")]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(o => o.status === "rejected")).toMatchObject({ reason: { code: "ROOT_LIMIT" } });
    await settleTask(pool, f.task.id, { state: "uncertain" });
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(1500);
  });
  it("invalidates a prepared memory snapshot before dispatch when Forget wins admission", async () => {
    const f = await fixture({ memory: { enabled: true } , sourceRevisionIds: [] }); const item = await acceptedMemory(f, "My preferred report language is Shona.");
    const held=holdPreparedContext(f.task.id,false);
    try {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
      await held.ready;
      await memory.mutate(f.managed, item.id, { operationId: randomUUID(), expectedRevision: item.revision, action: "forget" });
      held.release();
      expect(await execute(f.task.id)).toMatchObject({state:"incomplete",error_code:"EVIDENCE_UNAVAILABLE"});expect(calls).toHaveLength(0);
      expect(JSON.stringify(calls)).not.toContain("preferred report language is Shona");
    } finally { held.restore(); }
  }, 30_000);
  it("expires a prepared memory dependency before provider admission", async () => {
    const f = await fixture({ memory: { enabled: true } , sourceRevisionIds: [] });
    const item = await acceptedMemory(f, "My temporary preference is Shona.", new Date(Date.now() + 2500).toISOString());
    const held=holdPreparedContext(f.task.id,false);
    try {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
      await held.ready;
      await eventually(async () => (await pool.query("SELECT expires_at<=clock_timestamp() AS expired FROM agents_platform.memories WHERE id=$1", [item.id])).rows[0].expired);
      held.release();
      expect(await execute(f.task.id)).toMatchObject({state:"incomplete",error_code:"EVIDENCE_UNAVAILABLE"});expect(calls).toHaveLength(0);
      expect(JSON.stringify(calls)).not.toContain("My temporary preference is Shona");
    } finally { held.restore(); }
  }, 30_000);
  it("keeps a successful memory proposal receipt in the next model context", async () => {
    const f = await fixture({ memory: { enabled: true }, tools: ["memory.propose"] });
    provider = async () => calls.length === 1 ? reply("", "tool_calls", [tool("memory_propose", { content: "I prefer Shona reports.", kind: "semantic" })]) : reply("Your preference is pending review.");
    expect((await execute(f.task.id)).state).toBe("completed"); expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.some(message => message.role === "tool" && message.content?.includes("pending_review"))).toBe(true);
    expect((await memory.list(f.managed)).candidates).toHaveLength(1);
  }, 30_000);
  it("discards tool proposals from a model snapshot invalidated while the model was in flight", async () => {
    const f = await fixture({ memory: { enabled: true }, tools: ["memory.propose"] });
    const item = await acceptedMemory(f, "My preferred report language is Shona.");
    let release!: () => void;
    provider = async () => {
      if (calls.length === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return reply("", "tool_calls", [tool("memory_propose", { content: "Reports should be written in Shona.", kind: "semantic" })]);
      }
      return reply("I have no retained language preference.");
    };
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl }); await eventually(async () => calls.length === 1);
    await memory.mutate(f.managed, item.id, { operationId: randomUUID(), expectedRevision: item.revision, action: "forget" });
    release();
    expect(await execute(f.task.id)).toMatchObject({state:"incomplete",error_code:"EVIDENCE_UNAVAILABLE"});expect(calls).toHaveLength(1);
    expect((await memory.list(f.managed)).candidates).toEqual([]);
    const followup=await store.admitTask({...f.request,requestKey:randomUUID(),conversationId:f.task.conversation_id,input:"Continue with current retained information"});
    expect((await execute(followup.task.id)).state).toBe("completed");expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Reports should be written in Shona");
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("preferred report language is Shona");
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1 AND name='memory.propose'", [f.task.id])).rows[0].count).toBe(0);
  }, 30_000);
  it("resumes a pending tool decision after authority expiry without regenerating that decision", async () => {
    const f = await fixture({ tools: ["knowledge.search"] });
    let release!: () => void;
    provider = async () => {
      if (calls.length === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return reply("", "tool_calls", [tool("knowledge_search", { query: "open" })]);
      }
      return reply("The confirmed opening time is nine.");
    };
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl }); await eventually(async () => calls.length === 1);
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()+interval '500 milliseconds' WHERE id=$1", [f.grant.id]);
    await eventually(async () => (await pool.query("SELECT expires_at<=clock_timestamp() AS expired FROM agents_platform.execution_grants WHERE id=$1", [f.grant.id])).rows[0].expired);
    release();
    await eventually(async () => (await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0].state === "waiting_authority");
    expect(calls).toHaveLength(1);
    const replacement = { ...f.grant, id: randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    await store.createGrant({ accountId: f.account.id, grant: replacement });
    await pool.query("UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1 WHERE id=$1", [f.task.id, replacement.id]);
    const resumed = await fetch(`${ingressUrl}/${WORKFLOW_NAME}/${f.task.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: 0 }) });
    expect(resumed.ok, await resumed.text()).toBe(true);
    expect(await execute(f.task.id)).toMatchObject({ state: "completed", output: "The confirmed opening time is nine." });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.some(message => message.role === "tool" && message.content?.includes("Open at nine"))).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1 AND kind='tool'", [f.task.id])).rows[0].count).toBe(2);
  }, 30_000);
  it("reads accepted personal memory in another authorized conversation", async () => {
    const f = await fixture({ memory: { enabled: true } }); await acceptedMemory(f, "My preferred report language is Shona.");
    expect((await execute(f.task.id)).state).toBe("completed");
    const next = await store.admitTask({ ...f.request, requestKey: randomUUID(), input: "Which language?" });
    expect((await execute(next.task.id)).state).toBe("completed");
    expect(JSON.stringify(calls[1]!.messages)).toContain("preferred report language is Shona");
  }, 30_000);
  it("excludes prior derived answers after their memory dependency expires", async () => {
    const f = await fixture({ memory: { enabled: true } });
    const item = await acceptedMemory(f, "Temporary preference: Shona.", new Date(Date.now() + 1600).toISOString());
    provider = async () => reply("Derived remembered preference is Shona.");
    expect((await execute(f.task.id)).state).toBe("completed");
    await eventually(async () => (await pool.query("SELECT expires_at<=clock_timestamp() AS expired FROM agents_platform.memories WHERE id=$1", [item.id])).rows[0].expired);
    const next = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: "Continue from current valid information" });
    provider = async () => reply("No currently retained preference.");
    expect((await execute(next.task.id)).state).toBe("completed");
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Derived remembered preference is Shona");
  }, 30_000);
  function nearLimitToolConfiguration():Partial<AgentConfiguration>{
    const config=defaultBusinessConfiguration();config.tools=["knowledge.search"];config.instructions="Use approved knowledge and preserve issued evidence identifiers. ";
    const request:ModelRequest={model:config.model.model,maxInputTokens:8192,maxOutputTokens:config.model.maxOutputTokens,maxDurationSeconds:config.model.maxDurationSeconds,
      messages:[{role:"system",content:config.instructions},{role:"user",content:"What are the opening hours?"}],tools:toolsFor(config)};
    config.instructions+="p".repeat(7600-estimateRequestTokens(request));
    return{instructions:config.instructions,tools:config.tools,context:{maxInputTokens:8192,compactAtTokens:6144}};
  }
  it("compacts a single complete overflowing tool group and replays its evidence without spending again",async()=>{
    const sourceContent=JSON.stringify({hours:"Open at nine",note:'Opening "quoted" hours\nnext line'});
    const f=await fixture(nearLimitToolConfiguration(),32000,sourceContent);
    const evidence=businessOptions.evidence!,supply=evidence.supplyContext.bind(evidence);
    let release!:()=>void,held=false,evidenceId="",citation="";
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    evidence.supplyContext=async(...args)=>{const value=await supply(...args);if(args[0]===f.task.id&&args[1]===`context:${f.task.id}:2`&&!held){held=true;await barrier;}return value;};
    provider=async body=>{
      if(body.messages[0].content.startsWith("Summarize")){
        const packed=JSON.parse(body.messages.find((message:any)=>message.role==="user"&&message.content.includes('"groupId"')).content);
        expect(packed.records.map((message:any)=>message.role)).toEqual(["assistant","tool"]);validateMessageGroups(packed.records);
        const passage=JSON.parse(packed.records[1].content).passages[0];expect(passage.text).toBe(sourceContent);evidenceId=passage.evidenceId;citation=passage.citation;
        return reply(`Confirmed nine. Issued evidence ${evidenceId} ${citation}.`);
      }
      if(calls.length===1){expect(estimateRequestTokens(body)).toBeLessThanOrEqual(8192);return reply("","tool_calls",[tool("knowledge_search",{query:"opening"})]);}
      expect(JSON.stringify(body.messages)).toContain(evidenceId);expect(JSON.stringify(body.messages)).toContain(citation);validateMessageGroups(body.messages);
      return reply(`Open at nine ${citation}`);
    };
    try{
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});await eventually(async()=>held);
      expect(calls).toHaveLength(2);
      const compactBefore=(await pool.query("SELECT id,output FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction' AND state='completed'",[f.task.id])).rows;
      expect(compactBefore).toHaveLength(1);
      const nodeBefore=(await pool.query("SELECT id,evidence_ids,parents,manifest,request_digest FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='context' AND owner_id=$2",[f.task.id,`context:${f.task.id}:2`])).rows[0];
      const snapshot=(await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE id=$1",[`context:${f.task.id}:2`])).rows[0];
      expect(snapshot.payload.estimatedTokens).toBeLessThanOrEqual(8192);expect(JSON.stringify(snapshot.payload)).toContain(evidenceId);
      const late=await evidence.derive(f.task.id,"artifact","later-output");
      const replayed=await evidence.supplyContext(f.task.id,`context:${f.task.id}:2`,[]);
      expect(replayed.parents).toEqual(nodeBefore.parents);expect(replayed.parents).not.toContain(late.id);expect(replayed.parents).not.toContain(replayed.id);
      await restart();const task=await execute(f.task.id);release();
      expect(task.state,task.error_code).toBe("completed");expect(task.output).toContain(citation);expect(calls).toHaveLength(3);
      expect(calls.filter(call=>call.messages[0]!.content?.startsWith("Summarize"))).toHaveLength(1);
      expect((await pool.query("SELECT id,output FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction' AND state='completed'",[f.task.id])).rows).toEqual(compactBefore);
      expect((await pool.query("SELECT kind,count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1 GROUP BY kind ORDER BY kind",[f.task.id])).rows).toEqual([{kind:"compaction",count:1},{kind:"model",count:2},{kind:"tool",count:2}]);
      expect((await pool.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].root_token_limit).toBe(32000);
      expect((await pool.query("SELECT tokens_used,tokens_reserved,model_calls FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0]).toEqual({tokens_used:168,tokens_reserved:0,model_calls:3});
      expect((await evidence.taskManifest(f.task.id)).dependencies).toEqual(expect.arrayContaining([expect.objectContaining({kind:"source",revisionId:f.source.id})]));
      const nodeAfter=(await pool.query("SELECT id,evidence_ids,parents,manifest,request_digest FROM agents_platform.evidence_nodes WHERE id=$1",[nodeBefore.id])).rows[0];
      expect(nodeAfter).toEqual(nodeBefore);
    }finally{release();evidence.supplyContext=supply;}
  },30000);
  it("rechecks current source policy when replaying an immutable compacted context",async()=>{
    const f=await fixture(nearLimitToolConfiguration()),evidence=businessOptions.evidence!,supply=evidence.supplyContext.bind(evidence);
    let release!:()=>void,held=false;const barrier=new Promise<void>(resolve=>{release=resolve;});
    evidence.supplyContext=async(...args)=>{const value=await supply(...args);if(args[0]===f.task.id&&args[1]===`context:${f.task.id}:2`&&!held){held=true;await barrier;}return value;};
    provider=async body=>body.messages[0].content.startsWith("Summarize")?reply("Confirmed opening hours nine."):reply("","tool_calls",[tool("knowledge_search",{query:"opening"})]);
    try{
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});await eventually(async()=>held);
      const generation=(await pool.query("SELECT generation FROM agents_platform.sources WHERE id=$1",[f.source.sourceId])).rows[0].generation;
      await f.source.knowledge.setPolicy({accountId:f.account.id,organizationId:f.org.id},f.source.sourceId,{operationId:randomUUID(),expectedGeneration:generation,action:"withdraw"});
      await expect(evidence.supplyContext(f.task.id,`context:${f.task.id}:2`,[])).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      release();const task=await execute(f.task.id);expect(task.error_code).toBe("EVIDENCE_UNAVAILABLE");expect(calls).toHaveLength(2);
    }finally{release();evidence.supplyContext=supply;}
  },30000);
  it("stops after one single-group compaction when its summary cannot fit the fixed context",async()=>{
    const f=await fixture(nearLimitToolConfiguration());
    provider=async body=>body.messages[0].content.startsWith("Summarize")?reply("s".repeat(384)):reply("","tool_calls",[tool("knowledge_search",{query:"opening"})]);
    const task=await execute(f.task.id);
    expect(task.state).toBe("incomplete");expect(task.error_code).toBe("CONTEXT_LIMIT");expect(calls).toHaveLength(2);
    expect(calls.filter(call=>call.messages[0]!.content?.startsWith("Summarize"))).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction'",[f.task.id])).rows[0].count).toBe(1);
  },30000);
  it("rejects a changed explicit child-result parent set after an early empty join",async()=>{
    const f=await researchFixture(),evidence=businessOptions.evidence!,operationId=`delegate:${f.task.id}`;
    await beginOperation(pool,f.task.id,{id:operationId,kind:"delegation",name:"agents.delegate",request:childRequests,reservedTokens:0,reservedMs:60000});
    const children=await admitChildren(pool,f.task.id,operationId,childRequests);
    try{
      const early=await evidence.joinChildren(f.task.id,operationId);expect(early.parents).toEqual([]);expect(early.evidenceIds).toEqual([]);
      const childId=children[0]!.taskId,readId=`knowledge:${childId}:initial`;
      await beginOperation(pool,childId,{id:readId,kind:"tool",name:"knowledge.search",request:{query:"opening"},reservedTokens:0,reservedMs:30000,retrySafe:true});
      const observation=await businessOptions.knowledgeRuntime!.search(childId,readId,"opening");
      const payload={messages:[{role:"user",content:JSON.stringify(observation)}]};
      await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[`context:${childId}:0`,childId,textDigest(JSON.stringify(payload)),payload]);
      await evidence.supplyContext(childId,`context:${childId}:0`,observation.passages.map(passage=>passage.evidenceId));
      await evidence.derive(childId,"child_result",childId);
      await finishOperation(pool,childId,readId,"completed",observation,null,0);await settleTask(pool,childId,{state:"completed",output:"Confirmed source-backed result."});
      await expect(evidence.joinChildren(f.task.id,operationId)).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
      const original=(await pool.query("SELECT parents,evidence_ids FROM agents_platform.evidence_nodes WHERE id=$1",[early.id])).rows[0];expect(original).toEqual({parents:[],evidence_ids:[]});
    }finally{
      for(const child of children)await settleTask(pool,child.taskId,{state:"cancelled"});
      await finishOperation(pool,f.task.id,operationId,"failed",null,"TEST_CLEANUP",0);await settleTask(pool,f.task.id,{state:"cancelled"});
    }
  },30000);
  it("waits for fresh authority when a prepared compaction cannot yet be admitted", async () => {
    const f = await fixture({ context: { maxInputTokens: 4096, compactAtTokens: 1024 } , sourceRevisionIds: [] });
    await execute(f.task.id);
    for (let index = 0; index < 2; index++) {
      const prior = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: `Earlier ${index} ` + "facts ".repeat(80) });
      await execute(prior.task.id);
    }
    calls.length = 0;
    const next = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: "Continue" });
    provider = async body => reply(body.messages[0].content.startsWith("Summarize") ? "Earlier opening hours were confirmed nine." : "Continued after renewal.");
    const held=holdPreparedContext(next.task.id,true);
    try {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
      await held.ready;
      await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()+interval '500 milliseconds' WHERE id=$1", [f.grant.id]);
      await eventually(async () => (await pool.query("SELECT expires_at<=clock_timestamp() AS expired FROM agents_platform.execution_grants WHERE id=$1", [f.grant.id])).rows[0].expired);
      held.release();
      await eventually(async () => (await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [next.task.id])).rows[0].state === "waiting_authority");
      expect(calls).toHaveLength(0);
      const replacement = { ...f.grant, id: randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
      await store.createGrant({ accountId: f.account.id, grant: replacement });
      await pool.query("UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1 WHERE id=$1", [next.task.id, replacement.id]);
      const resumed = await fetch(`${ingressUrl}/${WORKFLOW_NAME}/${next.task.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: 0 }) });
      expect(resumed.ok, await resumed.text()).toBe(true);
      expect((await execute(next.task.id)).state).toBe("completed");
      expect(calls.filter(call => call.messages[0]!.content?.startsWith("Summarize"))).toHaveLength(1);
    } finally { held.restore(); }
  }, 30_000);
  it("replays a completed compaction without repeating its model request after worker restart", async () => {
    const f = await fixture({ context: { maxInputTokens: 4096, compactAtTokens: 1024 } });
    await execute(f.task.id);
    for (let index = 0; index < 2; index++) {
      const t = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: `Earlier request ${index} ` + "facts ".repeat(80) }); await execute(t.task.id);
    }
    calls.length = 0;
    const next = await store.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: f.task.conversation_id, input: "Continue from the earlier work" });
    let release!: () => void;
    provider = async (body, request) => {
      if (body.messages[0].content.startsWith("Summarize")) return reply("Earlier opening-hours requests confirmed nine; retain source identity.");
      await new Promise<void>((resolve, reject) => { release = resolve; request.signal?.addEventListener("abort", () => reject(new Error("worker attempt ended")), { once: true }); });
      return reply("Continued");
    };
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    await eventually(async () => calls.some(c => c.messages[0]!.content?.startsWith("Summarize")) && calls.length >= 2);
    const before = (await pool.query("SELECT id,output FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction' AND state='completed'", [next.task.id])).rows;
    expect(before.length).toBeGreaterThan(0);
    const compactions = (await pool.query("SELECT request FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction'", [next.task.id])).rows;
    const snapshots = (await pool.query("SELECT digest,payload,source_references FROM agents_platform.context_snapshots WHERE task_id=$1", [next.task.id])).rows;
    for (const compaction of compactions) {
      const snapshot = snapshots.find(row => row.digest === modelRequestDigest(compaction.request));
      expect(snapshot, "Every compaction model request has its own persisted context snapshot").toBeDefined();
      expect(snapshot.payload.messages).toEqual(compaction.request.messages);
      expect(snapshot.source_references.length).toBeGreaterThan(0);
    }
    await restart();
    const task = await execute(next.task.id); release?.();
    expect(task.state).toBe("uncertain");
    expect(calls.filter(c => c.messages[0]!.content?.startsWith("Summarize"))).toHaveLength(before.length);
    expect((await pool.query("SELECT id,output FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction' AND state='completed'", [next.task.id])).rows).toEqual(before);
  }, 30_000);
});
