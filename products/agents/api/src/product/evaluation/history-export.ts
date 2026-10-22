import type { Pool, PoolClient } from "pg";
import { builtinToolName } from "../../capabilities/tool-definitions";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import { observationSchema } from "../../contracts/observations";
import { effectiveCompositionSchema } from "../../contracts/programs";
import type { HarnessMessage, ToolDefinition } from "../../execution/business/model";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { assertExportArtifact, exportReportEffects, withheldDependency } from "./history-policy";
import { exportProviderEffects, type ProviderEffectExportOptions } from "./history-provider-effects";
import { loadTaskModelRoutes } from "../../execution/models/persistence";
import type { AcceptedModelRoutes } from "../../contracts/model-bindings";
import type { ResolvedModelBinding, EffectiveExecutionPolicy } from "../../contracts/model-providers";
import { transaction } from "../../infrastructure/database";

export interface CoveragePart { status: "complete" | "partial" | "unavailable"; omissions: string[] }
export type Coverage = Record<"modelInputs" | "modelOutputs" | "toolCalls" | "toolResults" | "children" | "artifacts" | "observations" | "effects", CoveragePart>;
export interface NativeToolResult {
  toolCallId: string; operationId: string; name: string; state: string; content: string | null;
  childTaskIds: string[]; observedByOperationId: string | null; nativeOutput: unknown; errorCode: string | null;
}
export interface NativeModelCall {
  operationId: string; step: number; model: string; state: string; modelBinding: ResolvedModelBinding; effectivePolicy: EffectiveExecutionPolicy;
  inputMessages: HarnessMessage[]; outputMessage: HarnessMessage | null; toolDefinitions: ToolDefinition[];
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  toolResults: NativeToolResult[]; nativeRequest: unknown; nativeResponse: unknown; usageOmissions: string[];
}
export interface NativeTask {
  id: string; agentId: string; versionId: string; effectiveComposition: unknown; parentTaskId: string | null; parentOperationId: string | null; state: string;
  input: string | null; output: string | null; modelCalls: NativeModelCall[]; modelRoutes: AcceptedModelRoutes; modelRoutesDigest: string;
  initialOperations: unknown[]; compactions: unknown[]; contextSnapshots: unknown[]; evidenceManifest: unknown; evidenceReferences: unknown[];
}
export interface ExecutionHistoryExport {
  schemaVersion: "execution-export.v1"; conversationId: string; rootTaskId: string; organizationId: string; agentId: string; versionId: string;
  effectiveComposition: { digest: string; programId: string; programVersion: string; runtime: string; capabilities: unknown[]; workflows: unknown[] };
  compositionSnapshot: unknown; modelRoutes: AcceptedModelRoutes; modelRoutesDigest: string; tasks: NativeTask[]; coverage: Coverage;
  artifacts: { id: string; taskId: string; name: string; bytes: number; downloadPath: string | null; contentDigest: string | null }[];
  observations: unknown[]; effectReceipts: unknown[];
}
export interface OperationRow {
  id: string; task_id: string; kind: string; name: string; state: string;
  request: any; output: any; error_code: string | null; accounted_tokens: number;
}
const part = (status: CoveragePart["status"] = "complete", ...omissions: string[]): CoveragePart => ({ status, omissions });
export function emptyExportCoverage(): Coverage {
  return { modelInputs: part(), modelOutputs: part(), toolCalls: part(), toolResults: part(), children: part(), artifacts: part(),
    observations: part("unavailable", "Native runtime observations are not exported by this release"),
    effects: part("unavailable", "Native effect receipts are not exported by this release") };
}
function omit(coverage: Coverage, key: keyof Coverage, reason: string) {
  const value = coverage[key]; if (value.status !== "unavailable") value.status = "partial";
  if (!value.omissions.includes(reason)) value.omissions.push(reason);
}
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const receipt = (row: OperationRow) => ({ operationId: row.id, name: row.name, kind: row.kind, state: row.state,
  request: row.request, output: row.output, errorCode: row.error_code });

/** Pair only the worker's persisted model/step/index identity, never text in a later prompt. */
export function exportModelCalls(taskId: string, operations: OperationRow[], children: { id: string; parent_task_id: string | null; delegation_operation_id: string | null }[], coverage: Coverage, models: { primary: Pick<AcceptedModelRoutes["primary"], "binding" | "policy"> }): NativeModelCall[] {
  const byId = new Map(operations.map(row => [row.id, row]));
  const calls: NativeModelCall[] = [];
  const paired = new Set<string>();
  for (const row of operations.filter(row => row.kind === "model")) {
    const match = new RegExp(`^model:${taskId}:([0-9]+)$`).exec(row.id);
    if (!match || !Number.isSafeInteger(Number(match[1]))) { omit(coverage, "modelInputs", "Unmapped native model operation identity"); continue; }
    const request = row.request, response = row.output;
    const hasInputs = Array.isArray(request?.messages);
    if (!hasInputs) omit(coverage, "modelInputs", "Native model operation lacks an exact request snapshot");
    const outputMessage: HarnessMessage | null = response?.message?.role === "assistant" ? response.message : null;
    if (!outputMessage) {
      omit(coverage, "modelOutputs", "Native model operation has no recorded assistant response");
      omit(coverage, "toolCalls", "Native model operation has no recorded assistant response");
    }
    const inputTokens = integer(response?.usage?.inputTokens), outputTokens = integer(response?.usage?.outputTokens);
    const next = operations.filter(candidate => ["model", "compaction"].includes(candidate.kind) &&
      new RegExp(`^(?:model|compact):${taskId}:([0-9]+)$`).test(candidate.id))
      .map(candidate => ({ row: candidate, step: Number(candidate.id.split(":").at(-1)) }))
      .filter(candidate => candidate.step > Number(match[1])).sort((a, b) => a.step - b.step)[0]?.row;
    const nextMessages: HarnessMessage[] = Array.isArray(next?.request?.messages) ? next.request.messages : [];
    let observedGroup: HarnessMessage[] = [];
    for (let index = nextMessages.length - 1; index >= 0; index--) {
      if (outputMessage && canonicalJson(nextMessages[index]) === canonicalJson(outputMessage)) {
        for (let after = index + 1; after < nextMessages.length && nextMessages[after]?.role === "tool"; after++) observedGroup.push(nextMessages[after]!);
        break;
      }
    }
    const toolResults: NativeToolResult[] = [];
    for (const [index, call] of (outputMessage?.tool_calls ?? []).entries()) {
      const operationId = `tool:${taskId}:${match[1]}:${index}`, tool = byId.get(operationId);
      // Built-in provider aliases differ from native names. The saved arguments and
      // canonical request.tool identify the executed call without guessing aliases.
      if (!tool || !["tool", "delegation", "resource"].includes(tool.kind) || tool.request?.arguments !== call.function.arguments || tool.request?.tool !== tool.name || (builtinToolName(call.function.name) ?? call.function.name) !== tool.name) {
        omit(coverage, "toolResults", "Provider tool call has no exact native operation mapping"); continue;
      }
      paired.add(tool.id);
      if (tool.state !== "completed" || tool.output === null) omit(coverage, "toolResults", "Native tool result is not confirmed complete");
      const observations = observedGroup.filter(message => message.tool_call_id === call.id);
      const observed = observations.length === 1 ? observations[0] : undefined;
      if (!observed) omit(coverage, "toolResults", "Native receipt has no exact recorded model-visible tool observation");
      toolResults.push({ toolCallId: call.id, operationId: tool.id, name: call.function.name, state: tool.state,
        content: observed ? observed.content : null, observedByOperationId: observed ? next!.id : null, nativeOutput: tool.output, errorCode: tool.error_code,
        childTaskIds: children.filter(child => child.parent_task_id === taskId && child.delegation_operation_id === tool.id).map(child => child.id) });
    }
    calls.push({ operationId: row.id, step: Number(match[1]), model: models.primary.binding.modelId, state: row.state, modelBinding: models.primary.binding, effectivePolicy: models.primary.policy,
      inputMessages: hasInputs ? request.messages : [], outputMessage, toolDefinitions: Array.isArray(request?.tools) ? request.tools : [],
      usage: response?.usage ? { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null } : null, toolResults,
      nativeRequest: request, nativeResponse: response, usageOmissions: inputTokens === null || outputTokens === null ? ["Exact provider input/output token split is unavailable; reserved/accounted tokens are not substituted"] : [] });
  }
  for (const row of operations) if (/^tool:/.test(row.id) && !paired.has(row.id)) omit(coverage, "toolResults", "Native tool operation has no recorded provider call mapping");
  return calls.sort((a, b) => a.step - b.step);
}

export type HistoryExportAuthorization = void | { evaluationTrialId: string; accountId: string };

/** The mandatory hook verifies the requesting human's exact root ownership within this transaction. */
export async function exportExecutionHistory(pool: Pool, rootTaskId: string, authorize: (db: PoolClient, rootTaskId: string) => Promise<HistoryExportAuthorization>, options: ProviderEffectExportOptions = {}): Promise<ExecutionHistoryExport> {
  return transaction(pool, async db => {
    const initial = (await db.query("SELECT organization_id FROM agents_platform.tasks WHERE id=$1 AND parent_task_id IS NULL", [rootTaskId])).rows[0];
    if (!initial) throw new PlatformError("TASK_NOT_FOUND", 404, "Task not found");
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.organization_id]);
    const authorization = await authorize(db, rootTaskId);
    const rows = (await db.query(`SELECT t.*,v.agent_id FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
      WHERE t.root_task_id=$1 AND t.organization_id=$2 ORDER BY t.created_at,t.id LIMIT 1025 FOR SHARE OF t`, [rootTaskId, initial.organization_id])).rows;
    if (rows.length > 1024) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
    const root = rows.find(row => row.id === rootTaskId);
    if (!root || root.parent_task_id || !["human", "visitor","channel_customer"].includes(root.principal.kind)) throw new PlatformError("ACCESS_DENIED", 403, "Root ownership is required");
    if (root.principal.kind === "visitor") {
      if (!authorization || authorization.evaluationTrialId !== root.evaluation_trial_id) throw new PlatformError("ACCESS_DENIED", 403, "Evaluation ownership is required");
      const bound = await db.query(`SELECT e.id FROM agents_platform.evaluation_trials e
        JOIN agents_platform.evaluation_trial_channels c ON c.trial_id=e.id
        JOIN agents_platform.memberships m ON m.organization_id=e.organization_id AND m.account_id=e.account_id AND m.revoked_at IS NULL
        WHERE e.id=$1 AND e.account_id=$2 AND e.organization_id=$3 AND e.agent_id=$4 AND e.version_id=$5
          AND c.deployment_id=$6 AND c.session_id=$7 FOR SHARE OF e,c,m`,
      [authorization.evaluationTrialId, authorization.accountId, root.organization_id, root.agent_id, root.version_id, root.principal.deploymentId, root.principal.sessionId]);
      if (!bound.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Evaluation ownership is required");
    }
    if(root.principal.kind==="channel_customer") {
      if(!authorization||authorization.evaluationTrialId!==root.evaluation_trial_id)throw new PlatformError("ACCESS_DENIED",403,"Evaluation ownership is required");
      const bound=await db.query(`SELECT 1 FROM agents_platform.evaluation_trials e
        JOIN agents_platform.evaluation_trial_messaging_channels f ON f.trial_id=e.id AND f.organization_id=e.organization_id
        JOIN agents_platform.customer_conversations c ON c.channel_deployment_id=f.deployment_id AND c.organization_id=e.organization_id
        JOIN agents_platform.memberships m ON m.organization_id=e.organization_id AND m.account_id=e.account_id AND m.revoked_at IS NULL
        WHERE e.id=$1 AND e.account_id=$2 AND e.organization_id=$3 AND e.agent_id=$4 AND e.version_id=$5
          AND f.deployment_id=$6 AND c.id=$7 FOR SHARE OF e,f,c,m`,[authorization.evaluationTrialId,authorization.accountId,
          root.organization_id,root.agent_id,root.version_id,root.principal.deploymentId,root.principal.participantId]);
      if(!bound.rowCount)throw new PlatformError("ACCESS_DENIED",403,"Evaluation ownership is required");
    }
    const composition = effectiveCompositionSchema.parse(root.effective_composition), coverage = emptyExportCoverage();
    const tasks: NativeTask[] = [], visible = new Set<string>();
    for (const task of rows) {
      const models = await loadTaskModelRoutes(db, task.id, task.organization_id);
      const snapshots = (await db.query("SELECT id,step,digest,payload,source_references,memory_scope_id,memory_generation,created_at FROM agents_platform.context_snapshots WHERE task_id=$1 ORDER BY step LIMIT 129", [task.id])).rows;
      if (snapshots.length > 128) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
      const references = (await db.query("SELECT id,operation_id,source_id,revision_id,chunk_id,content_digest,manifest,citation_label FROM agents_platform.evidence_references WHERE task_id=$1 ORDER BY id LIMIT 1025", [task.id])).rows;
      if (references.length > 1024) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
      let manifest: unknown = null, authorized = false;
      try {
        manifest = await taskEvidenceManifest(db, task.id);
        await assertCurrentEvidence(db, task.id, manifest as Parameters<typeof assertCurrentEvidence>[2], { requireActiveTask: false });
        for (const reference of references) await assertCurrentEvidence(db, task.id, reference.manifest, { requireActiveTask: false });
        for (const snapshot of snapshots) {
          if (snapshot.memory_scope_id) {
            const memory = (await db.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND account_id=(SELECT id FROM agents_platform.accounts WHERE issuer=$4 AND subject=$5) FOR SHARE", [snapshot.memory_scope_id, task.organization_id, root.agent_id, root.principal.issuer, root.principal.subject])).rows[0];
            if (!memory || Number(memory.generation) !== Number(snapshot.memory_generation) || memory.next_expiry_at && new Date(memory.next_expiry_at).getTime() <= Date.now() || snapshot.payload.memoryExpiresAt !== undefined && snapshot.payload.memoryExpiresAt <= Date.now()) throw new PlatformError("EVIDENCE_UNAVAILABLE", 403, "Memory is unavailable");
          }
        }
        authorized = true; visible.add(task.id);
      } catch (error) {
        if (!(error instanceof PlatformError) || ![403, 404, 409, 503].includes(error.statusCode)) throw error;
        for (const key of ["modelInputs", "modelOutputs", "toolCalls", "toolResults", "artifacts"] as const) omit(coverage, key, "Execution data withheld because a current dependency is unavailable");
      }
      const operations: OperationRow[] = authorized ? (await db.query("SELECT * FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at,id LIMIT 4097", [task.id])).rows : [];
      if (operations.length > 4096) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
      tasks.push({ id: task.id, agentId: task.agent_id, versionId: task.version_id, effectiveComposition: task.effective_composition, parentTaskId: task.parent_task_id, parentOperationId: task.delegation_operation_id ?? null, state: task.state,
        input: authorized ? task.input : null, output: authorized ? task.output : null,
        modelRoutes: models, modelRoutesDigest: requestDigest(models),
        modelCalls: exportModelCalls(task.id, operations, rows, coverage, models), initialOperations: operations.filter(row => !["model", "compaction"].includes(row.kind) && !row.id.startsWith("tool:")).map(receipt),
        compactions: operations.filter(row => row.kind === "compaction").map(row => ({ ...receipt(row), modelBinding: models.compaction.binding, effectivePolicy: models.compaction.policy })),
        contextSnapshots: authorized ? snapshots.map(snapshot => ({ id: snapshot.id, step: snapshot.step, digest: snapshot.digest,
          payload: snapshot.payload, sourceReferences: snapshot.source_references, createdAt: snapshot.created_at })) : [], evidenceManifest: authorized ? manifest : null, evidenceReferences: authorized ? references : [] });
    }
    const ids = new Set(rows.map(row => row.id));
    for (const task of rows) if (task.id !== rootTaskId && (!ids.has(task.parent_task_id) || !task.delegation_operation_id)) throw new PlatformError("EXPORT_LINEAGE_INVALID", 409, "Execution lineage is incomplete");
    const artifacts = (await db.query("SELECT id,task_id,name,bytes,content_digest,state FROM agents_platform.artifacts WHERE root_task_id=$1 AND organization_id=$2 ORDER BY created_at,id LIMIT 1025", [rootTaskId, root.organization_id])).rows;
    if (artifacts.length > 1024) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
    const artifactEvidence = new Set<string>();
    let invalidArtifactDependency = false;
    for (const artifact of artifacts) {
      if (!visible.has(artifact.task_id) || artifact.state !== "available") continue;
      try { await assertExportArtifact(db, root, artifact.id); artifactEvidence.add(artifact.id); }
      catch (error) { if (!withheldDependency(error)) throw error; invalidArtifactDependency = true; }
    }
    if (invalidArtifactDependency) {
      // Artifact dependencies can predate a later model snapshot. Fail closed for
      // the whole rooted trace rather than retain a possibly derived quotation.
      visible.clear(); artifactEvidence.clear();
      for (const task of tasks) { task.input = null; task.output = null; task.modelCalls = []; task.initialOperations = []; task.compactions = []; task.contextSnapshots = []; task.evidenceManifest = null; task.evidenceReferences = []; }
      for (const key of ["modelInputs", "modelOutputs", "toolCalls", "toolResults", "artifacts"] as const) omit(coverage, key, "Rooted execution payload withheld because a transitive artifact dependency is unavailable");
    }
    const reports = await exportReportEffects(db, root, visible), providers = await exportProviderEffects(db, root, visible, options);
    const effects = { records: [...reports.records, ...providers.records], omissions: [...reports.omissions, ...providers.omissions] };
    coverage.effects = { status: effects.omissions.length ? "partial" : "complete", omissions: [...new Set(effects.omissions)] };
    const eventRows = (await db.query(`SELECT e.task_id,e.observation FROM agents_platform.task_events e JOIN agents_platform.tasks t ON t.id=e.task_id
      WHERE t.root_task_id=$1 AND t.organization_id=$2 ORDER BY e.sequence LIMIT 10001`, [rootTaskId, root.organization_id])).rows;
    if (eventRows.length > 10000) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
    coverage.observations = part();
    const observations: unknown[] = [];
    for (const event of eventRows) {
      if (!visible.has(event.task_id)) { omit(coverage, "observations", "Observation withheld because its task dependencies are unavailable"); continue; }
      const parsed = observationSchema.safeParse(event.observation), task = rows.find(row => row.id === event.task_id);
      if (!parsed.success || parsed.data.identity.taskId !== event.task_id || parsed.data.identity.rootTaskId !== rootTaskId || parsed.data.identity.organizationId !== root.organization_id || parsed.data.identity.agentId !== task.agent_id || parsed.data.identity.versionId !== task.version_id) {
        omit(coverage, "observations", "Native event has no valid typed observation for this execution"); continue;
      }
      observations.push(parsed.data);
    }
    const rootModels = tasks.find(task => task.id === rootTaskId)!.modelRoutes;
    const result: ExecutionHistoryExport = { schemaVersion: "execution-export.v1", conversationId: root.conversation_id, rootTaskId, organizationId: root.organization_id, agentId: root.agent_id, versionId: root.version_id,
      effectiveComposition: { digest: composition.digest, programId: composition.program.id, programVersion: composition.program.version, runtime: composition.runtime.kind,
        capabilities: composition.capabilities, workflows: composition.workflows }, compositionSnapshot: composition, modelRoutes: rootModels, modelRoutesDigest: requestDigest(rootModels), tasks, coverage,
      artifacts: artifacts.map(row => {
        const allowed = visible.has(row.task_id) && row.state === "available" && artifactEvidence.has(row.id);
        if (!allowed) omit(coverage, "artifacts", "Native artifact is unavailable or its current dependencies are withheld");
        return { id: row.id, taskId: row.task_id, name: allowed ? row.name : "withheld", bytes: row.bytes,
          downloadPath: allowed ? `/api/organizations/${root.organization_id}/tasks/${rootTaskId}/artifacts/${row.id}` : null, contentDigest: allowed ? row.content_digest : null };
      }), observations, effectReceipts: effects.records };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
    return result;
  });
}
