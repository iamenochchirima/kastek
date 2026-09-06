import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExecutionScope } from "../runtime/execution-scope";

const identifier = z.string().trim().min(1).max(240);
const grants = z.array(identifier).max(500).default([]);
const boundedJson = z.unknown().refine(
  (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8") <= 32 * 1024,
  "Child invocation context must not exceed 32 KiB",
);

/** A declarative request to run one named child agent. */
export const childInvocationRequestSchema = z.object({
  childAgentDefinitionId: identifier,
  childAgentVersionId: identifier,
  idempotencyKey: identifier,
  input: boundedJson,
  capabilityGrants: grants,
  resourceGrants: grants,
}).strict();

export type ChildInvocationRequest = z.infer<typeof childInvocationRequestSchema>;

/**
 * Authority delegated from a parent run to a child run.
 *
 * It deliberately is not an ExecutionScope: the child receives a distinct run
 * identity when a durable executor is introduced. This envelope carries only
 * the tenant/session lineage and the subset of authority it may use.
 */
export interface ChildInvocationScope {
  invocationId: string;
  parentRunId: string;
  organizationId: string;
  installationId: string;
  sessionId?: string;
  conversationId?: string;
  correlationId: string;
  causationId: string;
  childAgentDefinitionId: string;
  childAgentVersionId: string;
  capabilityGrants: string[];
  resourceGrants: string[];
}

export type ChildInvocationStatus = "succeeded" | "failed";

export interface ChildInvocationResult<TOutput = unknown> {
  invocationId: string;
  status: ChildInvocationStatus;
  output?: TOutput;
  error?: {
    code: string;
    message: string;
  };
}

export interface ChildInvocationExecutor<TOutput = unknown> {
  execute(input: {
    scope: ChildInvocationScope;
    input: unknown;
  }): Promise<TOutput>;
}

function attenuate(parentGrants: string[] | undefined, requestedGrants: string[]): string[] {
  const parent = new Set(parentGrants ?? []);
  const invalid = requestedGrants.find((grant) => !parent.has(grant));
  if (invalid) throw new Error(`CHILD_AUTHORITY_EXPANSION:${invalid}`);
  return [...new Set(requestedGrants)].sort();
}

function deterministicInvocationId(parent: ExecutionScope, idempotencyKey: string): string {
  return createHash("sha256")
    .update(`${parent.organizationId}:${parent.installationId}:${parent.runId}:${idempotencyKey}`)
    .digest("hex");
}

/** Create a bounded, non-expandable authority envelope for a child request. */
export function createChildInvocationScope(
  parent: ExecutionScope,
  input: unknown,
): { scope: ChildInvocationScope; request: ChildInvocationRequest } {
  const request = childInvocationRequestSchema.parse(input);
  const capabilityGrants = attenuate(parent.capabilityGrants, request.capabilityGrants);
  const resourceGrants = attenuate(parent.resourceGrants, request.resourceGrants);

  return {
    request: {
      ...request,
      capabilityGrants,
      resourceGrants,
    },
    scope: {
      invocationId: deterministicInvocationId(parent, request.idempotencyKey),
      parentRunId: parent.runId,
      organizationId: parent.organizationId,
      installationId: parent.installationId,
      ...(parent.sessionId ? { sessionId: parent.sessionId } : {}),
      ...(parent.conversationId ? { conversationId: parent.conversationId } : {}),
      correlationId: parent.correlationId,
      causationId: parent.runId,
      childAgentDefinitionId: request.childAgentDefinitionId,
      childAgentVersionId: request.childAgentVersionId,
      capabilityGrants,
      resourceGrants,
    },
  };
}
