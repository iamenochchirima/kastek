import { describe, expect, it, vi } from "vitest";
import { runDecomposedCoordinator } from "../src/temporal/decomposed-coordinator";
import { DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, type DecomposedAgentRunActivities } from "../src/temporal/decomposed-contracts";

function activities(overrides: Partial<DecomposedAgentRunActivities> = {}): DecomposedAgentRunActivities {
  return {
    buildLoopContext: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 1, nextPhase: "model" as const })),
    executeModelStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "completed" as const })),
    executeToolStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, providerToolCallId: "call-1", status: "completed" as const })),
    checkpointLoop: vi.fn(async ({ stateRevision }) => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision })),
    completeRunFromCheckpoint: vi.fn(async ({ stateRevision }) => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision })),
    ...overrides,
  };
}

describe("decomposed Temporal coordinator", () => {
  it("keeps model completion and checkpoint/terminal sequencing in the workflow layer", async () => {
    const phaseActivities = activities();
    const result = await runDecomposedCoordinator({
      runId: "run-1",
      organizationId: "org-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent: vi.fn(),
    });

    expect(result).toEqual({ status: "completed", steps: 1 });
    expect(phaseActivities.executeModelStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      step: 0,
      operationKey: "agent:1:run-1:0:model",
      inputStateRevision: 1,
    }));
    expect(phaseActivities.checkpointLoop).toHaveBeenCalledTimes(2);
    expect(phaseActivities.completeRunFromCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", stateRevision: 2 }));
  });

  it("executes durable tool IDs, waits for approval, and resumes the same operation", async () => {
    let toolCalls = 0;
    const phaseActivities = activities({
      executeModelStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "tool_calls" as const, toolCallIds: ["call-1"] })),
      executeToolStep: vi.fn(async ({ approval }) => {
        toolCalls += 1;
        return {
          protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
          stateRevision: 2 + toolCalls,
          providerToolCallId: "call-1",
          status: approval ? "completed" as const : "awaiting_approval" as const,
        };
      }),
    });
    const waitForApproval = vi.fn(async () => ({
      providerToolCallId: "call-1",
      decision: {
        decision: "approved" as const,
        approvedBy: "operator",
        argumentsHash: "hash",
        providerToolCallId: "call-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }));
    const result = await runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval,
      waitForExternalEvent: vi.fn(),
      maxSteps: 1,
    });

    expect(result).toEqual({ status: "limited", steps: 1, errorCode: "DECOMPOSED_STEP_LIMIT" });
    expect(waitForApproval).toHaveBeenCalledWith("call-1");
    expect(phaseActivities.executeToolStep).toHaveBeenCalledTimes(2);
    expect(phaseActivities.executeToolStep).toHaveBeenLastCalledWith(expect.objectContaining({
      providerToolCallId: "call-1",
      operationKey: "agent:1:run-1:0:tool:call-1",
      approval: expect.objectContaining({ approvedBy: "operator" }),
    }));
  });

  it("completes when a tool provides the terminal agent response", async () => {
    const phaseActivities = activities({
      executeModelStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "tool_calls" as const, toolCallIds: ["call-1"] })),
      executeToolStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 3, providerToolCallId: "call-1", status: "completed" as const, terminal: true })),
    });
    const result = await runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent: vi.fn(),
      maxSteps: 1,
    });

    expect(result).toEqual({ status: "completed", steps: 1 });
    expect(phaseActivities.completeRunFromCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ stateRevision: 3 }));
  });

  it("pauses for a human tool outcome and resumes the model with the external event", async () => {
    let modelCalls = 0;
    const phaseActivities = activities({
      executeModelStep: vi.fn(async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "tool_calls" as const, toolCallIds: ["call-1"] }
          : { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 4, status: "completed" as const };
      }),
      executeToolStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 3, providerToolCallId: "call-1", status: "awaiting_human" as const, waitingFor: "handoff-1" })),
    });
    const waitForExternalEvent = vi.fn(async (waitingFor: string, status?: "awaiting_human" | "awaiting_external_event") => ({
      event: { key: `${waitingFor}:${status ?? "external"}`, payload: { answer: "approved" } },
    }));

    const result = await runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent,
      maxSteps: 2,
    });

    expect(result).toEqual({ status: "completed", steps: 2 });
    expect(waitForExternalEvent).toHaveBeenCalledWith("handoff-1", "awaiting_human");
    expect(phaseActivities.executeModelStep).toHaveBeenLastCalledWith(expect.objectContaining({
      step: 1,
      operationKey: "agent:1:run-1:1:model",
      resumeExternalEvent: expect.objectContaining({ key: "handoff-1:awaiting_human" }),
    }));
  });

  it("resumes a model-owned external wait instead of failing the decomposed run", async () => {
    let modelCalls = 0;
    const phaseActivities = activities({
      executeModelStep: vi.fn(async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "awaiting_external_event" as const, waitingFor: "provider-callback" }
          : { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 3, status: "completed" as const };
      }),
    });
    const waitForExternalEvent = vi.fn(async () => ({ event: { key: "provider-callback", payload: { receipt: "ok" } } }));

    await expect(runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent,
      maxSteps: 2,
    })).resolves.toEqual({ status: "completed", steps: 2 });
    expect(waitForExternalEvent).toHaveBeenCalledWith("provider-callback", "awaiting_external_event");
    expect(phaseActivities.executeModelStep).toHaveBeenLastCalledWith(expect.objectContaining({
      step: 1,
      resumeExternalEvent: { key: "provider-callback", payload: { receipt: "ok" } },
    }));
  });

  it("fails closed when an activity returns a terminal failure", async () => {
    const phaseActivities = activities({
      executeModelStep: vi.fn(async () => ({ protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: 2, status: "failed" as const, errorCode: "MODEL_CALL_OUTCOME_UNKNOWN" })),
    });
    await expect(runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent: vi.fn(),
    })).resolves.toEqual({ status: "failed", steps: 1, errorCode: "MODEL_CALL_OUTCOME_UNKNOWN" });
    expect(phaseActivities.completeRunFromCheckpoint).not.toHaveBeenCalled();
  });

  it("resumes pending tools from the persisted logical step", async () => {
    const phaseActivities = activities({
      buildLoopContext: vi.fn(async () => ({
        protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
        stateRevision: 7,
        nextPhase: "tool" as const,
        nextStep: 1,
        pendingToolCallIds: ["call-1"],
      })),
    });
    const result = await runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent: vi.fn(),
      maxSteps: 2,
    });

    expect(result).toEqual({ status: "completed", steps: 2 });
    expect(phaseActivities.executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      step: 0,
      operationKey: "agent:1:run-1:0:tool:call-1",
      providerToolCallId: "call-1",
    }));
    expect(phaseActivities.executeModelStep).toHaveBeenCalledWith(expect.objectContaining({
      step: 1,
      operationKey: "agent:1:run-1:1:model",
    }));
  });

  it("stops before a completed model can publish after cancellation", async () => {
    let checks = 0;
    const phaseActivities = activities();
    const result = await runDecomposedCoordinator({
      runId: "run-1",
      activities: phaseActivities,
      waitForApproval: vi.fn(),
      waitForExternalEvent: vi.fn(),
      shouldStop: () => checks++ >= 2 ? "cancelled" : undefined,
    });
    expect(result).toEqual({ status: "cancelled", steps: 1 });
    expect(phaseActivities.completeRunFromCheckpoint).not.toHaveBeenCalled();
  });
});
