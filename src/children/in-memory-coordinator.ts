import type { ExecutionScope } from "../runtime/execution-scope";
import {
  createChildInvocationScope,
  type ChildInvocationExecutor,
  type ChildInvocationResult,
} from "./contracts";

/**
 * Process-local reference coordinator for contract tests and local hosts.
 * A Temporal-backed coordinator can later replace this behind the same API.
 */
export class InMemoryChildInvocationCoordinator<TOutput = unknown> {
  private readonly invocations = new Map<string, Promise<ChildInvocationResult<TOutput>>>();

  constructor(private readonly executor: ChildInvocationExecutor<TOutput>) {}

  invoke(parent: ExecutionScope, input: unknown): Promise<ChildInvocationResult<TOutput>> {
    const { scope, request } = createChildInvocationScope(parent, input);
    const existing = this.invocations.get(scope.invocationId);
    if (existing) return existing;

    const invocation = this.executor.execute({ scope, input: request.input })
      .then((output) => ({ invocationId: scope.invocationId, status: "succeeded" as const, output }))
      .catch((error: unknown) => ({
        invocationId: scope.invocationId,
        status: "failed" as const,
        error: {
          code: "CHILD_INVOCATION_FAILED",
          message: error instanceof Error ? error.message : "Child invocation failed",
        },
      }));
    this.invocations.set(scope.invocationId, invocation);
    return invocation;
  }
}
