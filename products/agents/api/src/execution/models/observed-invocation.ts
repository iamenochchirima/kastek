import { recordEvent } from "../../observability/event-store";
import { performance } from "node:perf_hooks";
import { modelFailureDiagnosticsSchema,modelIdentitySchema } from "../../contracts/model-transport";
import { requestDigest } from "../../contracts/contracts";
import { emitModelInvocation, modelTraceId, type ModelInvocationEvent } from "../../observability/model-telemetry";
import { quoteNormalizedUsage } from "./accounting";
import { invokeTaskModel, type TaskModelInvocation, type TaskModelResponse, type ModelRuntimeDependencies } from "./runtime";
import { ModelOperationError } from "../business/model";

function failure(error: unknown): Pick<ModelInvocationEvent, "outcome" | "failureClass"|"failureCode"|"httpStatus"|"failureStage"|"requestDispatched"|"streamErrorKind"|"providerErrorCode"> {
  const value = error && typeof error === "object" ? error as { code?: unknown; outcome?: unknown; status?: unknown; statusCode?: unknown; name?: unknown;diagnostics?:unknown } : {};
  const status = value.status ?? value.statusCode;
  const code = typeof value.code === "string" ? value.code : "";
  const uncertain = value.outcome === "uncertain";
  const cancelled = value.name === "AbortError" || code.includes("CANCEL");
  let failureClass: ModelInvocationEvent["failureClass"] = "internal";
  if (cancelled) failureClass = "cancelled";
  else if (status === 401 || status === 403 || /AUTHORITY|CREDENTIAL|USE_FORBIDDEN|REVOK/.test(code)) failureClass = "authorization";
  else if (status === 402) failureClass = "credit";
  else if (status === 429) failureClass = "rate_limit";
  else if (status === 404) failureClass = "model_access";
  else if (/QUOTA|BUDGET|TOKEN_LIMIT|COST_LIMIT|TIME_BOUND/.test(code)) failureClass = "quota";
  else if (/CONTEXT|INPUT_LIMIT|REQUEST_LIMIT/.test(code)) failureClass = "context";
  else if (/TIMEOUT|DEADLINE/.test(code)) failureClass = "timeout";
  else if (typeof status === "number" && status >= 400) failureClass = "provider";
  const diagnostics=modelFailureDiagnosticsSchema.safeParse(error instanceof ModelOperationError?value.diagnostics:undefined);
  return { outcome: uncertain ? "uncertain" : cancelled ? "cancelled" : "rejected", failureClass,
    ...(error instanceof ModelOperationError&&/^[A-Z][A-Z0-9_]{0,99}$/.test(code)?{failureCode:code}:{}),
    ...(diagnostics.success?{...(diagnostics.data.httpStatus===undefined?{}:{httpStatus:diagnostics.data.httpStatus}),failureStage:diagnostics.data.stage,requestDispatched:diagnostics.data.dispatched,
      ...(diagnostics.data.streamErrorKind===undefined?{}:{streamErrorKind:diagnostics.data.streamErrorKind}),
      ...(diagnostics.data.providerErrorCode===undefined?{}:{providerErrorCode:diagnostics.data.providerErrorCode})}:{}),
  };
}
/** Wrap the physical invocation inside its existing durable operation. Export failures cannot cause a retry. */
export async function invokeObservedTaskModel(input: TaskModelInvocation, dependencies?: ModelRuntimeDependencies): Promise<TaskModelResponse> {
  const started = performance.now();
  let firstVisibleTokenMs: number | undefined, response: TaskModelResponse | undefined, error: unknown;
  try {
    response = await invokeTaskModel({ ...input, onText: delta => {
      if (delta.length && firstVisibleTokenMs === undefined) firstVisibleTokenMs = Math.max(0, performance.now() - started);
      input.onText?.(delta);
    } }, dependencies);
    return response;
  } catch (caught) { error = caught; throw caught; }
  finally {
    try {
      const route = input.execution.models[input.role], binding = route.binding, task = input.execution.task;
      const usage = response?.usage.observed === true ? response.usage : undefined;
      const identity = modelIdentitySchema.safeParse(response?.modelIdentity ?? {requestedModelId:binding.modelId,returnedModelId:null,relation:"unreported"});
      const valid = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
      const quote = quoteNormalizedUsage(usage ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cachedInputTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null } : null, route.model.pricing);
      const failed=response?undefined:failure(error);
      try {
        void recordEvent(input.pool, task.id, `model-observed:${input.operationId}`, "model.observed", {
          operationId: input.operationId, role: input.role, durationMs: Math.max(0, performance.now() - started),
          ...(firstVisibleTokenMs === undefined ? {} : { firstTokenMs: firstVisibleTokenMs }),
          ...(valid(usage?.outputTokens) === undefined ? {} : { outputTokens: valid(usage?.outputTokens) }),
          ...failed,
        }).catch(() => { /* Runtime reporting cannot change a physical model outcome. */ });
      } catch { /* Runtime reporting cannot change a physical model outcome. */ }
      emitModelInvocation({ event: "model.invocation", traceId: modelTraceId(task.root_task_id),
        organizationId: task.organization_id, rootTaskId: task.root_task_id, taskId: task.id, operationId: input.operationId,
        connectionId: binding.connectionId, providerId: binding.providerId, protocol: binding.protocol, modelId: binding.modelId,
        ...(identity.success ? {modelIdentityRelation:identity.data.relation,...(identity.data.returnedModelId===null?{}:{returnedModelId:identity.data.returnedModelId})}:{}),
        role: binding.role, routeDigest: requestDigest(binding), policyDigest: route.policy.digest,
        adapterRevision: binding.adapterRevision, runtimeRelease: task.harness_release,
        ...(response ? { outcome: response.finishReason === "stop" ? "completed" : response.finishReason === "length" ? "truncated" : response.finishReason === "refusal" ? "refused" : "tool_calls" } as const : failed!),
        durationMs: Math.max(0, performance.now() - started), firstVisibleTokenStatus: firstVisibleTokenMs === undefined ? "unavailable" : "observed",
        ...(firstVisibleTokenMs === undefined ? {} : { firstVisibleTokenMs }), queueStatus: "unavailable",
        usageStatus: usage ? "observed" : "unavailable",
        inputTokens: valid(usage?.inputTokens), outputTokens: valid(usage?.outputTokens), cacheReadTokens: valid(usage?.cachedInputTokens),
        cacheWriteTokens: valid(usage?.cacheWriteTokens), reasoningTokens: valid(usage?.reasoningTokens),
        costStatus: quote.status === "known" ? "estimate" : "unavailable", ...(quote.status === "known" ? { costEstimateMicros: quote.costMicros.toString() } : {}),
      });
    } catch { /* Observation failures cannot change a settled physical outcome. */ }
  }
}
