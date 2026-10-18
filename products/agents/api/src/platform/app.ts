import { actionsFromEnvironment } from "./actions";
import { registerActionRoutes } from "./actions-routes";
import { AutomationService,operationsForConfiguration } from "./automations";
import { registerAutomationRoutes } from "./automation-routes";
import { resolveAutomationOwner,resolveAutomationReviewer } from "./automation-authority";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformIdentity } from "./auth";
import { registerPublicIdentityRoutes } from "./auth-routes";
import type { PlatformConfig } from "./config";
import { agentConfigurationSchema, assertRuntimeAvailable, executionGrantSchema, connectedToolAuthorityIds, parseAllowedOrigin,
  canonicalJson, PlatformError, terminalTaskStates, type AdmissionAuthority, type AgentConfiguration, type ExecutionGrant } from "./contracts";
import { PlatformStore, type Account, type TaskRecord } from "./store";
import {PlatformDiscovery} from "./discovery";
import {pageQuery} from "./read-pages";
import {taskStateSchema} from "./contracts";
import { websiteWidgetScript } from "./widget";
import { registerMemoryRoutes } from "./memory-routes";
import { privateStoreFromEnvironment } from "./artifacts";
import { MemoryStore } from "./memory";
import { TaskArtifactStore } from "./task-artifacts";
import { queueChildContinuations, requestTreeCancellation } from "./execution";
import { sandboxManagerFromEnvironment } from "./sandbox";
import { KnowledgeStore } from "./knowledge";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { documentRuntimeFromEnvironment } from "./document-runtime";
import { EvidenceStore, assertCurrentEvidence, citationLabels } from "./evidence";
import { ConnectedExecutor } from "./connected-executor";
import { capabilityBindingSchema } from "./capability-catalog";
import { assertConnectedBindingDependencies } from "./connected-tool-schema";

const uuid = z.uuid();
const taskInput = z.strictObject({ versionId: uuid, input: z.string().min(1).max(16_384),
  requestKey: z.string().min(1).max(128), conversationId: uuid.optional() });
const websiteTaskInput = taskInput.omit({ versionId: true });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const dto = (row: object) => ({ ...Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
])), ...(Object.hasOwn(row,"conversation_id") && Object.hasOwn(row,"grant_id") ? {
  rootTaskId: (row as TaskRecord).root_task_id, parentTaskId: (row as TaskRecord).parent_task_id,
  phase: terminalTaskStates.has((row as TaskRecord).state) ? "terminal" : (row as TaskRecord).state === "accepted" ? "queued" :
    (row as TaskRecord).state === "cancel_requested" ? "stopping" : (row as TaskRecord).state,
  outcome: terminalTaskStates.has((row as TaskRecord).state) ? (row as TaskRecord).state : null,
} : {}) });

export async function buildPlatformApp(options: { config: PlatformConfig; pool: Pool; identity?: PlatformIdentity; logging?: boolean }) {
  const { config, pool } = options;
  const store = new PlatformStore(pool);
  const discovery = new PlatformDiscovery(pool,store);
  const summary = ({position: _position,...row}: Record<string,unknown>) => row;
  const objects = privateStoreFromEnvironment();
  const sourceObjects = privateStoreFromEnvironment(process.env, 10_485_760);
  const knowledge = new KnowledgeStore(pool, sourceObjects);
  const documentRuntime = documentRuntimeFromEnvironment();
  const taskArtifacts = new TaskArtifactStore(pool, objects);
  const sandbox = sandboxManagerFromEnvironment(pool);
  const actionServices=actionsFromEnvironment(pool,taskArtifacts);
  const evidence = new EvidenceStore(pool, sourceObjects);
  // API and worker use the same execution mode/build: source and compiled artifact digests intentionally differ.
  const connected = actionServices && sourceObjects && evidence ? new ConnectedExecutor(pool, actionServices.connections, sourceObjects, evidence) : undefined;
  const grantOperations=operationsForConfiguration;
  async function assertBindings(configuration: AgentConfiguration): Promise<void> {
    if (configuration.sourceRevisionIds.length && !sourceObjects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
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
    if(!config.OPENROUTER_API_KEY)throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE",503,"Model connection is unavailable");
    if((configuration.capabilities.sandbox.enabled||configuration.capabilities.workflows.enabled)&&!objects)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    if(configuration.capabilities.workflows.enabled&&!actionServices)throw new PlatformError("ACTIONS_UNAVAILABLE",503,"Report delivery is unavailable");
    if(configuration.capabilities.sandbox.enabled&&(!sandbox||!await sandbox.available()))throw new PlatformError("SANDBOX_UNAVAILABLE",503,"Analysis is unavailable");
  }
  const automations=new AutomationService(pool,assertServices);
  const identity = options.identity ?? new PlatformIdentity(config, pool);
  const origin = new URL(config.AGENTS_PUBLIC_URL).origin;
  const secure = origin.startsWith("https:");
  const sessionCookie = secure ? "__Host-agents_session" : "agents_session";
  const loginCookie = secure ? "__Host-agents_login" : "agents_login";
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const app = Fastify({ bodyLimit: 128_000, logger: options.logging === false ? false : {
    base: { service: "agents-platform", environment: config.NODE_ENV, release: (process.env.KASITEK_RELEASE_ID || "development").slice(0, 128) },
    redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: { req: (request: { method: string; url: string }) => ({ method: request.method, path: request.url.split("?")[0] }) },
  } });
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
        !request.url.startsWith("/api/website/") && !request.url.startsWith("/api/automation-events/") && request.url.split("?")[0] !== "/api/auth/backchannel-logout" && request.headers.origin !== origin) {
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
    } else await store.getTask(authority, root.id);
    const source=(await pool.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1",[task.conversation_id])).rows[0];
    return { task: source?.deleted_at ? {...task,input:"[Deleted conversation]",output:null} : task, authority, reviewOnly };
  }
  async function readableOutput(taskId:string,output:string|null) {
    try{await (await import("./evidence")).assertDelegationInputEvidence(pool,taskId);}catch(error){if(error instanceof PlatformError)return {output:null,outputAvailability:"unavailable"};throw error;}
    if(!output)return {output};
    const influenced=(await pool.query("SELECT 1 FROM agents_platform.evidence_nodes WHERE task_id=$1 LIMIT 1",[taskId])).rowCount;
    if(!influenced)return {output};
    if(!evidence)return {output:null,outputAvailability:"unavailable"};
    try {await assertCurrentEvidence(pool,taskId,await evidence.taskManifest(taskId),{requireActiveTask:false});return {output,outputAvailability:"available"};}
    catch(error) {if(error instanceof PlatformError)return {output:null,outputAvailability:"unavailable"};throw error;}
  }
  async function readableTask(task:TaskRecord){
    let input:unknown=task.input,inputAvailability="available";
    if(task.parent_task_id)try{await (await import("./evidence")).assertDelegationInputEvidence(pool,task.id);}catch(error){if(!(error instanceof PlatformError))throw error;input=task.input==="[Deleted conversation]"?task.input:null;inputAvailability="unavailable";}
    return {...dto(task),input,inputAvailability,...await readableOutput(task.id,task.output)};
  }
  async function resolveScope(request:FastifyRequest) {const user=await account(request),org=organizationId(request);await store.requireMembership(user.id,org);return {accountId:user.id,organizationId:org};}
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
    const ready = result.rows[0]?.version === "001_platform" && Boolean(config.OPENROUTER_API_KEY);
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
    const page=await discovery.agents(await account(request),organizationId(request),pageQuery.strict().parse(request.query));
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
    const user = await account(request), input = z.strictObject({ name: z.string().min(1).max(120) }).parse(request.body);
    return reply.code(201).send({ agent: dto(await store.createAgent({ accountId: user.id, organizationId: organizationId(request), name: input.name })) });
  });
  app.get(`${base}/agents/:agentId`, async (request) => {
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    const agent = await store.getAgent(user.id, org, agentId);
    const [versions, deployments] = await Promise.all([store.listVersions(user.id, org, agentId), store.listDeployments(user.id, org, agentId)]);
    return { agent: dto(agent), versions: versions.map(dto), deployments: deployments.map(dto) };
  });
  app.put(`${base}/agents/:agentId`, async (request) => {
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), configuration: agentConfigurationSchema,
      expectedRevision: z.number().int().positive() }).parse(request.body);
    return { agent: dto(await store.updateDraft({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) };
  });
  registerKnowledgeRoutes(app, { knowledge, runtime: documentRuntime, resolveScope: async request => ({ accountId: (await account(request)).id, organizationId: organizationId(request) }) });
  app.post(`${base}/agents/:agentId/versions`, async (request, reply) => {
    const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    const agent = await store.getAgent(user.id, org, agentId);
    await assertBindings(agentConfigurationSchema.parse(agent.draft));
    return reply.code(201).send({ version: dto(await store.createVersion({ ...input, accountId: user.id,
      organizationId: org, agentId })) });
  });
  app.post(`${base}/agents/:agentId/deployments`, async (request, reply) => {
    const input = z.strictObject({ versionId: uuid, allowedOrigins: z.array(z.string()).min(1).max(10) }).parse(request.body);
    return reply.code(201).send({ deployment: dto(await store.publishWebsite({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) });
  });
  app.post(`${base}/tasks`, async (request, reply) => {
    const input = taskInput.parse(request.body), user = await account(request), org = organizationId(request);
    const version = await store.getVersion(user.id, org, input.versionId);
    assertRuntimeAvailable(version.configuration);
    await assertServices(version.configuration);
    const authority = humanAuthority(user, org, version.agent_id);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: grantOperations(version.configuration), sourceRevisionIds: version.configuration.sourceRevisionIds, connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
      maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: user.id, grant });
    const result = await store.admitTask({ ...input, authority, grantId: grant.id });
    request.log.info({ event: "task.admitted", taskId: result.task.id, organizationId: org, replayed: result.replayed }, "Task admitted");
    return reply.code(result.replayed ? 200 : 202).send({ task: dto(result.task) });
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
    return { actions,canControl,canDownloadArtifacts:true,task: await readableTask(task), events: events.map(dto), eventsNextCursor:eventPage.nextCursor, operations: operations.map(dto),children:await Promise.all(children.map(async child=>({...dto(child),...await readableOutput(child.id,child.output)}))),resources:resources.map(dto),artifacts };
  });
  app.get(`${base}/tasks/:taskId/events`,async request=>{
    const {task,authority,reviewOnly}=await humanTask(request);
    const query=pageQuery.strict().parse(request.query);
    if(reviewOnly)return {events:[],nextCursor:null};
    const page=await store.getEventPage(authority,task.id,query);
    return {events:page.items.map(dto),nextCursor:page.nextCursor};
  });
  async function taskPassages(task: TaskRecord) {
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
        WHERE t.id=$1 AND g.revoked_at IS NULL FOR UPDATE OF t FOR SHARE OF g`,[task.id])).rows[0];
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
    return { name: row?.name ?? "Assistant" };
  });
  app.get("/api/website/:deploymentId/widget.js", async (request, reply) => {
    const deploymentId = uuid.parse(parameters(request).deploymentId);
    await store.getWebsiteDeployment(deploymentId);
    return reply.type("application/javascript; charset=utf-8").send(websiteWidgetScript(deploymentId));
  });
  app.post("/api/website/:deploymentId/session", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    await publicRate(deployment.id);
    await pool.query("DELETE FROM agents_platform.website_sessions WHERE deployment_id=$1 AND expires_at<=now()", [deployment.id]);
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [randomUUID(), deployment.id, hash(token), websiteOrigin]);
    return reply.code(201).send({ token });
  });
  app.post("/api/website/:deploymentId/tasks", async (request, reply) => {
    const { deployment, websiteOrigin, grantOrigin } = await websiteContext(request, reply);
    const authority = await websiteAuthority(request, deployment, websiteOrigin), input = websiteTaskInput.parse(request.body);
    await publicRate(deployment.id);
    if (!config.OPENROUTER_API_KEY) throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE", 503, "Model connection is unavailable");
    if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const grant = await store.createWebsiteGrant({ deploymentId: deployment.id, origin: grantOrigin, sessionId: authority.principal.sessionId });
    const result = await store.admitTask({ ...input, authority, versionId: deployment.version_id, grantId: grant.id });
    return reply.code(result.replayed ? 200 : 202).send({ task: dto(result.task) });
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
  return app;
}
