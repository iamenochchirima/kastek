import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  childFailureIsRetryable,
  childRetryDelayMs,
  childWorkflowId,
  DEFAULT_CHILD_RETRY_POLICY,
  normalizeChildBudget,
  normalizeChildRetryPolicy,
} from "../src/children/temporal-activation";
import { createChildWorkflowActivities } from "../src/children/temporal-activities";

describe("Temporal child activation contracts", () => {
  it("normalizes retry policy and budget to bounded values", () => {
    const retryPolicy = normalizeChildRetryPolicy({
      maximumAttempts: 99,
      initialIntervalMs: 1,
      maximumIntervalMs: 2,
      backoffCoefficient: 99,
      retryableCodes: [" PROVIDER_UNAVAILABLE ", "PROVIDER_UNAVAILABLE", ""],
    });
    expect(retryPolicy).toEqual({
      maximumAttempts: 3,
      initialIntervalMs: 100,
      maximumIntervalMs: 100,
      backoffCoefficient: 4,
      retryableCodes: ["PROVIDER_UNAVAILABLE"],
    });
    expect(normalizeChildBudget({ modelTokens: -1, wallTimeMs: 99_999_999 })).toMatchObject({
      contextTokens: 8_000,
      modelTokens: 1,
      wallTimeMs: 3_600_000,
    });
    expect(childRetryDelayMs(DEFAULT_CHILD_RETRY_POLICY, 1)).toBe(500);
    expect(childRetryDelayMs(DEFAULT_CHILD_RETRY_POLICY, 20)).toBe(10_000);
  });

  it("classifies only bounded retryable outcomes for another attempt", () => {
    const policy = normalizeChildRetryPolicy({ retryableCodes: ["PROVIDER_UNAVAILABLE"] });
    expect(childFailureIsRetryable({ error: { code: "PROVIDER_UNAVAILABLE", message: "busy" } }, policy)).toBe(true);
    expect(childFailureIsRetryable({ error: { code: "CHILD_TIMEOUT", message: "slow" } }, policy)).toBe(false);
    expect(childFailureIsRetryable({ retryable: false, error: { code: "PROVIDER_UNAVAILABLE", message: "no" } }, policy)).toBe(false);
  });

  it("keeps child workflow identity stable and uses an explicit activity adapter", async () => {
    const executorCalls: number[] = [];
    const activities = createChildWorkflowActivities({} as Pool, {
      executor: async (input) => {
        executorCalls.push(input.attempt);
        return { status: "succeeded", output: { answer: 42 } };
      },
    });
    const result = await activities.executeChild({
      scope: {
        invocationId: "invocation-1",
        parentRunId: "parent-run",
        organizationId: "org",
        installationId: "installation",
        correlationId: "correlation",
        causationId: "parent-run",
        childAgentDefinitionId: "child",
        childAgentVersionId: "v1",
        capabilityGrants: [],
        resourceGrants: [],
      },
      input: { task: "answer" },
      operationId: "parent-run:child:invocation-1",
      budget: { contextTokens: 100, modelTokens: 100, toolCalls: 1, graphSteps: 1, wallTimeMs: 1_000 },
      attempt: 1,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ status: "succeeded", output: { answer: 42 } });
    expect(executorCalls).toEqual([1]);
    expect(childWorkflowId("invocation-1")).toBe("agent-child-invocation-1");
  });

  it("fails closed when the worker has no child execution adapter", async () => {
    const activities = createChildWorkflowActivities({} as Pool);
    await expect(activities.executeChild({
      scope: {
        invocationId: "invocation-2",
        parentRunId: "parent-run",
        organizationId: "org",
        installationId: "installation",
        correlationId: "correlation",
        causationId: "parent-run",
        childAgentDefinitionId: "child",
        childAgentVersionId: "v1",
        capabilityGrants: [],
        resourceGrants: [],
      },
      input: {},
      operationId: "parent-run:child:invocation-2",
      budget: { contextTokens: 100, modelTokens: 100, toolCalls: 1, graphSteps: 1, wallTimeMs: 1_000 },
      attempt: 1,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ status: "failed", error: { code: "CHILD_EXECUTOR_NOT_CONFIGURED" }, retryable: false });
  });
});
