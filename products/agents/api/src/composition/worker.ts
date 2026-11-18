import { skillPackageCodec } from "../capabilities/skills/package";
import {publishCustomerTimeoutBatch} from "../product/inbox/customer-timeout-notice";
import { assertKnowledgeBackfilled } from "../platform/knowledge/bootstrap";
import { runMemoryRetention } from "./memory-retention";
import { PostgresKnowledgeObjectStore } from "../platform/knowledge";
import { remoteAuthOptionsFromEnvironment } from "../product/connections/remote-auth";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { createServer,type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { ConnectedExecutor } from "../capabilities/connected-tools/connected-executor";
import { ToolReviewStore } from "../capabilities/reviews/tool-reviews";
import { RemoteConnectionStore } from "../product/connections/remote-connections";
import { ProviderServices } from "../product/connections/provider-services";
import { BookingService } from "../workflows/booking/bookings";
import { bookingOperationHandler } from "../workflows/booking/handler";
import { reportDeliveryHandler } from "../workflows/report-delivery/handler";
import { ApiConnectionStore } from "../product/connections/api-connections";
import { createNativeApiCapabilityCatalog } from "../capabilities/connected-tools/generic-connected-runtime";
import { assertConnectedBindingDependencies } from "../capabilities/connected-tools/connected-tool-schema";
import { IngestionService,createIngestionWorkflow,startIngestionDispatcher } from "../platform/knowledge";
import { KnowledgeStore } from "../platform/knowledge";
import { KnowledgeRuntime } from "../platform/knowledge";
import { QueryEmbeddingService } from "../platform/knowledge";
import { resourceBackends } from "./resource-backends";
import { createSandboxExecutor } from "../capabilities/sandbox/sandbox-executor";
import { capabilityBindingSchema } from "../contracts/capability-catalog";
import { PlatformError,connectedToolAuthorityIds } from "../contracts/contracts";import { TaskArtifactStore } from "../execution/artifacts/task-artifacts";
import { createBusinessWorkflow, type BusinessOptions } from "../execution/business/business";
import { PlatformConversationHistory } from "../platform/conversations";
import { PlatformRunStateReader } from "../platform/runs";
import { registeredWorkflowServices } from "../platform/capabilities";
import { workloadPoolsFromEnvironment } from "../execution/scheduling/workload-routes";
import { MemoryStore } from "../platform/memory";
import { createContextCompactionWorkflow } from "../execution/context/compaction-workflow";
import { createSupportStatusWorkflow,SUPPORT_STATUS_WORKFLOW } from '../execution/business/support-status-business';
import { ModelProviderStore } from "../product/model-providers/store";
import { generateConversationTitle } from "../product/agents/conversation-title";
import { ModelCredentialVault } from "../infrastructure/model-credential-vault";
import { connectionVaultFromEnvironment } from "../infrastructure/vault";
import { EvidenceStore } from "../execution/context/evidence";
import { startDispatcher } from "../execution/lifecycle/dispatcher";
import { dispatchPolicyFromEnvironment } from "../execution/scheduling/dispatch-claims";
import { WORKFLOW_NAME, reconcileInterruptedPreparations } from "../execution/lifecycle/execution";
import { createMaintenanceLoop } from "./maintenance-loop";
import { HARNESS_RELEASE, HANDOFF_HARNESS_RELEASE, HANDOFF_WORKFLOW_NAME, ADAPTIVE_HARNESS_RELEASE, ADAPTIVE_WORKFLOW_NAME,LEGACY_ADAPTIVE_HARNESS_RELEASE,LEGACY_ADAPTIVE_WORKFLOW_NAME,SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME } from "../contracts/execution";
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

import { createConfiguredProductRuntime } from "../execution/products/configured-runtime";
import { agentsBillingClient } from "../product/billing/billing";
import { forwardAgentsUsage } from "../product/billing/usage";
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
  // Independent maintenance loops: a slow provider send must not postpone cancellation or timeout work.
  const fail=(code:string)=>()=>console.error(JSON.stringify({...diagnosticIdentity,event:"channel_maintenance_failed",code}));
  const cancellationMaintenance=createMaintenanceLoop(()=>inbox.drainCancellations(),fail("CANCELLATION_DRAIN_UNAVAILABLE"));
  const timeoutMaintenance=createMaintenanceLoop(()=>publishCustomerTimeoutBatch(pool,20,code=>console.error(JSON.stringify({...diagnosticIdentity,event:"customer_timeout_notice_failed",code}))),fail("TIMEOUT_NOTICE_UNAVAILABLE"));
  const deliveryMaintenance=createMaintenanceLoop(()=>channelServices.delivery.drain(),fail("DELIVERY_DRAIN_UNAVAILABLE"));
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
  // A workflow that failed before binding an invocation cannot settle its own task.
  const preparationSweepMs=Number(process.env.AGENTS_PREPARATION_SWEEP_MS??900000);
  let preparationPending: Promise<unknown> | undefined;
  const preparationTimer=setInterval(()=>{
    if(preparationPending)return;
    preparationPending=reconcileInterruptedPreparations(pool,Number.isSafeInteger(preparationSweepMs)&&preparationSweepMs>=60000?preparationSweepMs:900000)
      .then(count=>{if(count)console.info(JSON.stringify({...diagnosticIdentity,event:"preparation_reconciled",count}));})
      .catch(()=>console.error(JSON.stringify({...diagnosticIdentity,event:"preparation_reconcile_failed"})))
      .finally(()=>{preparationPending=undefined;});
  },60000);preparationTimer.unref();
  const billing = agentsBillingClient(process.env);
  if (billing) {
    let billingPending: Promise<unknown> | undefined;
    const billingTimer = setInterval(() => {
      if (billingPending) return;
      billingPending = forwardAgentsUsage(pool, billing, 100)
        .then((count) => {
          if (count)
            console.info(JSON.stringify({ ...diagnosticIdentity, event: "billing_usage_forwarded", count }));
        })
        .catch(() => console.error(JSON.stringify({ ...diagnosticIdentity, event: "billing_usage_forward_failed" })))
        .finally(() => { billingPending = undefined; });
    }, 15_000);
    billingTimer.unref();
  }
  const modelVault = connectionVaultFromEnvironment();
  const modelProvider = new ModelProviderStore(pool, modelVault ? new ModelCredentialVault(modelVault) : undefined);
  const productRuntime=await createConfiguredProductRuntime(pool,evidence);
  const workflowOptions: BusinessOptions = { modelProvider, signal: abort.signal,
    product:productRuntime,
    readRetainedArtifact: (taskId,originTaskId,artifactId)=>artifacts.readRetainedForTask(taskId,originTaskId,artifactId),artifacts,
    actions:actionServices?.actions,selectReportArtifact:(taskId,name,output)=>artifacts.prepareReport(taskId,name,output),
    executeSandbox: createSandboxExecutor(pool,sandbox,objects),evidence,knowledgeRuntime,connected,toolReviews,
    capabilityHandlers:[bookingOperationHandler(bookings),reportDeliveryHandler()],
    history: new PlatformConversationHistory(pool),
    readers: { knowledge: knowledgeRuntime, memory: new MemoryStore(pool, skillPackageCodec), runState: new PlatformRunStateReader(pool) },
    onSettled: taskId => generateConversationTitle({ pool, providers: modelProvider, taskId })
      .catch(error => console.error(JSON.stringify({ ...diagnosticIdentity, event: "conversation.title.failed", taskId,
        code: error instanceof PlatformError ? error.code : "TITLE_GENERATION_FAILED" }))) };
  const workflow = createBusinessWorkflow(pool, workflowOptions);
  const handoffWorkflow = createBusinessWorkflow(pool, {...workflowOptions,
    settleHandoffReceipt:(taskId,candidate,definitiveFailure)=>settleReceipt(pool,taskId,candidate?{text:candidate}:null,HANDOFF_RECEIPT,
      (db,input)=>inbox.publishPendingHandoffReceipt(db,input),definitiveFailure),
  },{release:HANDOFF_HARNESS_RELEASE,workflow:HANDOFF_WORKFLOW_NAME});
  const legacyAdaptiveWorkflow = createBusinessWorkflow(pool, workflowOptions, {release:LEGACY_ADAPTIVE_HARNESS_RELEASE,workflow:LEGACY_ADAPTIVE_WORKFLOW_NAME});
  const adaptiveWorkflow = createBusinessWorkflow(pool, workflowOptions, {release:ADAPTIVE_HARNESS_RELEASE,workflow:ADAPTIVE_WORKFLOW_NAME});
  const sharedWorkflow = createBusinessWorkflow(pool, {...workflowOptions,
    settleHandoffReceipt:(taskId,candidate,definitiveFailure)=>settleReceipt(pool,taskId,candidate?{text:candidate}:null,HANDOFF_RECEIPT,
      (db,input)=>inbox.publishPendingHandoffReceipt(db,input),definitiveFailure),
  }, {release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME});
  const compactionWorkflow=createContextCompactionWorkflow(pool,{...workflowOptions,evidence});
  const {host,identityKeys} = workerSecurityFromEnvironment();
  const receiptWorkflow=createReceiptWorkflow(pool,HANDOFF_RECEIPT,(db,input)=>inbox.publishPendingHandoffReceipt(db,input));
  const statusWorkflow=createSupportStatusWorkflow(pool,{...workflowOptions,publishSupportStatus:taskId=>inbox.publishSupportStatus(taskId)});
  const workflowRegistrations = [
    { id: "business", service: workflow }, { id: "handoff", service: handoffWorkflow },
    { id: "adaptive-legacy", service: legacyAdaptiveWorkflow }, { id: "adaptive", service: adaptiveWorkflow },
    { id: "shared", service: sharedWorkflow }, { id: "compaction", service: compactionWorkflow },
    { id: "handoff-receipt", service: receiptWorkflow }, { id: "support-status", service: statusWorkflow },
    { id: "automation", service: createAutomationWorkflow(automations) },
    { id: "support-waiting", service: createSupportWaitingWorkflow(supportWaiting) },
    ...(followups ? [{ id: "customer-followup", service: createCustomerFollowupWorkflow(followups) }] : []),
    ...(ingestion ? [{ id: "knowledge-ingestion", service: createIngestionWorkflow(ingestion) }] : []),
  ];
  const server = createServer(createEndpointHandler({ services: registeredWorkflowServices(workflowRegistrations), identityKeys }));
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  try {
    await pool.query("SELECT 1 FROM agents_platform.tasks LIMIT 1");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } catch (error) { server.close(); await pool.end(); throw error; }
  const metrics = createNativeMetrics(pool,"worker");
  const workerPools = workloadPoolsFromEnvironment(), workerPool = process.env.AGENTS_WORKER_POOL?.trim() || null;
  const workload = workerPools.interactive && workerPool === workerPools.interactive ? "interactive" as const : workerPools.background && workerPool === workerPools.background ? "background" as const : undefined;
  const dispatcher = startDispatcher(pool, {
    workload,
    policy: dispatchPolicy,
    ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:18080",
    adminUrl: process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:19070",
    runtimeRoutes: Object.fromEntries([[HARNESS_RELEASE,WORKFLOW_NAME],[HANDOFF_HARNESS_RELEASE,HANDOFF_WORKFLOW_NAME],[ADAPTIVE_HARNESS_RELEASE,ADAPTIVE_WORKFLOW_NAME],[LEGACY_ADAPTIVE_HARNESS_RELEASE,LEGACY_ADAPTIVE_WORKFLOW_NAME],[SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME]].map(([release,workflowName])=>[release!,{ingressUrl:process.env.RESTATE_INGRESS_URL??"http://127.0.0.1:18080",adminUrl:process.env.RESTATE_ADMIN_URL??"http://127.0.0.1:19070",workflowName:workflowName!}])),
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
  const memoryCleanup=runMemoryRetention(pool,abort.signal);
  const telemetry = startObservationPublisher(pool, telemetryTransport);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    abort.abort();
    cancellationMaintenance.stop();timeoutMaintenance.stop();deliveryMaintenance.stop();clearInterval(uncertainTimer);clearInterval(preparationTimer); await Promise.all([cancellationMaintenance.pending(),timeoutMaintenance.pending(),deliveryMaintenance.pending(),uncertainPending]);
    await Promise.all([dispatcher.stop(),automationDispatcher.stop(),supportDispatcher.stop(),receiptDispatcher.stop(),followupDispatcher?.stop(),ingestionDispatcher?.stop(),documentCleanup,sourceCleanup,memoryCleanup]);
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
