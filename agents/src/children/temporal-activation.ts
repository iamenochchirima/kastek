import type { ChildExecutionBudget, ChildProgressEvidence } from "./execution-kernel";
import type { ChildInvocationRequest, ChildInvocationScope } from "./contracts";

export type { ChildProgressEvidence } from "./execution-kernel";

/**
 * Temporal child activation is deliberately an adapter boundary. Workflow code
 * only schedules this contract; provider/model execution belongs in an activity.
 */
export interface ChildActivationRequest {
  request: ChildInvocationRequest;
  budget?: Partial<ChildExecutionBudget>;
  timeoutMs?: number;
  retryPolicy?: Partial<ChildRetryPolicy>;
}

export interface ChildRetryPolicy {
  maximumAttempts: number;
  initialIntervalMs: number;
  maximumIntervalMs: number;
  backoffCoefficient: number;
  retryableCodes: string[];
}

export const DEFAULT_CHILD_RETRY_POLICY: ChildRetryPolicy = {
  maximumAttempts: 2,
  initialIntervalMs: 500,
  maximumIntervalMs: 10_000,
  backoffCoefficient: 2,
  retryableCodes: [
    "CHILD_RETRYABLE",
    "DATABASE_UNAVAILABLE",
    "MODEL_TIMEOUT",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "TOOL_TIMEOUT",
    "WORKFLOW_ACTIVITY_FAILED",
  ],
};

export function normalizeChildRetryPolicy(input?: Partial<ChildRetryPolicy>): ChildRetryPolicy {
  const maximumAttemptsInput = input?.maximumAttempts;
  const initialIntervalInput = input?.initialIntervalMs;
  const maximumIntervalInput = input?.maximumIntervalMs;
  const backoffCoefficientInput = input?.backoffCoefficient;
  const retryableCodesInput = input?.retryableCodes;
  const maximumAttempts = isSafeInteger(maximumAttemptsInput)
    ? Math.min(Math.max(maximumAttemptsInput, 1), 3)
    : DEFAULT_CHILD_RETRY_POLICY.maximumAttempts;
  const initialIntervalMs = isFiniteNumber(initialIntervalInput)
    ? Math.min(Math.max(Math.trunc(initialIntervalInput), 100), 60_000)
    : DEFAULT_CHILD_RETRY_POLICY.initialIntervalMs;
  const maximumIntervalMs = isFiniteNumber(maximumIntervalInput)
    ? Math.min(Math.max(Math.trunc(maximumIntervalInput), initialIntervalMs), 120_000)
    : DEFAULT_CHILD_RETRY_POLICY.maximumIntervalMs;
  const backoffCoefficient = isFiniteNumber(backoffCoefficientInput)
    ? Math.min(Math.max(backoffCoefficientInput, 1), 4)
    : DEFAULT_CHILD_RETRY_POLICY.backoffCoefficient;
  const retryableCodes = Array.isArray(retryableCodesInput)
    ? [...new Set(retryableCodesInput.filter((code): code is string => typeof code === "string" && code.trim().length > 0).map((code) => code.trim()).slice(0, 32))]
    : [...DEFAULT_CHILD_RETRY_POLICY.retryableCodes];
  return { maximumAttempts, initialIntervalMs, maximumIntervalMs, backoffCoefficient, retryableCodes };
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function childRetryDelayMs(policy: ChildRetryPolicy, retryNumber: number): number {
  const exponent = Math.max(0, Math.trunc(retryNumber) - 1);
  return Math.min(policy.maximumIntervalMs, Math.round(policy.initialIntervalMs * policy.backoffCoefficient ** exponent));
}

export function childWorkflowId(invocationId: string): string {
  return `agent-child-${invocationId}`;
}

export interface TemporalChildWorkflowInput {
  scope: ChildInvocationScope;
  input: unknown;
  operationId: string;
  /** The normal durable run created for a platform child activation. */
  childRunId?: string;
  budget: ChildExecutionBudget;
  timeoutMs: number;
  retryPolicy: ChildRetryPolicy;
}

export interface ChildActivityExecutionInput {
  scope: ChildInvocationScope;
  input: unknown;
  operationId: string;
  budget: ChildExecutionBudget;
  attempt: number;
  timeoutMs: number;
}

export type ChildActivityOutcome<TOutput = unknown> = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "partial";
  output?: TOutput;
  partialOutput?: unknown;
  error?: { code: string; message: string };
  retryable?: boolean;
  progress?: readonly ChildProgressEvidence[];
  usage?: Partial<ChildExecutionBudget>;
};

export interface ChildLineageEvidence {
  operationId: string;
  invocationId: string;
  parentRunId: string;
  parentCorrelationId: string;
  childAgentDefinitionId: string;
  childAgentVersionId: string;
  childWorkflowId: string;
  childWorkflowRunId?: string;
  attempts: number;
}

export type TemporalChildWorkflowOutcome<TOutput = unknown> = ChildActivityOutcome<TOutput> & {
  lineage: ChildLineageEvidence;
};

export interface ChildWorkflowActivities {
  executeChild(input: ChildActivityExecutionInput): Promise<ChildActivityOutcome>;
  /** Read the terminal result after a nested agentRunWorkflow completes. */
  getChildRunOutcome?(input: {
    scope: ChildInvocationScope;
    childRunId: string;
  }): Promise<ChildActivityOutcome>;
  recordChildProgress(input: {
    scope: ChildInvocationScope;
    operationId: string;
    evidence: ChildProgressEvidence;
  }): Promise<void>;
  recordChildOutcome(input: {
    scope: ChildInvocationScope;
    operationId: string;
    outcome: TemporalChildWorkflowOutcome;
  }): Promise<void>;
}

export interface ChildAdmissionActivities {
  admitChildInvocation(input: {
    parentRunId: string;
    activation: ChildActivationRequest;
  }): Promise<ChildAdmissionResult>;
  recordChildOutcome(input: {
    scope: ChildInvocationScope;
    operationId: string;
    outcome: TemporalChildWorkflowOutcome;
  }): Promise<void>;
}

export type ChildAdmissionResult =
  | { status: "admitted"; workflowInput: TemporalChildWorkflowInput }
  | { status: "rejected"; error: { code: string; message: string } };

export type ChildWorkflowExecutor = (input: ChildActivityExecutionInput & { signal: AbortSignal }) => Promise<ChildActivityOutcome>;

export function childOperationId(scope: ChildInvocationScope): string {
  return `${scope.parentRunId}:child:${scope.invocationId}`;
}

export function defaultChildBudget(): ChildExecutionBudget {
  return {
    contextTokens: 8_000,
    modelTokens: 32_000,
    toolCalls: 16,
    graphSteps: 2_000,
    wallTimeMs: 60_000,
  };
}

export function normalizeChildBudget(input?: Partial<ChildExecutionBudget>): ChildExecutionBudget {
  const defaults = defaultChildBudget();
  return {
    contextTokens: boundedInteger(input?.contextTokens, defaults.contextTokens, 0, 64_000),
    modelTokens: boundedInteger(input?.modelTokens, defaults.modelTokens, 1, 128_000),
    toolCalls: boundedInteger(input?.toolCalls, defaults.toolCalls, 0, 256),
    graphSteps: boundedInteger(input?.graphSteps, defaults.graphSteps, 0, 10_000),
    wallTimeMs: boundedInteger(input?.wallTimeMs, defaults.wallTimeMs, 1, 3_600_000),
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value!), minimum), maximum) : fallback;
}

export function childFailureIsRetryable(outcome: Pick<ChildActivityOutcome, "error" | "retryable">, policy: ChildRetryPolicy): boolean {
  if (outcome.retryable !== undefined) return outcome.retryable;
  return Boolean(outcome.error?.code && policy.retryableCodes.includes(outcome.error.code));
}

export function childErrorFrom(error: unknown, fallbackCode = "CHILD_WORKFLOW_FAILED"): { code: string; message: string } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" && candidate.code.trim()
      ? candidate.code.trim()
      : typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : fallbackCode;
    const message = typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message.trim().slice(0, 2_000)
      : fallbackCode;
    return { code, message };
  }
  return { code: fallbackCode, message: String(error ?? fallbackCode).slice(0, 2_000) };
}
