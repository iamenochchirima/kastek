import {
  childInvocationRequestSchema,
  createChildInvocationScope,
  type ChildInvocationRequest,
  type ChildInvocationScope,
} from "./contracts";
import type { ExecutionScope } from "../runtime/execution-scope";
import { z } from "zod";

const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().min(1);

export interface ChildExecutionBudget {
  contextTokens: number;
  modelTokens: number;
  toolCalls: number;
  graphSteps: number;
  wallTimeMs: number;
}

const childExecutionBudgetSchema = z.object({
  contextTokens: nonNegativeInteger,
  modelTokens: nonNegativeInteger,
  toolCalls: nonNegativeInteger,
  graphSteps: nonNegativeInteger,
  wallTimeMs: positiveInteger,
}).strict();

export const childExecutionPolicySchema = z.object({
  /** Root context is depth zero. A max depth of four allows four child levels. */
  maxDepth: nonNegativeInteger.max(32).default(4),
  /** Maximum number of direct children admitted by one execution context. */
  maxFanOut: positiveInteger.max(256).default(8),
  /** Maximum number of direct children running at the same time. */
  maxConcurrentChildren: positiveInteger.max(64).default(4),
  budget: childExecutionBudgetSchema.default({
    contextTokens: 8_000,
    modelTokens: 32_000,
    toolCalls: 16,
    graphSteps: 2_000,
    wallTimeMs: 60_000,
  }),
  defaultTimeoutMs: positiveInteger.max(3_600_000).default(60_000),
  allowPartialResults: z.boolean().default(true),
}).strict();

export type ChildExecutionPolicy = z.infer<typeof childExecutionPolicySchema>;
export type ChildExecutionPolicyIssue = { path: string; message: string };
export type ChildExecutionPolicyValidation =
  | { ok: true; policy: ChildExecutionPolicy }
  | { ok: false; issues: ChildExecutionPolicyIssue[] };

/** Parse policy at a host boundary so malformed limits never reach a child run. */
export function validateChildExecutionPolicy(input: unknown): ChildExecutionPolicyValidation {
  const result = childExecutionPolicySchema.safeParse(input);
  if (result.success) return { ok: true, policy: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "policy",
      message: issue.message,
    })),
  };
}

export function parseChildExecutionPolicy(input: unknown = {}): ChildExecutionPolicy {
  return childExecutionPolicySchema.parse(input);
}

export type ChildExecutionRejectionCode =
  | "CHILD_POLICY_INVALID"
  | "CHILD_CONTEXT_POLICY_MISMATCH"
  | "CHILD_MAX_DEPTH_EXCEEDED"
  | "CHILD_MAX_FAN_OUT_EXCEEDED"
  | "CHILD_MAX_CONCURRENCY_EXCEEDED"
  | "CHILD_BUDGET_EXHAUSTED"
  | "CHILD_BUDGET_INVALID"
  | "CHILD_AUTHORITY_EXPANSION"
  | "CHILD_REQUEST_INVALID"
  | "CHILD_PARENT_CANCELLED";

export interface ChildExecutionError {
  code: string;
  message: string;
}

export interface ChildBudgetEvidence {
  requested: ChildExecutionBudget;
  granted: ChildExecutionBudget;
  used: ChildExecutionBudget;
  parentRemaining: ChildExecutionBudget;
}

export type ChildProgressPhase =
  | "admitted"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "rejected";

/** A journal-ready, parent/child link for one observable execution event. */
export interface ChildProgressEvidence {
  sequence: number;
  phase: ChildProgressPhase;
  invocationId?: string;
  parentRunId: string;
  childAgentDefinitionId?: string;
  childAgentVersionId?: string;
  depth: number;
  occurredAt: string;
  progress?: number;
  message?: string;
  hasPartialResult: boolean;
}

export type ChildProgressSink = (evidence: ChildProgressEvidence) => void | Promise<void>;

export interface ChildProgressUpdate {
  progress?: number;
  message?: string;
  partialOutput?: unknown;
}

export interface ChildProgressReporter {
  report(update: ChildProgressUpdate): void;
  partialOutput(): unknown;
  evidence(): readonly ChildProgressEvidence[];
}

export interface ChildExecutionResponse<TOutput> {
  output?: TOutput;
  partialOutput?: unknown;
  usage?: Partial<ChildExecutionBudget>;
}

export interface ChildExecutionInput {
  scope: ChildInvocationScope;
  input: unknown;
  context: ChildExecutionContext;
  budget: Readonly<ChildExecutionBudget>;
  signal: AbortSignal;
  progress: ChildProgressReporter;
}

export interface BoundedChildExecutor<TOutput = unknown> {
  execute(input: ChildExecutionInput): Promise<ChildExecutionResponse<TOutput>>;
}

export type ChildExecutionStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "partial";

export interface BoundedChildExecutionResult<TOutput = unknown> {
  invocationId?: string;
  status: ChildExecutionStatus;
  scope?: ChildInvocationScope;
  output?: TOutput;
  partialOutput?: unknown;
  termination?: "cancelled" | "timed_out";
  error?: ChildExecutionError;
  budget?: ChildBudgetEvidence;
  progress: readonly ChildProgressEvidence[];
}

export interface ChildFanOutItem {
  input: unknown;
  options?: ChildExecutionOptions;
}

export interface ChildFanOutResult<TOutput = unknown> {
  status: "completed" | "partial" | "rejected";
  results: readonly BoundedChildExecutionResult<TOutput>[];
  error?: ChildExecutionError;
}

export interface ChildExecutionOptions {
  requestedBudget?: Partial<ChildExecutionBudget>;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowPartialResult?: boolean;
  onProgress?: ChildProgressSink;
}

type InternalBudget = ChildExecutionBudget;

function cloneBudget(budget: ChildExecutionBudget): ChildExecutionBudget {
  return { ...budget };
}

function minBudget(left: ChildExecutionBudget, right: ChildExecutionBudget): ChildExecutionBudget {
  return {
    contextTokens: Math.min(left.contextTokens, right.contextTokens),
    modelTokens: Math.min(left.modelTokens, right.modelTokens),
    toolCalls: Math.min(left.toolCalls, right.toolCalls),
    graphSteps: Math.min(left.graphSteps, right.graphSteps),
    wallTimeMs: Math.min(left.wallTimeMs, right.wallTimeMs),
  };
}

function addBudget(left: InternalBudget, right: ChildExecutionBudget): void {
  left.contextTokens += right.contextTokens;
  left.modelTokens += right.modelTokens;
  left.toolCalls += right.toolCalls;
  left.graphSteps += right.graphSteps;
  left.wallTimeMs += right.wallTimeMs;
}

function subtractBudget(left: InternalBudget, right: ChildExecutionBudget): void {
  left.contextTokens -= right.contextTokens;
  left.modelTokens -= right.modelTokens;
  left.toolCalls -= right.toolCalls;
  left.graphSteps -= right.graphSteps;
  left.wallTimeMs -= right.wallTimeMs;
}

function zeroBudget(): ChildExecutionBudget {
  return { contextTokens: 0, modelTokens: 0, toolCalls: 0, graphSteps: 0, wallTimeMs: 0 };
}

function divideBudget(budget: ChildExecutionBudget, divisor: number): ChildExecutionBudget {
  return {
    contextTokens: Math.floor(budget.contextTokens / divisor),
    modelTokens: Math.floor(budget.modelTokens / divisor),
    toolCalls: Math.floor(budget.toolCalls / divisor),
    graphSteps: Math.floor(budget.graphSteps / divisor),
    wallTimeMs: Math.max(1, Math.floor(budget.wallTimeMs / divisor)),
  };
}

function normalizeUsage(usage: Partial<ChildExecutionBudget> | undefined, elapsedMs: number, granted: ChildExecutionBudget): ChildExecutionBudget {
  const value = usage ?? {};
  return {
    contextTokens: Math.max(0, Math.floor(value.contextTokens ?? granted.contextTokens)),
    modelTokens: Math.max(0, Math.floor(value.modelTokens ?? granted.modelTokens)),
    toolCalls: Math.max(0, Math.floor(value.toolCalls ?? granted.toolCalls)),
    graphSteps: Math.max(0, Math.floor(value.graphSteps ?? granted.graphSteps)),
    wallTimeMs: Math.max(1, Math.floor(value.wallTimeMs ?? elapsedMs)),
  };
}

function usageExceedsGrant(used: ChildExecutionBudget, granted: ChildExecutionBudget): keyof ChildExecutionBudget | undefined {
  for (const key of ["contextTokens", "modelTokens", "toolCalls", "graphSteps", "wallTimeMs"] as const) {
    if (used[key] > granted[key]) return key;
  }
  return undefined;
}

function boundedProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function errorFrom(error: unknown, fallbackCode: string): ChildExecutionError {
  return {
    code: error instanceof Error && error.name ? error.name : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Mutable admission state for one parent execution. It is intentionally
 * separate from ExecutionScope: scope is identity/authority, while this is
 * runtime scheduling state that can be reconstructed by a durable host later.
 */
export class ChildExecutionContext {
  private directChildren = 0;
  private activeChildren = 0;
  private readonly remaining: InternalBudget;

  constructor(
    readonly policy: ChildExecutionPolicy,
    readonly depth = 0,
    initialBudget: ChildExecutionBudget = policy.budget,
  ) {
    this.remaining = cloneBudget(initialBudget);
  }

  snapshot(): {
    depth: number;
    directChildren: number;
    activeChildren: number;
    remainingBudget: ChildExecutionBudget;
  } {
    return {
      depth: this.depth,
      directChildren: this.directChildren,
      activeChildren: this.activeChildren,
      remainingBudget: cloneBudget(this.remaining),
    };
  }

  /** Create the isolated context a child may use for its own descendants. */
  childContext(grantedBudget: ChildExecutionBudget): ChildExecutionContext {
    return new ChildExecutionContext(this.policy, this.depth + 1, grantedBudget);
  }

  /** @internal */
  reserve(grantedBudget: ChildExecutionBudget): void {
    this.directChildren += 1;
    subtractBudget(this.remaining, grantedBudget);
  }

  /** @internal */
  release(grantedBudget: ChildExecutionBudget, usedBudget: ChildExecutionBudget): void {
    const unused: InternalBudget = {
      contextTokens: Math.max(0, grantedBudget.contextTokens - Math.min(grantedBudget.contextTokens, usedBudget.contextTokens)),
      modelTokens: Math.max(0, grantedBudget.modelTokens - Math.min(grantedBudget.modelTokens, usedBudget.modelTokens)),
      toolCalls: Math.max(0, grantedBudget.toolCalls - Math.min(grantedBudget.toolCalls, usedBudget.toolCalls)),
      graphSteps: Math.max(0, grantedBudget.graphSteps - Math.min(grantedBudget.graphSteps, usedBudget.graphSteps)),
      wallTimeMs: Math.max(0, grantedBudget.wallTimeMs - Math.min(grantedBudget.wallTimeMs, usedBudget.wallTimeMs)),
    };
    addBudget(this.remaining, unused);
  }

  /** @internal */
  rollback(grantedBudget: ChildExecutionBudget): void {
    this.directChildren = Math.max(0, this.directChildren - 1);
    addBudget(this.remaining, grantedBudget);
  }

  /** @internal */
  acquireActive(): boolean {
    if (this.activeChildren >= this.policy.maxConcurrentChildren) return false;
    this.activeChildren += 1;
    return true;
  }

  /** @internal */
  releaseActive(): void {
    this.activeChildren = Math.max(0, this.activeChildren - 1);
  }

  /** @internal */
  canAdmit(grantedBudget: ChildExecutionBudget): boolean {
    const snapshot = this.snapshot();
    return snapshot.directChildren < this.policy.maxFanOut
      && snapshot.remainingBudget.contextTokens >= grantedBudget.contextTokens
      && snapshot.remainingBudget.modelTokens >= grantedBudget.modelTokens
      && snapshot.remainingBudget.toolCalls >= grantedBudget.toolCalls
      && snapshot.remainingBudget.graphSteps >= grantedBudget.graphSteps
      && snapshot.remainingBudget.wallTimeMs >= grantedBudget.wallTimeMs;
  }

  /** @internal */
  remainingBudget(): ChildExecutionBudget {
    return cloneBudget(this.remaining);
  }
}

interface PreparedChild<TOutput> {
  parent: ExecutionScope;
  parentContext: ChildExecutionContext;
  childContext: ChildExecutionContext;
  scope: ChildInvocationScope;
  request: ChildInvocationRequest;
  executor: BoundedChildExecutor<TOutput>;
  grantedBudget: ChildExecutionBudget;
  requestedBudget: ChildExecutionBudget;
  options: ChildExecutionOptions;
  reporter: ProgressReporter;
}

class ProgressReporter implements ChildProgressReporter {
  private sequence = 0;
  private latestPartial: unknown;
  private readonly events: ChildProgressEvidence[] = [];
  private readonly pendingSinks: Promise<void>[] = [];

  constructor(
    private readonly parent: ExecutionScope,
    private readonly scope: ChildInvocationScope | undefined,
    private readonly depth: number,
    private readonly sink: ChildProgressSink | undefined,
  ) {}

  emit(phase: ChildProgressPhase, update: ChildProgressUpdate = {}): void {
    if (update.partialOutput !== undefined) this.latestPartial = update.partialOutput;
    const evidence: ChildProgressEvidence = {
      sequence: ++this.sequence,
      phase,
      ...(this.scope ? {
        invocationId: this.scope.invocationId,
        childAgentDefinitionId: this.scope.childAgentDefinitionId,
        childAgentVersionId: this.scope.childAgentVersionId,
      } : {}),
      parentRunId: this.parent.runId,
      depth: this.depth,
      occurredAt: new Date().toISOString(),
      ...(boundedProgress(update.progress) === undefined ? {} : { progress: boundedProgress(update.progress) }),
      ...(update.message ? { message: update.message } : {}),
      hasPartialResult: this.latestPartial !== undefined,
    };
    this.events.push(evidence);
    if (this.sink) {
      this.pendingSinks.push(Promise.resolve(this.sink(evidence)).catch(() => undefined));
    }
  }

  report(update: ChildProgressUpdate): void {
    this.emit("progress", update);
  }

  partialOutput(): unknown {
    return this.latestPartial;
  }

  evidence(): readonly ChildProgressEvidence[] {
    return this.events.slice();
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingSinks);
  }
}

interface PreparedRejection {
  result: BoundedChildExecutionResult;
}

function isPrepared<TOutput>(value: PreparedChild<TOutput> | PreparedRejection): value is PreparedChild<TOutput> {
  return "executor" in value;
}

/**
 * Host-neutral bounded child execution kernel.
 *
 * It owns admission and outcome semantics, not child execution itself. An
 * in-memory executor, Temporal workflow adapter, or another durable host can
 * implement BoundedChildExecutor without reimplementing these safety rules.
 */
export class ChildExecutionKernel {
  constructor(readonly policy: ChildExecutionPolicy = parseChildExecutionPolicy()) {}

  createContext(): ChildExecutionContext {
    return new ChildExecutionContext(this.policy);
  }

  execute<TOutput>(
    parent: ExecutionScope,
    context: ChildExecutionContext,
    input: unknown,
    executor: BoundedChildExecutor<TOutput>,
    options: ChildExecutionOptions = {},
  ): Promise<BoundedChildExecutionResult<TOutput>> {
    const prepared = this.prepare(parent, context, input, executor, options);
    if (!isPrepared(prepared)) return Promise.resolve(prepared.result as BoundedChildExecutionResult<TOutput>);
    return this.runPrepared(prepared);
  }

  async executeFanOut<TOutput>(
    parent: ExecutionScope,
    context: ChildExecutionContext,
    items: readonly ChildFanOutItem[],
    executor: BoundedChildExecutor<TOutput>,
  ): Promise<ChildFanOutResult<TOutput>> {
    if (items.length === 0) return { status: "completed", results: [] };
    if (items.length > this.policy.maxFanOut - context.snapshot().directChildren) {
      return {
        status: "rejected",
        results: [],
        error: {
          code: "CHILD_MAX_FAN_OUT_EXCEEDED",
          message: `Child fan-out exceeds the maximum of ${this.policy.maxFanOut}`,
        },
      };
    }

    const automaticBudget = divideBudget(context.remainingBudget(), items.length);
    const preparedValues = items.map((item) => {
      const itemOptions = item.options ?? {};
      const requestedBudget = itemOptions.requestedBudget
        ? itemOptions.requestedBudget
        : automaticBudget;
      return this.prepare(parent, context, item.input, executor, { ...itemOptions, requestedBudget });
    });
    const invalid = preparedValues.find((value) => !isPrepared(value));
    if (invalid && !isPrepared(invalid)) {
      for (const value of preparedValues) if (isPrepared(value)) this.releaseReservation(value);
      const results = await Promise.all(preparedValues.map(async (value) => {
        if (!isPrepared(value)) {
          return value.result as BoundedChildExecutionResult<TOutput>;
        }
        value.reporter.emit("rejected", { message: "Fan-out admission rolled back" });
        await value.reporter.flush();
        return {
          invocationId: value.scope.invocationId,
          status: "rejected" as const,
          scope: value.scope,
          error: { code: "CHILD_FAN_OUT_ADMISSION_ROLLED_BACK", message: "Fan-out admission rolled back" },
          progress: [...value.reporter.evidence()],
        };
      }));
      return {
        status: "rejected",
        results,
        error: invalid.result.error,
      };
    }

    const prepared = preparedValues.filter(isPrepared);
    const results: BoundedChildExecutionResult<TOutput>[] = [];
    for (let index = 0; index < prepared.length; index += this.policy.maxConcurrentChildren) {
      const batch = prepared.slice(index, index + this.policy.maxConcurrentChildren);
      results.push(...await Promise.all(batch.map((value) => this.runPrepared(value))));
    }
    const hasFailure = results.some((result) => result.status !== "succeeded");
    return { status: hasFailure ? "partial" : "completed", results };
  }

  private prepare<TOutput>(
    parent: ExecutionScope,
    context: ChildExecutionContext,
    input: unknown,
    executor: BoundedChildExecutor<TOutput>,
    options: ChildExecutionOptions,
  ): PreparedChild<TOutput> | PreparedRejection {
    const noScopeReporter = new ProgressReporter(parent, undefined, context.depth + 1, options.onProgress);
    if (context.policy !== this.policy) {
      noScopeReporter.emit("rejected", { message: "Child context belongs to a different policy" });
      return { result: { status: "rejected", error: { code: "CHILD_CONTEXT_POLICY_MISMATCH", message: "Child context belongs to a different policy" }, progress: noScopeReporter.evidence() } };
    }
    if (context.depth >= this.policy.maxDepth) {
      noScopeReporter.emit("rejected", { message: "Maximum child depth exceeded" });
      return { result: { status: "rejected", error: { code: "CHILD_MAX_DEPTH_EXCEEDED", message: "Maximum child depth exceeded" }, progress: noScopeReporter.evidence() } };
    }
    if (context.snapshot().directChildren >= this.policy.maxFanOut) {
      noScopeReporter.emit("rejected", { message: "Maximum child fan-out exceeded" });
      return { result: { status: "rejected", error: { code: "CHILD_MAX_FAN_OUT_EXCEEDED", message: "Maximum child fan-out exceeded" }, progress: noScopeReporter.evidence() } };
    }

    let parsedRequest: ChildInvocationRequest;
    let scope: ChildInvocationScope;
    try {
      parsedRequest = childInvocationRequestSchema.parse(input);
      ({ scope, request: parsedRequest } = createChildInvocationScope(parent, parsedRequest));
    } catch (error) {
      const typedError = errorFrom(error, "CHILD_REQUEST_INVALID");
      const code = typedError.message.startsWith("CHILD_AUTHORITY_EXPANSION:")
        ? "CHILD_AUTHORITY_EXPANSION"
        : "CHILD_REQUEST_INVALID";
      noScopeReporter.emit("rejected", { message: typedError.message });
      return { result: { status: "rejected", error: { code, message: typedError.message }, progress: noScopeReporter.evidence() } };
    }

    const requestedBudgetResult = this.requestedBudget(context, options.requestedBudget);
    if (!requestedBudgetResult.ok) {
      noScopeReporter.emit("rejected", { message: requestedBudgetResult.error.message });
      return { result: { invocationId: scope.invocationId, status: "rejected", scope, error: requestedBudgetResult.error, progress: noScopeReporter.evidence() } };
    }
    const grantedBudget = minBudget(requestedBudgetResult.requested, context.remainingBudget());
    if (grantedBudget.modelTokens <= 0 || grantedBudget.wallTimeMs <= 0 || !context.canAdmit(grantedBudget)) {
      noScopeReporter.emit("rejected", { message: "Child budget is exhausted" });
      return { result: { invocationId: scope.invocationId, status: "rejected", scope, error: { code: "CHILD_BUDGET_EXHAUSTED", message: "Child budget is exhausted" }, progress: noScopeReporter.evidence() } };
    }

    context.reserve(grantedBudget);
    const reporter = new ProgressReporter(parent, scope, context.depth + 1, options.onProgress);
    reporter.emit("admitted", { progress: 0 });
    return {
      parent,
      parentContext: context,
      childContext: context.childContext(grantedBudget),
      scope,
      request: parsedRequest,
      executor,
      grantedBudget,
      requestedBudget: requestedBudgetResult.requested,
      options,
      reporter,
    };
  }

  private requestedBudget(
    context: ChildExecutionContext,
    override: Partial<ChildExecutionBudget> | undefined,
  ): { ok: true; requested: ChildExecutionBudget } | { ok: false; error: ChildExecutionError } {
    const parsed = z.object({
      contextTokens: nonNegativeInteger.optional(),
      modelTokens: nonNegativeInteger.optional(),
      toolCalls: nonNegativeInteger.optional(),
      graphSteps: nonNegativeInteger.optional(),
      wallTimeMs: positiveInteger.optional(),
    }).strict().safeParse(override ?? {});
    if (!parsed.success) return { ok: false, error: { code: "CHILD_BUDGET_INVALID", message: parsed.error.message } };
    const parentRemaining = context.remainingBudget();
    return {
      ok: true,
      requested: {
        contextTokens: parsed.data.contextTokens ?? parentRemaining.contextTokens,
        modelTokens: parsed.data.modelTokens ?? parentRemaining.modelTokens,
        toolCalls: parsed.data.toolCalls ?? parentRemaining.toolCalls,
        graphSteps: parsed.data.graphSteps ?? parentRemaining.graphSteps,
        wallTimeMs: parsed.data.wallTimeMs ?? parentRemaining.wallTimeMs,
      },
    };
  }

  private async runPrepared<TOutput>(prepared: PreparedChild<TOutput>): Promise<BoundedChildExecutionResult<TOutput>> {
    if (!prepared.parentContext.acquireActive()) {
      this.releaseReservation(prepared);
      prepared.reporter.emit("rejected", { message: "Maximum concurrent child executions exceeded" });
      await prepared.reporter.flush();
      return {
        invocationId: prepared.scope.invocationId,
        status: "rejected",
        scope: prepared.scope,
        error: { code: "CHILD_MAX_CONCURRENCY_EXCEEDED", message: "Maximum concurrent child executions exceeded" },
        progress: [...prepared.reporter.evidence()],
      };
    }
    const startedAt = Date.now();
    const timeoutMs = Math.min(
      prepared.options.timeoutMs ?? this.policy.defaultTimeoutMs,
      prepared.grantedBudget.wallTimeMs,
      this.policy.defaultTimeoutMs,
    );
    const controller = new AbortController();
    let termination: "cancelled" | "timed_out" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCancellationListener: (() => void) | undefined;
    let rejectTermination: ((error: Error) => void) | undefined;
    const terminationPromise = new Promise<never>((_, reject) => {
      rejectTermination = reject;
    });
    const cancellation = prepared.options.signal;
    if (cancellation?.aborted) {
      termination = "cancelled";
      controller.abort(cancellation.reason);
    } else if (cancellation) {
      const onAbort = (): void => {
        termination = "cancelled";
        controller.abort(cancellation.reason);
        rejectTermination?.(new Error("CHILD_PARENT_CANCELLED"));
      };
      cancellation.addEventListener("abort", onAbort, { once: true });
      removeCancellationListener = () => cancellation.removeEventListener("abort", onAbort);
    }

    prepared.reporter.emit("started", { progress: 0 });
    let response: ChildExecutionResponse<TOutput> | undefined;
    let executionError: ChildExecutionError | undefined;
    if (!termination) {
      timer = setTimeout(() => {
        termination = "timed_out";
        controller.abort("CHILD_TIMEOUT");
        rejectTermination?.(new Error("CHILD_TIMEOUT"));
      }, timeoutMs);
      try {
        const execution = prepared.executor.execute({
          scope: prepared.scope,
          input: prepared.request.input,
          context: prepared.childContext,
          budget: prepared.grantedBudget,
          signal: controller.signal,
          progress: prepared.reporter,
        });
        response = await Promise.race([execution, terminationPromise]);
      } catch (error) {
        executionError = termination
          ? { code: termination === "timed_out" ? "CHILD_TIMEOUT" : "CHILD_PARENT_CANCELLED", message: termination === "timed_out" ? "Child execution timed out" : "Parent cancelled child execution" }
          : errorFrom(error, "CHILD_EXECUTION_FAILED");
      }
    }
    if (termination && !executionError) {
      executionError = termination === "timed_out"
        ? { code: "CHILD_TIMEOUT", message: "Child execution timed out" }
        : { code: "CHILD_PARENT_CANCELLED", message: "Parent cancelled child execution" };
    }
    if (timer) clearTimeout(timer);
    removeCancellationListener?.();
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const usedBudget = normalizeUsage(response?.usage, elapsedMs, prepared.grantedBudget);
    const overrun = usageExceedsGrant(usedBudget, prepared.grantedBudget);
    if (overrun && !executionError) executionError = { code: "CHILD_BUDGET_OVERRUN", message: `Child exceeded its ${overrun} budget` };
    const partialOutput = response?.partialOutput ?? prepared.reporter.partialOutput();
    const allowPartial = prepared.options.allowPartialResult ?? this.policy.allowPartialResults;
    const hasPartial = allowPartial && partialOutput !== undefined;
    prepared.parentContext.release(prepared.grantedBudget, usedBudget);
    prepared.parentContext.releaseActive();
    // Evidence describes the state the parent can actually use after this
    // child has settled, including unused reserved budget returned to it.
    const budget = this.budgetEvidence(prepared, usedBudget);

    let status: ChildExecutionStatus;
    let output: TOutput | undefined;
    if (executionError && termination && hasPartial) {
      status = "partial";
    } else if (executionError && termination === "cancelled") {
      status = "cancelled";
    } else if (executionError && termination === "timed_out") {
      status = "timed_out";
    } else if (executionError) {
      status = "failed";
    } else {
      status = "succeeded";
      output = response?.output;
    }
    const phase: ChildProgressPhase = status === "succeeded" ? "completed"
      : status === "cancelled" ? "cancelled"
        : status === "timed_out" ? "timed_out"
          : "failed";
    prepared.reporter.emit(phase, { progress: status === "succeeded" ? 1 : undefined, partialOutput: hasPartial ? partialOutput : undefined, message: executionError?.message });
    await prepared.reporter.flush();
    return {
      invocationId: prepared.scope.invocationId,
      status,
      scope: prepared.scope,
      ...(output === undefined ? {} : { output }),
      ...(hasPartial ? { partialOutput } : {}),
      ...(termination ? { termination } : {}),
      ...(executionError ? { error: executionError } : {}),
      budget,
      progress: [...prepared.reporter.evidence()],
    };
  }

  private releaseReservation<TOutput>(prepared: PreparedChild<TOutput>): void {
    prepared.parentContext.rollback(prepared.grantedBudget);
  }

  private budgetEvidence<TOutput>(prepared: PreparedChild<TOutput>, used: ChildExecutionBudget): ChildBudgetEvidence {
    return {
      requested: cloneBudget(prepared.requestedBudget),
      granted: cloneBudget(prepared.grantedBudget),
      used: cloneBudget(used),
      parentRemaining: prepared.parentContext.remainingBudget(),
    };
  }
}
