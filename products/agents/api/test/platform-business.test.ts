import { skillPackageCodec } from "../src/capabilities/skills/package";
import { contextGrantCeiling } from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import {countPreparedInput} from "../src/adapters/models/input-count";
import { ModelNetworkError, type ModelFetch } from "../src/infrastructure/model-network";
import {homedir,tmpdir} from "node:os";
import {join} from "node:path";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createServer as createPortServer} from "node:net";
import {SandboxManager} from "../src/capabilities/sandbox/sandbox";
import {createSandboxExecutor} from "../src/capabilities/sandbox/sandbox-executor";
import { createServer as createHttpServer } from "node:http";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { RemoteConnectionStore } from "../src/product/connections/remote-connections";
import { ToolReviewStore } from "../src/capabilities/reviews/tool-reviews";
import {publishFixtureSource} from "./knowledge-fixture";
import { execFileSync,spawn,type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusinessWorkflow, type BusinessOptions } from "../src/execution/business/business";
import { createContextCompactionWorkflow } from "../src/execution/context/compaction-workflow";
import { defaultBusinessConfiguration, terminalTaskStates, type AgentConfiguration, type AdmissionAuthority, type ExecutionGrant } from "../src/contracts/contracts";
import { HARNESS_RELEASE, SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../src/contracts/execution";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { beginOperation, finishOperation, settleTask, requestTreeCancellation, reconcilePendingRoots, WORKFLOW_NAME, loadExecution } from "../src/execution/lifecycle/execution";
import { admitChildren, readChildResults } from "../src/execution/delegation/delegation";
import {ActionService} from "../src/workflows/report-delivery/actions";
import {ConnectionStore} from "../src/product/connections/connections";
import {ConnectionVault} from "../src/infrastructure/vault";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {createReportReceiver,initializeReportReceiver} from "../src/acceptance/report-receiver";
import { KnowledgeStore } from "../src/platform/knowledge/knowledge";
import { KnowledgeRuntime } from "../src/platform/knowledge/knowledge-runtime";
import { EvidenceStore } from "../src/execution/context/evidence";
import { textDigest } from "../src/contracts/source-contracts";
import { MemoryStore } from "../src/platform/memory/memory";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { toolsFor, executeTool } from "../src/capabilities/tools";
import { ProductRuntime } from "../src/execution/products/product-runtime";
import type { ProductResourceScope } from "../src/contracts/resource-scope";
import { SkillPackageStore } from "../src/product/agents/skill-package-store";
import { controlPlatformAdmissions } from "../src/product/agents/platform-admission-control";
import { parseSkillPackage } from "../src/capabilities/skills/package";
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
  let sharedWorkflow: ReturnType<typeof createBusinessWorkflow>;
  let compactionWorkflow: ReturnType<typeof createContextCompactionWorkflow>;
  let businessOptions: BusinessOptions;
  let ingressUrl: string, adminUrl: string;
  let containerStarted = false;
  let native:ChildProcess|undefined,nativeDirectory:string|undefined,nativeOutput="";
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
    throw new Error(`Harness verification timed out: ${nativeOutput.slice(-1000)}`);
  }
  async function listen(port = 0) {
    server = createServer(createEndpointHandler({ services: [workflow,sharedWorkflow,compactionWorkflow] }));
    server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve));
  }
  async function freePort() {
    const server=createPortServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
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
    store = new PlatformStore(pool); memory = new MemoryStore(pool, skillPackageCodec);
    await initializeReportReceiver(pool);
    receiver=createReportReceiver({pool,keys:[{apiKey:receiverKey,resource:"reports:controller"}],afterAccept:async id=>{await afterAccept?.(id);}});
    const address=await receiver.listen({host:"127.0.0.1",port:0});
    const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),targets=[{id:"reports",label:"Reports",url:address+"/deliveries",resource:"reports:controller"}];
    artifacts=new TaskArtifactStore(pool,{async put(key,value){objects.set(key,Buffer.from(value));},async get(key){const value=objects.get(key);if(!value)throw Error("Missing fixture object");return value;},async delete(key){objects.delete(key);}});
    connections=new ConnectionStore(pool,vault,targets);actions=new ActionService(pool,{vault,targets,artifacts});
    businessOptions = {evidence:new EvidenceStore(pool,artifacts.objects),knowledgeRuntime:new KnowledgeRuntime(pool,new EvidenceStore(pool,artifacts.objects)),actions:{prepare:(...args)=>actions.prepare(...args),getReview:async(...args)=>{const review=await actions.getReview(...args);await afterReviewRead?.(review);return review;},reconcile:(...args)=>actions.reconcile(...args),execute:async(...args)=>{inFlightActionCalls++;try{return await actions.execute(...args);}finally{inFlightActionCalls--;}}},selectReportArtifact:(...args)=>artifacts.prepareReport(...args), modelProvider: fixtureModelProviders(pool), modelRuntime: { dispatch: input => dispatchBoundModel(input, policy => {
      const network = (async (url, request) => {
        if (!policy.authorizeUrl(new URL(String(url)))) throw Error("Fixture destination denied");
        await policy.beforeDispatch?.();
        const body = JSON.parse(String(request?.body)); calls.push(body);
        const response = await provider(body, request!);
        if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream") return response;
        const result = await response.json(), choice = result.choices[0];
        const delta = { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call:any,index:number) => ({ ...call,index })) } : {}) };
        return new Response(`data: ${JSON.stringify({ id:result.id, model:body.model, choices:[{index:0,delta,finish_reason:choice.finish_reason}],usage:result.usage })}\n\ndata: [DONE]\n\n`, {headers:{"content-type":"text/event-stream"}});
      }) as ModelFetch;
      network.markProgress = () => {}; return network;
    }) } };
    workflow = createBusinessWorkflow(pool,businessOptions);
    sharedWorkflow = createBusinessWorkflow(pool,businessOptions,{release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME});
    compactionWorkflow=createContextCompactionWorkflow(pool,{modelProvider:businessOptions.modelProvider!,modelRuntime:businessOptions.modelRuntime,evidence:businessOptions.evidence!});
    await listen();
    const port = (server.address() as { port: number }).port;
    const binary=process.env.AGENTS_TEST_RESTATE_BINARY;
    if(binary){
      expect(execFileSync(binary,["--version"],{encoding:"utf8"})).toContain("1.7.13");
      nativeDirectory=await mkdtemp(join(tmpdir(),"kasitek-business-test-"));
      const ingress=await freePort(),administration=await freePort(),internal=await freePort();
      ingressUrl=`http://127.0.0.1:${ingress}`;adminUrl=`http://127.0.0.1:${administration}`;
      const config=join(nativeDirectory,"restate.toml"),template=await readFile(join(__dirname,"scheduling-restate.toml"),"utf8");
      await writeFile(config,`${template}\n[ingress]\nbind-address="127.0.0.1:${ingress}"\n[admin]\nbind-address="127.0.0.1:${administration}"\n`);
      native=spawn(binary,["--config-file",config,"--base-dir",join(nativeDirectory,"data"),"--bind-address",`127.0.0.1:${internal}`,"--advertised-host","127.0.0.1","--node-name","business-fixture","--no-logo"],{stdio:["ignore","pipe","pipe"]});
      native.stdout?.on("data",chunk=>{nativeOutput=(nativeOutput+String(chunk)).slice(-5000);});native.stderr?.on("data",chunk=>{nativeOutput=(nativeOutput+String(chunk)).slice(-5000);});
    }else{
      docker("run", "-d", "--name", containerName, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway",
        "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13");
      containerStarted = true;
      ingressUrl = `http://${docker("port", containerName, "8080/tcp")}`; adminUrl = `http://${docker("port", containerName, "9070/tcp")}`;
    }
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } });
    const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: `http://${binary?"127.0.0.1":"host.docker.internal"}:${port}`, force: false }) });
    expect(registration.ok, await registration.text()).toBe(true);
  }, 60_000);
  afterAll(async () => {
    for (const session of sessions) session.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (containerStarted) docker("rm", "-f", containerName);
    if(native&&native.exitCode===null){native.kill("SIGTERM");await new Promise<void>(resolve=>native!.once("exit",()=>resolve()));}
    if(nativeDirectory)await rm(nativeDirectory,{recursive:true,force:true});
    await receiver?.close();
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin,databaseName); await admin.end(); }
  });
  async function fixture(changes: Partial<AgentConfiguration> = {}, rootTokenLimit = 32000, sourceContent = "Opening hours. Open at nine.") {
    provider = async () => reply(); calls.length = 0;
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/test", subject: randomUUID(), email: "fixture@example.com", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Harness fixture");
    await connectFixtureModel(pool, account.id, org.id);
    const source = await publishFixtureSource(pool,{ accountId: account.id, organizationId: org.id, title: "Hours", content: sourceContent, visibility: "public" }, artifacts.objects);
    const config = { ...defaultBusinessConfiguration(), sourceRevisionIds: [source.id], ...changes };
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: version.id,
      operations: config.memory.enabled ? ["model.reply", "knowledge.read", "memory.read", "memory.propose"] : ["model.reply", "knowledge.read"],
      sourceRevisionIds: config.sourceRevisionIds, connectedToolBindingIds: config.connectedToolBindingIds, maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(config), rootTokenLimit, expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    const request = { authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "What are the opening hours?" };
    const { task } = await store.admitTask(request);
    return { task, grant, request, account, org, agent, config, source,
      managed: { accountId: account.id, organizationId: org.id, agentId: agent.id },
      scoped: { organizationId: org.id, agentId: agent.id, principal: authority.principal } };
  }
  function runtimeRoutes() {
    return { [HARNESS_RELEASE]:{ingressUrl,adminUrl,workflowName:WORKFLOW_NAME},
      [SHARED_HARNESS_RELEASE]:{ingressUrl,adminUrl,workflowName:SHARED_WORKFLOW_NAME} };
  }
  async function execute(taskId: string) {
    const routes=runtimeRoutes();
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes:routes });
    return eventually(async () => { await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:routes}); const row = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0]; return terminalTaskStates.has(row.state) ? row : false; });
  }
  it("runs the saved provider through the real Restate business workflow and private continuation store", async () => {
    const f = await fixture({ sourceRevisionIds: [], instructions: "Reply with a greeting." });
    provider = async () => reply("Hello from the configured provider.");
    const result = await execute(f.task.id);
    expect(result.state).toBe("completed"); expect(result.output).toBe("Hello from the configured provider.");
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT state FROM agents_platform.private_model_continuations WHERE task_id=$1", [f.task.id])).rows).toEqual([{state:"completed"}]);
    expect((await pool.query("SELECT state FROM agents_platform.model_cost_reservations WHERE task_id=$1", [f.task.id])).rows).toEqual([{state:"settled"}]);
  });
  it("continues a configured native tool round through the shared business workflow", async () => {
    const f = await fixture({ sourceRevisionIds: [], instructions: "Search approved knowledge, then reply.", tools: ["knowledge.search"] });
    let round = 0;
    provider = async body => {
      if (++round === 1) return reply("", "tool_calls", [tool("knowledge_search", { query: "opening hours" }, "native-tool-round")]);
      expect(body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "native-tool-round")).toBe(true);
      return reply("No approved opening hours were found.");
    };
    const result = await execute(f.task.id);
    expect(result.state).toBe("completed"); expect(round).toBe(2);
    expect((await pool.query("SELECT state FROM agents_platform.private_model_continuations WHERE task_id=$1", [f.task.id])).rows).toEqual([{state:"completed"},{state:"completed"}]);
    expect((await pool.query("SELECT unknown_operations FROM agents_platform.root_model_accounts WHERE root_task_id=$1", [f.task.id])).rows[0].unknown_operations).toBe(0);
  });
  it("waits durably for an exact connected-tool review, restarts, then sends once and retains authoritative evidence", async () => {
    const f=await fixture(); await execute(f.task.id); calls.length=0;
    let effects=0;
    const mcp=createHttpServer(async(request,response)=>{
      if(request.method!=="POST"){response.writeHead(405).end();return;}
      let body="";for await(const chunk of request)body+=chunk;
      const message=JSON.parse(body);response.setHeader("content-type","application/json");
      const send=(result:unknown)=>response.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
      if(message.method==="initialize")send({protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"review-fixture",version:"1"}});
      else if(message.method==="notifications/initialized")response.writeHead(202).end();
      else if(message.method==="tools/list")send({tools:[{name:"record_request",description:"Record one approved request",inputSchema:{type:"object",required:["message"],additionalProperties:false,properties:{message:{type:"string"}}}}]});
      else if(message.method==="tools/call"){effects++;send({content:[{type:"text",text:"Provider receipt: request confirmed."}],structuredContent:{id:"confirmed-1"}});}
      else response.end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Unsupported method"}}));
    });
    await new Promise<void>(resolve=>mcp.listen(0,"127.0.0.1",resolve));
    try {
      const endpoint=`http://127.0.0.1:${(mcp.address() as {port:number}).port}/mcp`,scope={accountId:f.account.id,organizationId:f.org.id};
      const remote=new RemoteConnectionStore(pool,connections.vault,{callbackUrl:"http://localhost/callback",testLoopback:true});
      const connection=await remote.create(scope,{operationId:randomUUID(),endpoint,authentication:"none"});
      const discovered=await remote.discover(scope,connection.id,connection.generation);
      expect(discovered.candidate).toBeDefined();
      const [binding]=await remote.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:discovered.connection.revision,
        catalogId:discovered.candidate!.catalog.id,selections:[{providerOperation:"record_request",resources:[{kind:"mcp.endpoint",id:endpoint}]}]});
      const reviews=new ToolReviewStore(pool),evidence=new EvidenceStore(pool,artifacts.objects);
      businessOptions.connected=new ConnectedExecutor(pool,connections,artifacts.objects,evidence,{resolveRemoteEndpoint:remote.resolveRemoteEndpoint.bind(remote),genericReview:reviews.port()});
      businessOptions.toolReviews=reviews;
      const configuration={...f.config,program:{id:"grounded-conversation",version:"1"} as const,connectedToolBindingIds:[binding!.id]};
      const draft=await store.updateDraft({...f.managed,configuration,expectedRevision:1}),version=await store.createVersion({...f.managed,expectedRevision:draft.draft_revision});
      const grant:ExecutionGrant={...f.grant,id:randomUUID(),versionId:version.id,operations:[...f.grant.operations,"connected.read","connected.execute"],connectedToolBindingIds:[binding!.id]};
      await store.createGrant({accountId:f.account.id,grant});
      const admitted=await store.admitTask({...f.request,grantId:grant.id,versionId:version.id,requestKey:randomUUID()});
      let steps=0;
      provider=async body=>{
        steps++;
        if(steps===1)return reply("","tool_calls",[tool(binding!.alias,{message:"Please record this request"},"approved-operation")]);
        expect(JSON.stringify(body.messages)).toContain("Provider receipt: request confirmed.");
        return reply("The provider confirmed the request.");
      };
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl});
      const review=await eventually(async()=>{
        await dispatchTasksOnce(pool,{ingressUrl,adminUrl});
        const row=(await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[admitted.task.id])).rows[0];
        const pending=await reviews.list(scope,admitted.task.id);return row?.state==="waiting_review"&&pending.length?pending[0]!:false;
      });
      expect(effects).toBe(0);
      expect((await pool.query("SELECT count(*) FROM agents_platform.connected_attempts a JOIN agents_platform.connected_reads r ON r.operation_id=a.operation_id WHERE r.task_id=$1",[admitted.task.id])).rows[0].count).toBe("0");
      await restart();
      await reviews.decide(scope,review.id,{decision:"approve",requestDigest:review.requestDigest});
      const settled=await execute(admitted.task.id);
      expect(settled.state,settled.error_code).toBe("completed");expect(effects).toBe(1);expect(steps).toBe(2);
      expect((await reviews.list(scope,admitted.task.id))[0]!.state).toBe("completed");
      expect((await pool.query("SELECT count(*) FROM agents_platform.evidence_contents c JOIN agents_platform.evidence_references r ON r.id=c.reference_id WHERE r.task_id=$1 AND c.binding_id=$2",[admitted.task.id,binding!.id])).rows[0].count).toBe("1");
    }finally {
      businessOptions.connected=undefined;businessOptions.toolReviews=undefined;
      mcp.closeAllConnections();await new Promise<void>(resolve=>mcp.close(()=>resolve()));
    }
  },60000);
  it("loads reviewed skill metadata first, activates instructions and exact files without memory, and restores them after compaction", async () => {
    const f = await fixture(); await execute(f.task.id); calls.length = 0;
    const packages = new SkillPackageStore(pool), pkg = parseSkillPackage({ files: [
      { path: "SKILL.md", content: "---\nname: opening-procedure\ndescription: Check the opening-hours response procedure when answering hours.\n---\nACTIVATED_PROCEDURE: Read references/hours.md before answering the hours question." },
      { path: "references/hours.md", content: "LOADED_REFERENCE: The source evidence must establish that doors open at nine." },
      { path: "references/large.md", content: "OVERSIZED_REFERENCE:" + "x".repeat(50000) },
    ] });
    const installed = await packages.import(f.managed, randomUUID(), pkg); await packages.review(f.managed, installed.id, installed.contentDigest);
    const configuration = { ...f.config, skillIds: [installed.id], memory: { enabled: false }, context: { maxInputTokens: 32768, compactAtTokens: 18000 } };
    const draft = await store.updateDraft({ ...f.managed, configuration, expectedRevision: 1 });
    const version = await store.createVersion({ ...f.managed, expectedRevision: draft.draft_revision });
    expect(version.tool_bindings.map(binding => binding.name)).toEqual(expect.arrayContaining(["skills.activate", "skills.read"]));
    const grant: ExecutionGrant = { ...f.grant, id: randomUUID(), versionId: version.id, rootTokenLimit: null,
      maxContextTokens: contextGrantCeiling(configuration), operations: ["model.reply", "knowledge.read", "skill.read"] };
    await store.createGrant({ accountId: f.account.id, grant });
    const request = { ...f.request, versionId: version.id, grantId: grant.id, requestKey: randomUUID() };
    const limitedGrant: ExecutionGrant = { ...grant, id: randomUUID(), operations: ["model.reply", "knowledge.read"] };
    await expect(store.createGrant({ accountId: f.account.id, grant: limitedGrant })).rejects.toMatchObject({ code: "GRANT_CAPABILITY_DENIED" });
    const admitted = await store.admitTask(request);
    await expect(executeTool(pool, memory, admitted.task.id, "before-activation", "skills.read", JSON.stringify({ skillId: installed.id, path: "references/hours.md" }))).rejects.toMatchObject({ code: "SKILL_ACTIVATION_REQUIRED" });
    await expect(executeTool(pool, memory, admitted.task.id, "foreign-skill", "skills.activate", JSON.stringify({ skillId: randomUUID() }))).rejects.toMatchObject({ code: "SKILL_SCOPE_DENIED" });
    let regular = 0, compacted = 0;
    let markBackground!:()=>void,releaseBackground!:()=>void,backgroundFinished=false;
    const backgroundStarted=new Promise<void>(resolve=>{markBackground=resolve;});
    const backgroundHeld=new Promise<void>(resolve=>{releaseBackground=resolve;});
    provider = async body => {
      if (body.messages[0].content.startsWith("Summarize")) {
        compacted++;markBackground();await backgroundHeld;backgroundFinished=true;
        return reply("The approved procedure and supporting reference were loaded; opening evidence confirms nine.");
      }
      regular++;
      const system = body.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
      const references = body.messages.filter((message: any) => message.role === "user").map((message: any) => message.content).join("\n");
      expect(body.tools.map((entry: any) => entry.function.name)).toEqual(expect.arrayContaining(["skills_activate", "skills_read"]));
      expect(body.tools.map((entry: any) => entry.function.name)).not.toContain("memory_search");
      if (regular === 1) { expect(system).toContain("opening-procedure"); expect(system).not.toContain("ACTIVATED_PROCEDURE"); expect(system).not.toContain("LOADED_REFERENCE"); return reply("", "tool_calls", [tool("skills_activate", { skillId: installed.id }, "activate-procedure")]); }
      expect(system).toContain("ACTIVATED_PROCEDURE");
      if (regular === 2) { expect(system).not.toContain("LOADED_REFERENCE"); return reply("", "tool_calls", [tool("skills_read", { skillId: installed.id, path: "references/hours.md" }, "read-procedure-reference")]); }
      expect(system).not.toContain("LOADED_REFERENCE");
      expect(references).toContain("LOADED_REFERENCE");
      expect(references).toContain("untrusted reference data");
      expect(system).not.toContain("OVERSIZED_REFERENCE");
      if (regular === 3) return reply("", "tool_calls", [tool("skills_read", { skillId: installed.id, path: "references/large.md" }, "oversized-reference")]);
      if (regular === 4) return reply("", "tool_calls", [tool("knowledge_search", { query: "opening" }, "verify-opening-evidence")]);
      await backgroundStarted;
      expect(backgroundFinished).toBe(false);
      setTimeout(releaseBackground,750);
      return reply("The approved procedure confirms that doors open at nine.");
    };
    const task = await execute(admitted.task.id).finally(releaseBackground);
    expect(task.state, task.error_code).toBe("completed"); expect(regular).toBe(5); expect(compacted).toBeGreaterThan(0);
    const background=(await pool.query("SELECT state FROM agents_platform.operations WHERE task_id=$1 AND id LIKE $2",[admitted.task.id,`background:${admitted.task.id}:%`])).rows;
    expect(background).toEqual([{state:"completed"}]);
    const receipts = (await pool.query("SELECT name,state,output,error_code FROM agents_platform.operations WHERE task_id=$1 AND name IN ('skills.activate','skills.read') ORDER BY started_at", [admitted.task.id])).rows;
    expect(receipts.map(row => row.state)).toEqual(["completed", "completed", "completed"]); expect(receipts[1].output.evidence.path).toBe("references/hours.md");
    expect(receipts[2].output.content).toContain("OVERSIZED_REFERENCE");
    expect(receipts[2].output.range.nextOffset).toBeGreaterThan(0);
    const snapshots = (await pool.query("SELECT step,source_references,payload FROM agents_platform.context_snapshots WHERE task_id=$1 AND step>=0 ORDER BY step", [admitted.task.id])).rows;
    expect(snapshots[0].source_references).toContainEqual(expect.objectContaining({ id: installed.id, metadataOnly: true, packageDigest: pkg.contentDigest }));
    const last = snapshots.at(-1)!;
    expect(last.source_references.filter((reference: any) => reference.skillFile).map((reference: any) => reference.skillFile.path)).toEqual(expect.arrayContaining(["SKILL.md", "references/hours.md"]));
    expect(last.source_references.every((reference: any) => !reference.skillFile || reference.skillFile.packageDigest === pkg.contentDigest)).toBe(true);
  }, 30_000);
  it("bootstraps a reviewed product skill for a human without standalone membership", async () => {
    const f=await fixture({sourceRevisionIds:[],tools:[]});await settleTask(pool,f.task.id,{state:"cancelled"});
    const tenantId=randomUUID(),actor={issuer:"https://growth.fixture.test",subject:randomUUID()},service={issuer:"https://growth.fixture.test",clientId:"growth-api"};
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,$3,$4)",[tenantId,f.org.id,service.clientId,service.issuer]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id) VALUES('growth',$1,'assistant',$2,$3,$4)",[tenantId,f.org.id,f.agent.id,f.task.version_id]);
    const scope:ProductResourceScope={kind:"product_feature",product:"growth",tenantId,organizationId:f.org.id,agentId:f.agent.id,actor,service,authority:"manage"};
    const packages=new SkillPackageStore(pool),pkg=parseSkillPackage({files:[{path:"SKILL.md",content:"---\nname: product-procedure\ndescription: Use the reviewed product response procedure.\n---\nPRODUCT_SKILL_INSTRUCTIONS: Reply using this reviewed procedure."}]});
    const installed=await packages.import(scope,randomUUID(),pkg);await packages.review(scope,installed.id,installed.contentDigest);
    const providers=fixtureModelProviders(pool),selection=(await providers.getDefault({accountId:f.account.id,organizationId:f.org.id})).selection!;
    await providers.grant({accountId:f.account.id,organizationId:f.org.id},{connectionId:selection.connectionId,consumer:{kind:"agent",agentId:f.agent.id},roles:["primary","compaction","delegated"],modelIds:[selection.modelId]});
    const configuration={...f.config,skillIds:[installed.id],model:{...f.config.model,selection}};
    const draft=await store.updateDraft({...f.managed,configuration,expectedRevision:1}),version=await store.createVersion({...f.managed,expectedRevision:draft.draft_revision});
    await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$3 WHERE product='growth' AND tenant_id=$1 AND agent_id=$2",[tenantId,f.agent.id,version.id]);
    const grantId=randomUUID(),principal={kind:"human" as const,...actor};
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
      VALUES($1,'growth',$2,'assistant','growth-api',$3,$4,$5,$6,$7,$8,NULL,now()+interval '5 minutes')`,[grantId,f.org.id,principal,version.id,JSON.stringify(["model.reply","knowledge.read","skill.read"]),configuration.model.maxInputBytes,configuration.model.maxOutputTokens,contextGrantCeiling(configuration)]);
    await pool.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)",[grantId,f.org.id,service.issuer,"a".repeat(64)]);
    const {task}=await store.admitTask({authority:{product:"growth",organizationId:f.org.id,resourceId:"assistant",callerClientId:"growth-api",principal},grantId,versionId:version.id,requestKey:randomUUID(),input:"Use the product response procedure."});
    await pool.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,title) VALUES($1,'growth',$2,'assistant','Product skill')",[task.conversation_id,tenantId]);
    await pool.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,command_digest) VALUES($1,'growth',$2,'assistant',$3,$4)",[task.id,tenantId,task.conversation_id,"a".repeat(64)]);
    expect((await pool.query("SELECT 1 FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[actor.issuer,actor.subject])).rowCount).toBe(0);
    const runtime=new ProductRuntime(pool);runtime.registerOriginAuthorizer("growth",async(_taskId,db)=>{
      expect((await db.query("SELECT revoked_at FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1",[tenantId])).rows[0].revoked_at).toBeNull();
    });
    businessOptions.product=runtime;let rounds=0;
    provider=async body=>{rounds++;const system=body.messages.filter((message:any)=>message.role==="system").map((message:any)=>message.content).join("\n");
      if(rounds===1){expect(system).toContain("Current agent capabilities");expect(system).toContain("product-procedure");expect(system).not.toContain("PRODUCT_SKILL_INSTRUCTIONS");return reply("","tool_calls",[tool("skills_activate",{skillId:installed.id},"activate-product-skill")]);}
      expect(system).toContain("PRODUCT_SKILL_INSTRUCTIONS");return reply("Product procedure loaded.");};
    try{
      const result=await execute(task.id);expect(result.state,result.error_code).toBe("completed");expect(rounds).toBe(2);
      expect((await pool.query("SELECT state FROM agents_platform.operations WHERE task_id=$1 AND name='skills.activate'",[task.id])).rows).toEqual([{state:"completed"}]);
    }finally{businessOptions.product=undefined;}
  },30000);
  (process.env.AGENTS_SANDBOX_VERIFY==="1"?it:it.skip)("runs a reviewed skill through published activation and real isolated Python without loading script source",async()=>{
    const f=await fixture();await execute(f.task.id);calls.length=0;
    const packages=new SkillPackageStore(pool),pkg=parseSkillPackage({files:[
      {path:"SKILL.md",content:"---\nname: packaged-analysis\ndescription: Compute the exact total from the reviewed package data.\n---\nPACKAGED_ANALYSIS: Run scripts/total.py with skills_run. Use the resulting total and report receipt."},
      {path:"scripts/total.py",content:"import json,os\nfrom total_helper import sum_values\nvalues=json.load(open('references/numbers.json'))\ntotal=sum_values(values)\nopen(os.environ['OUTPUT_DIR']+'/total.json','w').write(json.dumps({'total':total}))\nprint('Authoritative computed total:',total)\n"+"# CODE_SOURCE_NOT_IN_CONTEXT\n".repeat(200)},
      {path:"references/numbers.json",content:"[20,30,10]"},{path:"scripts/total_helper.py",content:"def sum_values(values):\n return sum(values)\n"}]});
    const installed=await packages.import(f.managed,randomUUID(),pkg);await packages.review(f.managed,installed.id,installed.contentDigest);
    const configuration:AgentConfiguration={...f.config,skillIds:[installed.id],memory:{enabled:false},tools:["sandbox.analyze"],capabilities:{...f.config.capabilities,sandbox:{enabled:true,profileId:"python-analysis-v1"}}};
    const draft=await store.updateDraft({...f.managed,configuration,expectedRevision:1}),version=await store.createVersion({...f.managed,expectedRevision:draft.draft_revision});
    expect(version.tool_bindings.map(binding=>binding.name)).toContain("skills.run");
    const grant:ExecutionGrant={...f.grant,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","skill.read","sandbox.execute","artifact.read","artifact.write"]};await store.createGrant({accountId:f.account.id,grant});
    const admitted=await store.admitTask({...f.request,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Compute the reviewed package total."});
    const directory=join(homedir(),".cache/kasitek-agents-sandbox",`test-${randomUUID()}`),manager=new SandboxManager(pool,{directory,runsc:join(homedir(),".cache/kasitek-agents-sandbox/gvisor/runsc"),rootfs:join(homedir(),".cache/kasitek-agents-sandbox/python-rootfs")});
    const previous=businessOptions.executeSandbox;businessOptions.executeSandbox=createSandboxExecutor(pool,manager,artifacts.objects);
    let rounds=0;
    provider=async body=>{rounds++;expect(JSON.stringify(body.messages)).not.toContain("CODE_SOURCE_NOT_IN_CONTEXT");expect(body.tools.map((entry:any)=>entry.function.name)).toContain("skills_run");
      if(rounds===1)return reply("","tool_calls",[tool("skills_activate",{skillId:installed.id},"activate-analysis")]);
      expect(JSON.stringify(body.messages)).toContain("PACKAGED_ANALYSIS");
      if(rounds===2)return reply("","tool_calls",[tool("skills_run",{skillId:installed.id,path:"scripts/total.py"},"run-analysis")]);
      expect(JSON.stringify(body.messages)).toContain("Authoritative computed total: 60");return reply("The computed total is 60. The report was generated from the reviewed package.");};
    try{expect(await manager.available()).toBe(true);const task=await execute(admitted.task.id);expect(task.state,task.error_code).toBe("completed");expect(rounds).toBe(3);expect(task.output).toContain("total is 60");
      const receipts=(await pool.query("SELECT * FROM agents_platform.operations WHERE task_id=$1 AND name='skills.run'",[task.id])).rows;expect(receipts).toHaveLength(1);expect(receipts[0].kind).toBe("resource");expect(receipts[0].state).toBe("completed");expect(receipts[0].output.skill.packageDigest).toBe(pkg.contentDigest);
      expect((await pool.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='skills.read'",[task.id])).rowCount).toBe(0);expect((await pool.query("SELECT state FROM agents_platform.sandbox_allocations WHERE task_id=$1",[task.id])).rows).toEqual([{state:"destroyed"}]);
      const report=await artifacts.download(f.account.id,f.org.id,task.id,receipts[0].output.artifacts[0].id);expect(JSON.parse(Buffer.from(report.content).toString())).toEqual({total:60});
    }finally{businessOptions.executeSandbox=previous;for(const row of(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE task_id=$1 AND state<>'destroyed'",[admitted.task.id])).rows)await manager.destroy({organizationId:row.organization_id,rootTaskId:row.root_task_id,taskId:row.task_id,deadlineAt:new Date(row.lease_expires_at)},row.id);await rm(directory,{recursive:true,force:true});}
  },45000);
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
  async function researchFixture(enableMemory=false,specialistTokens=8000,specialistOutputTokens=4096) {
    const f=await fixture(); await settleTask(pool,f.task.id,{state:"cancelled"});
    const versions=[];
    for(const name of ["FIRST","SECOND"]) {
      const agent=await store.createAgent({accountId:f.account.id,organizationId:f.org.id,name,configuration:{...defaultBusinessConfiguration(),instructions:`SPECIALIST_${name}: Answer from the provided source.`,model:{...defaultBusinessConfiguration().model,maxOutputTokens:specialistOutputTokens},sourceRevisionIds:[f.source.id],tools:["knowledge.search","knowledge.read"]}});
      versions.push(await store.createVersion({accountId:f.account.id,organizationId:f.org.id,agentId:agent.id,expectedRevision:1}));
    }
    const config:AgentConfiguration={...defaultBusinessConfiguration(),instructions:"ROOT_RESEARCH: Delegate work to both approved specialists, then synthesize their confirmed evidence.",memory:{enabled:enableMemory},sourceRevisionIds:[f.source.id],tools:["agents.delegate"],
      capabilities:{...defaultBusinessConfiguration().capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:versions.map((version,index)=>({id:index===0?"first":"second",versionId:version.id,sourceRevisionIds:[f.source.id],connectedToolBindingIds:[],tools:["knowledge.search"],maxTokens:specialistTokens,maxActiveMs:240000}))}}};
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
    await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});
    return eventually(async()=>{const task=(await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(task.state!=="waiting_review"){
        if(terminalTaskStates.has(task.state))throw new Error(`Expected report review; task settled ${task.state} (${task.error_code??"no error code"})`);
        return false;
      }
      const action=(await pool.query("SELECT id FROM agents_platform.actions WHERE task_id=$1",[taskId])).rows[0];return action?actions.getReview(taskId,action.id):false;});
  }
  async function finishWithControls(taskId:string) {
    const routes=runtimeRoutes();
    return eventually(async()=>{await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:routes});const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return terminalTaskStates.has(task.state)?task:false;});
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
  it("rejects malformed native results before model context while retaining the actual completed receipt",async()=>{
    const f=await fixture({tools:["knowledge.search"]}),runtime=businessOptions.knowledgeRuntime!,original=runtime.search.bind(runtime);
    const malformed={profile:"lexical-v1",passages:[],omitted:"invalid",privateMarker:"DO_NOT_EXPOSE_TO_MODEL"};
    runtime.search=(async(...args:Parameters<KnowledgeRuntime["search"]>)=>args[1].startsWith("tool:")?malformed:original(...args)) as KnowledgeRuntime["search"];
    provider=async()=>reply("","tool_calls",[tool("knowledge_search",{query:"hours"})]);
    try{
      expect(await execute(f.task.id)).toMatchObject({state:"incomplete",error_code:"CAPABILITY_RESULT_INVALID",output:null});
      expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).not.toContain("DO_NOT_EXPOSE_TO_MODEL");
      const receipt=(await pool.query("SELECT state,output FROM agents_platform.operations WHERE task_id=$1 AND id LIKE 'tool:%'",[f.task.id])).rows[0];
      expect(receipt).toMatchObject({state:"completed",output:malformed});
    }finally{resetGrounding();}
  },30000);
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
  it("drains root admissions during report rollback and reconciles an accepted effect exactly once",async()=>{
    const f=await reportFixture(),review=await waitForReview(f.task.id);
    let accepted=false,posts=0,release!:()=>void,paused=false,admissionRevision=Number((await pool.query("SELECT revision FROM agents_platform.platform_admission_gate WHERE id=1")).rows[0].revision);const blocked=new Promise<void>(resolve=>{release=resolve;});
    const actor="platform-operator-test";
    afterAccept=async id=>{if(id===review.id){posts++;accepted=true;await blocked;}};
    try {
      await actions.decide(f.scope,f.task.id,review.id,{operationId:randomUUID(),decision:"approve",expectedDigest:review.reviewDigest});
      await dispatchTasksOnce(pool,{ingressUrl,adminUrl,runtimeRoutes:runtimeRoutes()});await eventually(async()=>accepted);

      const before=Number((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.org.id])).rows[0].n);
      const drained=await controlPlatformAdmissions(pool,{action:"drain",actor,reason:"Report capability rollback",expectedRevision:admissionRevision});paused=true;admissionRevision=drained.revision;
      expect(drained).toMatchObject({acceptingRoots:false,changed:true});

      // New work will use this rollback version after the operator reopens root admissions.
      const rollbackConfiguration:AgentConfiguration={...f.config,capabilities:{...f.config.capabilities,workflows:{enabled:false}}};
      const draft=await store.updateDraft({...f.managed,configuration:rollbackConfiguration,expectedRevision:1});
      const rollback=await store.createVersion({...f.managed,expectedRevision:draft.draft_revision});
      expect(rollback.id).not.toBe(f.task.version_id);
      expect((rollback.configuration as AgentConfiguration).capabilities.workflows.enabled).toBe(false);
      const grant:ExecutionGrant={...f.grant,id:randomUUID(),versionId:rollback.id,operations:["model.reply","knowledge.read"],
        sourceRevisionIds:rollbackConfiguration.sourceRevisionIds,connectedToolBindingIds:rollbackConfiguration.connectedToolBindingIds};
      await store.createGrant({accountId:f.account.id,grant});
      const newRequest={...f.request,grantId:grant.id,versionId:rollback.id,requestKey:randomUUID()};
      await expect(store.admitTask(newRequest)).rejects.toMatchObject({code:"PLATFORM_ADMISSIONS_PAUSED"});
      expect(Number((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.org.id])).rows[0].n)).toBe(before);
      expect(await store.admitTask(f.request)).toMatchObject({replayed:true,task:{id:f.task.id}});

      await restart();
      const result=await eventually(async()=>{const task=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];return terminalTaskStates.has(task.state)?task:false;});
      expect(result.state).toBe("completed");expect(posts).toBe(1);expect(calls).toHaveLength(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(1);
      expect((await actions.getReview(f.task.id,review.id)).state).toBe("delivered");

      const resumed=await controlPlatformAdmissions(pool,{action:"resume",actor,reason:"Rollback recovery verified",expectedRevision:admissionRevision});paused=false;admissionRevision=resumed.revision;
      expect(resumed).toMatchObject({acceptingRoots:true,changed:true});
      const newTask=await store.admitTask(newRequest);
      expect(newTask.task.version_id).toBe(rollback.id);
      expect((await execute(newTask.task.id)).state).toBe("completed");
      expect(posts).toBe(1);expect((await pool.query("SELECT count(*)::int AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[review.id])).rows[0].count).toBe(1);
    } finally {
      release();afterAccept=undefined;await eventually(async()=>inFlightActionCalls===0);
      if(paused)await controlPlatformAdmissions(pool,{action:"resume",actor,reason:"Test cleanup",expectedRevision:admissionRevision});
    }
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
  it("lets an accepted root finish two specialists during a drain and charges the root tree exactly once",async()=>{
    const f=await researchFixture(false,12000,512); researchProvider();
    const originalProvider=provider;let releasedBeforeChildModel=0;
    provider=async(body,request)=>{
      if(!body.messages[0].content.startsWith("ROOT_RESEARCH")){
        const parent=(await pool.query("SELECT o.state,c.state AS capacity_state FROM agents_platform.operations o JOIN agents_platform.capacity_requests c ON c.id=o.id WHERE o.task_id=$1 AND o.kind='delegation'",[f.task.id])).rows;
        expect(parent).toEqual([{state:'completed',capacity_state:'released'}]);releasedBeforeChildModel++;
      }
      return originalProvider(body,request);
    };
    let paused=false,admissionRevision=Number((await pool.query("SELECT revision FROM agents_platform.platform_admission_gate WHERE id=1")).rows[0].revision);
    try{
      const drained=await controlPlatformAdmissions(pool,{action:"drain",actor:"platform-operator-test",reason:"Verify accepted root and child work continues during drain",expectedRevision:admissionRevision});paused=true;admissionRevision=drained.revision;
      expect(drained).toMatchObject({acceptingRoots:false,changed:true});
      expect((await pool.query("SELECT accepting_roots FROM agents_platform.platform_admission_gate WHERE id=1")).rows[0]).toEqual({accepting_roots:false});
      const outcome=await execute(f.task.id);
      const childStates=(await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY state,error_code",[f.task.id])).rows;
      expect(childStates).toEqual([{state:"completed",error_code:null},{state:"completed",error_code:null}]);
      expect({state:outcome.state,error_code:outcome.error_code}).toEqual({state:"completed",error_code:null});
      expect(outcome.output).toBe("Both approved specialists confirm opening at nine.");
    }finally{
      provider=originalProvider;
      if(paused)await controlPlatformAdmissions(pool,{action:"resume",actor:"platform-operator-test",reason:"Specialist drain case complete",expectedRevision:admissionRevision});
    }
    expect(releasedBeforeChildModel).toBe(2);expect(calls).toHaveLength(4);
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
    const modelObservation=JSON.parse(resultMessage.content!);
    expect(modelObservation.children.map((child:any)=>child.bindingId)).toEqual(["first","second"]);
    expect(modelObservation.interpretation).toContain("agent-reported");
    expect(modelObservation.children.every((child:any)=>child.reportAssessment.correctness==="not_assessed")).toBe(true);
    expect(modelObservation.children[0].authorizedScope.meaning).toContain("Permitted scope only");
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
    const f=await researchFixture();const children=await admitChildren(pool,f.task.id,randomUUID(),{requests:[{bindingId:"first",brief:"Use the intentionally narrowed trusted scope.",maxTokens:6000,sourceRevisionIds:[],connectedToolBindingIds:[]}]});
    const child=(await pool.query("SELECT root_token_limit,effective_configuration,grant_id FROM agents_platform.tasks WHERE id=$1",[children[0]!.taskId])).rows[0];
    expect(child.root_token_limit).toBe(6000);expect(child.effective_configuration.sourceRevisionIds).toEqual([]);expect(child.effective_configuration.tools).toEqual(["knowledge.search"]);
    const grant=(await pool.query("SELECT root_token_limit,source_revision_ids FROM agents_platform.execution_grants WHERE id=$1",[child.grant_id])).rows[0];expect(grant).toEqual({root_token_limit:6000,source_revision_ids:[]});
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
  it("persists a known model response after a transient receipt failure without repeating the model",async()=>{
    const f=await fixture(),suffix=f.task.id.replaceAll('-',''),sequence=`receipt_retry_${suffix}`,fn=`receipt_failure_${suffix}`,trigger=`receipt_trigger_${suffix}`;
    await pool.query(`CREATE SEQUENCE agents_platform.${sequence};
      CREATE FUNCTION agents_platform.${fn}() RETURNS trigger LANGUAGE plpgsql AS $receipt$
      BEGIN IF NEW.operation_id='model:${f.task.id}:0' AND nextval('agents_platform.${sequence}')=1 THEN RAISE EXCEPTION 'Injected receipt serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $receipt$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON agents_platform.operation_usage FOR EACH ROW EXECUTE FUNCTION agents_platform.${fn}();`);
    try{
      expect(await execute(f.task.id)).toMatchObject({state:'completed',output:'Open at nine.'});expect(calls).toHaveLength(1);
      expect((await pool.query('SELECT count(*)::int n FROM agents_platform.operation_usage WHERE operation_id=$1',[`model:${f.task.id}:0`])).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT last_value FROM agents_platform.${sequence}`)).rows[0].last_value).toBe('2');
    }finally{await pool.query(`DROP TRIGGER ${trigger} ON agents_platform.operation_usage;DROP FUNCTION agents_platform.${fn}();DROP SEQUENCE agents_platform.${sequence};`);}
  },30000);
  for(const state of ['completed','uncertain'] as const)it(`never reports a conflicting existing ${state} model receipt as fresh success`,async()=>{
    const f=await fixture(),stored={message:{role:'assistant',content:'Previously recorded answer'},usage:{inputTokens:5,outputTokens:2}};
    provider=async()=>{
      const operation=(await pool.query("SELECT * FROM agents_platform.operations WHERE task_id=$1 AND kind='model'",[f.task.id])).rows[0];
      await finishOperation(pool,f.task.id,operation.id,state,state==='completed'?stored:null,state==='uncertain'?'PREVIOUS_OUTCOME_UNCERTAIN':null,state==='completed'?7:operation.reserved_tokens,operation.attempt_id);
      return reply('Conflicting new answer');
    };
    expect(await execute(f.task.id)).toMatchObject({state:'uncertain',output:null});expect(calls).toHaveLength(1);
    const receipt=(await pool.query("SELECT state,output FROM agents_platform.operations WHERE task_id=$1 AND kind='model'",[f.task.id])).rows[0];
    expect(receipt).toMatchObject({state,output:state==='completed'?stored:null});
  },30000);
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
  it.each([400, 429, 500, 503])("accounts definitive versus uncertain provider HTTP %i outcomes", async status => {
    const f = await fixture(); provider = async () => new Response("private provider detail", { status });
    const outcome = await execute(f.task.id); expect(outcome.state).toBe(status === 500 ? "uncertain" : "failed");
    if (status === 503) expect(outcome.error_code).toBe("MODEL_PROVIDER_UNAVAILABLE");
    expect(calls).toHaveLength(1);
    if (status === 503) expect((await pool.query("SELECT state,error_code FROM agents_platform.operations WHERE task_id=$1 AND kind='model'", [f.task.id])).rows[0])
      .toEqual({ state: "failed", error_code: "MODEL_PROVIDER_UNAVAILABLE" });
    const charged = (await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens;
    expect(status === 500 ? charged > 0 : charged === 0).toBe(true);
  }, 30_000);
  it("settles an HTTP 200 SSE provider 503 as failed without retrying the model request", async () => {
    const f = await fixture();
    provider = async () => new Response(`data: ${JSON.stringify({ error: { code: 503, message: "PRIVATE_PROVIDER_DETAIL" } })}\n\n`, {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
    const outcome = await execute(f.task.id);
    expect(outcome).toMatchObject({ state: "failed", error_code: "MODEL_PROVIDER_UNAVAILABLE", output: null });
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT state,error_code FROM agents_platform.operations WHERE task_id=$1 AND kind='model'", [f.task.id])).rows[0])
      .toEqual({ state: "failed", error_code: "MODEL_PROVIDER_UNAVAILABLE" });
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes: runtimeRoutes() });
    expect(calls).toHaveLength(1);
  }, 30_000);
  it("keeps an HTTP 503 failed when its response body is interrupted and never replays it", async () => {
    const f = await fixture();
    provider = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"message":"PRIVATE_PROVIDER_DETAIL"}'));
      controller.error(new ModelNetworkError("NETWORK_UNAVAILABLE", true));
    } }), { status: 503, headers: { "content-type": "application/json" } });
    const outcome = await execute(f.task.id);
    expect(outcome).toMatchObject({ state: "failed", error_code: "MODEL_PROVIDER_UNAVAILABLE", output: null });
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT state,error_code FROM agents_platform.operations WHERE task_id=$1 AND kind='model'", [f.task.id])).rows[0])
      .toEqual({ state: "failed", error_code: "MODEL_PROVIDER_UNAVAILABLE" });
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(0);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, runtimeRoutes: runtimeRoutes() });
    expect(calls).toHaveLength(1);
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
  it("rejects admission when the configured model call exceeds the root allowance", async () => {
    await expect(fixture({ instructions: "Mandatory policy ".repeat(100) }, 2048)).rejects.toMatchObject({ code: "MODEL_POLICY_INVALID" });
    expect(calls).toHaveLength(0);
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
    const reviewed = { id: `tool:${f.task.id}:reviewed`, kind: "tool" as const, name: "fixture.reviewed_write",
      request: { bindingDigest:"a".repeat(64),productReviewId:"opaque-product-review",productReviewDigest:"b".repeat(64) },
      reservedTokens:0,reservedMs:1000,retrySafe:false,reconcile:true };
    const initial=await beginOperation(pool,f.task.id,reviewed);
    expect(initial.replayed).toBe(false);expect(initial.recovering).not.toBe(true);
    const recovery=await beginOperation(pool,f.task.id,reviewed);
    expect(recovery.replayed).toBe(false);expect(recovery.recovering).toBe(true);
    expect(recovery.operation.id).toBe(initial.operation.id);expect(recovery.operation.attempt_id).not.toBe(initial.operation.attempt_id);
    const reserved=(await pool.query("SELECT tool_calls,active_reserved_ms FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0];
    expect(reserved.tool_calls).toBe(1);expect(Number(reserved.active_reserved_ms)).toBe(1000);
    await finishOperation(pool,f.task.id,reviewed.id,"completed",{receipt:"authoritative-product-reconciliation"},null,0,recovery.operation.attempt_id);
    expect((await beginOperation(pool,f.task.id,reviewed)).operation).toMatchObject({state:"completed",output:{receipt:"authoritative-product-reconciliation"}});
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.operation_usage WHERE operation_id=$1",[reviewed.id])).rows[0].count)).toBe(1);
    const unknown = { ...input, id: input.id + ':unknown' };
    await beginOperation(pool, f.task.id, unknown);
    expect((await beginOperation(pool, f.task.id, unknown)).operation.state).toBe("uncertain");
    await settleTask(pool, f.task.id, { state: "uncertain" }); expect(calls).toHaveLength(0);
  });
  it("enforces root allocation atomically across competing operations", async () => {
    const f = await fixture({}, 16000);
    const claim = (suffix: string) => beginOperation(pool, f.task.id, { id: `budget:${f.task.id}:${suffix}`, kind: "model", name: "generate",
      request: { suffix }, reservedTokens: 10000, reservedMs: 1000 });
    const outcomes = await Promise.allSettled([claim("a"), claim("b")]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(o => o.status === "rejected")).toMatchObject({ reason: { code: "ROOT_LIMIT" } });
    await settleTask(pool, f.task.id, { state: "uncertain" });
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(10000);
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
  function nearLimitToolConfiguration(inputBudget=7600):Partial<AgentConfiguration>{
    const config=defaultBusinessConfiguration();config.tools=["knowledge.search"];config.instructions="Use approved knowledge and preserve issued evidence identifiers. ";
    const request:ModelRequest={model:"nvidia/nemotron-3-super-120b-a12b",maxInputTokens:8192,maxOutputTokens:config.model.maxOutputTokens,maxDurationSeconds:config.model.maxDurationSeconds,
      messages:[{role:"system",content:config.instructions},{role:"user",content:"What are the opening hours?"}],tools:toolsFor(config)};
    // Leave room for the native protocol envelope and the initial source record.
    config.instructions+="p".repeat(inputBudget-estimateRequestTokens(request));
    return{instructions:config.instructions,tools:config.tools,context:{maxInputTokens:8192,compactAtTokens:4096}};
  }
  it("compacts a single complete overflowing tool group and replays its evidence without spending again",async()=>{
    const sourceContent=JSON.stringify({hours:"Open at nine",note:'Opening "quoted" hours\nnext line'});
    const f=await fixture(nearLimitToolConfiguration(7200),32000,sourceContent);
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
      if(calls.length===1){
        const route=(await loadExecution(pool,f.task.id)).models.primary;
        const counted=await countPreparedInput(route,body,async()=>{throw Error("Fixture counting must not use network");});
        expect(counted.precision).toBe("serialized_bytes_estimate");expect(counted.tokens).toBeLessThanOrEqual(route.policy.maxInputTokens);
        return reply("","tool_calls",[tool("knowledge_search",{query:"opening"})]);
      }
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
