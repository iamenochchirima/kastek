/** Owned integration fixture. Harbor owns the trial, environment, verifier and reward. */
import {dropClosedTestDatabase} from "./support/database-cleanup";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { publishFixtureSource } from "./knowledge-fixture";
import { prepareHarborAnalysis } from "./harbor-analysis-support";
import { prepareHarborConnector,type HarborConnectorPurpose } from "./harbor-connector-support";
import { prepareHarborWorker } from "./harbor-worker-support";
import { HARNESS_RELEASE,SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME,WORKFLOW_NAME } from "../src/contracts/execution";

const root = resolve(__dirname, "../../../.."), api = join(root, "products/agents/api");
const fixtureId = randomUUID(), databasePrefix = process.env.AGENTS_HARBOR_DATABASE_PREFIX ?? "agents_harbor";
const databaseName = `${databasePrefix}_${fixtureId.replaceAll("-", "")}`;
if (process.env.AGENTS_HARBOR_DATABASE_PREFIX) {
  assert.ok(process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL, "Eval-prefixed fixture runs require an explicit eval database URL");
  assert.notEqual(process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL, process.env.AGENTS_DATABASE_URL, "Eval database must differ from the product database");
  assert.ok(databaseName.startsWith(`${process.env.AGENTS_HARBOR_DATABASE_PREFIX}_`), "Eval database name must use the configured prefix");
  assert.equal(process.env.AGENTS_BILLING_ENFORCEMENT, "0", "Eval-prefixed fixture runs must disable billing enforcement");
}
const containerName = `agents-harbor-${fixtureId}`, build = join(root, ".audit", `harbor-${fixtureId}`);
const compiled = join(build, "runtime");
const suite = process.env.AGENTS_HARBOR_SUITE ?? "faq-grounded";
assert.ok(["faq-grounded", "faq-follow-up", "research-report", "controlled-transaction", "controlled-transaction-conflict", "delegated-research", "inbox", "isolated-analysis", "faq-unknown", "faq-private", "faq-paraphrase", "faq-paraphrase-v2", "faq-paraphrase-v3", "faq-withdrawal", "faq-escalation", "inbox-takeover", "faq-connected-skill", "customer-service-connected-skill", "booking-policy-connected-skill", "research-connected-skill", "campaign-research-connected-skill"].includes(suite), "Select a known Harbor suite");
const connectorPurpose=(suite.endsWith("-connected-skill")?suite.slice(0,-"-connected-skill".length):undefined) as HarborConnectorPurpose|undefined;
const escalation = suite === "faq-escalation", takeover = suite === "inbox-takeover";
const inboxSuite = suite === "inbox" || escalation || takeover, analysisSuite = suite === "isolated-analysis";
const followUp = ["faq-follow-up", "inbox"].includes(suite), report = ["research-report", "controlled-transaction", "controlled-transaction-conflict", "delegated-research"].includes(suite);
const delegated = suite === "delegated-research";
const negativeKnowledge = ["faq-unknown", "faq-private"].includes(suite), withdrawal = suite === "faq-withdrawal";
const attempts = Number(process.env.AGENTS_HARBOR_ATTEMPTS ?? "1");
assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 4, "Harbor repetitions are bounded to one through four fresh scopes");
assert.ok(attempts === 1 || !(report || inboxSuite || analysisSuite || withdrawal || connectorPurpose), "Repeated fixture acceptance currently supports isolated FAQ cases");
const lifecycle = process.env.AGENTS_HARBOR_LIFECYCLE ?? "none";
assert.ok(["none","native-restart","evaluator-restart","cancel"].includes(lifecycle));
assert.ok(lifecycle==="none" || (attempts===1 && ["faq-grounded","faq-follow-up"].includes(suite)), "Lifecycle fixtures use one dedicated FAQ trial");
const verifierScenario = process.env.AGENTS_HARBOR_VERIFIER_TEST ?? "none";
assert.ok(["none","assertion","exception","missing-evidence"].includes(verifierScenario));
assert.ok(verifierScenario==="none" || (suite==="faq-grounded" && attempts===1), "Verifier failure probes use one ordinary FAQ execution");
const realModel = process.env.AGENTS_HARBOR_REAL_MODEL === "1";
assert.ok(!connectorPurpose||process.env.AGENTS_HARBOR_REAL_MODEL!=="1","Connector acceptance uses deterministic provider fixtures, not a quality benchmark");
const modelKey = realModel ? process.env.OPENROUTER_API_KEY : randomBytes(32).toString("base64url");
assert.ok(!realModel || lifecycle==="none","Lifecycle acceptance uses deterministic provider fixtures");
assert.ok(!realModel || verifierScenario==="none", "Verifier failure probes never call a live model");
assert.ok(modelKey, "Approved free-model acceptance requires the configured key");
let pool: Pool | undefined, admin: Pool | undefined, storage: ChildProcess | undefined, harbor: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof import("../src/composition/app")["buildPlatformApp"]>> | undefined;
let dispatcher: ReturnType<typeof import("../src/execution/lifecycle/dispatcher")["startDispatcher"]> | undefined;
let worker: ReturnType<typeof createServer> | undefined;
let receiver: ReturnType<typeof import("../src/acceptance/report-receiver")["createReportReceiver"]> | undefined;
let verifierBridge: ReturnType<typeof httpServer> | undefined;
let approvalTimer: ReturnType<typeof setInterval> | undefined, approvalPending: Promise<void> | undefined;
let processWorker:Awaited<ReturnType<typeof prepareHarborWorker>>|undefined;
let connector:Awaited<ReturnType<typeof prepareHarborConnector>>|undefined;
let analysis: Awaited<ReturnType<typeof prepareHarborAnalysis>> | undefined;
let ownedRuntime = false, privateDirectory: string | undefined;
const orphanProjects=new Set<string>();
let releaseProvider:(()=>void)|undefined;
const sessions = new Set<ServerHttp2Session>(), abort = new AbortController();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
async function availablePort() {
  const server = httpServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function ready(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Fixture readiness failed: ${label}`);
}
async function stop(process: ChildProcess | undefined) {
  if (process?.pid && process.exitCode === null && process.signalCode === null) { process.kill("SIGTERM"); await once(process, "exit"); }
}
async function main() {
  await mkdir(compiled, { recursive: true, mode: 0o700 });
  execFileSync(process.execPath, [join(api, "node_modules/typescript/bin/tsc"), "-p", join(api, "tsconfig.json"), "--outDir", compiled], { cwd: root, stdio: "inherit", timeout: 60000 });
  await cp(join(api, "schema"), join(build, "schema"), { recursive: true });
  // Native ESM imports also need a filesystem package resolution path; NODE_PATH is CommonJS only.
  await symlink(join(api,"node_modules"),join(compiled,"node_modules"),"dir");
  // The isolated CommonJS build resolves the same pinned workspace dependencies.
  process.env.NODE_PATH = join(api, "node_modules"); require("node:module").Module._initPaths();
  const load = (path: string) => require(join(compiled, path));
  const { setupPlatformSchema } = load("composition/setup.js") as typeof import("../src/composition/setup");
  const { PlatformStore } = load("product/agents/store.js") as typeof import("../src/product/agents/store");
  const { requestDigest } = load("contracts/contracts.js") as typeof import("../src/contracts/contracts");
  const { defaultBusinessConfiguration } = load("contracts/contracts.js") as typeof import("../src/contracts/contracts");
  const { customerConfiguration } = load("product/offerings/offerings.js") as typeof import("../src/product/offerings/offerings");
  const { buildPlatformApp } = load("composition/app.js") as typeof import("../src/composition/app");
  const { loadPlatformConfig } = load("infrastructure/config.js") as typeof import("../src/infrastructure/config");
  const { privateStoreFromEnvironment } = load("infrastructure/object-store.js") as typeof import("../src/infrastructure/object-store");
  const { EvidenceStore } = load("execution/context/evidence.js") as typeof import("../src/execution/context/evidence");
  const { KnowledgeRuntime } = load("capabilities/knowledge/knowledge-runtime.js") as typeof import("../src/capabilities/knowledge/knowledge-runtime");
  const { createBusinessWorkflow } = load("execution/business/business.js") as typeof import("../src/execution/business/business");
  const { ModelProviderStore } = load("product/model-providers/store.js") as typeof import("../src/product/model-providers/store");
  const { ModelCredentialVault } = load("infrastructure/model-credential-vault.js") as typeof import("../src/infrastructure/model-credential-vault");
  const { ConnectionVault } = load("infrastructure/vault.js") as typeof import("../src/infrastructure/vault");
  const { builtinProviderRegistry } = load("adapters/models/registry.js") as typeof import("../src/adapters/models/registry");
  const { dispatchBoundModel } = load("execution/models/dispatch.js") as typeof import("../src/execution/models/dispatch");
  const { startDispatcher } = load("execution/lifecycle/dispatcher.js") as typeof import("../src/execution/lifecycle/dispatcher");
  const { actionsFromEnvironment } = load("composition/actions.js") as typeof import("../src/composition/actions");
  const { TaskArtifactStore } = load("execution/artifacts/task-artifacts.js") as typeof import("../src/execution/artifacts/task-artifacts");
  const { createReportReceiver, initializeReportReceiver } = load("acceptance/report-receiver.js") as typeof import("../src/acceptance/report-receiver");
  const databaseUrl = process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL ?? process.env.AGENTS_DATABASE_URL;
  assert.ok(databaseUrl, "Fixture requires an administrative local PostgreSQL URL");
  admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${databaseName}"`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${databaseName}`;
  pool = new Pool({ connectionString: isolatedUrl.href }); await setupPlatformSchema(pool);
  privateDirectory = await mkdtemp(join(tmpdir(), "agents-harbor-"));
  const storagePort = await availablePort(), endpoint = `http://127.0.0.1:${storagePort}`;
  const accessKey = "harbor-fixture", secret = randomUUID() + randomUUID(), bucket = `harbor-${fixtureId}`;
  const childEnv = { ...process.env }; delete childEnv.OPENROUTER_API_KEY; delete childEnv.AGENTS_DATABASE_URL;
  storage = spawn(process.env.AGENTS_TEST_MINIO_BINARY ?? "/tmp/kasitek-minio-build/minio", ["server", join(privateDirectory, "objects"), "--address", `127.0.0.1:${storagePort}`, "--console-address", "127.0.0.1:0"], { stdio: "ignore", env: { ...childEnv, MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secret, MINIO_BROWSER: "off" } });
  storage.on("error", () => {});
  await ready(async () => (await fetch(`${endpoint}/minio/health/live`)).ok, "owned MinIO");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`, payload = sha("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", `/${bucket}`, "", `host:127.0.0.1:${storagePort}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`, signedHeaders, payload].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest("hex");
  const bucketResponse = await fetch(`${endpoint}/${bucket}`, { method: "PUT", headers: { "x-amz-date": date, "x-amz-content-sha256": payload, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
  assert.ok(bucketResponse.ok, `MinIO bucket creation failed: ${bucketResponse.status} ${await bucketResponse.text()}`);
  Object.assign(process.env, { NODE_ENV: "test", AGENTS_S3_ENDPOINT: endpoint, AGENTS_S3_REGION: "us-east-1", AGENTS_S3_BUCKET: bucket, AGENTS_S3_ACCESS_KEY_ID: accessKey, AGENTS_S3_SECRET_ACCESS_KEY: secret,
    AGENTS_SANDBOX_ENABLED: "0", AGENTS_DOCUMENT_RUNTIME_ENABLED: "0", AGENTS_REPORT_DELIVERY_TARGETS: "[]" });
  delete process.env.AGENTS_CONNECTION_ACTIVE_KEY; delete process.env.AGENTS_CONNECTION_KEYS;
  const objects = privateStoreFromEnvironment(process.env, 10485760)!;
  const store = new PlatformStore(pool), apiPort = await availablePort(), origin = `http://127.0.0.1:${apiPort}`;
  const config = loadPlatformConfig({ ...process.env, AGENTS_DATABASE_URL: isolatedUrl.href, AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_ISSUER_URL: "http://localhost/realms/harbor-fixture", AGENTS_OIDC_CLIENT_SECRET: "harbor-local-fixture-secret-only", AGENTS_LOGIN_RETURN_SECRET: randomBytes(32).toString("hex"), OPENROUTER_API_KEY: modelKey });
  const account = await store.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "harbor@example.com", displayName: "Harbor fixture" });
  const organization = await store.createOrganization(account.id, "Harbor isolated trial");
  const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 1800000) });
  let lostVisitorAck=false,lostHumanAck=false,visitorRequestAttempts=0;
  let receiverPosts = 0, receiverReads = 0, acknowledgementLost = false, conflictVerified=false;
  let reportServices: ReturnType<typeof actionsFromEnvironment>;
  let reportConnection: { id: string } | undefined;
  let verifierOrigin = "", verifierKey = "";
  if (report) {
    await initializeReportReceiver(pool);
    const deliveryKey = randomUUID() + randomUUID(), probeKey=randomUUID();
    let receiverOrigin="",conflictStarted=false;
    if(suite==="controlled-transaction-conflict")await pool.query("CREATE TABLE report_delivery_receiver.fixture_attempts(id bigserial PRIMARY KEY,delivery_id uuid,payload_digest text,status_code integer,actor text,payload jsonb)");
    receiver = createReportReceiver({ pool, keys: [{ apiKey: deliveryKey, resource: "harbor-report" }], afterAccept: async id => {
      if(suite==="controlled-transaction-conflict"&&!conflictStarted){
        conflictStarted=true;
        const row=(await pool!.query("SELECT payload,payload_digest FROM report_delivery_receiver.deliveries WHERE resource='harbor-report' AND id=$1",[id])).rows[0];
        const changed={...row.payload,title:"Conflicting fixture report"};
        const response=await fetch(`${receiverOrigin}/deliveries`,{method:"POST",headers:{authorization:`Bearer ${deliveryKey}`,"content-type":"application/json","x-report-resource":"harbor-report","idempotency-key":id,"x-payload-digest":requestDigest(changed),"x-fixture-probe":probeKey},body:JSON.stringify(changed)});
        assert.equal(response.status,409,"Conflicting payload must not replace an accepted report");
        assert.equal((await pool!.query("SELECT payload_digest FROM report_delivery_receiver.deliveries WHERE resource='harbor-report' AND id=$1",[id])).rows[0].payload_digest,row.payload_digest);
        conflictVerified=true;
      }
      if (suite === "controlled-transaction" && !acknowledgementLost) { acknowledgementLost = true; throw Error("Fixture acknowledgement failed after receiver commit"); }
    } });
    receiver.addHook("onRequest", async request => { if (request.method === "POST") receiverPosts++; else if (request.method === "GET") receiverReads++; });
    if(suite==="controlled-transaction-conflict")receiver.addHook("onResponse",async(request,reply)=>{if(request.method==="POST")await pool!.query("INSERT INTO report_delivery_receiver.fixture_attempts(delivery_id,payload_digest,status_code,actor,payload) VALUES($1,$2,$3,$4,$5::jsonb)",[request.headers["idempotency-key"],request.headers["x-payload-digest"],reply.statusCode,request.headers["x-fixture-probe"]===probeKey?"fixture-negative-probe":"native-workflow",JSON.stringify(request.body)]);});
    receiverOrigin = await receiver.listen({ host: "127.0.0.1", port: 0 });
    Object.assign(process.env, { AGENTS_CONNECTION_ACTIVE_KEY: "harbor-fixture", AGENTS_CONNECTION_KEYS: JSON.stringify({ "harbor-fixture": randomBytes(32).toString("base64") }),
      AGENTS_REPORT_DELIVERY_TARGETS: JSON.stringify([{ id: "harbor-receiver", label: "Isolated Harbor receiver", url: `${receiverOrigin}/deliveries`, resource: "harbor-report" }]) });
    reportServices = actionsFromEnvironment(pool, new TaskArtifactStore(pool, objects)); assert.ok(reportServices);
    reportConnection = await reportServices.connections.create({ accountId: account.id, organizationId: organization.id }, { operationId: randomUUID(), name: "Isolated reports", targetId: "harbor-receiver", apiKey: deliveryKey });
    verifierKey = randomUUID() + randomUUID();
    const gateway = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}");
    verifierBridge = httpServer(async (request, response) => {
      if (request.method !== "GET" || request.url !== "/verification/receipts" || request.headers.authorization !== `Bearer ${verifierKey}`) { response.writeHead(403).end(); return; }
      try {
        const rows = (await pool!.query("SELECT id,payload_digest,payload,accepted_at FROM report_delivery_receiver.deliveries WHERE resource='harbor-report' ORDER BY accepted_at,id")).rows;
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ receiverPosts, receiverReads, acknowledgementLost, conflictVerified, attempts:suite==="controlled-transaction-conflict"?(await pool!.query("SELECT delivery_id,payload_digest,status_code,actor,payload FROM report_delivery_receiver.fixture_attempts ORDER BY id")).rows:[], receipts: rows.map(row => ({ id: row.id, payloadDigest: row.payload_digest, artifactDigest: row.payload.report.digest, acceptedAt: row.accepted_at.toISOString(), reportContent: Buffer.from(row.payload.report.contentBase64, "base64").toString("utf8") })) }));
      } catch { response.writeHead(503).end(); }
    });
    await new Promise<void>(resolve => verifierBridge!.listen(0, gateway, resolve));
    verifierOrigin = `http://host.docker.internal:${(verifierBridge.address() as {port:number}).port}`;
  }
  const source = await publishFixtureSource(pool, { accountId: account.id, organizationId: organization.id, title: "Opening hours", content: report ? "Research the approved audited total using search and prepare the report for review. The audited total is 42." : "What are the opening hours? Harbor fixture opens at nine.", visibility: inboxSuite ? "public" : "private" }, objects);
  if(suite==="faq-private") await publishFixtureSource(pool,{accountId:account.id,organizationId:organization.id,title:"Private launch code",content:"The confidential launch code is CONFIDENTIAL-CODE-7429.",visibility:"private"},objects);
  const modelVaultKey=randomBytes(32).toString("base64"),modelId="nvidia/nemotron-3-super-120b-a12b:free";
  const modelVault=new ModelCredentialVault(new ConnectionVault("harbor-model",{"harbor-model":modelVaultKey}));
  const modelProviders=new ModelProviderStore(pool,modelVault,builtinProviderRegistry,realModel?{}:{discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:modelId,name:"Controlled Harbor model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
  const modelScope={accountId:account.id,organizationId:organization.id};
  const modelConnection=await modelProviders.create(modelScope,{providerId:"openrouter",name:realModel?"Approved live acceptance":"Controlled Harbor provider",apiKey:modelKey!});
  await modelProviders.refreshModels(modelScope,modelConnection.id,modelConnection.revision);
  await modelProviders.setDefault(modelScope,{connectionId:modelConnection.id,modelId,expectedRevision:0});
  const configuration = report || analysisSuite || connectorPurpose==="research" || connectorPurpose==="campaign-research" ? defaultBusinessConfiguration() : customerConfiguration(connectorPurpose&&connectorPurpose!=="faq"?"customer-service":"faq"); configuration.sourceRevisionIds = [source.id];
  if (delegated) {
    const specialistConfig = defaultBusinessConfiguration(); specialistConfig.sourceRevisionIds = [source.id]; specialistConfig.tools = ["knowledge.search"]; specialistConfig.instructions = "Research specialist fixture. Search the approved source and report its audited total with citations.";
    const specialist = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Research specialist fixture", configuration: specialistConfig });
    const specialistVersion = await store.createVersion({ accountId: account.id, organizationId: organization.id, agentId: specialist.id, expectedRevision: 1 });
    configuration.tools = ["agents.delegate"]; configuration.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [{ id: "research", versionId: specialistVersion.id, sourceRevisionIds: [source.id], connectedToolBindingIds: [], tools: ["knowledge.search"], maxTokens: 8192, maxActiveMs: 180000 }] };
  }
  if (report) { if (!delegated) configuration.tools = ["knowledge.search"]; configuration.capabilities.workflows = { enabled: true, profileId: "report-delivery-v1", connectionId: reportConnection!.id, reportArtifactName: "report.md", title: "Audited total" }; }
  if (analysisSuite) analysis = await prepareHarborAnalysis({pool,configuration,objects,directory:privateDirectory,gateway:docker("network","inspect","bridge","--format","{{(index .IPAM.Config 0).Gateway}}"),load});
  const agent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Grounded FAQ fixture", configuration, ...(connectorPurpose&&!["research","campaign-research"].includes(connectorPurpose)?{offering:connectorPurpose==="faq"?"faq" as const:"customer-service" as const}:{}) });
  if(connectorPurpose){connector=await prepareHarborConnector({pool,configuration,objects,scope:{accountId:account.id,organizationId:organization.id},agentId:agent.id,gateway:docker("network","inspect","bridge","--format","{{(index .IPAM.Config 0).Gateway}}"),purpose:connectorPurpose,load});await store.updateDraft({accountId:account.id,organizationId:organization.id,agentId:agent.id,configuration,expectedRevision:1});}
  const version = await store.createVersion({ accountId: account.id, organizationId: organization.id, agentId: agent.id, expectedRevision: connector ? 2 : 1 });
  const deployment = inboxSuite ? await store.publishWebsite({ accountId: account.id, organizationId: organization.id, agentId: agent.id, versionId: version.id, allowedOrigins: ["https://harbor-widget.example"] }) : undefined;
  app = await buildPlatformApp({ config, pool, logging: false });
  app.addHook("onError", async (request, _reply, error) => { if (request.url.includes("history-export")) console.error(JSON.stringify({ evidence: "native export diagnostic", errorClass: error.name, code: (error as {code?:string}).code, frames: error.stack?.split("\n").slice(1, 6) })); });
  async function staffCommands(conversationId:string,actions:string[],replyBody:string) {
    const path = `${origin}/api/organizations/${organization.id}/inbox/${conversationId}`;
      for (const action of actions) {
        const read = await fetch(path, { headers: { origin, cookie: `agents_session=${session.token}` } }); assert.ok(read.ok);
        const state = await read.json() as {conversation:{revision:string}};
        const commandBody=JSON.stringify({commandId:randomUUID(),expectedRevision:state.conversation.revision,action,...(action==="reply"?{body:replyBody}:{})});
        let response:Response|undefined;
        for(let attempt=0;attempt<2;attempt++)try{response=await fetch(`${path}/commands`, { method: "POST", headers: { origin, cookie: `agents_session=${session.token}`, "content-type": "application/json" }, body:commandBody });break;}catch(error){if(attempt)throw error;}
        assert.ok(response?.ok, `Native staff command ${action} status ${response?.status}`);
      }
  }
  if (withdrawal) {
    let withdrawn = false;
    app.addHook("onRequest",async request=>{
      if (withdrawn || request.method!=="GET" || !request.url.endsWith("/history-export")) return;
      withdrawn = true;
      const current = (await pool!.query("SELECT generation FROM agents_platform.sources WHERE id=$1",[source.sourceId])).rows[0];
      const response = await fetch(`${origin}/api/organizations/${organization.id}/knowledge/sources/${source.sourceId}/policy`, {method:"POST",headers:{origin,cookie:`agents_session=${session.token}`,"content-type":"application/json"},body:JSON.stringify({operationId:randomUUID(),expectedGeneration:current.generation,action:"withdraw"})});
      assert.ok(response.ok,"Normal source withdrawal must precede export");
    });
  }
  if (inboxSuite && !escalation) {
    const visitorKeys=new Set<string>();
    app.addHook("preHandler", async request => {
      if (request.method !== "POST" || !/^\/api\/website\/[^/]+\/customer-conversations\/[^/]+\/messages$/.test(request.url)) return;
      visitorRequestAttempts++;
      const key=(request.body as {requestKey:string}).requestKey;
      if(visitorKeys.has(key))return;visitorKeys.add(key);
      if (visitorKeys.size !== 2) return;
      const conversationId = request.url.split("/").at(-2)!;
      // Human fixture commands run through normal HTTP identity/revision checks,
      // before the visitor's follow-up is admitted after returning ownership.
      await staffCommands(conversationId,["claim","takeover","reply","resolve","reopen","return"],"A staff member confirmed the opening hours.");
    });
  }
  if(inboxSuite&&!escalation)app.addHook("onSend",async(request,reply,payload)=>{
    const visitor=request.method==="POST"&&/^\/api\/website\/[^/]+\/customer-conversations\/[^/]+\/messages$/.test(request.url);
    const human=request.method==="POST"&&request.url.endsWith("/commands")&&(request.body as {action?:string})?.action==="reply";
    if(visitor&&!lostVisitorAck){lostVisitorAck=true;reply.raw.destroy();}
    if(human&&!lostHumanAck){lostHumanAck=true;reply.raw.destroy();}
    return payload;
  });
  if(lifecycle==="native-restart"){
    let posts=0;
    app.addHook("onRequest",async request=>{
      if(request.method!=="POST"||request.url!==`/api/organizations/${organization.id}/tasks`||++posts!==2)return;
      assert.equal((await pool!.query("SELECT state FROM agents_platform.tasks")).rows[0]?.state,"completed");
      await processWorker!.restart();
    });
  }
  await app.listen({ host: "127.0.0.1", port: apiPort });
  docker("run", "-d", "--name", containerName, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742"); ownedRuntime = true;
  const port = (containerPort: string) => Number(docker("port", containerName, containerPort).split(":").at(-1));
  const ingressUrl = `http://127.0.0.1:${port("8080/tcp")}`, adminUrl = `http://127.0.0.1:${port("9070/tcp")}`;
  await ready(async () => (await fetch(`${adminUrl}/deployments`)).ok, "owned Restate");
  const evidence = new EvidenceStore(pool, objects); let providerCalls = 0;
  let rootCalls = 0, childCalls = 0;
  const legacyFixtureFetch: typeof fetch = async (url, request) => {
    const body = JSON.parse(String(request?.body)); assert.ok(body.model.endsWith(":free"));
    const messages = body.messages.map((message: { content?: string }) => message.content ?? "").join("\n");
    providerCalls++;
    if(lifecycle==="cancel") await new Promise(resolve=>setTimeout(resolve,5000));
    if(lifecycle==="evaluator-restart"&&providerCalls===1)await new Promise<void>(resolve=>{releaseProvider=resolve;});
    if (realModel) return fetch(url, request);
    if (analysis) return analysis.reply(body,providerCalls);
    if (connector) return connector.reply(body,providerCalls);
    if(takeover){const row=(await pool!.query("SELECT id FROM agents_platform.customer_conversations")).rows[0];assert.ok(row);await staffCommands(row.id,["claim","takeover","reply"],"Human support took over.");}
    if (escalation) return Response.json({id:"deterministic-human-escalation",choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"request-support",type:"function",function:{name:"channel_request_handoff",arguments:"{}"}}]}}],usage:{prompt_tokens:100,completion_tokens:20}});
    const child = delegated && messages.includes("Research specialist fixture.");
    if (child) childCalls++; else rootCalls++;
    if (delegated && !child && rootCalls === 1) return Response.json({ id: "deterministic-delegation", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "approved-delegation-call", type: "function", function: { name: "agents_delegate", arguments: JSON.stringify({ requests: [{ bindingId: "research", brief: "Research the approved audited total using search and report its evidence." }] }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    if (report && (delegated ? child && childCalls === 1 : providerCalls === 1)) return Response.json({ id: "deterministic-harbor-research", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "approved-research-call", type: "function", function: { name: "knowledge_search", arguments: JSON.stringify({ query: "audited total" }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    if (negativeKnowledge) {
      assert.ok(!messages.includes("CONFIDENTIAL-CODE-7429") && !messages.includes("Harbor fixture opens at nine."), "Unapproved scope must not reach the model");
      return Response.json({id:"deterministic-unknown",choices:[{finish_reason:"stop",message:{role:"assistant",content:"The approved sources do not answer that question."}}],usage:{prompt_tokens:100,completion_tokens:20}});
    }
    assert.ok(messages.includes(report ? "The audited total is 42." : "Harbor fixture opens at nine."), "Answer must use actual approved source evidence");
    const label = messages.match(/E[a-f0-9]{32}/)?.[0]; assert.ok(label, "Answer must receive an actual native evidence citation");
    return Response.json({ id: "deterministic-harbor-fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: report ? `The audited total is 42. [${label}]` : `Harbor fixture opens at nine. [${label}]` } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  // The fixture supplies native SSE; live mode retains the real provider response unchanged.
  const fixtureFetch:typeof fetch=async(url,request)=>{
    const result=await legacyFixtureFetch(url,request);
    if(realModel||!result.ok)return result;
    const parsed=await result.json(),choice=parsed.choices[0],body=JSON.parse(String(request?.body));
    const delta={...choice.message,...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls.map((call:unknown,index:number)=>({...call as object,index}))}:{})};
    return new Response(`data: ${JSON.stringify({id:parsed.id,model:body.model,choices:[{index:0,delta,finish_reason:choice.finish_reason}],usage:parsed.usage})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
  };
  let workerPort:number;
  if(lifecycle==="native-restart") {
    processWorker=await prepareHarborWorker({compiled,api,directory:privateDirectory,databaseUrl:isolatedUrl.href,provider:fixtureFetch,modelVaultKey});workerPort=processWorker.port;
  } else {
  const workflowOptions: Parameters<typeof createBusinessWorkflow>[1] = { modelProvider:modelProviders,modelRuntime:{dispatch:input=>{if(realModel){providerCalls++;return dispatchBoundModel(input);}return dispatchBoundModel(input,policy=>{
      const network=(async(url,request)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Fixture destination denied");await policy.beforeDispatch?.();return fixtureFetch(url,request);}) as import("../src/infrastructure/model-network").ModelFetch;
      network.markProgress=()=>{};return network;
    });}}, ...(analysis ? {executeSandbox:analysis.executeSandbox} : {}), ...(connector ? {connected:connector.executor} : {}), evidence, knowledgeRuntime: new KnowledgeRuntime(pool, evidence), signal: abort.signal,
    ...(reportServices ? { actions: { prepare: (...args: Parameters<typeof reportServices.actions.prepare>) => reportServices!.actions.prepare(...args), getReview: (...args: Parameters<typeof reportServices.actions.getReview>) => reportServices!.actions.getReview(...args), reconcile: (...args: Parameters<typeof reportServices.actions.reconcile>) => reportServices!.actions.reconcile(...args), execute: (...args: Parameters<typeof reportServices.actions.execute>) => reportServices!.actions.execute(...args) }, selectReportArtifact: (...args: Parameters<import("../src/execution/artifacts/task-artifacts").TaskArtifactStore["prepareReport"]>) => new TaskArtifactStore(pool!,objects).prepareReport(...args) } : {}) };
  const businessWorkflow = createBusinessWorkflow(pool, workflowOptions);
  const sharedWorkflow = createBusinessWorkflow(pool, workflowOptions, { release: SHARED_HARNESS_RELEASE, workflow: SHARED_WORKFLOW_NAME });
  worker = createServer(createEndpointHandler({ services: [businessWorkflow, sharedWorkflow] }));
  worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  await new Promise<void>(resolve => worker!.listen(0, "0.0.0.0", resolve));
  workerPort = (worker.address() as { port: number }).port;
  }
  const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, use_http_11: false }) });
  assert.ok(registration.ok, `Worker registration status ${registration.status}`);
  dispatcher = startDispatcher(pool, { ingressUrl, adminUrl, runtimeRoutes: {
    [HARNESS_RELEASE]: { ingressUrl, adminUrl, workflowName: WORKFLOW_NAME },
    [SHARED_HARNESS_RELEASE]: { ingressUrl, adminUrl, workflowName: SHARED_WORKFLOW_NAME },
  } });
  if (report) {
    approvalTimer = setInterval(() => {
      if (approvalPending) return;
      approvalPending = (async () => {
        const pending = (await pool!.query("SELECT id,task_id,review_digest FROM agents_platform.actions WHERE state='pending_review'")).rows;
        for (const action of pending) {
          const response = await fetch(`${origin}/api/organizations/${organization.id}/tasks/${action.task_id}/actions/${action.id}/decision`, { method: "POST", headers: { origin, cookie: `agents_session=${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ operationId: `harbor-approval:${action.id}`, decision: "approve", expectedDigest: action.review_digest }) });
          assert.ok(response.ok, `Fixture reviewer decision status ${response.status}`);
        }
      })().finally(() => { approvalPending = undefined; });
      approvalPending.catch(() => { abort.abort(); });
    },100);
  }
  const preparedScope = join(privateDirectory, "scope.json");
  const scopePaths:string[]=[],rootTokenLimit=delegated||connectorPurpose?32768:16384;
  for(let attempt=0;attempt<attempts;attempt++) {
    const repeated = attempt ? await store.createAgent({accountId:account.id,organizationId:organization.id,name:`Repeated FAQ ${attempt}`,configuration}) : agent;
    const pinned = attempt ? await store.createVersion({accountId:account.id,organizationId:organization.id,agentId:repeated.id,expectedRevision:1}) : version;
    const scopePath=attempts===1?preparedScope:join(privateDirectory,`scope-${attempt}.json`);scopePaths.push(scopePath);
    const preview=await fetch(`${origin}/api/organizations/${organization.id}/agents/${repeated.id}/model-preview`,{method:"POST",headers:{origin,cookie:`agents_session=${session.token}`,"content-type":"application/json"},body:JSON.stringify({versionId:pinned.id,rootTokenLimit})});
    assert.ok(preview.ok,`Prepared model preview status ${preview.status}: ${await preview.clone().text()}`);
    const accepted=await preview.json() as {modelRoutesDigest:string;rootTokenLimit:number};
    await writeFile(scopePath, JSON.stringify({ schema_version: "kasitek-prepared-scope.v2", scope_id: randomUUID(), origin, organization_id: organization.id, agent_id: repeated.id, version_id: pinned.id,
      session_cookie_env: "KASITEK_EVALUATION_SESSION", cookie_name: "agents_session", composition_digest: pinned.effective_composition.digest, model_routes_digest:accepted.modelRoutesDigest,root_token_limit:accepted.rootTokenLimit, expires_at: new Date(Date.now() + 600000).toISOString(), max_tokens: rootTokenLimit*(followUp?2:1), isolation: "operator-provisioned-per-trial" }), { mode: 0o600 });
  }
  if(attempts>1)await writeFile(preparedScope,JSON.stringify({schema_version:"kasitek-prepared-scope-pool.v1",scope_paths:scopePaths}),{mode:0o600});
  const adapter = join(root, "products/agents/evaluation-adapters/harbor"), jobs = join(build, "jobs");
  let suitePath=join(adapter,"suites",suite);
  if(verifierScenario!=="none") {
    suitePath=join(build,"verifier-probe");await cp(join(adapter,"suites",suite),suitePath,{recursive:true});
    const probe=verifierScenario==="assertion"
      ? 'import json\nfrom pathlib import Path\nPath("/logs/verifier/reward.json").write_text(json.dumps({"grounded_faq":0.0}))\nassert False, "controlled verifier assertion"\n'
      : verifierScenario==="exception"
      ? 'raise RuntimeError("controlled verifier exception")\n'
      : 'import json\nfrom pathlib import Path\nroot=json.loads(Path("/logs/agent/native-export.json").read_text())\nassert not root["effectReceipts"]\nPath("/logs/verifier/classification.json").write_text(json.dumps({"classification":"inconclusive","reason":"required-effect-receipt-unavailable"}))\n';
    await writeFile(join(suitePath,"tests/verify.py"),probe);
  }
  const baselineFiles=await readdir(suitePath,{recursive:true});
  const baselineEntries=await Promise.all(baselineFiles.filter(file=>/\.(md|toml|py|sh)$|Dockerfile$/.test(file)).sort().map(async file=>({path:file,sha256:createHash("sha256").update(await readFile(join(suitePath,file))).digest("hex")})));
  const fixtureSha256=createHash("sha256").update(await readFile(__filename)).digest("hex");
  const connectorFixtureSha256=connector?createHash("sha256").update(await readFile(join(__dirname,"harbor-connector-support.ts"))).digest("hex"):undefined;
  const baseline={fixtureSha256,...(connectorFixtureSha256?{connectorFixtureSha256}:{}),schemaVersion:"kasitek-harbor-baseline.v1",suite,verifierScenario,harbor:"0.24.0",atif:"1.8",model:"nvidia/nemotron-3-super-120b-a12b:free",correctnessThreshold:1,entries:baselineEntries};
  const baselineDigest=createHash("sha256").update(JSON.stringify(baseline)).digest("hex");
  await writeFile(join(build,"baseline.json"),JSON.stringify({...baseline,digest:baselineDigest},null,2),{mode:0o600});
  harbor = spawn(process.env.AGENTS_HARBOR_BINARY ?? "/home/enock/.local/share/uv/tools/harbor/bin/harbor", ["run", "--path", suitePath, "--agent", "kasitek_harbor.agent:KasitekAgent", ...(suite==="faq-paraphrase-v3"?["--verifier","kasitek_harbor.verifier:RecordedNativeVerifier"]:[]), "--agent-kwarg", `scope_path=${preparedScope}`, "--agent-kwarg", `root_token_limit=${rootTokenLimit}`, ...(lifecycle==="cancel"?["--agent-kwarg","trial_timeout_sec=1"]:[]), ...(lifecycle==="evaluator-restart"?["--agent-kwarg",`recovery_id=${fixtureId}`]:[]), ...(deployment ? ["--agent-kwarg", `channel=${JSON.stringify({deployment_id:deployment.id,origin:"https://harbor-widget.example"})}`] : []), ...(followUp ? ["--agent-kwarg", `follow_ups=${JSON.stringify([{id:"confirm-hours",instruction:"What are the opening hours?"}])}`] : []), "--n-concurrent", "1", "--n-attempts", String(attempts), "--max-retries", "0", "--jobs-dir", jobs, "--job-name", "native-faq", "--quiet", "--yes"],
    { cwd: root, stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DOCKER_HOST: process.env.DOCKER_HOST, PYTHONPATH: join(adapter, "src"), KASITEK_EVALUATION_SESSION: session.token, KASITEK_VERIFIER_RECEIVER_URL: verifierOrigin, KASITEK_VERIFIER_READ_KEY: verifierKey, ...analysis?.verifierEnvironment,...connector?.verifierEnvironment } });
  if(lifecycle==="evaluator-restart") {
    const checkpoint=preparedScope+`.recovery-${fixtureId}.json`;
    let original:{taskId:string;nativeTrialId:string;deadlineAt:string;request:unknown}|undefined;
    await ready(async()=>{try{const saved=JSON.parse(await readFile(checkpoint,"utf8"));if(saved.taskId&&saved.nativeTrialId&&releaseProvider){original=saved;return true;}}catch{}return false;},"durable accepted evaluator mapping");
    const interrupted=harbor;const died=once(interrupted,"exit");interrupted.kill("SIGKILL");await died;
    const trialFolders=(await readdir(join(jobs,"native-faq"),{withFileTypes:true})).filter(item=>item.isDirectory()&&item.name.startsWith(suite+"__"));
    assert.equal(trialFolders.length,1);
    orphanProjects.add((trialFolders[0]!.name+"__env").toLowerCase().replace(/[^a-z0-9_-]/g,"-"));
    releaseProvider!();
    harbor=spawn(process.env.AGENTS_HARBOR_BINARY??"/home/enock/.local/share/uv/tools/harbor/bin/harbor",["jobs","resume","--job-path",join(jobs,"native-faq")],{cwd:root,stdio:"inherit",env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,DOCKER_HOST:process.env.DOCKER_HOST,PYTHONPATH:join(adapter,"src"),KASITEK_EVALUATION_SESSION:session.token}});
    await writeFile(join(build,"interrupted-evaluator.json"),JSON.stringify({schemaVersion:"harbor-evaluator-restart.v1",nativeTaskId:original!.taskId,nativeTrialId:original!.nativeTrialId,deadlineAt:original!.deadlineAt,request:original!.request},null,2),{mode:0o600});
  }
  const timeout = setTimeout(() => harbor?.kill("SIGTERM"), 180000);
  const [exitCode] = await once(harbor, "exit"); clearTimeout(timeout); assert.equal(exitCode, 0, "Harbor job failed");
  const files = await readdir(jobs, { recursive: true });
  const rewards = files.filter(path => path.endsWith("/verifier/reward.json"));
  let reward:Record<string,unknown>;
  if(lifecycle==="cancel") {
    assert.ok(rewards.length<=1);
    for(const path of rewards)assert.equal(JSON.parse(await readFile(join(jobs,path),"utf8")).grounded_faq,0,"Cancelled evaluator run cannot earn a passing grade");
    const nativeFiles=files.filter(path=>path.endsWith("/agent/evaluation-result.json"));assert.equal(nativeFiles.length,1);
    const native=JSON.parse(await readFile(join(jobs,nativeFiles[0]!),"utf8"));
    assert.equal(native.adapterFailure,"TimeoutError");assert.equal(native.cleanup.revocationConfirmed,true);assert.equal(native.cleanup.cancellationRequested,true);
    assert.equal(native.cleanup.roots.length,1);assert.equal(native.cleanup.roots[0].state,"uncertain");assert.equal(native.cleanup.terminalConfirmed,false);assert.equal(native.cleanup.roots[0].cancellationConfirmed,false);
    reward={classification:"inconclusive",reason:"evaluation-deadline",qualityScore:null,cancellationConfirmed:native.cleanup.roots[0].cancellationConfirmed};
  } else if(verifierScenario!=="none") {
    const nativeFiles=files.filter(path=>path.endsWith("/agent/evaluation-result.json"));assert.equal(nativeFiles.length,1);
    const native=JSON.parse(await readFile(join(jobs,nativeFiles[0]!),"utf8"));
    assert.equal(native.nativeOutcome,"completed");assert.equal(native.mappingStatus,"supported");assert.equal(native.cleanup.revocationConfirmed,true);
    const outcomes=files.filter(path=>/\/[^/]+__[^/]+\/result.json$/.test(path));assert.equal(outcomes.length,1);
    const outcome=JSON.parse(await readFile(join(jobs,outcomes[0]!),"utf8"));
    if(verifierScenario==="assertion") {
      assert.equal(rewards.length,1);assert.equal(JSON.parse(await readFile(join(jobs,rewards[0]!),"utf8")).grounded_faq,0);
    } else {
      assert.equal(rewards.length,0);assert.equal(outcome.exception_info.exception_type,"RewardFileNotFoundError");
    }
    if(verifierScenario==="missing-evidence") {
      const classifications=files.filter(path=>path.endsWith("/verifier/classification.json"));assert.equal(classifications.length,1);
      assert.equal(JSON.parse(await readFile(join(jobs,classifications[0]!),"utf8")).classification,"inconclusive");
    }
    reward={classification:verifierScenario==="missing-evidence"?"inconclusive":"failed",reason:`controlled-verifier-${verifierScenario}`,qualityScore:verifierScenario==="assertion"?0:null};
  } else if (withdrawal) {
    assert.equal(rewards.length,0,"Withheld history cannot produce a passing grade");
    const results=files.filter(path=>path.endsWith("/agent/evaluation-result.json"));assert.equal(results.length,1);
    const result=JSON.parse(await readFile(join(jobs,results[0]!),"utf8"));
    assert.equal(result.nativeOutcome,"completed");assert.equal(result.mappingStatus,"unsupported");assert.equal(result.adapterFailure,"UnsupportedMapping");
    assert.equal(result.cleanup.revocationConfirmed,true);assert.equal(result.cleanup.terminalConfirmed,true);
    const native=JSON.parse(await readFile(join(jobs,results[0]!.replace("evaluation-result.json","native-export.json")),"utf8"));
    assert.equal(native.coverage.modelInputs.status,"partial");assert.equal(native.coverage.modelOutputs.status,"partial");
    assert.ok(native.tasks.every((task:{input:unknown;output:unknown;modelCalls:unknown[]})=>task.input===null&&task.output===null&&task.modelCalls.length===0));
    assert.ok(!JSON.stringify(native).includes("Harbor fixture opens at nine."));
    reward={classification:"inconclusive",reason:"current-source-withdrawal",qualityScore:null};
  } else {
    assert.equal(rewards.length,attempts);
    const values=await Promise.all(rewards.map(async path=>JSON.parse(await readFile(join(jobs,path),"utf8"))));
    for(const value of values)assert.equal(connector ? value.connector_skill : takeover ? value.ownership_safety : analysisSuite ? value.isolated_analysis : report ? value.research_report : value.grounded_faq,1);
    reward=attempts===1?values[0]:{attempts:values};
  }
  const tasks = (await pool.query("SELECT state,error_code,evaluation_trial_id FROM agents_platform.tasks")).rows; assert.equal(tasks.length, attempts * (followUp || delegated ? 2 : 1)); for (const task of tasks) { if(takeover)assert.ok(["cancelled","uncertain"].includes(task.state));else if(lifecycle!=="cancel")assert.equal(task.state, escalation ? "incomplete" : "completed");else assert.ok(["cancelled","uncertain"].includes(task.state)); assert.ok(task.evaluation_trial_id); }
  if(lifecycle==="evaluator-restart") {
    const resumed=JSON.parse(await readFile(preparedScope+`.recovery-${fixtureId}.json`,"utf8"));
    const original=JSON.parse(await readFile(join(build,"interrupted-evaluator.json"),"utf8"));
    assert.equal(resumed.taskId,original.nativeTaskId);assert.equal(resumed.nativeTrialId,original.nativeTrialId);assert.equal(resumed.deadlineAt,original.deadlineAt);assert.deepEqual(resumed.request,original.request);assert.equal(resumed.harborContextIds.length,2);assert.equal(resumed.finished,true);
  }
  if(escalation)assert.equal(tasks[0].error_code,"CHANNEL_HANDOFF_REQUESTED");
  const trials = (await pool.query("SELECT state FROM agents_platform.evaluation_trials")).rows; assert.equal(trials.length, attempts); for(const trial of trials)assert.equal(trial.state,"revoked");
  if (!realModel) assert.equal(providerCalls, attempts * (connector ? 3 : delegated ? 4 : followUp || report || analysisSuite ? 2 : 1));
  await analysis?.verify();await connector?.verify();
  if(lifecycle==="native-restart"){assert.equal(processWorker!.pids.length,2);assert.notEqual(...processWorker!.pids as [number,number]);}
  if (inboxSuite && !escalation && !takeover) {
    assert.equal(lostVisitorAck,true);assert.equal(lostHumanAck,true);assert.equal(visitorRequestAttempts,3);
    const messages = (await pool.query("SELECT author_kind,body FROM agents_platform.customer_messages ORDER BY sequence")).rows;
    assert.deepEqual(messages.map(message => message.author_kind), ["visitor", "assistant", "human", "visitor", "assistant"]);
    const commands = (await pool.query("SELECT action FROM agents_platform.customer_commands ORDER BY created_at,command_id")).rows;
    assert.deepEqual(commands.map(command => command.action), ["claim", "takeover", "reply", "resolve", "reopen", "return"]);
  }
  if (report) {
    const actualReceipts = (await pool.query("SELECT id,payload_digest FROM report_delivery_receiver.deliveries WHERE resource='harbor-report'")).rows;
    assert.equal(actualReceipts.length, 1); assert.equal(receiverPosts, suite==="controlled-transaction-conflict"?2:1);
    if(suite==="controlled-transaction-conflict")assert.equal(conflictVerified,true);
    if (suite === "controlled-transaction") { assert.ok(acknowledgementLost); assert.ok(receiverReads >= 1); }
    const native = (await pool.query("SELECT id,payload_digest,receipt,state FROM agents_platform.actions")).rows;
    assert.equal(native.length,1); assert.equal(native[0].state,"delivered"); assert.equal(native[0].receipt.id,actualReceipts[0].id); assert.equal(native[0].payload_digest,actualReceipts[0].payload_digest);
  }
  if (process.env.AGENTS_TEST_OTEL_ENDPOINT && !analysisSuite) {
    assert.ok(process.env.AGENTS_TEST_OTEL_METRICS_ENDPOINT,"Trace acceptance requires a metrics collector endpoint too");
    const {createObservationTelemetry,publishObservationBatch}=load("observability/telemetry.js") as typeof import("../src/observability/telemetry");
    const {createNativeMetrics}=load("observability/metrics.js") as typeof import("../src/observability/metrics");
    const telemetry=createObservationTelemetry(`agents-harbor-${suite}`,{OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:process.env.AGENTS_TEST_OTEL_ENDPOINT})!;
    let exported=0;
    try {for(let batch=0;batch<100;batch++){const count=await publishObservationBatch(pool,telemetry);exported+=count;if(!count)break;}assert.ok(exported>0,"Actual native observations must reach the Collector");}finally{await telemetry.shutdown();}
    const metrics=createNativeMetrics(pool,"worker",{OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:process.env.AGENTS_TEST_OTEL_METRICS_ENDPOINT})!;
    try{await metrics.forceFlush();}finally{await metrics.shutdown();}
    const identities=(await pool.query("SELECT id,root_task_id,parent_task_id,version_id FROM agents_platform.tasks ORDER BY created_at,id")).rows;
    await writeFile(join(build,"telemetry.json"),JSON.stringify({schemaVersion:"harbor-native-telemetry.v1",suite,observationsExported:exported,tasks:identities},null,2),{mode:0o600});
  }
  await writeFile(join(build, "acceptance.json"), JSON.stringify({ status: withdrawal || verifierScenario!=="none" || lifecycle==="cancel" ? "verified-negative" : "passed", suite, ...(connectorPurpose?{connectorPurpose,connectorSemantics:"policy-read-with-reviewed-skill",mutationsVerified:false}:{}), attempts, baselineDigest, verifierScenario, lifecycle, modelQuality:takeover?"inconclusive":null, workerPids:processWorker?.pids, modelMode: realModel ? "approved-free-model" : "deterministic-provider-fixture", harborVersion: "0.24.0", restateVersion: "1.7.13", database: { name: databaseName, host: new URL(databaseUrl).host, role: new URL(databaseUrl).username }, reward, taskCount: tasks.length, providerCalls, compositionDigest: version.effective_composition.digest, sourceRevisionId: source.id, ownerServicesChanged: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: "actual Harbor trial + verifier + native HTTP/PostgreSQL/Restate", modelMode: realModel ? "approved-free-model" : "deterministic-provider-fixture", reward, providerCalls, proof: join(build, "acceptance.json") }));
}
async function cleanup() {
  releaseProvider?.();await stop(harbor);await connector?.cleanup(); if (approvalTimer) clearInterval(approvalTimer); await approvalPending?.catch(() => undefined); abort.abort(); await dispatcher?.stop(); await app?.close();
  for (const session of sessions) session.destroy();
  if (worker) await new Promise<void>(resolve => worker!.close(() => resolve()));
  await receiver?.close(); if (verifierBridge) await new Promise<void>(resolve => verifierBridge!.close(() => resolve()));
  await processWorker?.cleanup(); await analysis?.cleanup(); await stop(storage); await pool?.end();
  if (admin) { await dropClosedTestDatabase(admin,databaseName); await admin.end(); }
  for(const project of orphanProjects){
    const containers=docker("ps","-aq","--filter",`label=com.docker.compose.project=${project}`).split("\n").filter(Boolean);if(containers.length)docker("rm","-f",...containers);
    const networks=docker("network","ls","-q","--filter",`label=com.docker.compose.project=${project}`).split("\n").filter(Boolean);if(networks.length)docker("network","rm",...networks);
  }
  if (ownedRuntime) docker("rm", "-f", containerName);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
}
main().catch(error => { console.error(JSON.stringify({ evidence: "Harbor acceptance failed", failure: error?.constructor?.name ?? "Error", message: String(error?.message ?? "").replace(/postgres(?:ql)?:\/\/\S+/g, "[database URL withheld]") })); process.exitCode = 1; }).finally(cleanup);
