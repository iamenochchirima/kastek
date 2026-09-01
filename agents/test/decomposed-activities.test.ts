import { describe, expect, it, vi } from "vitest";
import { createDecomposedActivities, type DecomposedActivityDependencies } from "../src/temporal/decomposed-activities";
import { DECOMPOSED_ACTIVITY_PROTOCOL_VERSION } from "../src/temporal/decomposed-contracts";
import { hashToolArguments, ToolRegistry } from "../src/tools/registry";
import { ModelProviderError, type ModelResponse } from "../src/model/types";
import type { RuntimeRunRecord } from "../src/db/repositories/run-repository";

function run(): RuntimeRunRecord {
  return {
    id: "run-1",
    organization_id: "org-1",
    agent_definition_id: "agent-1",
    agent_version_id: "version-1",
    installation_id: "installation-1",
    conversation_id: null,
    trigger_type: "message",
    status: "running",
    input: { message: "hello" },
    output: null,
    error: null,
    correlation_id: "correlation-1",
    causation_id: null,
    created_by: "actor-1",
    created_at: "2026-09-01T00:00:00.000Z",
    started_at: "2026-09-01T00:00:00.000Z",
    finished_at: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    instructions: "Be helpful.",
    configuration: { provider: "openai", model: "test-model" },
    policy: { allowedTools: ["test.read"] },
    installation_settings: {},
    installation_status: "active",
    resolved_model_provider: "openai",
    resolved_model: "test-model",
  };
}

function response(): ModelResponse {
  return {
    provider: "openai",
    model: "test-model",
    message: { role: "assistant", content: "done" },
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 1,
  };
}

function dependencies(state: Record<string, unknown>): DecomposedActivityDependencies & {
  toolHandler: ReturnType<typeof vi.fn>;
  consumeToolBudget: ReturnType<typeof vi.fn>;
  consumeApproval: ReturnType<typeof vi.fn>;
  stateRecord: { revision: number; state: Record<string, unknown> };
} {
  const currentRun = run();
  const stateRecord = { revision: 3, state: { __decomposedLoop: state } };
  const toolHandler = vi.fn(async () => ({ value: "live" }));
  const consumeToolBudget = vi.fn(async () => undefined);
  const consumeApproval = vi.fn(async () => undefined);
  const tools = new ToolRegistry();
  tools.register({
    name: "test.read",
    version: "1.0.0",
    description: "Test read",
    riskClass: "read",
    requiresApproval: true,
    timeoutMs: 1_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    handler: toolHandler,
  });
  const argumentsHash = hashToolArguments({});
  const workflowState = {
    get: vi.fn(async () => stateRecord),
    put: vi.fn(async ({ state: nextState }: { state: Record<string, unknown> }) => {
      stateRecord.revision += 1;
      stateRecord.state = nextState;
      return { run_id: currentRun.id, organization_id: currentRun.organization_id, state: nextState, revision: stateRecord.revision, updated_at: "2026-09-01T00:00:00.000Z" };
    }),
  };
  const deps = {
    runs: {
      getRuntimeRunById: vi.fn(async () => currentRun),
      completeRun: vi.fn(async () => ({ ...currentRun, status: "completed" as const })),
    },
    modelCalls: { prepare: vi.fn(async () => ({ status: "new" as const })), recordCompleted: vi.fn(async () => undefined), recordFailed: vi.fn(async () => undefined) },
    runBudgets: { ensure: vi.fn(), reserveModelCall: vi.fn(), consumeToolCallWithParallelLease: vi.fn() },
    conversations: {},
    memory: {},
    knowledge: {},
    toolInvocations: {
      getProposal: vi.fn(async () => ({ organizationId: currentRun.organization_id, runId: currentRun.id, providerToolCallId: "call-1", sequenceNumber: 1, toolName: "test.read", toolVersion: "1.0.0", riskClass: "read", argumentsHash, arguments: {}, requiresApproval: true })),
      getCompleted: vi.fn(async () => ({ name: "test.read", version: "1.0.0", argumentsHash, output: { value: "cached" }, latencyMs: 1 })),
      recordCompleted: vi.fn(async () => undefined),
      recordFailed: vi.fn(async () => undefined),
    },
    runSteps: { startStep: vi.fn(async () => ({ id: "step-1" })), finishStep: vi.fn(async () => undefined) },
    toolGrants: { effectiveTools: vi.fn(async () => new Set(["test.read"])) },
    summaries: {},
    killSwitches: { isBlocked: vi.fn(async () => false) },
    controls: { isFeatureEnabled: vi.fn(async () => true), isHeld: vi.fn(async () => false) },
    kasiaiPreferences: {},
    effectReceipts: {},
    approvals: { getForRun: vi.fn(async () => null), consume: consumeApproval, consumeAndStartEffect: vi.fn(), createPending: vi.fn() },
    installationGrants: { effective: vi.fn(async () => ({ resources: [] })), isResourceScopeUnconstrained: vi.fn(async () => true) },
    workflowState,
    gateway: { complete: vi.fn(async () => response()), estimateCost: vi.fn(() => 0) },
    credentials: { resolve: vi.fn(async () => ({ apiKey: "test", fundingSource: "kasitek" as const })) },
    tools,
    modelPricing: {},
    creditPricing: { creditsPerUsd: 1_000, version: "test" },
    creditBillingMode: "disabled" as const,
    heartbeat: vi.fn(),
    signal: () => undefined,
    reserveModelCredits: vi.fn(async () => undefined),
    reserveRunBudget: vi.fn(async () => ({ capture: vi.fn(async () => undefined), release: vi.fn(async () => undefined), markUnknown: vi.fn(async () => undefined) })),
    consumeRunToolBudget: consumeToolBudget,
    buildApprovalResourceSnapshot: vi.fn(async () => ({})),
    toolHandler,
    consumeToolBudget,
    consumeApproval,
    stateRecord,
  } as unknown as DecomposedActivityDependencies & {
    toolHandler: ReturnType<typeof vi.fn>;
    consumeToolBudget: ReturnType<typeof vi.fn>;
    consumeApproval: ReturnType<typeof vi.fn>;
    stateRecord: { revision: number; state: Record<string, unknown> };
  };
  return deps;
}

describe("decomposed Temporal activities", () => {
  it("persists model usage and response before reporting completion", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "model",
      messages: [{ role: "user", content: "hello" }],
      iteration: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      pendingToolCallIds: [],
      completedToolCallIds: [],
      toolStepIds: {},
    });
    const activities = createDecomposedActivities(deps);
    const result = await activities.executeModelStep({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:model",
      inputStateRevision: 3,
    });

    expect(result.status).toBe("completed");
    expect(deps.modelCalls.recordCompleted).toHaveBeenCalledTimes(1);
    expect(deps.stateRecord.state.__decomposedLoop).toEqual(expect.objectContaining({
      phase: "completed",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      lastModelOperationKey: "agent:1:run-1:0:model",
    }));
  });

  it("replays a durable tool outcome before approval, budget, or handler work", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "tool",
      messages: [{ role: "user", content: "hello" }],
      iteration: 1,
      toolCalls: 1,
      pendingToolCallIds: ["call-1"],
      completedToolCallIds: [],
      toolStepIds: { "call-1": "step-1" },
    });
    const activities = createDecomposedActivities(deps);
    const result = await activities.executeToolStep({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:tool:call-1",
      providerToolCallId: "call-1",
    });

    expect(result.status).toBe("completed");
    expect(deps.toolHandler).not.toHaveBeenCalled();
    expect(deps.consumeToolBudget).not.toHaveBeenCalled();
    expect(deps.consumeApproval).not.toHaveBeenCalled();
    expect(deps.stateRecord.state.__decomposedLoop).toEqual(expect.objectContaining({
      phase: "model",
      pendingToolCallIds: [],
      completedToolCallIds: ["call-1"],
    }));
  });

  it("records provider failures and releases the run reservation", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "model",
      messages: [{ role: "user", content: "hello" }],
      iteration: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      pendingToolCallIds: [],
      completedToolCallIds: [],
      toolStepIds: {},
    });
    const providerError = new ModelProviderError("provider unavailable", "PROVIDER_UNAVAILABLE", true, "openai", 503);
    const release = vi.fn(async () => undefined);
    vi.mocked(deps.gateway.complete).mockRejectedValue(providerError);
    vi.mocked(deps.reserveRunBudget).mockResolvedValue({ capture: vi.fn(), release, markUnknown: vi.fn() });
    const activities = createDecomposedActivities(deps);

    await expect(activities.executeModelStep({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:model",
      inputStateRevision: 3,
    })).rejects.toBe(providerError);

    expect(deps.modelCalls.recordFailed).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: "agent:1:run-1:0:model",
      error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" },
    }));
    expect(release).toHaveBeenCalledWith("provider unavailable");
  });

  it("replays the recorded model response after a post-provider database failure", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "model",
      messages: [{ role: "user", content: "hello" }],
      iteration: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      pendingToolCallIds: [],
      completedToolCallIds: [],
      toolStepIds: {},
    });
    vi.mocked(deps.modelCalls.prepare)
      .mockResolvedValueOnce({ status: "new" })
      .mockResolvedValueOnce({ status: "completed", response: response() });
    vi.mocked(deps.runSteps.finishStep)
      .mockRejectedValueOnce(new Error("step write failed"))
      .mockResolvedValue(undefined);
    const activities = createDecomposedActivities(deps);
    const input = {
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:model",
      inputStateRevision: 3,
    } as const;

    await expect(activities.executeModelStep(input)).rejects.toThrow("step write failed");
    const retry = await activities.executeModelStep(input);

    expect(retry.status).toBe("completed");
    expect(deps.gateway.complete).toHaveBeenCalledTimes(1);
    expect(deps.modelCalls.recordCompleted).toHaveBeenCalledTimes(1);
  });

  it("records a tool failure without persisting a successful state", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "tool",
      messages: [{ role: "user", content: "hello" }],
      iteration: 1,
      toolCalls: 1,
      pendingToolCallIds: ["call-1"],
      completedToolCallIds: [],
      toolStepIds: { "call-1": "step-1" },
    });
    vi.mocked(deps.toolInvocations.getCompleted).mockResolvedValue(null);
    deps.toolHandler.mockRejectedValue(new Error("tool backend unavailable"));
    const activities = createDecomposedActivities(deps);

    const result = await activities.executeToolStep({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:tool:call-1",
      providerToolCallId: "call-1",
      approval: {
        approvedBy: "operator",
        argumentsHash: hashToolArguments({}),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: "failed", errorCode: "DECOMPOSED_TOOL_FAILED" }));
    expect(deps.toolInvocations.recordFailed).toHaveBeenCalledWith(expect.objectContaining({
      providerToolCallId: "call-1",
      error: { code: "DECOMPOSED_TOOL_FAILED", message: "tool backend unavailable" },
    }));
    expect(deps.stateRecord.state.__decomposedLoop).toEqual(expect.objectContaining({ phase: "tool", pendingToolCallIds: ["call-1"] }));
  });

  it("fails a checkpoint on a stale revision instead of overwriting newer state", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "model",
      messages: [{ role: "user", content: "hello" }],
      iteration: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      pendingToolCallIds: [],
      completedToolCallIds: [],
      toolStepIds: {},
    });
    const activities = createDecomposedActivities(deps);

    await expect(activities.checkpointLoop({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:checkpoint",
      stateRevision: 2,
      phase: "model",
    })).rejects.toThrow("DECOMPOSED_CHECKPOINT_REVISION_CONFLICT");
    expect(deps.workflowState.put).not.toHaveBeenCalled();
  });

  it("surfaces a context checkpoint write failure", async () => {
    const deps = dependencies({});
    vi.mocked(deps.workflowState.get).mockResolvedValue({ revision: 3, state: {} } as never);
    vi.mocked(deps.workflowState.put).mockRejectedValue(new Error("context checkpoint unavailable"));
    const activities = createDecomposedActivities(deps);

    await expect(activities.buildLoopContext({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
    })).rejects.toThrow("context checkpoint unavailable");
  });

  it("fails closed on an invalid persisted loop state instead of restarting the run", async () => {
    const deps = dependencies({});
    vi.mocked(deps.workflowState.get).mockResolvedValue({ revision: 3, state: { __decomposedLoop: { version: 1, phase: "corrupted" } } } as never);
    const activities = createDecomposedActivities(deps);

    await expect(activities.buildLoopContext({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
    })).rejects.toThrow("DECOMPOSED_LOOP_STATE_INVALID");
    expect(deps.workflowState.put).not.toHaveBeenCalled();
  });

  it("does not claim completion when the terminal run write fails", async () => {
    const deps = dependencies({
      version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      phase: "completed",
      messages: [{ role: "user", content: "hello" }],
      iteration: 1,
      toolCalls: 0,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      pendingToolCallIds: [],
      completedToolCallIds: [],
      toolStepIds: {},
      completion: { response: response(), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 }, iterations: 1, toolCalls: 0 },
    });
    vi.mocked(deps.runs.completeRun).mockRejectedValue(new Error("terminal run write failed"));
    const activities = createDecomposedActivities(deps);

    await expect(activities.completeRunFromCheckpoint({
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      stateRevision: 3,
    })).rejects.toThrow("terminal run write failed");
  });
});
