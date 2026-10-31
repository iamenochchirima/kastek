import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer as httpServer } from "node:http";
import { access } from "node:fs/promises";
import { createServer as portServer } from "node:net";
import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, terminalTaskStates, type AgentConfiguration } from "../src/contracts/contracts";
import { HARNESS_RELEASE, WORKFLOW_NAME, ADAPTIVE_HARNESS_RELEASE, ADAPTIVE_WORKFLOW_NAME } from "../src/contracts/execution";
import { EvidenceStore } from "../src/execution/context/evidence";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { loadPlatformConfig } from "../src/infrastructure/config";
import type { ModelFetch } from "../src/infrastructure/model-network";
import { PlatformStore } from "../src/product/agents/store";
import { OrganizationAssistantStore } from "../src/product/agents/organization-assistant";
import { channelWebhookEventSchema } from "../src/contracts/channel-adapters";
import { ChannelStore } from "../src/product/channels/channel-store";
import { ChannelDelivery } from "../src/product/channels/channel-delivery";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { ConnectionVault } from "../src/infrastructure/vault";
import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const binary = process.env.AGENTS_TEST_RESTATE_BINARY;
const suite = databaseUrl && binary ? describe : describe.skip;

suite("organization assistant through app, PostgreSQL and Restate", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  let app: Awaited<ReturnType<typeof buildPlatformApp>>;
  let worker: ReturnType<typeof createServer>;
  let runtime: ChildProcess, directory: string, ingressUrl: string, adminUrl: string;
  let runtimeOutput = "", workerPort = 0;
  const databaseName = `agents_assistant_runtime_${randomUUID().replaceAll("-", "")}`;
  let origin = "http://localhost:3000";
  let browserPort = 0;
  const sessions = new Set<ServerHttp2Session>();
  const requests: any[] = [];
  let fixtureMode: "draft" | "direct" | "clarification" | "child_failure" | "control" | "adaptive" | "stalled" | "adaptive_cancel" | "instruction_burst" | "adaptive_timeout" = "draft";
  let controlTarget = "";
  let adaptiveCallSequence = 0;
  let childBarrier: Promise<void> | null = null;
  const previousEnabled = process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;

  async function eventually<T>(check: () => Promise<T | false>, timeout = 30_000): Promise<T> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const result = await check();
      if (result !== false) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Assistant runtime timed out. ${runtimeOutput.slice(-4000)}`);
  }
  async function freePort() {
    const server = portServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }
  async function listenWorker(workflow: ReturnType<typeof createBusinessWorkflow>, port = 0) {
    worker = createServer(createEndpointHandler({ services: [workflow, workflowForAdaptive()] }));
    worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => worker.listen(port, "127.0.0.1", resolve));
    workerPort = (worker.address() as { port: number }).port;
  }
  async function closeWorker() {
    for (const session of sessions) session.destroy();
    if (worker) await new Promise<void>(resolve => worker.close(() => resolve()));
  }
  function fixtureResponse(body: any) {
    if(fixtureMode==="instruction_burst") return new Response(`data: ${JSON.stringify({id:"controlled-instruction-burst",model:body.model,choices:[{index:0,delta:{role:"assistant",content:"Instructions reviewed."},finish_reason:"stop"}],usage:{prompt_tokens:50,completion_tokens:10}})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
    if (fixtureMode === "adaptive" || fixtureMode === "stalled" || fixtureMode === "adaptive_cancel" || fixtureMode === "adaptive_timeout") {
      const coordinator = body.messages[0].content.startsWith("ADAPTIVE_FIXTURE");
      const records = body.messages.filter((message:any)=>message.role==="tool");
      const named = (name:string) => records.filter((record:any)=>body.messages.some((message:any)=>message.tool_calls?.some((call:any)=>call.id===record.tool_call_id && call.function.name===name))).map((record:any)=>JSON.parse(record.content));
      const stages=named("agents_start");
      const first=stages[0]?.children??[], second=stages[1]?.children??[], revision=named("agents_followup")[0]?.children??[];
      const result = (taskId:string,offset?:number)=>({name:"agents_result",arguments:JSON.stringify({taskId,...(offset===undefined?{}:{offset})})});
      let calls:{name:string;arguments:string}[]=[];
      let content="";
      const call=(name:string,args:unknown)=>({name,arguments:JSON.stringify(args)});
      const checkpointMatch=body.messages.map((message:any)=>message.content??"").join("\n").match(/Server-confirmed execution receipts follow\.[^\n]*\n([^\n]+)/);
      const checkpoint=checkpointMatch?JSON.parse(checkpointMatch[1]):undefined;
      const persisted=named("agents_status").at(-1)?.children??checkpoint?.delegations?.flatMap((group:any)=>group.children)??[];
      if(fixtureMode === "stalled") calls=[call("agents_discover",{})];
      else if(!coordinator) content=body.messages.some((message:any)=>message.content?.includes("Revise"))?"REVISED: The confirmed short draft.":body.messages.some((message:any)=>message.content?.includes("long evidence"))?"L".repeat(5000)+" END_EVIDENCE":"Confirmed independent finding.";
      else if(fixtureMode === "adaptive_timeout") {
        if(!stages.length) calls=[call("agents_start",{requests:[{bindingId:"content",brief:"Optional specialist work"}]})];
        else if(!named("agents_wait").length) calls=[call("agents_wait",{taskIds:[first[0].taskId],mode:"all",timeoutSeconds:1})];
        else if(!named("agents_cancel").length) calls=[call("agents_cancel",{taskId:first[0].taskId})];
        else content="Wait expired; specialist cancelled.";
      }
      else if(fixtureMode === "adaptive_cancel") {
        if(!stages.length) calls=[call("agents_start",{requests:[{bindingId:"content",brief:"First optional check"},{bindingId:"research",brief:"Required independent finding"}]})];
        else if(!named("agents_cancel").length) calls=[call("agents_cancel",{taskId:first[0].taskId})];
        else if(!named("agents_wait").length) calls=[call("agents_wait",{taskIds:[first[1].taskId],mode:"all",timeoutSeconds:30}),result(first[1].taskId)];
        else content="Confirmed remaining specialist result; first task cancelled.";
      }
      else if(coordinator && checkpoint) {
        if(persisted.length<4) calls=[call("agents_status",{})];
        else {
        const original=persisted.find((child:any)=>child.bindingId==="content"),latest=[...persisted].reverse().find((child:any)=>child.bindingId==="content"),review=persisted.find((child:any)=>child.bindingId==="review");
        if(body.messages.some((message:any)=>message.content?.includes("END_EVIDENCE"))) content="SYNTHESIS: Revised draft, independent check and specialist review confirmed.";
        else calls=[call("agents_wait",{taskIds:persisted.map((child:any)=>child.taskId),mode:"all",timeoutSeconds:30}),result(latest.taskId),result(review.taskId),result(original.taskId,4096)];
        }
      }
      else if(!named("agents_discover").length) calls=[call("agents_discover",{})];
      else if(!stages.length) calls=[call("agents_start",{requests:[{bindingId:"content",brief:"Produce long evidence"},{bindingId:"research",brief:"Check the claim"}]}),call("work_update",{expectedRevision:0,record:{objective:"Produce a verified draft",steps:[{id:"draft",title:"Check and revise",state:"in_progress"}],questions:[],evidenceTaskIds:[]}})];
      else if(!named("work_inspect").length) calls=[call("work_inspect",{}),call("agents_status",{taskIds:first.map((child:any)=>child.taskId)})];
      else if(!named("agents_wait").length) calls=[call("agents_wait",{taskIds:first.map((child:any)=>child.taskId),mode:"all",timeoutSeconds:30}),...first.map((child:any)=>result(child.taskId))];
      else if(!revision.length) calls=[call("agents_followup",{taskId:first[0].taskId,brief:"Revise to a short draft"}),call("agents_start",{requests:[{bindingId:"review",brief:"Review the conclusion"}]})];
      else if(named("agents_wait").length<2) calls=[call("agents_wait",{taskIds:[revision[0].taskId,second[0].taskId],mode:"all",timeoutSeconds:30}),result(revision[0].taskId),result(second[0].taskId)];
      else if(!named("agents_result").some((value:any)=>value.nextOffset===null&&value.totalBytes>4096)) calls=[result(first[0].taskId,4096)];
      else content="SYNTHESIS: Revised draft, independent check and specialist review confirmed.";
      const callSequence=adaptiveCallSequence++;
      const delta=calls.length?{role:"assistant",content:null,tool_calls:calls.map((fn,index)=>({index,id:`adaptive-${callSequence}-${index}`,type:"function",function:fn}))}:{role:"assistant",content};
      return new Response(`data: ${JSON.stringify({id:"controlled-adaptive",model:body.model,choices:[{index:0,delta,finish_reason:calls.length?"tool_calls":"stop"}],usage:{prompt_tokens:50,completion_tokens:10}})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
    }
    if (fixtureMode === "control") {
      const steps = body.messages.filter((message: any) => message.role === "tool").length;
      const call = steps === 0 ? { name: "tasks_inspect", arguments: "{}" } : { name: "tasks_cancel", arguments: JSON.stringify({ taskId: controlTarget }) };
      const delta = steps < 2 ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `control-${steps}`, type: "function", function: call }] }
        : { role: "assistant", content: "Cancellation requested." };
      return new Response(`data: ${JSON.stringify({ id: "controlled-task-tools", model: body.model, choices: [{ index: 0, delta, finish_reason: steps < 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    const coordinator = body.messages[0].content.startsWith("COORDINATOR_FIXTURE");
    let content = "DRAFT: A concise launch post.";
    if (fixtureMode === "direct") content = "The fixture request is complete.";
    if (fixtureMode === "clarification") content = "Which audience is this post for?";
    const delegate = coordinator && ["draft", "child_failure"].includes(fixtureMode) && !body.messages.some((message: any) => message.role === "tool");
    const delta = delegate ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "content-draft-call", type: "function",
      function: { name: "agents_delegate", arguments: JSON.stringify({ requests: [{ bindingId: body.tools.find((tool: any) => tool.function?.name === "agents_delegate").function.parameters.properties.requests.items.properties.bindingId.enum[0], brief: "Write a concise launch post. Use only this brief." }] }) } }] }
      : { role: "assistant", content };
    return new Response(`data: ${JSON.stringify({ id: "controlled-assistant-fixture", model: body.model,
      choices: [{ index: 0, delta, finish_reason: delegate ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  }
  function workflowForAdaptive() { return workflow({release:ADAPTIVE_HARNESS_RELEASE,workflow:ADAPTIVE_WORKFLOW_NAME}); }
  function workflow(runtimeConfig?: {release:string;workflow:string}) {
    return createBusinessWorkflow(pool, { evidence: new EvidenceStore(pool), modelProvider: fixtureModelProviders(pool), modelRuntime: {
      dispatch: input => dispatchBoundModel(input, policy => {
        const network = (async (url, request) => {
          if (!policy.authorizeUrl(new URL(String(url)))) throw Error("Fixture destination denied");
          await policy.beforeDispatch?.();
          const body = JSON.parse(String(request?.body)); requests.push(body);
          if (body.messages[0].content.startsWith("CONTENT_FIXTURE") && childBarrier) await childBarrier;
          if (fixtureMode === "child_failure" && body.messages[0].content.startsWith("CONTENT_FIXTURE")) return new Response("Controlled specialist rejection", { status: 400 });
          return fixtureResponse(body);
        }) as ModelFetch;
        network.markProgress = () => {};
        return network;
      }),
    } }, runtimeConfig);
  }
  const runtimeRoutes = () => ({
    [HARNESS_RELEASE]: { ingressUrl, adminUrl, workflowName: WORKFLOW_NAME },
    [ADAPTIVE_HARNESS_RELEASE]: { ingressUrl, adminUrl, workflowName: ADAPTIVE_WORKFLOW_NAME },
  });
  beforeAll(async () => {
    process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = "*";
    expect(execFileSync(binary!, ["--version"], { encoding: "utf8" })).toContain("1.7.13");
    directory = await mkdtemp(join(tmpdir(), "kasitek-assistant-runtime-"));
    const ingress = await freePort(), administration = await freePort(), internal = await freePort();
    ingressUrl = `http://127.0.0.1:${ingress}`; adminUrl = `http://127.0.0.1:${administration}`;
    const template = await readFile(join(__dirname, "scheduling-restate.toml"), "utf8");
    const configFile = join(directory, "restate.toml");
    await writeFile(configFile, `${template}\n[ingress]\nbind-address="127.0.0.1:${ingress}"\n[admin]\nbind-address="127.0.0.1:${administration}"\n`);
    runtime = spawn(binary!, ["--config-file", configFile, "--base-dir", join(directory, "data"), "--bind-address", `127.0.0.1:${internal}`, "--advertised-host", "127.0.0.1", "--node-name", "assistant-fixture", "--no-logo"], { stdio: ["ignore", "pipe", "pipe"] });
    runtime.stdout?.on("data", chunk => { runtimeOutput += chunk.toString(); });
    runtime.stderr?.on("data", chunk => { runtimeOutput += chunk.toString(); });
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } });
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href, max: 10 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
    if (process.env.AGENTS_ASSISTANT_BROWSER === "1" || process.env.AGENTS_ASSISTANT_COMPUTER_USE === "1") { browserPort = await freePort(); origin = `http://127.0.0.1:${browserPort}`; }
    await listenWorker(workflow());
    const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://127.0.0.1:${workerPort}`, force: false }) });
    expect(registration.ok, await registration.text()).toBe(true);
    app = await buildPlatformApp({ pool, logging: false, config: loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href,
      AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_ISSUER_URL: "https://assistant-runtime.fixture.test", AGENTS_OIDC_CLIENT_SECRET: "assistant-controlled-fixture-secret", RESTATE_INGRESS_URL: ingressUrl, RESTATE_ADMIN_URL: adminUrl }) });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    if (previousEnabled === undefined) delete process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;
    else process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = previousEnabled;
    await app?.close();
    await closeWorker();
    if (runtime?.exitCode === null) {
      runtime.kill("SIGTERM");
      await Promise.race([new Promise<void>(resolve => runtime.once("exit", () => resolve())), new Promise<void>(resolve => setTimeout(() => { runtime.kill("SIGKILL"); resolve(); }, 5000))]);
    }
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, databaseName); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 15_000);
  async function fixture() {
    requests.length = 0; fixtureMode = "draft";
    const owner = await store.ensureAccount({ issuer: "https://assistant-runtime.fixture.test", subject: randomUUID(), email: "fixture@example.test", displayName: "Owner" });
    const organization = await store.createOrganization(owner.id, "Private assistant runtime");
    await connectFixtureModel(pool, owner.id, organization.id);
    const session = await store.createSession({ accountId: owner.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 300_000) });
    const cookie = `agents_session=${session.token}`, base = `/api/organizations/${organization.id}`;
    const assistant = (await new OrganizationAssistantStore(pool).getOrganizationAssistant(owner.id, organization.id)).agent!;
    const content = await store.createAgent({ accountId: owner.id, organizationId: organization.id, name: "Content", configuration: {
      ...defaultBusinessConfiguration(), instructions: "CONTENT_FIXTURE: Return a concise text draft from the supplied brief only.",
    } });
    const specialist = await store.createVersion({ accountId: owner.id, organizationId: organization.id, agentId: content.id, expectedRevision: content.draft_revision });
    const configuration: AgentConfiguration = { ...assistant.draft, instructions: "COORDINATOR_FIXTURE: Ask Content to draft the requested post and return its confirmed result.", tools: [...assistant.draft.tools, "agents.delegate"],
      capabilities: { ...assistant.draft.capabilities, delegation: { enabled: true, maxChildren: 2, maxDepth: 1,
        bindings: [{ id: "content", versionId: specialist.id, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 8000, maxActiveMs: 240000 }] } } };
    const configured = await app.inject({ method: "POST", url: `${base}/agents/${assistant.id}/configuration`, headers: { cookie, origin }, payload: { expectedRevision: assistant.draft_revision, configuration, confirmImpact: true } });
    expect(configured.statusCode, configured.body).toBe(200);
    return { owner, organization, assistant, specialist, cookie, base };
  }
  async function admit(f: Awaited<ReturnType<typeof fixture>>, requestKey = randomUUID()) {
    const response = await app.inject({ method: "POST", url: `${f.base}/tasks`, headers: { cookie: f.cookie, origin }, payload: { agentId: f.assistant.id, input: "Draft a launch post", requestKey } });
    expect([200, 202], response.body).toContain(response.statusCode);
    return response.json().task;
  }
  async function finish(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
    return eventually(async () => {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes:runtimeRoutes() });
      const response = await app.inject({ method: "GET", url: `${f.base}/tasks/${taskId}`, headers: { cookie: f.cookie } });
      expect(response.statusCode, response.body).toBe(200);
      const task = response.json().task;
      return terminalTaskStates.has(task.state) ? task : false;
    });
  }
  async function adaptiveFixture() {
    const f=await fixture();
    const current=(await pool.query("SELECT draft,draft_revision FROM agents_platform.agents WHERE id=$1",[f.assistant.id])).rows[0];
    const configuration:AgentConfiguration={...current.draft,program:{id:"tool-directed",version:"4"},instructions:"ADAPTIVE_FIXTURE: Coordinate the requested work with authorized specialists.",
      model:{...current.draft.model,maxOutputTokens:512},context:{maxInputTokens:24000,compactAtTokens:22000},
      tools:["agents.discover","agents.start","agents.status","agents.result","agents.wait","agents.followup","agents.cancel","work.update","work.inspect"],
      capabilities:{...current.draft.capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:1,policy:{maxTasks:8,maxStalls:3},bindings:["content","research","review"].map(id=>({id,label:id,description:`${id} specialist`,versionId:f.specialist.id,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:120000}))}}};
    const specialistConfig={...defaultBusinessConfiguration(),model:{...defaultBusinessConfiguration().model,maxOutputTokens:512},instructions:"CONTENT_FIXTURE: Complete the requested specialist brief."};
    await store.updateDraft({accountId:f.owner.id,organizationId:f.organization.id,agentId:f.specialist.agent_id,expectedRevision:1,configuration:specialistConfig});
    const specialist=await store.createVersion({accountId:f.owner.id,organizationId:f.organization.id,agentId:f.specialist.agent_id,expectedRevision:2});
    const versions=new Map([["content",specialist.id]]);
    for(const name of ["Research","Review"]){
      const agent=await store.createAgent({accountId:f.owner.id,organizationId:f.organization.id,name,configuration:specialistConfig});
      const version=await store.createVersion({accountId:f.owner.id,organizationId:f.organization.id,agentId:agent.id,expectedRevision:agent.draft_revision});
      versions.set(name.toLowerCase(),version.id);
    }
    if(configuration.capabilities.delegation.enabled)for(const binding of configuration.capabilities.delegation.bindings)binding.versionId=versions.get(binding.id)!;
    const configured=await app.inject({method:"POST",url:`${f.base}/agents/${f.assistant.id}/configuration`,headers:{cookie:f.cookie,origin},payload:{expectedRevision:current.draft_revision,configuration,confirmImpact:true}});
    expect(configured.statusCode,configured.body).toBe(200);fixtureMode="adaptive";
    return f;
  }
  it("adaptively discovers, runs background specialists, retrieves full results and revises the same specialist thread", async () => {
    const f=await adaptiveFixture();
    let releaseChildren!:()=>void;childBarrier=new Promise<void>(resolve=>{releaseChildren=resolve;});
    const requestKey=randomUUID(),task=await admit(f,requestKey);
    try {
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
    await eventually(async()=>Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE parent_task_id=$1",[task.id])).rows[0].count)===2);
    await eventually(async()=>(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].state==="waiting_children");
    const instruction=await app.inject({method:"POST",url:`${f.base}/tasks/${task.id}/instructions`,headers:{cookie:f.cookie,origin},payload:{instruction:"Keep the final answer concise.",requestKey:randomUUID()}});
    expect(instruction.statusCode,instruction.body).toBe(200);
    await eventually(async()=>(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].state==="waiting_children");
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()-interval '1 second' WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)",[task.id]);
    await eventually(async()=>(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].state==="waiting_authority");
    const continued=await app.inject({method:"POST",url:`${f.base}/tasks/${task.id}/continue`,headers:{cookie:f.cookie,origin}});
    expect(continued.statusCode,continued.body).toBe(200);
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
    await eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});return requests.some(body=>body.messages[0].content.startsWith("CONTENT_FIXTURE"));});
    } finally { releaseChildren();childBarrier=null; }
    // The next children remain in their durable outbox while the coordinator compacts and waits.
    // Restart the worker only when no model or physical tool operation is in flight.
    await eventually(async()=>{
      const facts=(await pool.query(`SELECT t.state,t.pending_outcome,
        (SELECT count(*)::int FROM agents_platform.tasks c WHERE c.parent_task_id=t.id) AS children,
        EXISTS(SELECT 1 FROM agents_platform.task_events e WHERE e.task_id=t.id AND e.kind='context.compacted') AS compacted,
        EXISTS(SELECT 1 FROM agents_platform.operations o JOIN agents_platform.tasks c ON c.id=o.task_id WHERE c.root_task_id=t.id AND o.state='started') AS active_operation
        FROM agents_platform.tasks t WHERE t.id=$1`,[task.id])).rows[0];
      if(terminalTaskStates.has(facts.state)||facts.pending_outcome) {
        const detail=(await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0];
        throw Error("Coordinator settled before restart barrier: "+JSON.stringify({...detail,pendingOutcome:facts.pending_outcome,operations:(await pool.query("SELECT name,state,error_code FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at",[task.id])).rows}));
      }
      return facts.state==="waiting_children"&&facts.children===4&&facts.compacted&&!facts.active_operation;
    });
    const admittedBeforeRestart=(await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id",[task.id])).rows.map(row=>row.id);
    await closeWorker();await listenWorker(workflow(),workerPort);
    expect((await admit(f,requestKey)).id).toBe(task.id);
    const result=await finish(f,task.id).catch(async error=>{console.error("ADAPTIVE_RUNTIME_STATE",JSON.stringify({tasks:(await pool.query("SELECT id,state,error_code,harness_release,runtime_invocation_id FROM agents_platform.tasks WHERE root_task_id=$1",[task.id])).rows,outbox:(await pool.query("SELECT o.* FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id WHERE t.root_task_id=$1",[task.id])).rows,operations:(await pool.query("SELECT name,state,error_code FROM agents_platform.operations WHERE task_id=$1",[task.id])).rows}));throw error;});
    expect(result,JSON.stringify({state:result.state,errorCode:result.error_code,operations:(await pool.query("SELECT name,state,error_code FROM agents_platform.operations WHERE task_id=$1",[task.id])).rows})).toMatchObject({state:"completed",output:"SYNTHESIS: Revised draft, independent check and specialist review confirmed."});
    const children=(await pool.query(`SELECT t.id,t.state,t.resource_id,t.version_id,t.conversation_id,t.turn_sequence,t.harness_release,d.binding_id,d.prior_task_id FROM agents_platform.tasks t JOIN agents_platform.delegations d ON d.child_task_id=t.id WHERE t.parent_task_id=$1 ORDER BY t.created_at,t.id`,[task.id])).rows;
    expect(children).toHaveLength(4);expect(children.every(child=>child.state==="completed")).toBe(true);
    expect(new Set(children.map(child=>child.resource_id)).size).toBe(3);expect(new Set(children.map(child=>child.version_id)).size).toBe(3);
    expect((await pool.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].root_token_limit).toBe(32000);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_events WHERE task_id=$1 AND kind='specialists.budget_wait'",[task.id])).rows[0].count).toBeGreaterThan(0);
    expect(children.map(child=>child.id).sort()).toEqual(admittedBeforeRestart);
    expect((await pool.query("SELECT count(*)::int AS count,count(DISTINCT id)::int AS distinct_count FROM agents_platform.operations WHERE task_id=$1 AND kind='model'",[task.id])).rows[0]).toEqual({count:requests.filter(body=>body.messages[0].content.startsWith("ADAPTIVE_FIXTURE")).length,distinct_count:requests.filter(body=>body.messages[0].content.startsWith("ADAPTIVE_FIXTURE")).length});
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_events WHERE task_id=$1 AND event_key=$2",[task.id,`terminal:${task.id}`])).rows[0].count).toBe(1);
    expect(new Set(children.map(child=>child.binding_id))).toEqual(new Set(["content","research","review"]));
    const followup=children.find(child=>child.prior_task_id);expect(followup.turn_sequence).toBe("2");expect(followup.conversation_id).toBe(children.find(child=>child.id===followup.prior_task_id).conversation_id);
    expect(children.every(child=>child.harness_release===HARNESS_RELEASE)).toBe(true);
    expect(requests.some(body=>body.messages.some((message:any)=>message.content?.includes("END_EVIDENCE")))).toBe(true);
    expect(requests.some(body=>body.messages.some((message:any)=>message.content?.includes("Keep the final answer concise.")))).toBe(true);
    expect((await pool.query("SELECT revision FROM agents_platform.orchestration_progress WHERE task_id=$1",[task.id])).rows[0].revision).toBe("1");
  },60_000);
  it("lets the model cancel one background specialist without cancelling its sibling or coordinator",async()=>{
    const f=await adaptiveFixture();fixtureMode="adaptive_cancel";
    const task=await admit(f);
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
    await eventually(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='agents.cancel' AND state='completed'",[task.id])).rowCount));
    const result=await finish(f,task.id);
    expect(result).toMatchObject({state:"completed",output:"Confirmed remaining specialist result; first task cancelled."});
    const children=(await pool.query("SELECT state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY state",[task.id])).rows;
    expect(children).toEqual([{state:"cancelled"},{state:"completed"}]);
    expect(requests.filter(body=>body.messages[0].content.startsWith("CONTENT_FIXTURE"))).toHaveLength(1);
  },60_000);

  it("incorporates a burst of member corrections across compaction before closing the task",async()=>{
    const f=await adaptiveFixture();fixtureMode="instruction_burst";
    const task=await admit(f);
    for(let index=0;index<8;index++) {
      const response=await app.inject({method:"POST",url:`${f.base}/tasks/${task.id}/instructions`,headers:{cookie:f.cookie,origin},payload:{instruction:`Correction ${index}: `+"x".repeat(3000),requestKey:randomUUID()}});
      expect(response.statusCode,response.body).toBe(200);
    }
    expect(await finish(f,task.id)).toMatchObject({state:"completed",output:"Instructions reviewed."});
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_events WHERE task_id=$1 AND kind='context.compacted'",[task.id])).rows[0].count).toBeGreaterThan(0);
    const snapshots=(await pool.query("SELECT payload->'instructionGroups' AS groups,source_references FROM agents_platform.context_snapshots WHERE task_id=$1",[task.id])).rows;
    const ids=new Set(snapshots.flatMap(row=>[...(row.groups??[]),...(row.source_references??[])].map((group:any)=>group.id).filter((id:string)=>id.startsWith("instruction:"))));
    expect(ids.size).toBe(8);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[task.id])).rows[0].count).toBe(1);
    const late=await app.inject({method:"POST",url:`${f.base}/tasks/${task.id}/instructions`,headers:{cookie:f.cookie,origin},payload:{instruction:"Too late",requestKey:randomUUID()}});
    expect(late.statusCode).toBe(409);
  },60_000);

  it("persists the actual timed-out specialist wait receipt",async()=>{
    const f=await adaptiveFixture();fixtureMode="adaptive_timeout";
    const task=await admit(f);
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
    const receipt=await eventually(async()=>{
      const row=(await pool.query("SELECT output FROM agents_platform.operations WHERE task_id=$1 AND name='agents.wait' AND state='completed'",[task.id])).rows[0];
      return row?.output??false;
    });
    expect(receipt).toMatchObject({timedOut:true,children:[{state:"accepted",resultAvailable:false}]});
    await eventually(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='agents.cancel' AND state='completed'",[task.id])).rowCount));
    expect(await finish(f,task.id)).toMatchObject({state:"completed",output:"Wait expired; specialist cancelled."});
    expect(requests.filter(body=>body.messages[0].content.startsWith("CONTENT_FIXTURE"))).toHaveLength(0);
  },45_000);

  it("stops a repeated unproductive model loop with a durable stalled outcome",async()=>{
    const f=await adaptiveFixture();fixtureMode="stalled";
    const task=await admit(f);const result=await finish(f,task.id);
    expect(result).toMatchObject({state:"incomplete",errorCode:"ORCHESTRATION_STALLED"});
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operations WHERE task_id=$1 AND name='agents.discover'",[task.id])).rows[0].count).toBe(3);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.tasks WHERE parent_task_id=$1",[task.id])).rows[0].count).toBe(0);
  },45_000);

  (process.env.AGENTS_ASSISTANT_COMPUTER_USE === "1" ? it : it.skip)("holds the real app for computer-use verification",async()=>{
    const f=await adaptiveFixture(),root=resolve(__dirname,"../../../.."),web=resolve(root,"products/agents/web");
    const manifest=resolve(root,".audit/adaptive-computer-use.json"),stop=resolve(root,".audit/adaptive-computer-use.stop");
    await rm(stop,{force:true});
    const endpoint=await app.listen({host:"127.0.0.1",port:0});
    const login=httpServer((request,response)=>{
      if(request.url!=="/__fixture/login"){response.writeHead(404).end();return;}
      response.setHeader("Set-Cookie",`${f.cookie}; Path=/; HttpOnly; SameSite=Lax`);
      response.writeHead(302,{location:`${origin}/app/assistant`});response.end();
    });
    await new Promise<void>(resolve=>login.listen(0,"127.0.0.1",resolve));
    const loginPort=(login.address() as {port:number}).port;
    const frontend=spawn(process.execPath,[resolve(web,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--port",String(browserPort)],{cwd:web,env:{...process.env,AGENTS_API_PROXY_TARGET:endpoint},stdio:["ignore","pipe","pipe"]});
    let frontendOutput="";frontend.stdout?.on("data",chunk=>{frontendOutput+=chunk.toString();});frontend.stderr?.on("data",chunk=>{frontendOutput+=chunk.toString();});
    try{
      await eventually(async()=>{if(frontend.exitCode!==null)throw Error(frontendOutput);try{return(await fetch(origin)).ok;}catch{return false;}});
      await writeFile(manifest,JSON.stringify({loginUrl:`http://127.0.0.1:${loginPort}/__fixture/login`,origin,databaseName,organizationId:f.organization.id,assistantId:f.assistant.id},null,2));
      const until=Date.now()+15*60_000;
      while(Date.now()<until){
        if(await access(stop).then(()=>true,()=>false))return;
        await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error("Computer-use fixture reached its time limit");
    }finally{
      await new Promise<void>(resolve=>login.close(()=>resolve()));
      if(frontend.exitCode===null){frontend.kill("SIGTERM");await new Promise<void>(resolve=>frontend.once("exit",()=>resolve()));}
    }
  },16*60_000);

  it("returns a pinned Content draft through the app once and keeps another member out", async () => {
    const f = await fixture(), key = randomUUID();
    const task = await admit(f, key);
    expect((await admit(f, key)).id).toBe(task.id);
    expect(await finish(f, task.id)).toMatchObject({ state: "completed", output: "DRAFT: A concise launch post." });
    const children = (await pool.query("SELECT id,version_id,principal,state,output FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows;
    expect(children).toEqual([expect.objectContaining({ version_id: f.specialist.id, state: "completed", output: "DRAFT: A concise launch post.", principal: { kind: "human", issuer: f.owner.issuer, subject: f.owner.subject } })]);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages[0].content).toContain("CONTENT_FIXTURE");
    expect(JSON.stringify(requests[1])).not.toContain("fixture-model-key");
    const member = await store.ensureAccount({ issuer: f.owner.issuer, subject: randomUUID(), email: "member@example.test", displayName: "Member" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.organization.id, member.id]);
    const session = await store.createSession({ accountId: member.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 300_000) });
    const denied = await app.inject({ method: "GET", url: `${f.base}/tasks/${task.id}`, headers: { cookie: `agents_session=${session.token}` } });
    expect(denied.statusCode).toBe(403);
    const history = await app.inject({ method: "GET", url: `${f.base}/conversations?agentId=${f.assistant.id}`, headers: { cookie: `agents_session=${session.token}` } });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().conversations).toEqual([]);
    await closeWorker(); await listenWorker(workflow(), workerPort);
    expect((await admit(f, key)).id).toBe(task.id);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes:runtimeRoutes() });
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }, 45_000);
  it.each(["direct", "clarification"] as const)("runs the %s answer without a child", async mode => {
    const f = await fixture(); fixtureMode = mode;
    const task = await admit(f);
    expect(await finish(f, task.id)).toMatchObject({ state: "completed", output: mode === "direct" ? "The fixture request is complete." : "Which audience is this post for?" });
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows).toEqual([]);
  }, 45_000);
  it("cancels accepted app work before model admission", async () => {
    const f = await fixture(), task = await admit(f);
    const response = await app.inject({ method: "POST", url: `${f.base}/tasks/${task.id}/cancel`, headers: { cookie: f.cookie, origin }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(await finish(f, task.id)).toMatchObject({ state: "cancelled" });
    expect(requests).toEqual([]);
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows).toEqual([]);
  }, 45_000);
  it("reports failed specialist work without claiming a successful draft", async () => {
    const f = await fixture(); fixtureMode = "child_failure";
    const task = await admit(f);
    expect(await finish(f, task.id)).toMatchObject({ state: "incomplete", errorCode: "CHILD_PARTIAL_FAILURE" });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows).toEqual([{ state: "failed" }]);
  }, 45_000);

  (process.env.AGENTS_ASSISTANT_BROWSER === "1" ? it : it.skip)("uses the real browser, HTTP API and persisted specialist draft", async () => {
    const requireModule = createRequire(__filename);
    const { chromium, expect: browserExpect } = requireModule("../../web/node_modules/@playwright/test");
    const root = resolve(__dirname, "../../../.."), web = resolve(root, "products/agents/web");
    const artifact = resolve(root, ".audit/organization-assistant-browser");
    const f = await fixture();
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    let browser: any, page: any, frontendOutput = "";
    const frontend = spawn(process.execPath, [resolve(web, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(browserPort)], {
      cwd: web, env: { ...process.env, AGENTS_API_PROXY_TARGET: endpoint }, stdio: ["ignore", "pipe", "pipe"],
    });
    frontend.stdout?.on("data", chunk => { frontendOutput += chunk.toString(); });
    frontend.stderr?.on("data", chunk => { frontendOutput += chunk.toString(); });
    try {
      await eventually(async () => { if (frontend.exitCode !== null) throw Error(frontendOutput); try { return (await fetch(origin)).ok; } catch { return false; } });
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies([{ name: "agents_session", value: f.cookie.slice("agents_session=".length), url: origin }]);
      page = await context.newPage();
      await mkdir(artifact, { recursive: true });
      await page.goto(`${origin}/app/assistant`);
      await browserExpect(page.getByRole("heading", { name: "Assistant", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Configure", exact: true }).click();
      const specialists = page.getByRole("region", { name: "Specialists", exact: true });
      await browserExpect(specialists.getByText("Content · v1", { exact: true })).toBeVisible();
      await specialists.getByRole("button", { name: "Remove", exact: true }).click();
      await specialists.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Content · v1", exact: true }) }).getByRole("button", { name: "Add specialist", exact: true }).click();
      const saved = page.waitForResponse((response: any) => response.url().endsWith(`/agents/${f.assistant.id}/configuration`) && response.request().method() === "POST" && response.status() === 200);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const confirmation = page.getByRole("alertdialog");
      const needsConfirmation = await Promise.race([saved.then(() => false), confirmation.waitFor({ state: "visible" }).then(() => true)]);
      if (needsConfirmation) await confirmation.getByRole("button", { name: "Apply changes", exact: true }).click();
      await saved;
      const configured = await store.getAgent(f.owner.id, f.organization.id, f.assistant.id);
      expect(configured.draft.capabilities.delegation).toMatchObject({ enabled: true, bindings: [{ versionId: f.specialist.id, label: "Content" }] });
      for (const [width, theme] of [[1440, "light"], [768, "dark"], [390, "light"], [390, "dark"]] as const) {
        await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: theme });
        await specialists.scrollIntoViewIfNeeded();
        await specialists.screenshot({ path: resolve(artifact, `specialists-${width}-${theme}.png`), animations: "disabled" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.goto(`${origin}/app/assistant`);
      await page.getByRole("link", { name: "Open chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draft a launch post");
      const admitted = page.waitForResponse((response: any) => response.url().endsWith("/tasks") && response.request().method() === "POST" && response.status() === 202);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const task = (await (await admitted).json()).task;
      expect(await finish(f, task.id)).toMatchObject({ state: "completed", output: "DRAFT: A concise launch post." });
      await browserExpect(page.getByText("DRAFT: A concise launch post.", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      expect((await pool.query("SELECT version_id,state FROM agents_platform.tasks WHERE parent_task_id=$1", [task.id])).rows).toEqual([{ version_id: f.specialist.id, state: "completed" }]);
      await page.reload();
      await browserExpect(page.getByText("DRAFT: A concise launch post.", { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: resolve(artifact, "persisted-private-draft-mobile-dark.png"), fullPage: true, animations: "disabled" });
      const channels = new ChannelStore(pool, new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
      const assetId = String(randomInt(1_000_000, 1_000_000_000));
      await channels.create({ accountId: f.owner.id, organizationId: f.organization.id }, { kind: "telegram", mode: "bot", name: "Browser pairing bot", assetId,
        state: "active", credentials: { botToken: `${assetId}:browser-controlled-fixture`, webhookSecret: "browser-controlled-secret" } });
      const inbox = new InboxStore(pool, { admit: async () => { throw Error("Private pairing entered customer admission"); }, readableOutput: async (_db, _id, text) => text, cancelRoot: async () => undefined });
      const delivery = new ChannelDelivery(pool, channels, inbox, { assertPolicy: async () => undefined, context: () => { throw Error("Browser pairing must not send provider messages"); } });
      await page.goto(`${origin}/app/assistant`);
      const challenged = page.waitForResponse((response: any) => response.url().endsWith("/member-channels/challenges") && response.status() === 200);
      await page.getByRole("button", { name: "Link Browser pairing bot", exact: true }).click();
      const challenge = await (await challenged).json();
      await browserExpect(page.getByText(`/pair ${challenge.token}`, { exact: true })).toBeVisible();
      await delivery.persist("telegram", [channelWebhookEventSchema.parse({ kind: "message", assetId, eventId: randomUUID(), externalConversationId: "27710001111",
        senderId: "27710001111", providerMessageId: randomUUID(), occurredAt: new Date().toISOString(), text: `/pair ${challenge.token}`, privateChat: true })]);
      await browserExpect(page.getByText("27710001111", { exact: true })).toBeVisible();
      await browserExpect(page.getByText(`/pair ${challenge.token}`, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Confirm account", exact: true }).click();
      await browserExpect(page.getByRole("alertdialog")).toContainText("27710001111 on Telegram");
      expect((await pool.query("SELECT state FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows).toEqual([{ state: "pending" }]);
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm account", exact: true }).click();
      await browserExpect(page.getByText("Telegram · Linked", { exact: true })).toBeVisible();
      await page.screenshot({ path: resolve(artifact, "verified-member-link-mobile-dark.png"), fullPage: true, animations: "disabled" });
      await page.getByRole("button", { name: "Unlink", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await pool.query("SELECT state FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows).toEqual([{ state: "active" }]);
      await page.getByRole("button", { name: "Unlink", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Unlink", exact: true }).click();
      await browserExpect(page.getByText("27710001111", { exact: true })).toHaveCount(0);
      expect((await pool.query("SELECT state FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows).toEqual([{ state: "revoked" }]);
    } catch (error) {
      if (page && !page.isClosed()) { await page.screenshot({ path: resolve(artifact, "failure.png"), fullPage: true }); console.error((await page.locator("body").innerText()).slice(0, 4000)); }
      throw error;
    } finally {
      await browser?.close();
      if (frontend.exitCode === null) { frontend.kill("SIGTERM"); await new Promise<void>(resolve => frontend.once("exit", () => resolve())); }
    }
  }, 90_000);

  async function phoneFixture(kind: "telegram" | "whatsapp", adaptive = false) {
    const f = await (adaptive ? adaptiveFixture() : fixture()), sent: { url: string; body: any }[] = [];
    const channels = new ChannelStore(pool, new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
    const scope = { accountId: f.owner.id, organizationId: f.organization.id }, assetId = String(randomInt(1_000_000, 1_000_000_000));
    const connection = await channels.create(scope, { kind, mode: kind === "telegram" ? "bot" : "cloud_api", name: "Controlled private channel", assetId,
      state: "active", credentials: kind === "telegram" ? { botToken: `${assetId}:controlled-fixture`, webhookSecret: "controlled-fixture-secret" } : { accessToken: "controlled-fixture-token" } });
    const inbox = new InboxStore(pool, { admit: async () => { throw Error("Private member ingress entered customer admission"); }, readableOutput: async (_db, _id, text) => text, cancelRoot: async () => undefined });
    const delivery = new ChannelDelivery(pool, channels, inbox, { assertPolicy: async () => undefined,
      context: (_connection, credentials, beforeAttempt) => ({ credential: credentials.botToken ?? credentials.accessToken, apiVersion: "v24.0",
        fetch: async (url, init) => {
          await beforeAttempt();
          sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return kind === "telegram" ? Response.json({ ok: true, result: { message_id: 800 + sent.length } })
            : Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid.controlled.${sent.length}` }] });
        } }),
    });
    const event = (text: string) => channelWebhookEventSchema.parse({ kind: "message", assetId, eventId: randomUUID(), externalConversationId: "27710001111",
      senderId: "27710001111", providerMessageId: randomUUID(), occurredAt: new Date().toISOString(), text, privateChat: true });
    const challengeResponse = await app.inject({ method: "POST", url: `${f.base}/member-channels/challenges`, headers: { cookie: f.cookie, origin }, payload: { connectionId: connection.id } });
    expect(challengeResponse.statusCode, challengeResponse.body).toBe(200);
    const challenge = challengeResponse.json();
    // This verified-event boundary is shared by the real webhook adapters and durable delivery worker.
    expect(await delivery.persist(kind, [event(`/pair ${challenge.token}`)])).toBe(0);
    const pending = await app.inject({ method: "GET", url: `${f.base}/member-channels`, headers: { cookie: f.cookie } });
    expect(pending.json().links).toEqual([expect.objectContaining({ id: challenge.id, state: "pending", senderLabel: "27710001111" })]);
    const confirmation = await app.inject({ method: "POST", url: `${f.base}/member-channels/${challenge.id}/confirm`, headers: { cookie: f.cookie, origin }, payload: {} });
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    const incoming = event("Draft a launch post");
    expect(await delivery.persist(kind, [incoming])).toBe(1);
    expect(await delivery.persist(kind, [incoming])).toBe(0);
    await delivery.drain(8);
    const taskId = (await pool.query("SELECT task_id FROM agents_platform.member_channel_tasks WHERE link_id=$1", [challenge.id])).rows[0]?.task_id;
    expect(taskId).toBeTruthy();
    expect(sent).toHaveLength(1);
    return { ...f, kind, sent, event, delivery, challenge, connection, taskId: taskId as string };
  }
  it.each(["telegram", "whatsapp"] as const)("steers private adaptive %s specialists on the same root and delivers the durable final result", async kind => {
    const f = await phoneFixture(kind, true);
    let release!: () => void; childBarrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes: runtimeRoutes() });
      await eventually(async () => Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE parent_task_id=$1", [f.taskId])).rows[0].count) === 2);
      await eventually(async () => (await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [f.taskId])).rows[0].state === "waiting_children");
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes: runtimeRoutes() });
      await eventually(async () => requests.some(body => body.messages[0].content.startsWith("CONTENT_FIXTURE")));
      const correction = f.event("Keep the final answer concise.");
      expect(await f.delivery.persist(kind, [correction])).toBe(1);
      expect(await f.delivery.persist(kind, [correction])).toBe(0);
      await f.delivery.drain(8);
      expect((await pool.query("SELECT count(*)::int count FROM agents_platform.member_channel_tasks WHERE link_id=$1", [f.challenge.id])).rows[0].count).toBe(1);
      expect((await pool.query("SELECT task_id,instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1", [f.taskId])).rows).toEqual([{ task_id: f.taskId, instruction: "Keep the final answer concise." }]);
      expect(JSON.stringify(f.sent)).toContain("Instructions queued.");
    } finally { release(); childBarrier = null; }
    const completed = await finish(f, f.taskId);
    expect(completed).toMatchObject({ state: "completed", output: "SYNTHESIS: Revised draft, independent check and specialist review confirmed." });
    const children = (await pool.query(`SELECT t.id,t.state,t.resource_id,t.version_id,t.conversation_id,d.prior_task_id FROM agents_platform.tasks t
      JOIN agents_platform.delegations d ON d.child_task_id=t.id WHERE t.parent_task_id=$1`, [f.taskId])).rows;
    expect(children).toHaveLength(4); expect(children.every(child => child.state === "completed")).toBe(true);
    expect(new Set(children.map(child=>child.resource_id)).size).toBe(3);expect(new Set(children.map(child=>child.version_id)).size).toBe(3);
    const revised = children.find(child => child.prior_task_id);
    expect(revised.conversation_id).toBe(children.find(child => child.id === revised.prior_task_id).conversation_id);
    expect(requests.some(body => body.messages.some((message: any) => message.content?.includes("Keep the final answer concise.")))).toBe(true);
    await f.delivery.members.collect(); await f.delivery.drain(16); await f.delivery.drain(16);
    const result = (await pool.query("SELECT state,request FROM agents_platform.channel_outbound WHERE member_link_id=$1 AND member_notice_key=$2", [f.challenge.id, `result:${f.taskId}`])).rows;
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ state: "accepted" });
    expect(result[0].request.text).toBe(completed.output);
    expect(f.sent.filter(send => JSON.stringify(send.body).includes(completed.output))).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.organization.id])).rows[0].count).toBe(0);
  }, 90_000);
  it.each(["telegram", "whatsapp"] as const)("delivers a private %s Content draft and continues the same conversation in app", async kind => {
    const f = await phoneFixture(kind);
    const completed = await finish(f, f.taskId);
    expect(completed).toMatchObject({ state: "completed", output: "DRAFT: A concise launch post." });
    expect((await pool.query("SELECT version_id,state FROM agents_platform.tasks WHERE parent_task_id=$1", [f.taskId])).rows).toEqual([{ version_id: f.specialist.id, state: "completed" }]);
    await f.delivery.members.collect();
    await f.delivery.drain(8);
    await f.delivery.drain(8);
    expect(f.sent).toHaveLength(2);
    expect(JSON.stringify(f.sent[1].body)).toContain("DRAFT: A concise launch post.");
    if (kind === "whatsapp") expect(f.sent[1].url).toContain("/v24.0/");
    const privateRows = (await pool.query("SELECT deployment_id,member_link_id,event FROM agents_platform.channel_ingress WHERE connection_id=$1", [f.connection.id])).rows;
    expect(privateRows).toHaveLength(1);
    expect(privateRows[0]).toMatchObject({ deployment_id: null, member_link_id: f.challenge.id });
    expect(JSON.stringify(privateRows)).not.toContain(f.challenge.token);
    const analytics = (await pool.query("SELECT envelope FROM analytics_outbox WHERE contract_name='agent.assistant.lifecycle@1' AND scope_external_id=$1", [f.organization.id])).rows.map(row => row.envelope);
    expect(new Set(analytics.map(row => row.data.action))).toEqual(new Set(["provisioned", "link_challenge_created", "link_pending", "link_confirmed", "task_admitted", "task_completed"]));
    for (const envelope of analytics) expect(Object.keys(envelope.data).sort()).toEqual(["action", "channel_type", "occurred_at"]);
    for (const privateValue of [f.challenge.token, "27710001111", "Draft a launch post", "controlled-fixture-token", f.owner.subject, f.taskId]) {
      expect(JSON.stringify(analytics)).not.toContain(privateValue);
    }
    const conversation = (await pool.query("SELECT conversation_id FROM agents_platform.member_channel_links WHERE id=$1", [f.challenge.id])).rows[0].conversation_id;
    const history = await app.inject({ method: "GET", url: `${f.base}/conversations?agentId=${f.assistant.id}`, headers: { cookie: f.cookie } });
    expect(history.json().conversations).toEqual([expect.objectContaining({ id: conversation })]);
    fixtureMode = "direct";
    const continuation = await app.inject({ method: "POST", url: `${f.base}/tasks`, headers: { cookie: f.cookie, origin }, payload: {
      agentId: f.assistant.id, conversationId: conversation, input: "Continue this private draft in the app", requestKey: randomUUID(),
    } });
    expect(continuation.statusCode, continuation.body).toBe(202);
    const continued = await finish(f, continuation.json().task.id);
    expect(continued).toMatchObject({ state: "completed", conversationId: conversation });
    expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.organization.id])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE root_task_id=$1", [f.taskId])).rows).toHaveLength(2);
  }, 45_000);
  it.each(["telegram", "whatsapp"] as const)("blocks a queued %s private result when the member unlinks during delegation", async kind => {
    const f = await phoneFixture(kind);
    let release!: () => void;
    childBarrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes:runtimeRoutes() });
      await eventually(async () => requests.some(request => request.messages[0].content.startsWith("CONTENT_FIXTURE")));
      const revoked = await app.inject({ method: "DELETE", url: `${f.base}/member-channels/${f.challenge.id}`, headers: { cookie: f.cookie, origin } });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const repeatedRevoke = await app.inject({ method: "DELETE", url: `${f.base}/member-channels/${f.challenge.id}`, headers: { cookie: f.cookie, origin } });
      expect(repeatedRevoke.statusCode, repeatedRevoke.body).toBe(403);
      expect((await pool.query("SELECT envelope FROM analytics_outbox WHERE scope_external_id=$1 AND contract_name='agent.assistant.lifecycle@1' AND envelope->'data'->>'action'='link_revoked'", [f.organization.id])).rows).toHaveLength(1);
      release(); childBarrier = null;
      await finish(f, f.taskId);
      await f.delivery.members.collect();
      await f.delivery.drain(8);
      expect(f.sent).toHaveLength(1);
      expect(await f.delivery.persist(kind, [f.event("Try the revoked private route")])).toBe(0);
      expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.organization.id])).rows).toEqual([]);
    } finally { release(); childBarrier = null; }
  }, 45_000);
  it.each(["telegram", "whatsapp"] as const)("handles %s status and cancellation without creating another model task", async kind => {
    const f = await phoneFixture(kind);
    expect(await f.delivery.persist(kind, [f.event("/status")])).toBe(1);
    await f.delivery.drain(8);
    expect(JSON.stringify(f.sent.at(-1)?.body)).toContain("Request accepted.");
    const cancellation = f.event("/cancel");
    expect(await f.delivery.persist(kind, [cancellation])).toBe(1);
    expect(await f.delivery.persist(kind, [cancellation])).toBe(0);
    await f.delivery.drain(8);
    expect(JSON.stringify(f.sent.at(-1)?.body)).toContain("Cancellation requested.");
    expect(await finish(f, f.taskId)).toMatchObject({ state: "cancelled" });
    expect(requests).toEqual([]);
    expect((await pool.query("SELECT task_id FROM agents_platform.member_channel_tasks WHERE link_id=$1", [f.challenge.id])).rows).toHaveLength(1);
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1", [f.taskId])).rows).toEqual([]);
    await f.delivery.members.collect(); await f.delivery.drain(8);
    expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.organization.id])).rows).toEqual([]);
  }, 45_000);
  it("lets the model inspect and cancel an earlier authorized task through native tools", async () => {
    const f = await fixture(); fixtureMode = "control";
    const earlier = await admit(f); controlTarget = earlier.id;
    await pool.query("UPDATE agents_platform.task_outbox SET available_at=now()+interval '1 hour' WHERE task_id=$1", [earlier.id]);
    const controller = await admit(f);
    expect(await finish(f, controller.id)).toMatchObject({ state: "completed", output: "Cancellation requested." });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [earlier.id])).rows[0].state).toBe("cancel_requested");
    expect(requests).toHaveLength(3);
    const inspected = requests[1].messages.find((message: any) => message.role === "tool");
    const result = JSON.parse(inspected.content);
    expect(result.tasks).toEqual([expect.objectContaining({ id: earlier.id, state: "accepted" })]);
    expect(Object.keys(result.tasks[0]).sort()).toEqual(["createdAt", "id", "state", "updatedAt"]);
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["tasks_inspect", "tasks_cancel"]));
    expect((await pool.query("SELECT sequence FROM agents_platform.task_events WHERE task_id=$1 AND kind='cancel_requested'", [earlier.id])).rows).toHaveLength(1);
  }, 45_000);
});
