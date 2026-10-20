import { createEndpointHandler } from "@restatedev/restate-sdk";
import { createServer,type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { ConnectedExecutor } from "../capabilities/connected-tools/connected-executor";
import { ToolReviewStore } from "../capabilities/reviews/tool-reviews";
import { RemoteConnectionStore } from "../product/connections/remote-connections";
import { assertConnectedBindingDependencies } from "../capabilities/connected-tools/connected-tool-schema";
import { IngestionService,createIngestionWorkflow,startIngestionDispatcher } from "../capabilities/knowledge/ingestion-runtime";
import { KnowledgeStore } from "../capabilities/knowledge/knowledge";
import { KnowledgeRuntime } from "../capabilities/knowledge/knowledge-runtime";
import { QueryEmbeddingService } from "../capabilities/knowledge/query-embedding";
import { resourceBackends } from "./resource-backends";
import { createSandboxExecutor } from "../capabilities/sandbox/sandbox-executor";
import { capabilityBindingSchema } from "../contracts/capability-catalog";
import { PlatformError,connectedToolAuthorityIds } from "../contracts/contracts";
import { TaskArtifactStore } from "../execution/artifacts/task-artifacts";
import { createBusinessWorkflow } from "../execution/business/business";
import { EvidenceStore } from "../execution/context/evidence";
import { startDispatcher } from "../execution/lifecycle/dispatcher";
import { dispatchPolicyFromEnvironment } from "../execution/scheduling/dispatch-claims";
import { WORKFLOW_NAME } from "../execution/lifecycle/execution";
import { privateStoreFromEnvironment } from "../infrastructure/object-store";
import { createAutomationWorkflow,startAutomationDispatcher } from "../product/automations/automation-runtime";
import { AutomationService } from "../product/automations/automations";
import { actionsFromEnvironment } from "./actions";
import { runDocumentReaper } from "./document-reaper";
import { runSourceObjectReaper } from "./source-object-reaper";
import { workerSecurityFromEnvironment } from "./worker-security";
import { createNativeMetrics } from "../observability/metrics";
import { createObservationTelemetry, startObservationPublisher } from "../observability/telemetry";
import { composeInbox } from "./inbox";
import { databasePoolOptions } from "../infrastructure/pool-policy";

async function main(): Promise<void> {
  const dispatchPolicy = dispatchPolicyFromEnvironment();
  const telemetryTransport = createObservationTelemetry("agents-worker");
  const diagnosticIdentity = { service: "agents-worker", environment: process.env.NODE_ENV || "development",
    release: (process.env.KASITEK_RELEASE_ID || "development").slice(0, 128) };
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const port = Number(process.env.RESTATE_WORKER_PORT ?? 9080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid RESTATE_WORKER_PORT");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("worker"),
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 });
  const abort = new AbortController();
  const {sandbox,documents}=resourceBackends(pool);
  const objects=privateStoreFromEnvironment(),artifacts=new TaskArtifactStore(pool,objects),actionServices=actionsFromEnvironment(pool,artifacts);
  const sourceObjects=privateStoreFromEnvironment(process.env,10_485_760);
  const ingestion=documents&&sourceObjects?new IngestionService(pool,sourceObjects,documents,new KnowledgeStore(pool,sourceObjects)):undefined;
  const evidence=new EvidenceStore(pool,sourceObjects);
  const embeddings=documents&&sourceObjects?new QueryEmbeddingService(pool,sourceObjects,documents):undefined;
  const knowledgeRuntime=sourceObjects?new KnowledgeRuntime(pool,evidence,embeddings):undefined;
  const toolReviews=new ToolReviewStore(pool);
  const remoteConnections=actionServices?new RemoteConnectionStore(pool,actionServices.connections.vault,{
    callbackUrl:`${new URL(process.env.AGENTS_PUBLIC_URL??"http://localhost:3100").origin}/api/connections/oauth/callback`,
    ...(process.env.AGENTS_MCP_CLIENT_METADATA_URL?{clientMetadataUrl:process.env.AGENTS_MCP_CLIENT_METADATA_URL}:{}),
  }):undefined;
  const connected=actionServices&&sourceObjects&&evidence?new ConnectedExecutor(pool,actionServices.connections,sourceObjects,evidence,{
    resolveRemoteEndpoint:remoteConnections?(db,scope,id,policy)=>remoteConnections.resolveRemoteEndpoint(db,scope,id,policy):undefined,
    genericReview:toolReviews.port(),
  }):undefined;
  const automations=new AutomationService(pool,async configuration=>{
    if(!process.env.OPENROUTER_API_KEY)throw new PlatformError('MODEL_CREDENTIAL_UNAVAILABLE',503,'Model connection is unavailable');
    if((configuration.capabilities.sandbox.enabled||configuration.capabilities.workflows.enabled)&&!objects)throw new PlatformError('OBJECT_STORE_UNAVAILABLE',503,'Private storage is unavailable');
    if(configuration.capabilities.workflows.enabled&&!actionServices)throw new PlatformError('ACTIONS_UNAVAILABLE',503,'Delivery is unavailable');
    if(configuration.capabilities.sandbox.enabled&&(!sandbox||!await sandbox.available()))throw new PlatformError('SANDBOX_UNAVAILABLE',503,'Analysis is unavailable');
    if(configuration.sourceRevisionIds.length&&!knowledgeRuntime)throw new PlatformError('OBJECT_STORE_UNAVAILABLE',503,'Knowledge storage is unavailable');
    if(configuration.retrievalProfile.kind==='hybrid-v1'&&(!documents||!await documents.available(configuration.retrievalProfile.embeddingRelease)))throw new PlatformError('RETRIEVAL_BACKEND_UNAVAILABLE',503,'The selected semantic search profile is unavailable');
    const connectedAuthority=connectedToolAuthorityIds(configuration);
    if(connectedAuthority.length){
      if(!connected)throw new PlatformError('CONNECTED_TOOLS_UNAVAILABLE',503,'Connected tools are unavailable');
      const bindings=(await pool.query('SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[])',[connectedAuthority])).rows.map(row=>capabilityBindingSchema.parse(row.binding));
      if(bindings.length!==connectedAuthority.length)throw new PlatformError('ADAPTER_RELEASE_UNAVAILABLE',503,'A selected tool binding is unavailable');
      assertConnectedBindingDependencies(bindings.filter(binding=>configuration.connectedToolBindingIds.includes(binding.id)));
      connected.assertAvailable(bindings);
    }
  });
  const inbox = composeInbox(pool, { publicOrigin: new URL(process.env.AGENTS_PUBLIC_URL ?? "http://localhost:3100").origin,
    assertServices: async () => { if(!process.env.OPENROUTER_API_KEY) throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE",503,"Model connection is unavailable"); } });
  let cancellationPending: Promise<unknown> | undefined;
  const cancellationTimer = setInterval(() => {
    if(!cancellationPending) cancellationPending=inbox.drainCancellations().catch(()=>undefined).finally(()=>{cancellationPending=undefined;});
  },1000); cancellationTimer.unref();
  const workflow = createBusinessWorkflow(pool, { openRouterApiKey: process.env.OPENROUTER_API_KEY, signal: abort.signal,
    actions:actionServices?.actions,selectReportArtifact:(taskId,name,output)=>artifacts.prepareReport(taskId,name,output),
    executeSandbox: createSandboxExecutor(pool,sandbox,objects),evidence,knowledgeRuntime,connected,toolReviews });
  const {host,identityKeys} = workerSecurityFromEnvironment();
  const server = createServer(createEndpointHandler({ services: [workflow,createAutomationWorkflow(automations),...(ingestion?[createIngestionWorkflow(ingestion)]:[])], identityKeys }));
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  try {
    await pool.query("SELECT 1 FROM agents_platform.tasks LIMIT 1");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } catch (error) { server.close(); await pool.end(); throw error; }
  const metrics = createNativeMetrics(pool,"worker");
  const dispatcher = startDispatcher(pool, {
    policy: dispatchPolicy,
    ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:18080",
    adminUrl: process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:19070",
    onError: code => console.error(JSON.stringify({ ...diagnosticIdentity, event: "runtime_publisher_error", code })),
    onPhase: metrics?.dispatcherPhase,
  });
  const automationDispatcher=startAutomationDispatcher(pool,automations,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"automation_publisher_error",code})),()=>actionServices?.actions.reconcilePending()??Promise.resolve());
  const ingestionDispatcher=ingestion?startIngestionDispatcher(ingestion,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"ingestion_publisher_error",code}))):undefined;
  // Object deletion is independent of physical resource cleanup; either backend may be temporarily unavailable.
  const documentCleanup=documents?runDocumentReaper(pool,abort.signal):undefined;
  const sourceCleanup=sourceObjects?runSourceObjectReaper(pool,abort.signal):undefined;
  const telemetry = startObservationPublisher(pool, telemetryTransport);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    abort.abort();
    clearInterval(cancellationTimer); await cancellationPending;
    await Promise.all([dispatcher.stop(),automationDispatcher.stop(),ingestionDispatcher?.stop(),documentCleanup,sourceCleanup]);
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => { for (const session of sessions) session.destroy(); }, 10_000);
      server.close(() => { clearTimeout(deadline); resolve(); });
      for (const session of sessions) session.close();
    });
    await telemetry.stop();
    await metrics?.shutdown();
    await pool.end();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  console.log(JSON.stringify({ ...diagnosticIdentity, event: "ready", port, workflow: WORKFLOW_NAME }));
}

if (require.main === module) void main().catch(() => {
  console.error(JSON.stringify({ service: "agents-worker", event: "startup_failed" }));
  process.exitCode = 1;
});
