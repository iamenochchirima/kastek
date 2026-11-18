import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { agentConfigurationSchema, assertRuntimeAvailable, connectedToolAuthorityIds, executionGrantSchema, PlatformError,
  sourceAuthorityIds, taskStateSchema, terminalTaskStates, type AdmissionAuthority, type AgentConfiguration,
  type ExecutionGrant, type TaskState } from "../../contracts/contracts";
import type { Account, AdmitTaskInput, TaskRecord, VersionRecord } from "../../contracts/records";
import { projectWorkProgress } from "../../execution/context/recipient-text";
import { assertCurrentEvidence, citationLabels, taskEvidenceManifest } from "../../execution/context/evidence";
import { authorizeOrchestration, queueOrchestrationInstruction, readWorkProgress } from "../../execution/delegation/progress";
import { deadlineMillis } from "../../execution/lifecycle/deadline";
import { queueChildContinuations, requestTreeCancellation } from "../../execution/lifecycle/execution";
import { contextGrantCeiling } from "../../execution/models/settings";
import { finishPage, pageQuery, readPageCursor, type PageQuery } from "../../infrastructure/read-pages";

export type RunScope = { account: Account; organizationId: string };

const taskInput = z.strictObject({ versionId: z.uuid(), input: z.string().min(1),
  requestKey: z.string().trim().min(1).max(128), conversationId: z.uuid().optional() });
export const humanTaskInput = taskInput.omit({ versionId: true }).extend({ agentId: z.uuid().optional(), versionId: z.uuid().optional(),
  evaluationTrialId: z.uuid().optional(), evaluationRootTokenLimit: z.number().int().positive().max(2147483647).optional() })
  .refine(input => Boolean(input.agentId) !== Boolean(input.versionId), "Choose an agent or an explicit evaluation snapshot")
  .refine(input => !input.agentId || !input.evaluationTrialId, "Evaluations require an explicit snapshot");
export { taskInput };

type WorkRecord = { objective: string; steps: { title: string }[]; questions: string[] };
type Progress = { revision: number; record: WorkRecord | null };

/** Task and conversation access, as used by the read and control routes. */
export interface RunHttpStorePort {
  requireMembership(accountId: string, organizationId: string): Promise<void>;
  getEventPage(authority: AdmissionAuthority, taskId: string, query: PageQuery): Promise<{ items: object[]; nextCursor: string | null }>;
  getConversationPage(authority: AdmissionAuthority, conversationId: string, query: PageQuery):
    Promise<{ items: TaskRecord[]; nextCursor: string | null; conversation: unknown }>;
  getVersion(accountId: string, organizationId: string, versionId: string): Promise<VersionRecord>;
  createGrant(input: { accountId: string; grant: ExecutionGrant }): Promise<ExecutionGrant>;
  admitTask(input: AdmitTaskInput): Promise<{ task: TaskRecord; replayed: boolean }>;
}

export interface RunDiscoveryPort {
  conversations(account: Account, organizationId: string,
    query: PageQuery & { agentId: string; versionId?: string; state?: "active" | "archived" }):
    Promise<{ items: object[]; nextCursor: string | null }>;
  tasks(account: Account, organizationId: string, query: PageQuery & { agentId?: string; state?: TaskState }):
    Promise<{ items: object[]; nextCursor: string | null }>;
}

type Passage = { reference: { id: string; contentDigest: string; acquiredAt: string }; label: string; title: string;
  text: string; page: number | null; section: string | null };

const summary = (value: object) => { const { position: _position, ...row } = value as Record<string, unknown>; return row; };
const humanAuthority = (user: Account, organizationId: string, resourceId: string): AdmissionAuthority => ({
  product: "agents", organizationId, resourceId, callerClientId: "agents-execution",
  principal: { kind: "human", issuer: user.issuer, subject: user.subject },
});

/**
 * Task and conversation routes. Paths and payloads stay unchanged while the handlers move out of
 * composition. Authorization decisions, product projections and stores arrive through ports.
 */
export function registerRunRoutes(app: FastifyInstance, options: {
  pool: Pool;
  store: RunHttpStorePort;
  discovery: RunDiscoveryPort;
  taskAccess(request: FastifyRequest): Promise<{ task: TaskRecord; authority: AdmissionAuthority; reviewOnly: boolean }>;
  presentTask(task: TaskRecord): Promise<Record<string, unknown>>;
  presentOutput(taskId: string, output: string | null): Promise<object>;
  deleteConversationSources(scope: { accountId: string; organizationId: string; agentId: string }, conversationId: string): Promise<unknown>;
  admitMember(input: { accountId: string; authority: AdmissionAuthority; message: string; requestKey: string;
    conversationId?: string; evaluationRootTokenLimit?: number }): Promise<{ task: TaskRecord; replayed: boolean }>;
  assertServices(configuration: AgentConfiguration): Promise<void>;
  grantOperations(configuration: AgentConfiguration): ExecutionGrant["operations"];
  evaluationTrials: { get(accountId: string, organizationId: string, input: { id: string }): Promise<{ trial: { rootTokenLimit: number } | null }> };
  actions?: { listForTask(scope: { accountId: string; organizationId: string }, taskId: string): Promise<Array<{ artifactId: string }>> };
  artifacts: {
    listForRoot(rootTaskId: string): Promise<Array<{ id: string; taskId: string }>>;
    download(accountId: string, organizationId: string, taskId: string, artifactId: string):
      Promise<{ artifact: { contentType: string; name: string }; content: Uint8Array }>;
  };
  evidence?: { validateCitations(taskId: string, output: string): Promise<Passage[]>; suppliedPassages(taskId: string): Promise<Passage[]> };
  readRuntime(task: TaskRecord): Promise<object>;
  readPublicUpdates(taskId: string): Promise<object>;
  readWorkProgress(taskId: string): Promise<Progress>;
  projectWorkProgress(taskId: string, progress: Progress): Promise<Progress>;
  authorizeOrchestration(taskId: string): Promise<unknown>;
  operationMetadataSql: string;
  presentOperation(kind: string, name: string, catalogBinding: unknown, catalogDescription: unknown): object;
  exportHistory(account: Account, organizationId: string, taskId: string): Promise<unknown>;
  resolveScope(request: FastifyRequest): Promise<RunScope>;
  present(record: object): object;
}) {
  const base = "/api/organizations/:organizationId";
  const uuid = z.uuid();
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;

  function scopeFor(request: FastifyRequest) { return options.resolveScope(request); }

  async function taskPassages(task: TaskRecord) {
    if (task.channel_binding && !(await options.pool.query("SELECT 1 FROM agents_platform.customer_deliveries WHERE task_id=$1 AND state='published'", [task.id])).rowCount)
      return { passages: [], availability: "unavailable" };
    if (!options.evidence) return { state: "unavailable", code: "EVIDENCE_BACKEND_UNAVAILABLE", passages: [] };
    try {
      // Cited passages when the answer carries evidence handles; otherwise the supplied manifest.
      const passages = task.output && citationLabels(task.output).length
        ? await options.evidence.validateCitations(task.id, task.output)
        : await options.evidence.suppliedPassages(task.id);
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

  app.get(`${base}/conversations`, async request => {
    const { account, organizationId } = await scopeFor(request);
    const query = pageQuery.extend({ agentId: uuid, versionId: uuid.optional(), state: z.enum(["active", "archived"]).optional() })
      .strict().parse(request.query);
    const page = await options.discovery.conversations(account, organizationId, query);
    return { conversations: page.items.map(row => summary(row)), nextCursor: page.nextCursor };
  });

  app.get(`${base}/tasks`, async request => {
    const { account, organizationId } = await scopeFor(request);
    const query = pageQuery.extend({ agentId: uuid.optional(), state: taskStateSchema.optional() }).strict().parse(request.query);
    const page = await options.discovery.tasks(account, organizationId, query);
    return { tasks: page.items.map(row => summary(row)), nextCursor: page.nextCursor };
  });

  app.post(`${base}/tasks`, async (request, reply) => {
    const input = humanTaskInput.parse(request.body), { account, organizationId } = await scopeFor(request);
    if (input.agentId) {
      const authority = humanAuthority(account, organizationId, input.agentId);
      const result = await options.admitMember({ accountId: account.id, authority, message: input.input, requestKey: input.requestKey,
        conversationId: input.conversationId, evaluationRootTokenLimit: input.evaluationRootTokenLimit });
      request.log.info({ event: "task.admitted", taskId: result.task.id, organizationId, replayed: result.replayed }, "Task admitted");
      return reply.code(result.replayed ? 200 : 202).send({ task: await options.presentTask(result.task) });
    }
    const version = await options.store.getVersion(account.id, organizationId, input.versionId!);
    assertRuntimeAvailable(version.configuration);
    await options.assertServices(version.configuration);
    const authority = humanAuthority(account, organizationId, version.agent_id);
    const trial = input.evaluationTrialId ? (await options.evaluationTrials.get(account.id, organizationId, { id: input.evaluationTrialId })).trial : null;
    if (input.evaluationTrialId && !trial) throw new PlatformError("EVALUATION_TRIAL_INACTIVE", 403, "Trial not found");
    if (input.evaluationRootTokenLimit && !trial) throw new PlatformError("EVALUATION_SCOPE_REQUIRED", 403, "A trial is required for this allocation");
    if (trial && input.evaluationRootTokenLimit !== undefined && input.evaluationRootTokenLimit !== trial.rootTokenLimit)
      throw new PlatformError("EVALUATION_MODEL_MISMATCH", 409, "Use the trial's pinned root allocation");
    const grant = executionGrantSchema.parse({ ...authority, id: crypto.randomUUID(), versionId: version.id,
      operations: options.grantOperations(version.configuration), sourceRevisionIds: sourceAuthorityIds(version.configuration),
      connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
      maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(version.configuration),
      ...(trial ? { rootTokenLimit: trial.rootTokenLimit } : {}),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await options.store.createGrant({ accountId: account.id, grant });
    const result = await options.store.admitTask({ ...input, versionId: version.id, authority, grantId: grant.id });
    request.log.info({ event: "task.admitted", taskId: result.task.id, organizationId, replayed: result.replayed }, "Task admitted");
    return reply.code(result.replayed ? 200 : 202).send({ task: await options.presentTask(result.task) });
  });

  app.get(`${base}/tasks/:taskId`, async request => {
    const { task, reviewOnly, authority } = await options.taskAccess(request);
    const { account } = await scopeFor(request);
    const eventQuery = z.object({ eventsLimit: pageQuery.shape.limit, eventsCursor: pageQuery.shape.cursor,
      operationsLimit: pageQuery.shape.limit, operationsCursor: pageQuery.shape.cursor }).strict().parse(request.query);
    if (reviewOnly) {
      const scope = { accountId: account.id, organizationId: task.organization_id };
      const actions = options.actions ? await options.actions.listForTask(scope, task.id) : [];
      const reports = actions.length ? (await options.pool.query("SELECT id,name,content_type,bytes FROM agents_platform.artifacts WHERE task_id=$1 AND id=ANY($2::uuid[]) AND state='available'", [task.id, actions.map(action => action.artifactId)])).rows : [];
      return { task: { id: task.id, state: task.state, output: null, errorCode: null }, actions, canControl: false, canDownloadArtifacts: true,
        events: [], eventsNextCursor: null, operations: [], children: [], resources: [],
        artifacts: reports.map(report => ({ ...options.present(report), downloadPath: `/api/organizations/${task.organization_id}/tasks/${task.id}/artifacts/${report.id}` })) };
    }
    const canControl = task.principal.kind !== "automation" || task.principal.ownerAccountId === account.id;
    const operationScope = { kind: "owner-task-operations", account: account.id, organization: task.organization_id, task: task.id };
    const operationCursor = readPageCursor(eventQuery.operationsCursor, operationScope);
    if (operationCursor.position && !Number.isFinite(Date.parse(operationCursor.position))) throw new PlatformError("INVALID_CURSOR", 400, "Invalid operation cursor");
    const operationRows = (await options.pool.query(`SELECT o.id AS operation_id,md5(o.id) AS cursor_id,
      to_char(o.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_position,
      o.kind,${options.operationMetadataSql},o.state,o.error_code,o.accounted_tokens,o.started_at,o.completed_at,
      greatest(0,extract(epoch FROM (coalesce(o.completed_at,now())-o.started_at))*1000)::float8 AS duration_ms,
      b.binding->>'transport' AS transport,b.binding->'definition'->>'providerOperation' AS provider_operation
      FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id
      JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
      LEFT JOIN agents_platform.capability_bindings b ON b.alias=o.name AND b.organization_id=$2
      WHERE o.task_id=$1 AND o.started_at<=$3 AND ($4::text='' OR (o.started_at,md5(o.id))<($4::timestamptz,$5::text))
      ORDER BY o.started_at DESC,md5(o.id) DESC LIMIT $6`,
    [task.id, task.organization_id, operationCursor.snapshot, operationCursor.position, operationCursor.id, eventQuery.operationsLimit + 1])).rows;
    const operationPage = finishPage(operationRows, eventQuery.operationsLimit, operationScope, operationCursor.snapshot,
      row => ({ position: row.cursor_position, id: row.cursor_id }));
    const operations = operationPage.items.reverse().map(({ cursor_id: _cursor, cursor_position: _position, catalog_binding, catalog_description, ...operation }) => ({
      ...operation, ...options.presentOperation(operation.kind, operation.name, catalog_binding, catalog_description) }));
    const eventPage = await options.store.getEventPage(authority, task.id, { limit: eventQuery.eventsLimit, cursor: eventQuery.eventsCursor });
    const events = eventPage.items;
    const children = (await options.pool.query(`SELECT t.id,a.name AS agent_name,t.version_id,v.number AS version_number,d.binding_id,
      t.state,t.created_at,CASE WHEN c.deleted_at IS NULL THEN t.input ELSE NULL END AS input,CASE WHEN c.deleted_at IS NULL THEN t.output ELSE NULL END AS output,t.error_code,t.root_task_id,t.parent_task_id FROM agents_platform.tasks t
      JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.agents a ON a.id=v.agent_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id
      JOIN agents_platform.delegations d ON d.child_task_id=t.id WHERE t.parent_task_id=$1 ORDER BY d.operation_id,d.slot`, [task.id])).rows;
    const resources = (await options.pool.query(`SELECT id,task_id,profile_id AS profile,state,
      CASE WHEN state='destroyed' THEN 'completed' WHEN state='destroying' THEN 'pending'
        WHEN state='uncertain' THEN 'uncertain' ELSE 'active' END AS cleanup_state,lease_expires_at AS expires_at
      FROM agents_platform.sandbox_allocations WHERE root_task_id=$1 ORDER BY created_at,id`, [task.root_task_id])).rows;
    const visibleArtifacts = await options.artifacts.listForRoot(task.root_task_id).catch(error => {
      if (error instanceof PlatformError && error.code === "ARTIFACT_NOT_FOUND") return [];
      throw error;
    });
    const reviewerReports = !canControl ? (await options.pool.query("SELECT artifact_id FROM agents_platform.actions WHERE root_task_id=$1 AND reviewer_account_id=$2",
      [task.root_task_id, account.id])).rows.map(row => row.artifact_id) : null;
    const artifacts = visibleArtifacts.filter(artifact => (!task.parent_task_id || artifact.taskId === task.id) && (!reviewerReports || reviewerReports.includes(artifact.id)))
      .map(artifact => ({ ...artifact, downloadPath: `/api/organizations/${task.organization_id}/tasks/${task.id}/artifacts/${artifact.id}` }));
    const actions = options.actions ? await options.actions.listForTask({ accountId: account.id, organizationId: task.organization_id }, task.id) : [];
    const hasToolReviews = Boolean((await options.pool.query("SELECT 1 FROM agents_platform.tool_invocation_reviews WHERE task_id=$1 AND organization_id=$2 AND reviewer_account_id=$3 LIMIT 1",
      [task.id, task.organization_id, account.id])).rowCount);
    const configuration = agentConfigurationSchema.parse((await options.pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1", [task.version_id])).rows[0].configuration);
    const adaptive = configuration.program.id === "tool-directed" && configuration.program.version === "4" && configuration.capabilities.delegation.enabled;
    let orchestration: Progress | undefined = adaptive ? await options.readWorkProgress(task.id) : undefined;
    if (orchestration?.record) {
      const conversation = (await options.pool.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1", [task.conversation_id])).rows[0];
      try {
        if (!conversation || conversation.deleted_at) throw new PlatformError("CONVERSATION_DELETED", 403, "Conversation unavailable");
        await assertCurrentEvidence(options.pool, task.id, await taskEvidenceManifest(options.pool, task.id), { requireActiveTask: false });
        orchestration = await options.projectWorkProgress(task.id, orchestration);
      } catch (error) { if (!(error instanceof PlatformError)) throw error; orchestration = { revision: orchestration.revision, record: null }; }
    }
    let canSteer = (adaptive || task.effective_composition?.runtime.release === "product-capabilities-v15") && canControl &&
      task.principal.kind === "human" && !task.parent_task_id && !terminalTaskStates.has(task.state) && task.state !== "cancel_requested";
    if (canSteer) try { await options.authorizeOrchestration(task.id); } catch (error) { if (!(error instanceof PlatformError)) throw error; canSteer = false; }
    const visibleTask = await options.presentTask(task);
    let runtime: object | undefined;
    if (task.product === "agents" && !task.channel_binding && (visibleTask as { inputAvailability?: string }).inputAvailability !== "unavailable" &&
        (visibleTask as { outputAvailability?: string }).outputAvailability !== "unavailable") try {
      runtime = await options.readRuntime(task);
    } catch (error) { if (!(error instanceof PlatformError) || ![403, 404, 409, 503].includes(error.statusCode)) throw error; }
    const runtimeView = runtime as { elapsedMs: number; workElapsedMs: number; observedAt: string } | undefined;
    return { ...await options.readPublicUpdates(task.id), orchestration, canSteer, actions, canControl, canDownloadArtifacts: true,
      task: { ...visibleTask, ...(runtimeView ? { runtime: runtimeView, elapsedMs: runtimeView.elapsedMs,
        workElapsedMs: runtimeView.workElapsedMs, observedAt: runtimeView.observedAt } : {}), hasToolReviews,
      hasEnquiries: Boolean((await options.pool.query("SELECT 1 FROM agents_platform.enquiries WHERE task_id=$1 LIMIT 1", [task.id])).rowCount),
      hasBookings: Boolean((await options.pool.query("SELECT 1 FROM agents_platform.booking_intents WHERE task_id=$1 LIMIT 1", [task.id])).rowCount) },
      events: events.map(options.present), eventsNextCursor: eventPage.nextCursor, operations: operations.map(options.present),
      operationsNextCursor: operationPage.nextCursor,
      children: await Promise.all(children.map(async child => {
        const visible = await options.presentTask(child as unknown as TaskRecord);
        return { ...options.present(child), input: visible.input, assignment: visible.input, ...await options.presentOutput(child.id, child.output) };
      })), resources: resources.map(options.present), artifacts };
  });

  app.get(`${base}/tasks/:taskId/events`, async request => {
    const { task, authority, reviewOnly } = await options.taskAccess(request);
    const query = pageQuery.strict().parse(request.query);
    if (reviewOnly) return { events: [], nextCursor: null };
    const page = await options.store.getEventPage(authority, task.id, query);
    return { events: page.items.map(options.present), nextCursor: page.nextCursor };
  });

  app.get(`${base}/tasks/:taskId/evidence`, async request => {
    const { task } = await options.taskAccess(request), { account } = await scopeFor(request);
    // A report reviewer receives only the prepared report's citations through ActionService.
    if (task.principal.kind === "automation" && task.principal.ownerAccountId !== account.id) throw new PlatformError("NOT_FOUND", 404, "Task not found");
    return taskPassages(task);
  });

  app.get(`${base}/tasks/:taskId/artifacts/:artifactId`, async (request, reply) => {
    const { task } = await options.taskAccess(request), { account } = await scopeFor(request);
    const result = await options.artifacts.download(account.id, task.organization_id, task.id, uuid.parse(parameters(request).artifactId));
    return reply.header("content-type", result.artifact.contentType).header("content-disposition", `attachment; filename="${result.artifact.name}"`)
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").send(Buffer.from(result.content));
  });

  app.post(`${base}/tasks/:taskId/instructions`, async request => {
    const { task, reviewOnly } = await options.taskAccess(request);
    if (reviewOnly || task.principal.kind !== "human" || task.parent_task_id) throw new PlatformError("ACCESS_DENIED", 403, "Task instructions are unavailable");
    return queueOrchestrationInstruction(options.pool, task.id, request.body);
  });

  app.post(`${base}/tasks/:taskId/continue`, async request => {
    const { task, authority } = await options.taskAccess(request);
    if (task.principal.kind !== "human") throw new PlatformError("AUTOMATION_CONTROL_REQUIRED", 403, "Manage access on the automation");
    if (task.parent_task_id) throw new PlatformError("ROOT_CONTROL_REQUIRED", 409, "Continue the main task");
    const { account } = await scopeFor(request);
    const childNeedsAuthority = task.state === "waiting_children" && Boolean((await options.pool.query(
      "SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' LIMIT 1", [task.id])).rowCount);
    if (task.state !== "waiting_authority" && !childNeedsAuthority) return { task: options.present(task) };
    const previous = (await options.pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1", [task.grant_id])).rows[0];
    if (!previous || previous.revoked_at) throw new PlatformError("GRANT_REVOKED", 403, "Execution access was revoked");
    const version = await options.store.getVersion(account.id, task.organization_id, task.version_id);
    const grant = executionGrantSchema.parse({ ...authority, id: crypto.randomUUID(), versionId: version.id,
      operations: options.grantOperations(version.configuration),
      sourceRevisionIds: sourceAuthorityIds(version.configuration), connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
      maxInputBytes: version.configuration.model.maxInputBytes,
      maxOutputTokens: version.configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(version.configuration),
      rootTokenLimit: (task as TaskRecord & { root_token_limit: number }).root_token_limit,
      expiresAt: new Date(Math.min(Date.now() + 30 * 60_000, deadlineMillis((task as TaskRecord & { deadline_at: Date | null }).deadline_at))).toISOString(), revokedAt: null });
    await options.store.createGrant({ accountId: account.id, grant });
    const db = await options.pool.connect();
    try {
      await db.query("BEGIN");
      const current = (await db.query(`SELECT g.id FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id
        WHERE t.id=$1 AND g.revoked_at IS NULL FOR NO KEY UPDATE OF t FOR SHARE OF g`, [task.id])).rows[0];
      if (!current) throw new PlatformError("GRANT_REVOKED", 403, "Execution access was revoked");
      const updated = (await db.query(`UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1,updated_at=now()
        WHERE id=$1 AND state IN ('waiting_authority','waiting_children') RETURNING control_generation-1 AS generation,state`, [task.id, grant.id])).rows[0];
      if (updated?.state === "waiting_authority") await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING", [task.id, updated.generation]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    await queueChildContinuations(options.pool, task.id);
    return { task: options.present((await options.taskAccess(request)).task) };
  });

  app.post(`${base}/tasks/:taskId/cancel`, async request => {
    const { task } = await options.taskAccess(request), { account } = await scopeFor(request);
    if (task.principal.kind === "automation" && account.id !== task.principal.ownerAccountId)
      throw new PlatformError("ACCESS_DENIED", 403, "Only the owner can stop this task");
    if (task.parent_task_id) throw new PlatformError("ROOT_CONTROL_REQUIRED", 409, "Cancel the main task");
    if (!terminalTaskStates.has(task.state)) await requestTreeCancellation(options.pool, task.id);
    return { task: options.present((await options.taskAccess(request)).task) };
  });

  app.get(`${base}/tasks/:taskId/history-export`, async request => {
    const { account, organizationId } = await scopeFor(request);
    return options.exportHistory(account, organizationId, uuid.parse(parameters(request).taskId));
  });

  app.get(`${base}/conversations/:conversationId`, async request => {
    const { account, organizationId } = await scopeFor(request);
    const conversationId = uuid.parse(parameters(request).conversationId);
    await options.store.requireMembership(account.id, organizationId);
    const conversation = (await options.pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [organizationId, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    const page = await options.store.getConversationPage(humanAuthority(account, organizationId, conversation.agent_id),
      conversationId, pageQuery.strict().parse(request.query));
    return { tasks: await Promise.all(page.items.map(options.presentTask)), nextCursor: page.nextCursor, conversation: page.conversation };
  });

  app.delete(`${base}/conversations/:conversationId`, async request => {
    const { account, organizationId } = await scopeFor(request);
    const conversationId = uuid.parse(parameters(request).conversationId);
    const conversation = (await options.pool.query("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2",
      [organizationId, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    return options.deleteConversationSources({ accountId: account.id, organizationId, agentId: conversation.agent_id }, conversationId);
  });
}
