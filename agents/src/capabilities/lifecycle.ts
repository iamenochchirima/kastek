import { hashToolArguments } from "../tools/registry";
import type { ToolInvocationLifecycle, ToolInvocationRequest } from "../tools/types";

type ToolInvocationStore = Pick<
  import("../db/repositories/tool-invocation-repository").ToolInvocationRepository,
  "recordProposal" | "getCompleted" | "recordCompleted" | "recordFailed"
>;

function operationId(request: ToolInvocationRequest): string {
  const value = request.operationId?.trim() || request.context.correlationId.trim();
  if (!value) throw new Error("CAPABILITY_OPERATION_ID_REQUIRED");
  return value;
}

/**
 * Durable tool-invocation evidence for the shared capability seam.
 *
 * The runtime calls this adapter for every admitted invocation. Keeping the
 * repository behind this small interface lets Temporal, immediate reads, and
 * graph nodes use the same proposal/replay/completion/failure contract.
 */
export function createToolInvocationLifecycle(input: {
  toolInvocations: ToolInvocationStore;
}): ToolInvocationLifecycle {
  return {
    propose: async ({ request, manifest }) => {
      await input.toolInvocations.recordProposal({
        organizationId: request.context.organizationId,
        runId: request.context.runId,
        providerToolCallId: operationId(request),
        sequenceNumber: request.sequenceNumber ?? 1,
        toolName: request.name,
        toolVersion: manifest.version,
        riskClass: manifest.riskClass,
        argumentsHash: hashToolArguments(request.arguments),
        arguments: request.arguments,
        requiresApproval: manifest.requiresApproval,
      });
    },
    prepare: async ({ request }) => {
      const result = await input.toolInvocations.getCompleted({
        organizationId: request.context.organizationId,
        runId: request.context.runId,
        providerToolCallId: operationId(request),
        toolName: request.name,
        argumentsHash: hashToolArguments(request.arguments),
      });
      return result ? { status: "completed" as const, result } : { status: "new" as const };
    },
    complete: async ({ request, result, redactedOutput }) => {
      await input.toolInvocations.recordCompleted({
        runId: request.context.runId,
        providerToolCallId: operationId(request),
        output: redactedOutput,
        latencyMs: result.latencyMs,
        effectId: result.effectId,
      });
    },
    fail: async ({ request, error }) => {
      await input.toolInvocations.recordFailed({
        runId: request.context.runId,
        providerToolCallId: operationId(request),
        error,
      });
    },
  };
}
