import { assertKnowledgeBackfilled } from "../capabilities/knowledge/cutover";
import { PostgresKnowledgeObjectStore } from "../capabilities/knowledge/postgres-object-store";
import { remoteAuthOptionsFromEnvironment } from "../product/connections/remote-auth";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { createServer,type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { ConnectedExecutor } from "../capabilities/connected-tools/connected-executor";
import { ToolReviewStore } from "../capabilities/reviews/tool-reviews";
import { RemoteConnectionStore } from "../product/connections/remote-connections";
import { ProviderServices } from "../product/connections/provider-services";
import { BookingService } from "../workflows/booking/bookings";
import { ApiConnectionStore } from "../product/connections/api-connections";
import { createNativeApiCapabilityCatalog } from "../capabilities/connected-tools/generic-connected-runtime";
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
import { createBusinessWorkflow, type BusinessOptions } from "../execution/business/business";
import { createSupportStatusWorkflow,SUPPORT_STATUS_WORKFLOW } from '../execution/business/support-status-business';
import { ModelProviderStore } from "../product/model-providers/store";
import { ModelCredentialVault } from "../infrastructure/model-credential-vault";
import { connectionVaultFromEnvironment } from "../infrastructure/vault";
import { EvidenceStore } from "../execution/context/evidence";
import { startDispatcher } from "../execution/lifecycle/dispatcher";
import { dispatchPolicyFromEnvironment } from "../execution/scheduling/dispatch-claims";
import { WORKFLOW_NAME } from "../execution/lifecycle/execution";
import { HARNESS_RELEASE, HANDOFF_HARNESS_RELEASE, HANDOFF_WORKFLOW_NAME } from "../contracts/execution";
import { privateStoreFromEnvironment } from "../infrastructure/object-store";
import { createAutomationWorkflow,startAutomationDispatcher } from "../product/automations/automation-runtime";
import { AutomationService } from "../product/automations/automations";
import { SupportWaitingService } from "../product/inbox/support-waiting";
import { captureConnectedUncertainBatch,processConnectedUncertainBatch } from "../product/inbox/connected-uncertain-recovery";
import { publishConnectedUncertaintyBatch } from "../product/inbox/connected-uncertainty-notice";
import { createSupportWaitingWorkflow,startSupportWaitingDispatcher } from "../product/inbox/support-waiting-runtime";
import { settleReceipt } from "../product/inbox/handoff-pending-receipt";
import { HANDOFF_RECEIPT } from "../product/inbox/handoff-receipt";
import { createReceiptWorkflow,startHandoffReceiptDispatcher } from "../product/inbox/handoff-pending-receipt-runtime";
import { customerFollowupConfig } from "../product/customer-followup/config";
import { CustomerFollowupNotifications } from "../product/customer-followup/notifications";
import { createCustomerFollowupWorkflow,startCustomerFollowupDispatcher } from "../product/customer-followup/runtime";
import { ResendNotificationSender } from "../adapters/notifications/resend";
import { followupConfigurationDigest } from "../product/customer-followup/readiness";
import { actionsFromEnvironment } from "./actions";
import { runDocumentReaper } from "./document-reaper";
import { runSourceObjectReaper } from "./source-object-reaper";
import { workerSecurityFromEnvironment } from "./worker-security";
import { createNativeMetrics } from "../observability/metrics";
import { createObservationTelemetry, startObservationPublisher } from "../observability/telemetry";
import { composeInbox } from "./inbox";
import { composeChannels } from "./channels";
import { databasePoolOptions } from "../infrastructure/pool-policy";

import { growthActionClientFromEnvironment } from "../adapters/products/growth-action-client";
import { GrowthProductRuntime } from "../execution/products/growth-runtime";
import { registerAgencyProductCapabilities } from "../adapters/products/agency-capability-client";
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
  await assertKnowledgeBackfilled(pool);
  const abort = new AbortController();
  const {sandbox,documents}=resourceBackends(pool);
  const objects=privateStoreFromEnvironment(),artifacts=new TaskArtifactStore(pool,objects),actionServices=actionsFromEnvironment(pool,artifacts);
  const sourceObjects=privateStoreFromEnvironment(process.env,10_485_760);
  const knowledgeObjects=new PostgresKnowledgeObjectStore(pool);
  const ingestion=documents?new IngestionService(pool,knowledgeObjects,documents,new KnowledgeStore(pool,knowledgeObjects)):undefined;
  const evidence=new EvidenceStore(pool,sourceObjects);
  const embeddings=documents?new QueryEmbeddingService(pool,knowledgeObjects,documents):undefined;
  const knowledgeRuntime=new KnowledgeRuntime(pool,evidence,embeddings);
  const toolReviews=new ToolReviewStore(pool);
  const providers=new ProviderServices(pool,actionServices?.connections.vault,{appUrl:process.env.AGENTS_PUBLIC_URL??"http://localhost:3100"});
  const bookings=new BookingService(pool,{resolveCalendar:(...args)=>providers.resolveCalendar(...args),ensureFresh:(scope,id)=>providers.ensureFresh(scope,id)});

  const remoteConnections=actionServices?new RemoteConnectionStore(pool,actionServices.connections.vault,{
    callbackUrl:`${new URL(process.env.AGENTS_PUBLIC_URL??"http://localhost:3100").origin}/api/connections/oauth/callback`,
    ...remoteAuthOptionsFromEnvironment(process.env),
  }):undefined;
  const connected:ConnectedExecutor|undefined=actionServices&&sourceObjects&&evidence?new ConnectedExecutor(pool,providers.credentials(actionServices.connections),sourceObjects,evidence,{
    resolveRemoteEndpoint:remoteConnections?(db,scope,id,policy)=>remoteConnections.resolveRemoteEndpoint(db,scope,id,policy):undefined,
    ensureCredentialFresh:async(scope,id)=>{const native=await providers.forConnection(scope,id);if(native)await native.ensureCredentialFresh(scope,id);else await remoteConnections?.ensureCredentialFresh(scope,id);},
    recordRemoteScopeChallenge:remoteConnections?(scope,id,policyRevision,challenge)=>remoteConnections.recordPermissionChallenge(scope,id,policyRevision,challenge):undefined,
    resolveApiOperation:(db,scope,id,policy,operation)=>apiConnections!.resolveApiOperation(db,scope,id,policy,operation),
    genericReview:toolReviews.port(),
  }):undefined;
  const apiConnections:ApiConnectionStore|undefined=actionServices?new ApiConnectionStore(pool,actionServices.connections.vault,{registry:connected?.registry,createCatalog:createNativeApiCapabilityCatalog}):undefined;
  const automations=new AutomationService(pool,async configuration=>{
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
  const followupConfig = customerFollowupConfig(process.env);
  const inbox = composeInbox(pool, { publicOrigin: new URL(process.env.AGENTS_PUBLIC_URL ?? "http://localhost:3100").origin, followupAccessEnabled:true,followupEnabled: Boolean(followupConfig),supportStatusEnabled:true,
    assertServices: async () => {} });
  const followupSender = followupConfig ? new ResendNotificationSender(followupConfig.apiKey,followupConfig.sender,{timeoutMs:10000}) : undefined;
  const followups = followupConfig && followupSender ? new CustomerFollowupNotifications(pool,(message,beforeAttempt)=>followupSender.send(message,beforeAttempt),followupConfig.publicUrl) : undefined;
  const supportWaiting = new SupportWaitingService(pool,(db,input)=>inbox.publishWaitingNotice(db,input));
  const channelServices=composeChannels(pool,inbox,process.env.AGENTS_PUBLIC_URL??"http://localhost:3100",abort.signal);
  let cancellationPending: Promise<unknown> | undefined;
  const cancellationTimer = setInterval(() => {
    if(!cancellationPending) cancellationPending=(async()=>{await inbox.drainCancellations();await channelServices.delivery.drain();})()
      .catch(()=>console.error(JSON.stringify({...diagnosticIdentity,event:"channel_maintenance_failed",code:"CHANNEL_MAINTENANCE_UNAVAILABLE"})))
      .finally(()=>{cancellationPending=undefined;});
  },1000); cancellationTimer.unref();
  let uncertainPending: Promise<unknown> | undefined;
  const uncertainTimer=setInterval(()=>{
    if(process.env.AGENTS_CONNECTED_UNCERTAIN_RECOVERY!=='false' && !uncertainPending)uncertainPending=(async()=>{
      await captureConnectedUncertainBatch(pool);
      await processConnectedUncertainBatch(pool,async(db,intent)=>{
        const result=await inbox.recoverUncertainConnectedHandoff(db,intent);
        return result.outcome==='recorded' ? {outcome:'recorded' as const,commandId:result.commandId!} : {outcome:result.outcome};
      },20,code=>console.error(JSON.stringify({...diagnosticIdentity,event:'connected_uncertain_recovery_failed',code})));
      await publishConnectedUncertaintyBatch(pool,20,code=>console.error(JSON.stringify({...diagnosticIdentity,event:'connected_uncertain_notice_failed',code})));
    })().catch(()=>console.error(JSON.stringify({...diagnosticIdentity,event:'connected_uncertain_recovery_failed',code:'CONNECTED_UNCERTAIN_RECOVERY_UNAVAILABLE'})))
      .finally(()=>{uncertainPending=undefined;});
  },1000);uncertainTimer.unref();
  const modelVault = connectionVaultFromEnvironment();
  const modelProvider = new ModelProviderStore(pool, modelVault ? new ModelCredentialVault(modelVault) : undefined);
  const growthActions=growthActionClientFromEnvironment();
  const productRuntime=growthActions?new GrowthProductRuntime(pool,growthActions,evidence):undefined;
  if(productRuntime){await productRuntime.loadPublications();registerAgencyProductCapabilities(productRuntime);}
  const workflowOptions: BusinessOptions = { modelProvider, signal: abort.signal,
    product:productRuntime,
    actions:actionServices?.actions,selectReportArtifact:(taskId,name,output)=>artifacts.prepareReport(taskId,name,output),
    executeSandbox: createSandboxExecutor(pool,sandbox,objects),evidence,knowledgeRuntime,connected,toolReviews,bookings };
  const workflow = createBusinessWorkflow(pool, workflowOptions);
  const handoffWorkflow = createBusinessWorkflow(pool, {...workflowOptions,
    settleHandoffReceipt:(taskId,candidate,definitiveFailure)=>settleReceipt(pool,taskId,candidate?{text:candidate}:null,HANDOFF_RECEIPT,
      (db,input)=>inbox.publishPendingHandoffReceipt(db,input),definitiveFailure),
  },{release:HANDOFF_HARNESS_RELEASE,workflow:HANDOFF_WORKFLOW_NAME});
  const {host,identityKeys} = workerSecurityFromEnvironment();
  const receiptWorkflow=createReceiptWorkflow(pool,HANDOFF_RECEIPT,(db,input)=>inbox.publishPendingHandoffReceipt(db,input));
  const statusWorkflow=createSupportStatusWorkflow(pool,{...workflowOptions,publishSupportStatus:taskId=>inbox.publishSupportStatus(taskId)});
  const server = createServer(createEndpointHandler({ services: [workflow,handoffWorkflow,receiptWorkflow,statusWorkflow,createAutomationWorkflow(automations),createSupportWaitingWorkflow(supportWaiting),...(followups?[createCustomerFollowupWorkflow(followups)]:[]),...(ingestion?[createIngestionWorkflow(ingestion)]:[])], identityKeys }));
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
    runtimeRoutes: Object.fromEntries([[HARNESS_RELEASE,WORKFLOW_NAME],[HANDOFF_HARNESS_RELEASE,HANDOFF_WORKFLOW_NAME]].map(([release,workflowName])=>[release!,{ingressUrl:process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",adminUrl:process.env.RESTATE_ADMIN_URL??"http://127.0.0.1:19070",workflowName:workflowName!}])),
    supportStatusRoute:{ingressUrl:process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",adminUrl:process.env.RESTATE_ADMIN_URL??"http://127.0.0.1:19070",workflowName:SUPPORT_STATUS_WORKFLOW},
    onError: code => console.error(JSON.stringify({ ...diagnosticIdentity, event: "runtime_publisher_error", code })),
    onPhase: metrics?.dispatcherPhase,
  });
  const automationDispatcher=startAutomationDispatcher(pool,automations,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"automation_publisher_error",code})),()=>actionServices?.actions.reconcilePending()??Promise.resolve());
  const supportDispatcher=startSupportWaitingDispatcher(pool,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"support_waiting_publisher_error",code})));
  const receiptDispatcher=startHandoffReceiptDispatcher(pool,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"handoff_receipt_publisher_error",code})));
  const followupDispatcher=followups ? startCustomerFollowupDispatcher(pool,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"customer_followup_publisher_error",code})),{configurationDigest:followupConfigurationDigest(followupConfig!),adminUrl:process.env.RESTATE_ADMIN_URL??"http://127.0.0.1:19070"}) : undefined;
  const ingestionDispatcher=ingestion?startIngestionDispatcher(ingestion,process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",
    code=>console.error(JSON.stringify({...diagnosticIdentity,event:"ingestion_publisher_error",code}))):undefined;
  // Object deletion is independent of physical resource cleanup; either backend may be temporarily unavailable.
  const documentCleanup=documents?runDocumentReaper(pool,abort.signal):undefined;
  const sourceCleanup=runSourceObjectReaper(pool,abort.signal);
  const telemetry = startObservationPublisher(pool, telemetryTransport);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    abort.abort();
    clearInterval(cancellationTimer);clearInterval(uncertainTimer); await Promise.all([cancellationPending,uncertainPending]);
    await Promise.all([dispatcher.stop(),automationDispatcher.stop(),supportDispatcher.stop(),receiptDispatcher.stop(),followupDispatcher?.stop(),ingestionDispatcher?.stop(),documentCleanup,sourceCleanup]);
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
