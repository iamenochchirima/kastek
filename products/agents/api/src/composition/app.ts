import { readWorkProgress, queueOrchestrationInstruction, authorizeOrchestration } from "../execution/delegation/progress";
import { specialistCatalogue } from "../product/assistant/specialists";
import { OrganizationAssistantStore } from "../product/agents/organization-assistant";
import { MemberChannels } from "../product/assistant/member-channels";
import { PostgresKnowledgeObjectStore } from "../capabilities/knowledge/postgres-object-store";
import { registerCustomerRecordRoutes } from "../product/customer-records/routes";
import { registerOverviewRoutes } from "../product/overview/routes";
import { CustomerRecordStore } from "../product/customer-records/store";
import { customerSetupReadiness } from "../product/agents/setup-readiness";
import {EnquiryStore} from "../capabilities/enquiries/enquiries";
import {registerEnquiryRoutes} from "../product/enquiries/routes";
import {registerAdminCustomerRoutes} from "../product/customers/routes";
import {registerAdminReportingRoutes} from "../product/reporting/routes";
import { remoteAuthOptionsFromEnvironment } from "../product/connections/remote-auth";
import cookie from "@fastify/cookie";
import Fastify,{ type FastifyReply, type FastifyRequest } from "fastify";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { websiteWidgetScript } from "../adapters/channels/website/widget";
import { websiteAppearanceSchema } from "../adapters/channels/website/appearance";
import { registerWebsiteAppearanceRoutes } from "../product/deployments/appearance-routes";
import { ConnectedExecutor } from "../capabilities/connected-tools/connected-executor";
import { assertConnectedBindingDependencies } from "../capabilities/connected-tools/connected-tool-schema";
import { KnowledgeStore } from "../capabilities/knowledge/knowledge";
import { resourceBackends } from "./resource-backends";
import { capabilityBindingSchema } from "../contracts/capability-catalog";
import {
agentConfigurationSchema,assertRuntimeAvailable,
canonicalJson,
connectedToolAuthorityIds,requestDigest,
executionGrantSchema,
parseAllowedOrigin,
PlatformError,
taskStateSchema,
terminalTaskStates,type AdmissionAuthority,type AgentConfiguration
} from "../contracts/contracts";
import type { Account,TaskRecord,VersionRecord } from "../contracts/records";
import { TaskArtifactStore } from "../execution/artifacts/task-artifacts";
import { assertCurrentEvidence,citationLabels,EvidenceStore } from "../execution/context/evidence";
import { resolveAutomationOwner,resolveAutomationReviewer } from "../execution/lifecycle/automation-authority";
import { queueChildContinuations,requestTreeCancellation } from "../execution/lifecycle/execution";
import { MemoryStore } from "../execution/memory/memory";
import type { PlatformConfig } from "../infrastructure/config";
import { privateStoreFromEnvironment } from "../infrastructure/object-store";
import { pageQuery, cursorKeysFromEnvironment } from "../infrastructure/read-pages";
import { PlatformDiscovery } from "../product/agents/discovery";
import { registerKnowledgeRoutes } from "../product/agents/knowledge-routes";
import { WebsiteCrawlStore, startWebsiteCrawlDispatcher } from "../product/agents/website-crawls";
import { registerWebsiteCrawlRoutes } from "../product/agents/website-crawl-routes";
import { loadFirecrawlConfig } from "../adapters/providers/firecrawl/client";
import { customerSetupSchema } from "../product/offerings/customer-setup";
import { registerMemoryRoutes } from "../product/agents/memory-routes";
import { registerSkillPackageRoutes } from "../product/agents/skill-package-routes";
import { SkillPackageStore } from "../product/agents/skill-package-store";
import { registerCatalogueRoutes } from "../product/catalogue/catalogue-routes";
import { RemoteConnectionStore } from "../product/connections/remote-connections";
import { ProviderServices } from "../product/connections/provider-services";
import type { GoogleOAuthPort } from "../product/connections/google-calendar-oauth";
import { BookingService } from "../workflows/booking/bookings";
import { ApiConnectionStore } from "../product/connections/api-connections";
import { ExecutableAdapterRegistry } from "../contracts/capability-catalog";
import { nativeApiAdapterManifest,executeGenericNativeApi,createNativeApiCapabilityCatalog } from "../capabilities/connected-tools/generic-connected-runtime";
import { registerProviderRoutes } from "../product/connections/provider-routes";
import { registerBookingRoutes } from "../workflows/booking/routes";
import { registerApiConnectionRoutes } from "../product/connections/api-connection-routes";
import { registerModelPolicyRoutes } from "../product/model-providers/model-policy";
import { registerModelProviderDependencyRoutes } from "../product/model-providers/dependencies";
import { registerModelProviderRoutes } from "../product/model-providers/routes";
import { ModelProviderStore } from "../product/model-providers/store";
import { ModelCredentialVault } from "../infrastructure/model-credential-vault";
import { connectionVaultFromEnvironment } from "../infrastructure/vault";
import { registerRemoteConnectionRoutes } from "../product/connections/remote-connection-routes";
import { curatedSkillCatalog } from "../capabilities/skills/curated";
import { ToolReviewStore } from "../capabilities/reviews/tool-reviews";
import { registerToolReviewRoutes } from "../product/connections/tool-review-routes";
import { PlatformStore } from "../product/agents/store";
import { transaction } from "../infrastructure/database";
import { EvaluationTrials, prepareTrialSchema } from "../product/evaluation/evaluation-trials";
import { customerOfferings } from "../product/offerings/offerings";
import { registerAutomationRoutes } from "../product/automations/automation-routes";
import { AutomationService,operationsForConfiguration } from "../product/automations/automations";
import { registerActionRoutes } from "../product/connections/actions-routes";
import { PlatformIdentity } from "../product/identity/auth";
import { registerPublicIdentityRoutes } from "../product/identity/auth-routes";
import { actionsFromEnvironment } from "./actions";
import { composeInbox } from "./inbox";
import { composeChannels } from "./channels";
import { registerChannelRoutes } from "../product/channels/channel-routes";
import { registerChannelWebhooks } from "../product/channels/channel-webhooks";
import { registerChannelSupportRoutes } from "../product/channels/channel-support-routes";
import { registerInboxRoutes } from "../product/inbox/inbox-routes";
import { ConnectedReconciliation } from "../product/inbox/connected-reconciliation";
import { customerFollowupConfig } from "../product/customer-followup/config";
import { CustomerFollowupChallenges } from "../product/customer-followup/challenges";
import { registerCustomerFollowupConsent, registerCustomerFollowupReturn } from "../product/customer-followup/routes";
import { ResendNotificationSender } from "../adapters/notifications/resend";
import { customerFollowupReady } from "../product/customer-followup/readiness";
import { registerSupportAlertRoutes } from "../product/inbox/support-alert-routes";
import { registerSupportPresenceRoutes } from "../product/inbox/support-presence-routes";
import { exportExecutionHistory } from "../product/evaluation/history-export";

import {registerGrowthProvisionRoute} from "../product/integrations/growth-provisioning";
import { registerGrowthProductRoutes } from "../product/integrations/growth-routes";
import { growthServiceTrustFromEnvironment } from "../adapters/products/growth-service-auth";
import { growthActionClientFromEnvironment } from "../adapters/products/growth-action-client";
import { GrowthProductRuntime } from "../execution/products/growth-runtime";
import { registerAgencyProductCapabilities } from "../adapters/products/agency-capability-client";
const uuid = z.uuid();
const taskInput = z.strictObject({ versionId: uuid, input: z.string().min(1),
  requestKey: z.string().trim().min(1).max(128), conversationId: uuid.optional() });
const websiteTaskInput = taskInput.omit({ versionId: true });
const humanTaskInput = taskInput.omit({ versionId: true }).extend({ agentId: uuid.optional(), versionId: uuid.optional(),
  evaluationTrialId: uuid.optional(), evaluationRootTokenLimit: z.number().int().positive().max(2147483647).optional() })
  .refine(input => Boolean(input.agentId) !== Boolean(input.versionId), "Choose an agent or an explicit evaluation snapshot")
  .refine(input => !input.agentId || !input.evaluationTrialId, "Evaluations require an explicit snapshot");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const dto = (row: object) => ({ ...Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
])), ...(Object.hasOwn(row,"conversation_id") && Object.hasOwn(row,"grant_id") ? {
  rootTaskId: (row as TaskRecord).root_task_id, parentTaskId: (row as TaskRecord).parent_task_id,
  phase: terminalTaskStates.has((row as TaskRecord).state) ? "terminal" : (row as TaskRecord).state === "accepted" ? "queued" :
    (row as TaskRecord).state === "cancel_requested" ? "stopping" : (row as TaskRecord).state,
  outcome: terminalTaskStates.has((row as TaskRecord).state) ? (row as TaskRecord).state : null,
} : {}) });

export async function buildPlatformApp(options: { config: PlatformConfig; pool: Pool; identity?: PlatformIdentity; logging?: boolean;testGoogleOAuth?:GoogleOAuthPort;testGoogleApiBaseUrl?:string;testConnectionLoopback?:boolean;
  testFollowupSender?: Pick<ResendNotificationSender,"send">;
  testModelProviderOptions?: ConstructorParameters<typeof ModelProviderStore>[3] }) {
  const { config, pool } = options;
  if((options.testGoogleOAuth||options.testGoogleApiBaseUrl)&&config.NODE_ENV!=="test")throw new Error("TEST_GOOGLE_OPTIONS_DENIED");
  if(options.testConnectionLoopback&&config.NODE_ENV!=="test")throw new Error("TEST_CONNECTION_OPTIONS_DENIED");
  if(options.testModelProviderOptions&&config.NODE_ENV!=="test")throw new Error("TEST_MODEL_OPTIONS_DENIED");
  if(options.testFollowupSender&&config.NODE_ENV!=="test")throw new Error("TEST_FOLLOWUP_OPTIONS_DENIED");
  const store = new PlatformStore(pool);
  const evaluationTrials = new EvaluationTrials(pool);
  const discovery = new PlatformDiscovery(pool,store);
  const summary = ({position: _position,...row}: Record<string,unknown>) => row;
  const objects = privateStoreFromEnvironment();
  const sourceObjects = privateStoreFromEnvironment(process.env, 10_485_760);
  const knowledge = new KnowledgeStore(pool, new PostgresKnowledgeObjectStore(pool));
  const {documents:documentRuntime,sandbox}=resourceBackends(pool);
  const taskArtifacts = new TaskArtifactStore(pool, objects);
  const actionServices=actionsFromEnvironment(pool,taskArtifacts);
  const toolReviews=new ToolReviewStore(pool);
  const enquiries=new EnquiryStore(pool);
  const providers=new ProviderServices(pool,actionServices?.connections.vault,{appUrl:config.AGENTS_PUBLIC_URL,tests:{"google-calendar":{oauth:options.testGoogleOAuth,testApiBaseUrl:options.testGoogleApiBaseUrl}}});
  const bookings=new BookingService(pool,{resolveCalendar:(...args)=>providers.resolveCalendar(...args),ensureFresh:(scope,id)=>providers.ensureFresh(scope,id),testBaseUrl:options.testGoogleApiBaseUrl});

  const remoteConnections=actionServices?new RemoteConnectionStore(pool,actionServices.connections.vault,{
    testLoopback:options.testConnectionLoopback,
    callbackUrl:`${new URL(config.AGENTS_PUBLIC_URL).origin}/api/connections/oauth/callback`,
    ...remoteAuthOptionsFromEnvironment(),
  }):undefined;
  const evidence = new EvidenceStore(pool, sourceObjects);
  // API and worker use the same execution mode/build: source and compiled artifact digests intentionally differ.
  const connected:ConnectedExecutor|undefined = actionServices && sourceObjects && evidence ? new ConnectedExecutor(pool, providers.credentials(actionServices.connections), sourceObjects, evidence,{
    resolveRemoteEndpoint:remoteConnections?(db,scope,id,policy)=>remoteConnections.resolveRemoteEndpoint(db,scope,id,policy):undefined,
    ensureCredentialFresh:async(scope,id)=>{const native=await providers.forConnection(scope,id);if(native)await native.ensureCredentialFresh(scope,id);else await remoteConnections?.ensureCredentialFresh(scope,id);},
    recordRemoteScopeChallenge:remoteConnections?(scope,id,policyRevision,challenge)=>remoteConnections.recordPermissionChallenge(scope,id,policyRevision,challenge):undefined,
    resolveApiOperation:(db,scope,id,policy,operation)=>apiConnections!.resolveApiOperation(db,scope,id,policy,operation),
    testApiLoopback:options.testConnectionLoopback,
    genericReview:toolReviews.port(),
  }) : undefined;
  const apiRegistry=connected?.registry??new ExecutableAdapterRegistry<unknown>();
  if(!connected)apiRegistry.register(nativeApiAdapterManifest(),executeGenericNativeApi);
  const apiConnections:ApiConnectionStore|undefined=actionServices?new ApiConnectionStore(pool,actionServices.connections.vault,{registry:apiRegistry,createCatalog:createNativeApiCapabilityCatalog,testLoopback:options.testConnectionLoopback}):undefined;
  const grantOperations=(configuration:AgentConfiguration)=>operationsForConfiguration(configuration,true);
  async function assertBindings(configuration: AgentConfiguration): Promise<void> {
    if (configuration.retrievalProfile.kind === "hybrid-v1" && (!documentRuntime || !await documentRuntime.available(configuration.retrievalProfile.embeddingRelease))) {
      throw new PlatformError("RETRIEVAL_BACKEND_UNAVAILABLE", 503, "The selected semantic search profile is unavailable");
    }
    const connectedAuthority = connectedToolAuthorityIds(configuration);
    if (connectedAuthority.length) {
      if (!connected) throw new PlatformError("CONNECTED_TOOLS_UNAVAILABLE", 503, "Connected tools are unavailable");
      const rows = (await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[])", [connectedAuthority])).rows;
      if (rows.length !== connectedAuthority.length) throw new PlatformError("ADAPTER_RELEASE_UNAVAILABLE", 503, "A selected tool binding is unavailable");
      const bindings = rows.map(row => capabilityBindingSchema.parse(row.binding));
      assertConnectedBindingDependencies(bindings.filter(binding => configuration.connectedToolBindingIds.includes(binding.id)));
      connected.assertAvailable(bindings);
    }
  }
  async function assertServices(configuration:AgentConfiguration):Promise<void> {
    await assertBindings(configuration);
    if((configuration.capabilities.sandbox.enabled||configuration.capabilities.workflows.enabled)&&!objects)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    if(configuration.capabilities.workflows.enabled&&!actionServices)throw new PlatformError("ACTIONS_UNAVAILABLE",503,"Report delivery is unavailable");
    if(configuration.capabilities.sandbox.enabled&&(!sandbox||!await sandbox.available()))throw new PlatformError("SANDBOX_UNAVAILABLE",503,"Analysis is unavailable");
  }
  const automations=new AutomationService(pool,assertServices);
  const followupConfig = customerFollowupConfig({...process.env, AGENTS_PUBLIC_URL:config.AGENTS_PUBLIC_URL});
  const inbox = composeInbox(pool, { publicOrigin: new URL(config.AGENTS_PUBLIC_URL).origin, followupAccessEnabled:true,followupEnabled: Boolean(followupConfig),supportStatusEnabled:true, assertServices, cursorKeys: cursorKeysFromEnvironment({ NODE_ENV:config.NODE_ENV, AGENTS_OIDC_CLIENT_SECRET:config.AGENTS_OIDC_CLIENT_SECRET, AGENTS_CURSOR_KEYS_JSON:config.AGENTS_CURSOR_KEYS_JSON, AGENTS_CURSOR_ACTIVE_KEY_ID:config.AGENTS_CURSOR_ACTIVE_KEY_ID, AGENTS_CURSOR_MAX_AGE_SECONDS:String(config.AGENTS_CURSOR_MAX_AGE_SECONDS) }) });
  const channelServices=composeChannels(pool,inbox,config.AGENTS_PUBLIC_URL);
  const identity = options.identity ?? new PlatformIdentity(config, pool);
  const origin = new URL(config.AGENTS_PUBLIC_URL).origin;
  const secure = origin.startsWith("https:");
  const sessionCookie = secure ? "__Host-agents_session" : "agents_session";
  const loginCookie = secure ? "__Host-agents_login" : "agents_login";
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const app = Fastify({ bodyLimit: 128_000, logger: options.logging === false ? false : {
    base: { service: "agents-platform", environment: config.NODE_ENV, release: (process.env.KASITEK_RELEASE_ID || "development").slice(0, 128) },
    redact: ["req.headers.authorization", "req.headers[\"x-kasitek-admin-authority\"]", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: { req: (request: { method: string; url: string }) => ({ method: request.method, path: request.url.split("?")[0] }) },
  } });
  registerGrowthProvisionRoute(app,pool,growthServiceTrustFromEnvironment());
  const growthActions=growthActionClientFromEnvironment();
  const productRuntime=growthActions?new GrowthProductRuntime(pool,growthActions,evidence):undefined;
  if(productRuntime){await productRuntime.loadPublications();registerAgencyProductCapabilities(productRuntime);}
  registerGrowthProductRoutes(app,{pool,trust:growthServiceTrustFromEnvironment(),
    runtime:productRuntime});
  await app.register(cookie);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Check the request fields" } });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });
    request.log.error({ event: "platform.request.failed", code: "INTERNAL_ERROR" }, "Request failed");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        request.url.split("?")[0] !== "/internal/v1/products/growth/commands" && request.url.split("?")[0] !== "/internal/v1/products/growth/provision" && !request.url.startsWith("/api/website/") && !request.url.startsWith("/api/automation-events/") && !request.url.startsWith("/api/channel-webhooks/") && request.url.split("?")[0] !== "/api/auth/backchannel-logout" && request.headers.origin !== origin) {
      throw new PlatformError("ORIGIN_DENIED", 403, "Request origin is not allowed");
    }
  });
  async function account(request: FastifyRequest): Promise<Account> {
    const session = await store.getSession(request.cookies[sessionCookie] ?? "");
    if (!session || session.account.issuer !== config.AGENTS_OIDC_ISSUER_URL) throw new PlatformError("SIGN_IN_REQUIRED", 401, "Sign in to continue");
    return session.account;
  }
  function parameters(request: FastifyRequest) { return request.params as Record<string, string>; }
  function organizationId(request: FastifyRequest) { return uuid.parse(parameters(request).organizationId); }
  function humanAuthority(user: Account, org: string, resourceId: string): AdmissionAuthority {
    return { product: "agents", organizationId: org, resourceId, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: user.issuer, subject: user.subject } };
  }
  async function humanTask(request: FastifyRequest) {
    const user = await account(request), org = organizationId(request), taskId = uuid.parse(parameters(request).taskId);
    await store.requireMembership(user.id, org);
    const task = (await pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2", [org, taskId])).rows[0];
    if (!task) throw new PlatformError("NOT_FOUND", 404, "Task not found");
    const root = task.parent_task_id ? (await pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2", [task.root_task_id,org])).rows[0] : task;
    if (!root || canonicalJson(root.principal)!==canonicalJson(task.principal)) throw new PlatformError("NOT_FOUND",404,"Task not found");
    let authority = humanAuthority(user, org, root.resource_id);
    let reviewOnly = false;
    if(root.principal.kind==="automation") {
      const owner=await resolveAutomationOwner(pool,org,root.principal),reviewer=await resolveAutomationReviewer(pool,org,root.id);
      if(user.id!==owner&&user.id!==reviewer)throw new PlatformError("NOT_FOUND",404,"Task not found");
      reviewOnly = user.id !== owner;
      if(reviewOnly && task.parent_task_id)throw new PlatformError("NOT_FOUND",404,"Task not found");
      authority={product:root.product,organizationId:org,resourceId:root.resource_id,callerClientId:root.caller_client_id,principal:root.principal};
    } else if(root.principal.kind==="visitor"||root.principal.kind==="channel_customer") {
      if(!await evaluationTrials.authorizeCustomerRoot(pool,user.id,org,root.id))throw new PlatformError("NOT_FOUND",404,"Task not found");
      authority={product:root.product,organizationId:org,resourceId:root.resource_id,callerClientId:root.caller_client_id,principal:root.principal};
    } else await store.getTask(authority, root.id);
    const source=(await pool.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1",[task.conversation_id])).rows[0];
    return { task: source?.deleted_at ? {...task,input:"[Deleted conversation]",output:null} : task, authority, reviewOnly };
  }
  async function readableOutput(taskId:string,output:string|null) {
    const binding=(await pool.query("SELECT channel_binding FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0]?.channel_binding;
    if(binding) {
      const published=(await pool.query(`SELECT m.body FROM agents_platform.customer_deliveries d
        JOIN agents_platform.customer_messages m ON m.id=d.message_id AND m.task_id=d.task_id
        WHERE d.task_id=$1 AND d.state='published'`,[taskId])).rows[0];
      if(!published||published.body!==output)return {output:null,outputAvailability:"unavailable"};
    }
    try{await (await import("../execution/context/evidence")).assertDelegationInputEvidence(pool,taskId);}catch(error){if(error instanceof PlatformError)return {output:null,outputAvailability:"unavailable"};throw error;}
    if(!output)return {output};
    const influenced=(await pool.query("SELECT 1 FROM agents_platform.evidence_nodes WHERE task_id=$1 LIMIT 1",[taskId])).rowCount;
    if(!influenced)return {output};
    if(!evidence)return {output:null,outputAvailability:"unavailable"};
    try {await assertCurrentEvidence(pool,taskId,await evidence.taskManifest(taskId),{requireActiveTask:false});return {output,outputAvailability:"available"};}
    catch(error) {if(error instanceof PlatformError)return {output:null,outputAvailability:"unavailable"};throw error;}
  }
  async function readableTask(task:TaskRecord){
    let input:unknown=task.input,inputAvailability="available";
    if(task.parent_task_id)try{await (await import("../execution/context/evidence")).assertDelegationInputEvidence(pool,task.id);}catch(error){if(!(error instanceof PlatformError))throw error;input=task.input==="[Deleted conversation]"?task.input:null;inputAvailability="unavailable";}
    return {...dto(task),input,inputAvailability,...await readableOutput(task.id,task.output)};
  }
  async function resolveScope(request:FastifyRequest) {const user=await account(request),org=organizationId(request);await store.requireMembership(user.id,org);return {accountId:user.id,organizationId:org};}
  const organizationAssistant=new OrganizationAssistantStore(pool),memberChannels=new MemberChannels(pool);
  const assistantBase="/api/organizations/:organizationId";
  app.get(`${assistantBase}/assistant`,async request=>{const scope=await resolveScope(request);return organizationAssistant.getOrganizationAssistant(scope.accountId,scope.organizationId);});
  app.post(`${assistantBase}/assistant/repair`,async request=>{z.strictObject({}).parse(request.body??{});const scope=await resolveScope(request);return organizationAssistant.repairOrganizationAssistant(scope.accountId,scope.organizationId);});
  app.get(`${assistantBase}/member-channels`,async request=>memberChannels.list(await resolveScope(request)));
  app.post(`${assistantBase}/member-channels/challenges`,async request=>memberChannels.challenge(await resolveScope(request),request.body));
  app.post(`${assistantBase}/member-channels/:linkId/confirm`,async request=>{z.strictObject({}).parse(request.body??{});return memberChannels.confirm(await resolveScope(request),uuid.parse(parameters(request).linkId));});
  app.delete(`${assistantBase}/member-channels/:linkId`,async request=>memberChannels.revoke(await resolveScope(request),uuid.parse(parameters(request).linkId)));
  app.get(`${assistantBase}/agents/:agentId/specialists`,async request=>specialistCatalogue(pool,await resolveScope(request),uuid.parse(parameters(request).agentId)));
  registerChannelRoutes(app,{store:channelServices.channels,telegram:channelServices.telegram,meta:channelServices.meta,resolveScope,
    resolveSessionId:async request=>{await account(request);return hash(request.cookies[sessionCookie]!);}});
  registerWebsiteAppearanceRoutes(app,{pool,resolveScope});
  registerChannelSupportRoutes(app,{inbox,delivery:channelServices.delivery,attachments:channelServices.attachments,templates:channelServices.templates,media:channelServices.media,resolveScope});
  await registerChannelWebhooks(app,{channels:channelServices.channels,delivery:channelServices.delivery,profiles:channelServices.profiles});
  const modelVault = connectionVaultFromEnvironment();
  const modelProviders = new ModelProviderStore(pool, modelVault ? new ModelCredentialVault(modelVault) : undefined, undefined, options.testModelProviderOptions);
  registerModelProviderRoutes(app, { store: modelProviders, resolveScope });
  registerModelProviderDependencyRoutes(app, { pool, resolveScope });
  registerModelPolicyRoutes(app, { store: modelProviders, resolveScope });
  registerProviderRoutes(app,{providers,resolveScope,resolveCallbackAccount:async request=>(await account(request)).id});
  registerCustomerRecordRoutes(app,{store:new CustomerRecordStore(pool),resolveScope});
  registerOverviewRoutes(app,{pool,resolveScope});
  registerSupportAlertRoutes(app,pool,resolveScope);
  registerSupportPresenceRoutes(app,pool,resolveScope);
  registerEnquiryRoutes(app,{store:enquiries,resolveScope,resolveTask:async request=>{const {task}=await humanTask(request);return {taskId:task.id,principal:task.principal};}});
  registerBookingRoutes(app,{bookings,resolveScope,resolveTask:async request=>{const {task}=await humanTask(request);return {taskId:task.id,principal:task.principal};}});
  if(apiConnections)registerApiConnectionRoutes(app,{store:apiConnections,resolveScope});
  if(remoteConnections) registerRemoteConnectionRoutes(app,{store:remoteConnections,resolveScope,accountId:async request=>(await account(request)).id});
  registerToolReviewRoutes(app,{store:toolReviews,resolveTask:async request=>{
    const scope=await resolveScope(request),task=await humanTask(request);return {...scope,taskId:task.task.id};
  }});
  const skillPackages = new SkillPackageStore(pool);
  registerCatalogueRoutes(app, { resolveScope,
    getAgent: (scope,id) => store.getAgent(scope.accountId,scope.organizationId,id),
    connectorReadiness:providers.readiness(),
    calendarProviderId:async(scope,agent)=>{
      const reference=agent.draft.capabilities.businessActions;if(!reference.enabled)return;
      const policy=(await pool.query("SELECT definition->>'providerId' provider_id FROM agents_platform.booking_policies WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND digest=$4",[reference.policyId,scope.organizationId,agent.id,reference.policyDigest])).rows[0];
      return policy?.provider_id;
    },
    listConnections: async scope => [...await actionServices?.connections.list(scope,true)??[],...await providers.catalogueConnections(scope)],
    listBindings: scope => connected?.catalogs.listBindings(scope) ?? Promise.resolve([]),
    permissions: async scope => ["agent.configure",...((await pool.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL",[scope.organizationId,scope.accountId])).rowCount?["calendar.configure"]:[])],
    listSkills: async (scope,agentId) => {
      if (!agentId) return [];
      const packages=await skillPackages.list({...scope,agentId});
      const installed=packages.map(skill => ({
        id:skill.id,name:skill.name,description:skill.description,revision:skill.revision,digest:skill.contentDigest,
        publisher:skill.publisher,source:skill.source,familyId:skill.familyId,runtimeRequirements:skill.requires,
        state:skill.state==="enabled"&&skill.reviewState==="reviewed"?"available" as const:"unavailable" as const,
        ...(skill.state!=="enabled"?{reason:"This skill is disabled or removed"}:skill.reviewState!=="reviewed"?{reason:"Review this skill before adding it"}:{}),
      }));
      const available=curatedSkillCatalog().filter(skill=>!packages.some(pkg=>pkg.source.kind==="curated"&&pkg.source.slug===skill.slug));
      return [...installed,...available.map(skill=>({id:`curated:${skill.slug}`,name:skill.name,description:skill.description,
        revision:1,digest:skill.contentDigest,publisher:skill.publisher,source:skill.source,state:"available" as const,installed:false,
        purposes:["faq" as const,"customer-service" as const]}))];
    },
  });
  registerSkillPackageRoutes(app, {pool,resolveScope:async request=>{
    const scope=await resolveScope(request),agentId=uuid.parse(parameters(request).agentId);
    await store.getAgent(scope.accountId,scope.organizationId,agentId);
    return {...scope,agentId};
  }});
  registerAutomationRoutes(app,automations,resolveScope);
  if(actionServices)registerActionRoutes(app,{...actionServices,catalogs:connected?.catalogs,
    discoverCatalog:connected?(scope,input)=>connected.discover(scope,input):undefined,
    resolveScope,resolveTask:async request=>({...await resolveScope(request),taskId:uuid.parse(parameters(request).taskId)})});
  else app.get("/api/organizations/:organizationId/connections",async request=>{
    await resolveScope(request);return{connections:[],targets:[],profiles:[],available:false};
  });
  if(!connected)app.get("/api/organizations/:organizationId/tool-bindings",async request=>{
    await resolveScope(request);return{bindings:[],available:false};
  });
  app.get("/health", async () => ({ status: "ok", service: "agents-platform", schema: "001_platform" }));
  app.get("/ready", async (_request, reply) => {
    const result = await pool.query("SELECT version FROM agents_platform.schema_version");
    const ready = result.rows[0]?.version === "001_platform";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable", business: ready, workspace: false });
  });
  registerPublicIdentityRoutes(app, { identity, store, secure, sessionCookie, loginCookie, signingSecret: config.AGENTS_LOGIN_RETURN_SECRET });
  app.post("/api/auth/logout", async (request, reply) => {
    await store.revokeSession(request.cookies[sessionCookie] ?? "");
    reply.clearCookie(sessionCookie, cookieOptions);
    return { redirectTo: await identity.logoutUrl() };
  });
  app.post("/api/auth/backchannel-logout", async (request, reply) => {
    const input = z.strictObject({ logout_token: z.string().min(1).max(16_000) }).parse(request.body);
    await identity.backchannelLogout(input.logout_token);
    return reply.code(204).send();
  });
  app.get("/api/session", async (request) => {
    const user = await account(request);
    await store.ensureInitialWorkspace(user.id);
    return { account: { id: user.id, email: user.email, displayName: user.display_name }, organizations: await store.listOrganizations(user.id) };
  });
  app.post("/api/organizations", async (request, reply) => {
    const user = await account(request), input = z.strictObject({ name: z.string().min(1).max(120) }).parse(request.body);
    return reply.code(201).send({ organization: await store.createOrganization(user.id, input.name) });
  });
  const base = "/api/organizations/:organizationId";
  registerMemoryRoutes(app, { pool, objects, resolveScope: async request => {
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    await store.getAgent(user.id, org, agentId);
    return { accountId: user.id, organizationId: org, agentId };
  } });
  app.get(`${base}/agents/summaries`,async request=>{
    const page=await discovery.agents(await account(request),organizationId(request),pageQuery.extend({q:z.string().trim().max(120).optional(),status:z.enum(["all","configured","changes-pending","setup"]).optional()}).strict().parse(request.query));
    return {agents:page.items.map(row=>summary(row as unknown as Record<string,unknown>)),nextCursor:page.nextCursor};
  });
  app.get(`${base}/conversations`,async request=>{
    const query=pageQuery.extend({agentId:uuid,versionId:uuid.optional()}).strict().parse(request.query);
    const page=await discovery.conversations(await account(request),organizationId(request),query);
    return {conversations:page.items.map(row=>summary(row as unknown as Record<string,unknown>)),nextCursor:page.nextCursor};
  });
  app.get(`${base}/tasks`,async request=>{
    const query=pageQuery.extend({agentId:uuid.optional(),state:taskStateSchema.optional()}).strict().parse(request.query);
    const page=await discovery.tasks(await account(request),organizationId(request),query);
    return {tasks:page.items.map(row=>summary(row as unknown as Record<string,unknown>)),nextCursor:page.nextCursor};
  });
  app.get(`${base}/agents`, async (request) => ({ agents: (await store.listAgents((await account(request)).id, organizationId(request))).map(dto) }));
  app.post(`${base}/agents`, async (request, reply) => {
    const user = await account(request), input = z.strictObject({ name: z.string().min(1).max(120), offering: z.literal("customer-service").optional(), configuration: agentConfigurationSchema.optional(), setup: customerSetupSchema.optional(), operationId:z.uuid().optional() }).parse(request.body);
    const created = await store.createConfiguredAgent({ accountId: user.id, organizationId: organizationId(request), name: input.name, offering: input.offering??(input.configuration?undefined:"customer-service"), configuration:input.configuration, setup: input.setup, operationId:input.operationId });
    return reply.code(201).send({ agent: dto(created.agent), snapshot: dto(created.snapshot) });
  });
  app.get(`${base}/agents/:agentId`, async (request) => {
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    const agent = await store.getAgent(user.id, org, agentId);
    const [versions, deployments] = await Promise.all([store.listVersions(user.id, org, agentId), store.listDeployments(user.id, org, agentId)]);
    return { agent: dto(agent), versions: versions.map(dto), deployments: deployments.map(dto) };
  });
  app.delete(`${base}/agents/:agentId`, async (request, reply) => {
    await store.deleteAgent((await account(request)).id, organizationId(request), uuid.parse(parameters(request).agentId));
    return reply.code(204).send();
  });
  app.get(`${base}/agents/:agentId/setup-readiness`, async request => ({ readiness: await customerSetupReadiness(pool, (await account(request)).id, organizationId(request), uuid.parse(parameters(request).agentId)) }));
  app.put(`${base}/agents/:agentId`, async (request) => {
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), configuration: agentConfigurationSchema,
      expectedRevision: z.number().int().positive() }).parse(request.body);
    return { agent: dto(await store.updateDraft({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) };
  });
  app.post(`${base}/agents/:agentId/configuration`, async request => {
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), configuration: agentConfigurationSchema,
      expectedRevision: z.number().int().positive(), confirmImpact: z.boolean().optional(), setup: customerSetupSchema.optional(), setupStep:z.enum(["Business","Responsibilities","Knowledge","Channels","Preferences","Bookings","Review","complete"]).optional() }).parse(request.body);
    await assertBindings(input.configuration);
    const result = await store.saveConfiguration({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) });
    request.log.info({ event: "agent.configuration.saved", agentId: result.agent.id, snapshotId: result.snapshot.id,
      organizationId: result.agent.organization_id }, "Agent configuration saved");
    return { agent: dto(result.agent), snapshot: dto(result.snapshot), deployments: result.deployments.map(dto) };
  });
  registerKnowledgeRoutes(app, { knowledge, runtime: documentRuntime, resolveScope: async request => ({ accountId: (await account(request)).id, organizationId: organizationId(request) }) });
  const websiteCrawls = new WebsiteCrawlStore(pool, knowledge, loadFirecrawlConfig());
  registerWebsiteCrawlRoutes(app, { crawls: websiteCrawls, runtime: documentRuntime,
    resolveScope: async request => ({ accountId: (await account(request)).id, organizationId: organizationId(request) }) });
  let stopWebsiteCrawls: (() => void | Promise<void>) | undefined;
  app.addHook("onReady", async () => {
    if (websiteCrawls.available) stopWebsiteCrawls = startWebsiteCrawlDispatcher(websiteCrawls,
      () => app.log.error({ event: "website_crawl_dispatch_failed", code: "WEBSITE_CRAWL_DISPATCH_FAILED" }));
  });
  app.addHook("onClose", async () => { await stopWebsiteCrawls?.(); });
  app.post(`${base}/agents/:agentId/versions`, async (request, reply) => {
    const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    const agent = await store.getAgent(user.id, org, agentId);
    await assertBindings(agentConfigurationSchema.parse(agent.draft));
    return reply.code(201).send({ version: dto(await store.createVersion({ ...input, accountId: user.id,
      organizationId: org, agentId })) });
  });
  app.post(`${base}/agents/:agentId/deployments`, async (request, reply) => {
    const input = z.strictObject({ versionId: uuid.optional(), allowedOrigins: z.array(z.string()).min(1).max(10) }).parse(request.body);
    const scope = { accountId: (await account(request)).id, organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId), allowedOrigins: input.allowedOrigins };
    const deployment = input.versionId ? await store.publishWebsite({ ...scope, versionId: input.versionId }) : await store.publishCurrentWebsite(scope);
    return reply.code(201).send({ deployment: dto(deployment) });
  });
  app.get(`${base}/offerings`, async request => {
    await store.requireMembership((await account(request)).id, organizationId(request));
    return { offerings: customerOfferings };
  });
  app.get(`${base}/tasks/:taskId/history-export`, async request => {
    const user = await account(request), org = organizationId(request), taskId = uuid.parse(parameters(request).taskId);
    return exportExecutionHistory(pool, taskId, async (db, rootTaskId) => {
      const visitorScope=await evaluationTrials.authorizeCustomerRoot(db,user.id,org,rootTaskId);
      if(visitorScope)return visitorScope;
      const allowed = await db.query(`SELECT t.id FROM agents_platform.tasks t
        JOIN agents_platform.memberships m ON m.organization_id=t.organization_id AND m.account_id=$3 AND m.revoked_at IS NULL
        WHERE t.id=$1 AND t.organization_id=$2 AND t.product='agents' AND t.caller_client_id='agents-execution'
          AND t.parent_task_id IS NULL AND t.principal=$4::jsonb FOR SHARE OF t,m`,
      [rootTaskId, org, user.id, JSON.stringify({ kind: "human", issuer: user.issuer, subject: user.subject })]);
      if (!allowed.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Execution history is unavailable");
    }, {objects:sourceObjects});
  });
  app.post(`${base}/agents/:agentId/model-preview`, async request => evaluationTrials.preview(
    (await account(request)).id, organizationId(request), uuid.parse(parameters(request).agentId), request.body));
  app.post(`${base}/evaluation-trials`, async (request, reply) => {
    const org = organizationId(request), user = await account(request);
    const trial = await evaluationTrials.prepare(user.id, org, prepareTrialSchema.parse(request.body));
    return reply.code(201).send({ trial, submitPath: `/api/organizations/${org}/tasks`, taskBinding: { evaluationTrialId: trial.id },
      revokePath: `/api/organizations/${org}/evaluation-trials/${trial.id}/revoke` });
  });
  app.get(`${base}/evaluation-trials`, async request => {
    const query = z.strictObject({ trialId: z.string().min(1).max(128) }).parse(request.query);
    return evaluationTrials.get((await account(request)).id, organizationId(request), query);
  });
  app.get(`${base}/evaluation-trials/:trialId`, async request => evaluationTrials.get((await account(request)).id,
    organizationId(request), { id: uuid.parse(parameters(request).trialId) }));
  app.post(`${base}/evaluation-trials/:trialId/channel-session`,async request=>{
    if(!config.AGENTS_LOGIN_RETURN_SECRET)throw new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE",503,"Evaluation channels require the configured signing secret");
    return evaluationTrials.channelSession((await account(request)).id,organizationId(request),uuid.parse(parameters(request).trialId),request.body,config.AGENTS_LOGIN_RETURN_SECRET);
  });
  app.post(`${base}/evaluation-trials/:trialId/channel-fixture`,async request=>{
    if(!channelServices.fixtures)throw new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE",503,"Isolated channel storage is unavailable");
    return channelServices.fixtures.prepare(await resolveScope(request),uuid.parse(parameters(request).trialId),request.body);
  });
  app.post(`${base}/evaluation-trials/:trialId/channel-fixture/ingress`,async request=>{
    if(!channelServices.fixtures)throw new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE",503,"Isolated channel storage is unavailable");
    return channelServices.fixtures.ingress(await resolveScope(request),uuid.parse(parameters(request).trialId),request.body);
  });
  app.get(`${base}/evaluation-trials/:trialId/channel-history`,async request=>{
    const user=await account(request),org=organizationId(request),id=uuid.parse(parameters(request).trialId);
    const trial=await evaluationTrials.get(user.id,org,{id});
    if(!trial.trial)throw new PlatformError("NOT_FOUND",404,"Trial not found");
    if((await pool.query("SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels WHERE trial_id=$1 AND organization_id=$2",[id,org])).rowCount){
      if(!channelServices.fixtures)throw new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE",503,"Isolated channel storage is unavailable");
      return channelServices.fixtures.history({accountId:user.id,organizationId:org},id);
    }
    const channel=(await pool.query(`SELECT c.id FROM agents_platform.evaluation_trial_channels e
      JOIN agents_platform.customer_conversations c ON c.session_id=e.session_id AND c.deployment_id=e.deployment_id
      WHERE e.trial_id=$1 AND c.organization_id=$2`,[id,org])).rows[0];
    if(!channel)return {conversation:null,messages:[],commands:[],deliveries:[],rootTaskIds:trial.rootTaskIds};
    const history=await inbox.readStaff({accountId:user.id,organizationId:org},channel.id);
    const commands=(await pool.query(`SELECT command_id,action,actor_account_id,created_at FROM agents_platform.customer_commands WHERE conversation_id=$1 ORDER BY created_at,command_id LIMIT 1000`,[channel.id])).rows;
    const deliveries=(await pool.query(`SELECT id,task_id,message_id,ownership_generation,state,reason,created_at FROM agents_platform.customer_deliveries WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1000`,[channel.id])).rows;
    return {...history,commands,deliveries,rootTaskIds:trial.rootTaskIds};
  });
  app.post(`${base}/evaluation-trials/:trialId/revoke`, async request => {
    z.strictObject({}).parse(request.body ?? {});
    return evaluationTrials.revoke((await account(request)).id, organizationId(request), uuid.parse(parameters(request).trialId));
  });
  app.post(`${base}/tasks`, async (request, reply) => {
    const input = humanTaskInput.parse(request.body), user = await account(request), org = organizationId(request);
    if (input.agentId) {
      const authority = humanAuthority(user,org,input.agentId);
      const result = await transaction(pool,async db => {
        if (!(await db.query("SELECT 1 FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[org])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"Access denied");
        if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[org,user.id])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"Access denied");
        const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product='agents' AND organization_id=$1
          AND caller_client_id='agents-execution' AND resource_id=$2 AND request_key=$3`,[org,input.agentId,input.requestKey])).rows[0];
        if (existing) {
          const digest = requestDigest({authority,versionId:existing.version_id,input:input.input,conversationId:input.conversationId??null,evaluationTrialId:null,channelBinding:null});
          if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The request key was used for different input");
          if ((await db.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1",[existing.conversation_id])).rows[0]?.deleted_at)
            throw new PlatformError("CONVERSATION_DELETED",403,"Conversation is unavailable");
          return {task:existing,replayed:true};
        }
        if (input.evaluationRootTokenLimit) throw new PlatformError("EVALUATION_SCOPE_REQUIRED",403,"A trial is required for this allocation");
        const version = (await db.query<VersionRecord>(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a
          ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.agent_id=$2 ORDER BY v.number DESC LIMIT 1`,[org,input.agentId])).rows[0];
        if (!version) throw new PlatformError("CONFIGURATION_UNAVAILABLE",409,"Save the agent settings before chatting");
        assertRuntimeAvailable(version.configuration);
        await assertServices(version.configuration);
        const grant = executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:grantOperations(version.configuration),
          sourceRevisionIds:version.configuration.sourceRevisionIds,connectedToolBindingIds:connectedToolAuthorityIds(version.configuration),
          maxInputBytes:version.configuration.model.maxInputBytes,maxOutputTokens:version.configuration.model.maxOutputTokens,
          maxContextTokens:version.configuration.context.maxInputTokens,expiresAt:new Date(Date.now()+30*60_000).toISOString(),revokedAt:null});
        await store.createGrantInTransaction(db,{accountId:user.id,grant});
        return store.admitTaskInTransaction(db,{authority,grantId:grant.id,versionId:version.id,input:input.input,requestKey:input.requestKey,
          conversationId:input.conversationId,configurationMode:"current"});
      });
      request.log.info({event:"task.admitted",taskId:result.task.id,organizationId:org,replayed:result.replayed},"Task admitted");
      return reply.code(result.replayed?200:202).send({task:await readableTask(result.task)});
    }
    const version = await store.getVersion(user.id, org, input.versionId!);
    assertRuntimeAvailable(version.configuration);
    await assertServices(version.configuration);
    const authority = humanAuthority(user, org, version.agent_id);
    const trial = input.evaluationTrialId ? (await evaluationTrials.get(user.id, org, { id: input.evaluationTrialId })).trial : null;
    if (input.evaluationTrialId && !trial) throw new PlatformError("EVALUATION_TRIAL_INACTIVE", 403, "Trial not found");
    if (input.evaluationRootTokenLimit && !trial) throw new PlatformError("EVALUATION_SCOPE_REQUIRED", 403, "A trial is required for this allocation");
    if (trial && input.evaluationRootTokenLimit !== undefined && input.evaluationRootTokenLimit !== trial.rootTokenLimit) throw new PlatformError("EVALUATION_MODEL_MISMATCH", 409, "Use the trial's pinned root allocation");
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: grantOperations(version.configuration), sourceRevisionIds: version.configuration.sourceRevisionIds, connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
      maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
      maxContextTokens: version.configuration.context.maxInputTokens,
      ...(trial ? { rootTokenLimit: trial.rootTokenLimit } : {}),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: user.id, grant });
    const result = await store.admitTask({ ...input, versionId: version.id, authority, grantId: grant.id });
    request.log.info({ event: "task.admitted", taskId: result.task.id, organizationId: org, replayed: result.replayed }, "Task admitted");
    return reply.code(result.replayed ? 200 : 202).send({ task: await readableTask(result.task) });
  });
  app.get(`${base}/tasks/:taskId`, async (request) => {
    const { task, reviewOnly, authority } = await humanTask(request);
    const eventQuery=z.object({eventsLimit:pageQuery.shape.limit,eventsCursor:pageQuery.shape.cursor}).strict().parse(request.query);
    if(reviewOnly){
      const scope={accountId:(await account(request)).id,organizationId:task.organization_id};
      const actions=actionServices?await actionServices.actions.listForTask(scope,task.id):[];
      const reports=actions.length?(await pool.query("SELECT id,name,content_type,bytes FROM agents_platform.artifacts WHERE task_id=$1 AND id=ANY($2::uuid[]) AND state='available'",[task.id,actions.map(action=>action.artifactId)])).rows:[];
      return {task:{id:task.id,state:task.state,output:null,errorCode:null},actions,canControl:false,canDownloadArtifacts:true,
        events:[],eventsNextCursor:null,operations:[],children:[],resources:[],artifacts:reports.map(report=>({...dto(report),downloadPath:`/api/organizations/${task.organization_id}/tasks/${task.id}/artifacts/${report.id}`}))};
    }
    const viewer=await account(request),canControl=task.principal.kind!=="automation"||task.principal.ownerAccountId===viewer.id;
    const operations = (await pool.query(`SELECT o.id AS operation_id,o.kind,o.name,o.state,o.error_code,o.accounted_tokens,o.started_at,o.completed_at,
      b.binding->>'transport' AS transport,b.binding->'definition'->>'providerOperation' AS provider_operation
      FROM agents_platform.operations o LEFT JOIN agents_platform.capability_bindings b ON b.alias=o.name AND b.organization_id=$2
      WHERE o.task_id=$1 ORDER BY o.started_at,o.id`, [task.id,task.organization_id])).rows;
    const eventPage=await store.getEventPage(authority,task.id,{limit:eventQuery.eventsLimit,cursor:eventQuery.eventsCursor});
    const events=eventPage.items;
    const children = (await pool.query(`SELECT t.id,a.name AS agent_name,t.version_id,v.number AS version_number,d.binding_id,
      t.state,CASE WHEN c.deleted_at IS NULL THEN t.output ELSE NULL END AS output,t.error_code,t.root_task_id,t.parent_task_id FROM agents_platform.tasks t
      JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.agents a ON a.id=v.agent_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id
      JOIN agents_platform.delegations d ON d.child_task_id=t.id WHERE t.parent_task_id=$1 ORDER BY d.operation_id,d.slot`,[task.id])).rows;
    const resources = (await pool.query(`SELECT id,task_id,profile_id AS profile,state,
      CASE WHEN state='destroyed' THEN 'completed' WHEN state='destroying' THEN 'pending'
        WHEN state='uncertain' THEN 'uncertain' ELSE 'active' END AS cleanup_state,lease_expires_at AS expires_at
      FROM agents_platform.sandbox_allocations WHERE root_task_id=$1 ORDER BY created_at,id`,[task.root_task_id])).rows;
    const visibleArtifacts = await taskArtifacts.listForRoot(task.root_task_id).catch(error=>{
      if(error instanceof PlatformError && error.code==="ARTIFACT_NOT_FOUND")return [];
      throw error;
    });
    const reviewerReports=!canControl?(await pool.query("SELECT artifact_id FROM agents_platform.actions WHERE root_task_id=$1 AND reviewer_account_id=$2",[task.root_task_id,viewer.id])).rows.map(row=>row.artifact_id):null;
    const artifacts = visibleArtifacts.filter(a=>(!task.parent_task_id||a.taskId===task.id)&&(!reviewerReports||reviewerReports.includes(a.id)))
      .map(a=>({...a,downloadPath:`/api/organizations/${task.organization_id}/tasks/${task.id}/artifacts/${a.id}`}));
    const actions=actionServices?await actionServices.actions.listForTask({accountId:viewer.id,organizationId:task.organization_id},task.id):[];
    const hasToolReviews=Boolean((await pool.query("SELECT 1 FROM agents_platform.tool_invocation_reviews WHERE task_id=$1 AND organization_id=$2 AND reviewer_account_id=$3 LIMIT 1",[task.id,task.organization_id,viewer.id])).rowCount);
    const configuration=agentConfigurationSchema.parse((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[task.version_id])).rows[0].configuration);
    const adaptive=configuration.program.id==="tool-directed"&&configuration.program.version==="4"&&!task.parent_task_id;
    let orchestration=adaptive?await readWorkProgress(pool,task.id):undefined;
    if(orchestration?.record){
      const conversation=(await pool.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1",[task.conversation_id])).rows[0];
      try{
        if(!conversation||conversation.deleted_at)throw new PlatformError("CONVERSATION_DELETED",403,"Conversation unavailable");
        const policy=await import("../execution/context/evidence");
        await policy.assertCurrentEvidence(pool,task.id,await policy.taskEvidenceManifest(pool,task.id),{requireActiveTask:false});
      }catch(error){if(!(error instanceof PlatformError))throw error;orchestration={revision:orchestration.revision,record:null};}
    }
    let canSteer=adaptive&&canControl&&task.principal.kind==="human"&&!terminalTaskStates.has(task.state)&&task.state!=="cancel_requested";
    if(canSteer)try{await authorizeOrchestration(pool,task.id);}catch(error){if(!(error instanceof PlatformError))throw error;canSteer=false;}
    return { orchestration,canSteer,actions,canControl,canDownloadArtifacts:true,task: {...await readableTask(task),hasToolReviews,hasEnquiries:Boolean((await pool.query("SELECT 1 FROM agents_platform.enquiries WHERE task_id=$1 LIMIT 1",[task.id])).rowCount),hasBookings:Boolean((await pool.query("SELECT 1 FROM agents_platform.booking_intents WHERE task_id=$1 LIMIT 1",[task.id])).rowCount)}, events: events.map(dto), eventsNextCursor:eventPage.nextCursor, operations: operations.map(dto),children:await Promise.all(children.map(async child=>({...dto(child),...await readableOutput(child.id,child.output)}))),resources:resources.map(dto),artifacts };
  });
  app.get(`${base}/tasks/:taskId/events`,async request=>{
    const {task,authority,reviewOnly}=await humanTask(request);
    const query=pageQuery.strict().parse(request.query);
    if(reviewOnly)return {events:[],nextCursor:null};
    const page=await store.getEventPage(authority,task.id,query);
    return {events:page.items.map(dto),nextCursor:page.nextCursor};
  });
  async function taskPassages(task: TaskRecord) {
    if(task.channel_binding && !(await pool.query("SELECT 1 FROM agents_platform.customer_deliveries WHERE task_id=$1 AND state='published'",[task.id])).rowCount)
      return {passages:[],availability:"unavailable"};
    if (!task.output || !citationLabels(task.output).length) return { state: "available", passages: [] };
    if (!evidence) return { state: "unavailable", code: "EVIDENCE_BACKEND_UNAVAILABLE", passages: [] };
    try {
      const passages = await evidence.validateCitations(task.id, task.output);
      return { state: "available", passages: passages.map(passage => ({ id: passage.reference.id, label: passage.label,
        title: passage.title, text: passage.text, page: passage.page, section: passage.section,
        contentDigest: passage.reference.contentDigest, acquiredAt: passage.reference.acquiredAt })) };
    } catch (error) {
      if (error instanceof PlatformError && ["EVIDENCE_UNAVAILABLE", "EVIDENCE_SCOPE_DENIED", "EVIDENCE_INTEGRITY", "CITATION_UNKNOWN"].includes(error.code)) {
        return { state: "unavailable", code: error.code, passages: [] };
      }
      throw error;
    }
  }
  app.get(`${base}/tasks/:taskId/evidence`, async request => {
    const {task}=await humanTask(request), viewer=await account(request);
    // A report reviewer receives only the prepared report's citations through ActionService.
    if(task.principal.kind==="automation" && task.principal.ownerAccountId!==viewer.id) throw new PlatformError("NOT_FOUND",404,"Task not found");
    return taskPassages(task);
  });
  app.get(`${base}/tasks/:taskId/artifacts/:artifactId`, async (request,reply) => {
    const {task}=await humanTask(request), user=await account(request);
    const result=await taskArtifacts.download(user.id,task.organization_id,task.id,uuid.parse(parameters(request).artifactId));
    return reply.header("content-type",result.artifact.contentType).header("content-disposition",`attachment; filename="${result.artifact.name}"`)
      .header("cache-control","private, no-store").header("x-content-type-options","nosniff").send(Buffer.from(result.content));
  });
  app.post(`${base}/tasks/:taskId/instructions`, async request => {
    const {task,reviewOnly}=await humanTask(request);
    if(reviewOnly||task.principal.kind!=="human"||task.parent_task_id)throw new PlatformError("ACCESS_DENIED",403,"Task instructions are unavailable");
    return queueOrchestrationInstruction(pool,task.id,request.body);
  });
  app.post(`${base}/tasks/:taskId/continue`, async request => {
    const { task, authority } = await humanTask(request);
    if(task.principal.kind!=="human")throw new PlatformError("AUTOMATION_CONTROL_REQUIRED",403,"Manage access on the automation");
    if(task.parent_task_id) throw new PlatformError("ROOT_CONTROL_REQUIRED",409,"Continue the main task");
    const user = await account(request);
    const childNeedsAuthority = task.state === "waiting_children" && Boolean((await pool.query(
      "SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' LIMIT 1",[task.id])).rowCount);
    if (task.state !== "waiting_authority" && !childNeedsAuthority) return { task: dto(task) };
    const previous = (await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1",[task.grant_id])).rows[0];
    if(!previous || previous.revoked_at) throw new PlatformError("GRANT_REVOKED",403,"Execution access was revoked");
    const version = await store.getVersion(user.id, task.organization_id, task.version_id);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: grantOperations(version.configuration),
      sourceRevisionIds: version.configuration.sourceRevisionIds, connectedToolBindingIds: connectedToolAuthorityIds(version.configuration), maxInputBytes: version.configuration.model.maxInputBytes,
      maxOutputTokens: version.configuration.model.maxOutputTokens, maxContextTokens: version.configuration.context.maxInputTokens,
      rootTokenLimit: (task as TaskRecord & {root_token_limit:number}).root_token_limit,
      expiresAt: new Date(Math.min(Date.now()+30*60_000, new Date((task as TaskRecord & {deadline_at:Date}).deadline_at).getTime())).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: user.id, grant });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const current=(await db.query(`SELECT g.id FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id
        WHERE t.id=$1 AND g.revoked_at IS NULL FOR NO KEY UPDATE OF t FOR SHARE OF g`,[task.id])).rows[0];
      if(!current)throw new PlatformError("GRANT_REVOKED",403,"Execution access was revoked");
      const updated = (await db.query(`UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1,updated_at=now()
        WHERE id=$1 AND state IN ('waiting_authority','waiting_children') RETURNING control_generation-1 AS generation,state`, [task.id, grant.id])).rows[0];
      if (updated?.state === "waiting_authority") await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING", [task.id, updated.generation]);
      await db.query("COMMIT");
    } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    await queueChildContinuations(pool,task.id);
    return { task: dto((await humanTask(request)).task) };
  });
  app.get(`${base}/conversations/:conversationId`, async (request) => {
    const user = await account(request), org = organizationId(request), conversationId = uuid.parse(parameters(request).conversationId);
    await store.requireMembership(user.id, org);
    const conversation = (await pool.query<{ agent_id: string }>("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [org, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    const page=await store.getConversationPage(humanAuthority(user, org, conversation.agent_id),conversationId,pageQuery.strict().parse(request.query));
    return {tasks:await Promise.all(page.items.map(readableTask)),nextCursor:page.nextCursor,conversation:page.conversation};
  });
  app.delete(`${base}/conversations/:conversationId`, async request => {
    const user = await account(request), org = organizationId(request), conversationId = uuid.parse(parameters(request).conversationId);
    const conversation = (await pool.query("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [org,conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND",404,"Conversation not found");
    return new MemoryStore(pool).deleteConversationSources({accountId:user.id,organizationId:org,agentId:conversation.agent_id},conversationId);
  });
  app.post(`${base}/tasks/:taskId/cancel`, async (request) => {
    const { task, authority } = await humanTask(request);
    if(task.principal.kind==="automation"&&(await account(request)).id!==task.principal.ownerAccountId)throw new PlatformError("ACCESS_DENIED",403,"Only the owner can stop this task");
    if(task.parent_task_id) throw new PlatformError("ROOT_CONTROL_REQUIRED",409,"Cancel the main task");
    if (!terminalTaskStates.has(task.state)) {
      await requestTreeCancellation(pool,task.id);
    }
    return { task: dto((await humanTask(request)).task) };
  });

  async function websiteContext(request: FastifyRequest, reply?: { header: (key: string, value: string) => unknown }) {
    const deployment = await store.getWebsiteDeployment(uuid.parse(parameters(request).deploymentId));
    const suppliedOrigin = request.headers.origin;
    // The first-party chat view is a preview of this explicit publication, never a draft.
    const websiteOrigin = suppliedOrigin || (request.method === "GET" ? origin : "");
    const allowed = deployment.allowed_origins.includes(websiteOrigin) || websiteOrigin === origin;
    if (!allowed || (websiteOrigin && parseAllowedOrigin(websiteOrigin) !== websiteOrigin)) throw new PlatformError("ORIGIN_DENIED", 403, "Website origin is not allowed");
    if (suppliedOrigin) {
      reply?.header("access-control-allow-origin", suppliedOrigin);
      reply?.header("vary", "Origin");
      reply?.header("access-control-allow-headers", "Content-Type, Authorization");
      reply?.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    return { deployment, websiteOrigin, grantOrigin: websiteOrigin === origin ? deployment.allowed_origins[0]! : websiteOrigin };
  }
  app.options("/api/website/:deploymentId/*", async (request, reply) => {
    await websiteContext(request, reply); return reply.code(204).send();
  });
  async function publicRate(deploymentId: string): Promise<void> {
    await pool.query("DELETE FROM agents_platform.website_rate_limits WHERE deployment_id=$1 AND minute<now()-interval '1 day'", [deploymentId]);
    const row = (await pool.query<{ requests: number }>(`INSERT INTO agents_platform.website_rate_limits(deployment_id,minute,requests)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(deployment_id,minute) DO UPDATE SET requests=agents_platform.website_rate_limits.requests+1 RETURNING requests`, [deploymentId])).rows[0]!;
    if (row.requests > 20) throw new PlatformError("RATE_LIMIT", 429, "Too many requests. Try again shortly");
  }
  async function websiteAuthority(request: FastifyRequest, deployment: Awaited<ReturnType<PlatformStore["getWebsiteDeployment"]>>, websiteOrigin: string): Promise<AdmissionAuthority> {
    if(deployment.paused)throw new PlatformError("WEBSITE_PAUSED",409,"This chat is paused");
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new PlatformError("WEBSITE_SESSION_REQUIRED", 401, "Website session required");
    const row = (await pool.query<{ id: string }>(`SELECT id FROM agents_platform.website_sessions
      WHERE deployment_id=$1 AND token_hash=$2 AND origin=$3 AND expires_at>now()`, [deployment.id, hash(token), websiteOrigin])).rows[0];
    if (!row) throw new PlatformError("WEBSITE_SESSION_EXPIRED", 401, "Website session expired");
    return { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id,
      callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: row.id } };
  }
  app.get("/api/website/:deploymentId", async (request, reply) => {
    const { deployment } = await websiteContext(request, reply);
    const row = (await pool.query<{ name: string }>("SELECT name FROM agents_platform.agents WHERE id=$1 AND organization_id=$2", [deployment.agent_id, deployment.organization_id])).rows[0];
    const version=(await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$2",[deployment.version_id,deployment.organization_id])).rows[0];
    return { name: row?.name ?? "Assistant",appearance:websiteAppearanceSchema.parse(deployment.appearance),paused:deployment.paused,followupPreferencesAvailable:true,followupEnabled:followupConfig?await customerFollowupReady(pool,followupConfig,config.RESTATE_ADMIN_URL):false,
      nativeEnquiryEnabled:Boolean(version?.configuration.capabilities?.enquiries?.enabled),intakeEnabled:Boolean(version?.configuration.connectedToolBindingIds.length || version?.configuration.capabilities?.enquiries?.enabled),bookingEnabled:Boolean(version?.configuration.capabilities?.businessActions?.enabled) };
  });
  app.get("/api/website/:deploymentId/widget.js", async (request, reply) => {
    const deploymentId = uuid.parse(parameters(request).deploymentId);
    await store.getWebsiteDeployment(deploymentId);
    return reply.type("application/javascript; charset=utf-8").send(websiteWidgetScript(deploymentId));
  });
  app.post("/api/website/:deploymentId/session", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    await publicRate(deployment.id);
    await pool.query(`DELETE FROM agents_platform.website_sessions s WHERE deployment_id=$1 AND expires_at<=now()
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_conversations c WHERE c.session_id=s.id)`, [deployment.id]);
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [randomUUID(), deployment.id, hash(token), websiteOrigin]);
    return reply.code(201).send({ token });
  });
  const resolveVisitor = async (request: FastifyRequest, reply: FastifyReply) => {
      const { deployment, websiteOrigin } = await websiteContext(request, reply);
      const authority = await websiteAuthority(request, deployment, websiteOrigin);
      if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Customer session required");
      return { deploymentId: deployment.id, sessionId: authority.principal.sessionId };
    };
  registerInboxRoutes(app, { inbox, bookings,toolReviews,enquiries,publicRate,connectedReconciliation:actionServices?new ConnectedReconciliation(pool,providers):undefined,
    resolveScope: async request => ({ accountId: (await account(request)).id, organizationId: organizationId(request) }),
    resolveVisitor,
  });
  {
    const challenges = new CustomerFollowupChallenges(pool), sender = followupConfig ? options.testFollowupSender ?? new ResendNotificationSender(followupConfig.apiKey,followupConfig.sender,{timeoutMs:10000}) : undefined;
    registerCustomerFollowupReturn(app,{challenges,resolveVisitor,publicRate});
    registerCustomerFollowupConsent(app,{challenges,resolveVisitor,publicRate,send:sender?input=>sender.send(input):undefined,ready:()=>followupConfig?customerFollowupReady(pool,followupConfig,config.RESTATE_ADMIN_URL):Promise.resolve(false)});
  }
  app.post("/api/website/:deploymentId/tasks", async (request, reply) => {
    const { deployment, websiteOrigin, grantOrigin } = await websiteContext(request, reply);
    const authority = await websiteAuthority(request, deployment, websiteOrigin), input = websiteTaskInput.parse(request.body);
    await publicRate(deployment.id);
    if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const scope={deploymentId:deployment.id,sessionId:authority.principal.sessionId};
    const conversation=await inbox.open(scope);
    if(input.conversationId&&input.conversationId!==conversation.execution_conversation_id)throw new PlatformError("CONVERSATION_SCOPE_DENIED",403,"Customer conversation is unavailable");
    const result=await inbox.ingress(scope,conversation.id,{requestKey:input.requestKey,body:input.input});
    const task=result.message.task_id?await store.getTask(authority,result.message.task_id):null;
    return reply.code(result.replayed?200:202).send({task:task?await readableTask(task):null,customerConversationId:conversation.id,state:result.conversation.state});
  });
  app.get("/api/website/:deploymentId/tasks/:taskId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    const task = await store.getTask(authority, uuid.parse(parameters(request).taskId));
    return { task: await readableTask(task), events: (await store.listTaskEvents(authority, task.id)).map(dto) };
  });
  app.get("/api/website/:deploymentId/tasks/:taskId/evidence", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    return taskPassages(await store.getTask(authority, uuid.parse(parameters(request).taskId)));
  });
  app.get("/api/website/:deploymentId/conversations/:conversationId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    return { tasks: await Promise.all((await store.getConversation(authority, uuid.parse(parameters(request).conversationId))).map(readableTask)) };
  });
  registerAdminReportingRoutes(app,pool,process.env.KASITEK_ADMIN_SERVICE_SECRET);
  registerAdminCustomerRoutes(app,pool,process.env.KASITEK_ADMIN_SERVICE_SECRET);
  return app;
}
