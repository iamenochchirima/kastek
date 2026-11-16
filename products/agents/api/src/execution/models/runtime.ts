import { deadlineMillis } from "../lifecycle/deadline";
import { modelIdentitySchema } from "../../contracts/model-transport";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import { SHARED_HARNESS_RELEASE } from "../../contracts/execution";
import { prepareRequestManifest, assertPreparedContext, type PreparedContextManifest } from "../context/request-manifest";
import type { HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
import type { AcceptedModelRoute } from "../../contracts/model-bindings";
import type { ModelRole } from "../../contracts/model-providers";
import type { PrivateNativeState, ProviderTransportResponse } from "../../adapters/models/pi-transport";
import { transaction } from "../../infrastructure/database";
import { assertMcpTaskAuthority } from "../../infrastructure/mcp-job-authority";
import { assertCurrentAuthority,assertCurrentEvidence,taskEvidenceManifest } from "../context/evidence-policy";
import { assertProductInformationForModel } from "../products/product-information";
import { loadExecution } from "../lifecycle/state";
import { ModelOperationError, validateMessageGroups } from "../business/model";
import type { PreparedInputCount } from "../../adapters/models/input-count";
import { BoundModelDispatchError, dispatchBoundModel, type BoundModelDispatchInput } from "./dispatch";
import { recordEvent } from "../../observability/event-store";

type Db = Pool | PoolClient;
/** Private protocol bytes contribute to packing without returning native reasoning to a durable journal. */
export async function nativeContextCosts(db: Db, execution: Execution): Promise<Map<string, number>> {
  const rows = (await db.query(`SELECT assistant_digest,octet_length(native_state::text)::int AS bytes
    FROM agents_platform.private_model_continuations WHERE organization_id=$1 AND task_id=$2
    AND route_binding_digest=$3 AND state='completed' AND role<>'compaction'`,
  [execution.task.organization_id, execution.task.id, requestDigest(execution.models.primary.binding)])).rows;
  const costs = new Map<string, number>();
  for (const row of rows) costs.set(row.assistant_digest, Math.max(costs.get(row.assistant_digest) ?? 0, row.bytes));
  return costs;
}
const unavailable = () => new ModelOperationError("MODEL_ROUTES_UNAVAILABLE", "rejected", 409);
export { saveTaskModelRoutes, loadTaskModelRoutes } from "./persistence";
import { loadTaskModelRoutes } from "./persistence";
const nativeSchema = z.strictObject({ provider: z.string(), protocol: z.enum(["openai_chat_completions", "openai_responses", "anthropic_messages", "google_generate_content"]),
  model: z.string(), baseUrl: z.string(), credentialRevision: z.string(), assistant: z.record(z.string(), z.unknown()) });
function compatible(state: PrivateNativeState, route: AcceptedModelRoute): boolean {
  return state.provider === route.binding.providerId && state.protocol === route.binding.protocol && state.model === route.binding.modelId &&
    state.baseUrl === route.binding.endpoint && state.credentialRevision === String(route.binding.credentialRevision);
}
/** Optional counters must describe the complete native protocol payload, including restored continuation. */
export interface TaskModelInvocation {
  pool: Pool;
  providerStore: BoundModelDispatchInput["providerStore"];
  execution: Execution;
  operationId: string;
  role: ModelRole;
  messages: HarnessMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  maxRequestBytes: number;
  contextSnapshotId?: string;
  estimateRequestTokens?: (payload: Readonly<Record<string, unknown>>) => number | Promise<number>;
  onText?: (delta: string) => void;
}
export type TaskModelResponse = Pick<ProviderTransportResponse, "message" | "finishReason" | "usage" | "providerRequestId" | "modelIdentity"> & {contextDisposition?:"quarantined";guardCode?:string};
export interface ModelRuntimeDependencies {
  dispatch?: typeof dispatchBoundModel;
  assertAuthority?: (db: PoolClient, execution: Execution) => Promise<void>;
}
async function currentAuthority(db: PoolClient, original: Execution): Promise<void> {
  const current = await loadExecution(db, original.task.id, true);
  if (current.task.organization_id !== original.task.organization_id) throw unavailable();
  await assertCurrentAuthority(db, current);
}
async function nativeHistory(db: Db, taskId: string, organizationId: string, route: AcceptedModelRoute,
  messages: HarnessMessage[]): Promise<Record<number, PrivateNativeState>> {
  const candidates = messages.flatMap((message, index) => message.role === "assistant" ? [{ message, index, digest: requestDigest(message) }] : []);
  const history: Record<number, PrivateNativeState> = {};
  if (!candidates.length || route.binding.role === "compaction") return history;
  const rows = (await db.query(`SELECT assistant_digest,tool_call_ids,native_state,native_state_digest,model_identity,model_identity_digest FROM agents_platform.private_model_continuations
    WHERE task_id=$1 AND organization_id=$2 AND route_binding_digest=$3 AND assistant_digest=ANY($4::text[])
      AND state='completed' AND role<>'compaction' ORDER BY created_at,operation_id`,
    [taskId, organizationId, requestDigest(route.binding), candidates.map(candidate => candidate.digest)])).rows;
  for (const candidate of candidates) {
    const ids = (candidate.message.tool_calls ?? []).map(call => call.id);
    const matching = rows.filter(row => row.assistant_digest === candidate.digest && requestDigest(row.tool_call_ids) === requestDigest(ids));
    // Identical public messages can hide different native reasoning. Ambiguity cannot select private history safely.
    if (matching.length > 1 && new Set(matching.map(row => row.native_state_digest)).size > 1) {
      throw new ModelOperationError("MODEL_NATIVE_HISTORY_AMBIGUOUS", "rejected", 409);
    }
    const row = matching[0]; if (!row) continue;
    if (row.model_identity !== null) {
      const identity = modelIdentitySchema.safeParse(row.model_identity);
      if (!identity.success || identity.data.requestedModelId !== route.binding.modelId || requestDigest(identity.data) !== row.model_identity_digest) {
        throw new ModelOperationError("MODEL_RESPONSE_IDENTITY_INTEGRITY", "rejected", 409);
      }
    }
    const parsed = nativeSchema.safeParse(row.native_state);
    if (!parsed.success || requestDigest(row.native_state) !== row.native_state_digest || !compatible(parsed.data, route)) {
      throw new ModelOperationError("MODEL_NATIVE_HISTORY_INTEGRITY", "rejected", 409);
    }
    history[candidate.index] = parsed.data;
  }
  return history;
}
/** Invoke only inside the durable operation boundary. Return public message/usage; keep native continuation out of journals. */
export async function invokeTaskModel(input: TaskModelInvocation, dependencies: ModelRuntimeDependencies = {}): Promise<TaskModelResponse> {
  let claimed = false, dispatched = false;
  let inputCount: PreparedInputCount | undefined;
  let inputRejectedBeforeDispatch = false;
  let guardFailure: ModelOperationError | PlatformError | undefined;
  const retainGuardFailure = (error: unknown): never => {
    if (error instanceof ModelOperationError || error instanceof PlatformError) guardFailure = error;
    throw error;
  };
  const taskId = input.execution.task.id, organizationId = input.execution.task.organization_id;
  const sharedProtocol=input.execution.task.harness_release===SHARED_HARNESS_RELEASE;
  const textChunks:string[]=[];
  const messages = structuredClone(input.messages), tools = structuredClone(input.tools);
  try {
    const prepared = await transaction(input.pool, async db => {
      await assertMcpTaskAuthority(db,taskId);
      const routes = await loadTaskModelRoutes(db, taskId, organizationId), route = routes[input.role];
      if (!messages.length || messages.length > route.policy.maxMessages || (tools?.length ?? 0) > route.policy.maxTools) {
        throw new ModelOperationError("MODEL_REQUEST_LIMIT", "rejected", 400);
      }
      validateMessageGroups(messages);
      const operation = (await db.query(`SELECT state,kind,reserved_tokens,started_at,reserved_ms FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE`, [input.operationId, taskId])).rows[0];
      if (!operation || operation.state !== "started" || (input.role === "compaction" ? operation.kind !== "compaction" : operation.kind !== "model")) {
        throw new ModelOperationError("MODEL_OPERATION_UNAVAILABLE", "rejected", 409);
      }
      const restored = await nativeHistory(db, taskId, organizationId, route, messages);
      const contextManifest:PreparedContextManifest|undefined=sharedProtocol?await prepareRequestManifest(db,input.execution,{operationId:input.operationId,role:input.role,snapshotId:input.contextSnapshotId}):undefined;
      const legacyEvidence=!sharedProtocol?await taskEvidenceManifest(db,taskId):undefined;
      const legacyProductFence=legacyEvidence?.dependencies.some(dependency=>dependency.kind==="product_access")?legacyEvidence:undefined;
      if(legacyProductFence){await assertCurrentEvidence(db,taskId,legacyProductFence);await assertProductInformationForModel(db,taskId,legacyProductFence,input.role);}
      const request = requestDigest({ role: input.role, messages, tools: tools ?? [] });
      const inserted = await db.query(`INSERT INTO agents_platform.private_model_continuations(operation_id,organization_id,task_id,role,route_binding_digest,request_digest,state)
        VALUES($1,$2,$3,$4,$5,$6,'started') ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
        [input.operationId, organizationId, taskId, input.role, requestDigest(route.binding), request]);
      if (!inserted.rowCount) throw new ModelOperationError("MODEL_NATIVE_OPERATION_ALREADY_RECORDED", "uncertain", 409);
      const deadlineAt = Math.min(deadlineMillis(input.execution.task.deadline_at),
        new Date(operation.started_at).getTime() + operation.reserved_ms);
      return { route, restored, reservedTokens: operation.reserved_tokens, deadlineAt,contextManifest,legacyProductFence };
    });
    claimed = true;
    if (!Number.isSafeInteger(prepared.deadlineAt) || prepared.deadlineAt <= Date.now()) {
      throw new ModelOperationError("MODEL_NETWORK_DEADLINE", "rejected", 408);
    }
    let emitted = false;
    const dispatchInput: BoundModelDispatchInput = { pool: input.pool, providerStore: input.providerStore,
      accepted: prepared.route, messages, tools, nativeHistory: prepared.restored, signal: input.signal,
      maxRequestBytes: Math.min(input.maxRequestBytes, prepared.route.policy.maxRequestBytes), deadlineAt: prepared.deadlineAt,
      onText: delta => { if (delta.length) emitted = true; if (sharedProtocol) textChunks.push(delta); else input.onText?.(delta); },
      beforeDispatch: async () => {
        try { await transaction(input.pool, async db => {
          await (dependencies.assertAuthority ?? currentAuthority)(db, input.execution);
          await assertMcpTaskAuthority(db,taskId);
          if(prepared.contextManifest)await assertPreparedContext(db,await loadExecution(db,taskId),prepared.contextManifest,true);
          if(prepared.legacyProductFence){await assertCurrentEvidence(db,taskId,prepared.legacyProductFence);await assertProductInformationForModel(db,taskId,prepared.legacyProductFence,input.role);}
          const operation = (await db.query(`SELECT state FROM agents_platform.operations WHERE id=$1 AND task_id=$2`, [input.operationId, taskId])).rows[0];
          if (!operation || operation.state !== "started") throw new ModelOperationError("MODEL_OPERATION_UNAVAILABLE", "rejected", 409);
        }); } catch (error) { retainGuardFailure(error); }
      },
      onPreparedInputCount: count => {
        inputCount = count;
        inputRejectedBeforeDispatch = count.tokens > prepared.route.policy.maxInputTokens ||
          BigInt(count.tokens) + BigInt(prepared.route.policy.maxOutputTokens) + BigInt(prepared.route.policy.safetyTokens) > BigInt(prepared.route.policy.contextTokens);
      },
      beforePayloadDispatch: async (payload, count) => {
        try {
          inputCount = count;
          const estimate = input.estimateRequestTokens ? await input.estimateRequestTokens(payload) : count.tokens;
        if (!Number.isSafeInteger(estimate) || estimate < 0 || estimate > prepared.route.policy.maxInputTokens ||
          estimate + prepared.route.policy.maxOutputTokens > prepared.reservedTokens ||
            BigInt(estimate) + BigInt(prepared.route.policy.maxOutputTokens) + BigInt(prepared.route.policy.safetyTokens) > BigInt(prepared.route.policy.contextTokens)) {
            throw new ModelOperationError("CONTEXT_LIMIT", "rejected", 400);
          }
        } catch (error) { retainGuardFailure(error); }
      },
    };
    // Retry a definitively rejected provider limit or outage before any output exists. The native
    // continuation is claimed once, so retrying the physical dispatch cannot record it twice.
    const retryableDispatch = new Set(["MODEL_RATE_LIMITED", "MODEL_PROVIDER_UNAVAILABLE"]);
    let response: ProviderTransportResponse | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await (dependencies.dispatch ?? dispatchBoundModel)(dispatchInput);
        break;
      } catch (error) {
        const value = error as { code?: unknown; outcome?: unknown; diagnostics?: { dispatched?: boolean } };
        const code = typeof value.code === "string" ? value.code : "";
        if (attempt >= 3 || emitted || value.outcome !== "rejected" || !retryableDispatch.has(code) ||
            value.diagnostics?.dispatched === true) throw error;
        void recordEvent(input.pool, taskId, `model-retry:${input.operationId}:${attempt}`, "model.retry", {
          operationId: input.operationId, attempt, code,
        }).catch(() => { /* Retry reporting cannot change the physical outcome. */ });
        await new Promise(resolve => setTimeout(resolve, 750 * attempt));
      }
    }
    dispatched = true;
    const identity = modelIdentitySchema.safeParse(response.modelIdentity ?? { requestedModelId: prepared.route.binding.modelId, returnedModelId: null, relation: "unreported" });
    if (!identity.success || identity.data.requestedModelId !== prepared.route.binding.modelId) throw new ModelOperationError("MODEL_RESPONSE_IDENTITY_INVALID", "uncertain");
    const modelIdentity = identity.data;
    let responseGuardCode: string | null = null;
    try {
      // Persist only JSON values. The provider SDK can include undefined fields that PostgreSQL drops.
      const state: unknown = JSON.parse(JSON.stringify(response.nativeState));
      const parsed = nativeSchema.safeParse(state);
      if (!parsed.success || !compatible(parsed.data, prepared.route)) throw new Error("Native continuation route changed");
      const stored = await transaction(input.pool, async db => {
        if(prepared.contextManifest||prepared.legacyProductFence){
          await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR SHARE",[organizationId]);
          try{
            const current=await loadExecution(db,taskId);
            await (dependencies.assertAuthority??currentAuthority)(db,current);
            await assertMcpTaskAuthority(db,taskId);
            if(prepared.contextManifest)await assertPreparedContext(db,current,prepared.contextManifest,false);
            if(prepared.legacyProductFence){await assertCurrentEvidence(db,taskId,prepared.legacyProductFence);await assertProductInformationForModel(db,taskId,prepared.legacyProductFence,input.role);}
            await input.providerStore.resolveCredential(db,prepared.route.binding,prepared.route.consumer);
          }catch(error){
            if(!(error instanceof PlatformError||error instanceof ModelOperationError||error instanceof BoundModelDispatchError))throw error;
            responseGuardCode=error.code;
            return db.query(`UPDATE agents_platform.private_model_continuations SET state='rejected',completed_at=now(),input_count=$3,
              response_guard=$4 WHERE operation_id=$1 AND task_id=$2 AND state='started' RETURNING operation_id`,[input.operationId,taskId,inputCount??null,
              {disposition:"quarantined",reason:responseGuardCode,usage:response.usage,modelIdentity,providerRequestId:response.providerRequestId??null}]);
          }
        }
        return db.query(`UPDATE agents_platform.private_model_continuations
          SET state='completed',assistant_digest=$3,tool_call_ids=$4,native_state=$5,native_state_digest=$6,input_count=$8,model_identity=$9,model_identity_digest=$10,completed_at=now()
          WHERE operation_id=$1 AND task_id=$2 AND organization_id=$7 AND state='started' RETURNING operation_id`,
          [input.operationId, taskId, requestDigest(response.message), (response.message.tool_calls ?? []).map(call => call.id), state, requestDigest(state), organizationId, inputCount ?? null, modelIdentity, requestDigest(modelIdentity)]);
      });
      if (!stored.rowCount) throw new Error("Native continuation was not persisted");
    } catch { throw new ModelOperationError("MODEL_CONTINUATION_PERSISTENCE_UNCERTAIN", "uncertain"); }
    if(responseGuardCode)return {message:{role:"assistant",content:null},finishReason:"refusal",usage:response.usage,modelIdentity,
      contextDisposition:"quarantined",guardCode:responseGuardCode,...(response.providerRequestId?{providerRequestId:response.providerRequestId}:{})};
    if(sharedProtocol)for(const chunk of textChunks){try{input.onText?.(chunk);}catch{}}
    return { message: response.message, finishReason: response.finishReason, usage: response.usage, modelIdentity,
      ...(response.providerRequestId ? { providerRequestId: response.providerRequestId } : {}) };
  } catch (caught) {
    // SDKs can wrap callback failures; preserve a known pre-dispatch denial without masking uncertain physical outcomes.
    const error = caught instanceof BoundModelDispatchError && caught.outcome === "rejected" && guardFailure ? guardFailure : caught;
    const mapped = error instanceof ModelOperationError ? error : error instanceof BoundModelDispatchError ?
      new ModelOperationError(error.code, error.outcome, error.status,error.diagnostics) : error instanceof PlatformError ?
      new ModelOperationError(error.code, "rejected", error.statusCode) :
      new ModelOperationError(dispatched ? "MODEL_CONTINUATION_PERSISTENCE_UNCERTAIN" : "MODEL_RUNTIME_UNAVAILABLE", dispatched ? "uncertain" : "rejected");
    if (claimed) {
      try { await input.pool.query(`UPDATE agents_platform.private_model_continuations SET state=$3,input_count=$4,completed_at=now()
        WHERE operation_id=$1 AND task_id=$2 AND state='started'`, [input.operationId, taskId, mapped.outcome, inputCount ? {...inputCount,...(inputRejectedBeforeDispatch && mapped.code === "CONTEXT_LIMIT" && mapped.outcome === "rejected" ? {rejectedBeforeDispatch:true} : {})} : null]); } catch {}
    }
    throw mapped;
  }
}
