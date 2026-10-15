import { InstallationCapabilityError } from "./installation-capability";
import { RunRepository, type RunRecord } from "../db/repositories/run-repository";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { executionScopeFromRun } from "../runtime/execution-scope";
import { hashToolArguments } from "../tools/registry";
import { toolInvocationContextFromScope } from "../tools/types";
import type { CapabilityRuntime } from "../capabilities/runtime";
import { createToolInvocationLifecycle } from "../capabilities/lifecycle";

export interface ImmediateReadInput {
  organizationId: string;
  actorId: string;
  installationId: string;
  agentId: string;
  agentVersionId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  toolCallId: string;
  idempotencyKey: string;
  transport?: "mcp" | "rest";
  grantedTools: ReadonlySet<string>;
}

export interface ImmediateReadResult {
  accepted: RunRecord;
  output: unknown;
}

/**
 * Executes only read manifests that explicitly opt into immediate execution.
 * The run, proposal, completion/failure evidence, and idempotency key remain
 * durable even though Temporal is not involved for this safe read path.
 */
export class InstallationImmediateReadService {
  public constructor(private readonly dependencies: {
    runs: RunRepository;
    toolInvocations: ToolInvocationRepository;
    capabilities: CapabilityRuntime;
  }) {}

  public async execute(input: ImmediateReadInput): Promise<ImmediateReadResult> {
    const lifecycle = createToolInvocationLifecycle({ toolInvocations: this.dependencies.toolInvocations });
    const accepted = await this.dependencies.runs.createRun(input.organizationId, input.actorId, {
      installationId: input.installationId,
      triggerType: "manual",
      idempotencyKey: input.idempotencyKey,
      input: { mcpTool: { name: input.name, arguments: input.argumentsValue, toolCallId: input.toolCallId, transport: input.transport ?? "mcp" } },
    });
    if (accepted.created === false || accepted.status === "completed") {
      return { accepted, output: accepted.output };
    }

    const argumentsHash = hashToolArguments(input.argumentsValue);
    await this.dependencies.runs.transitionRun(accepted.id, "received", "queued", { execution: "immediate", capability: input.name });
    await this.dependencies.runs.transitionRun(accepted.id, "queued", "running", { execution: "immediate", capability: input.name });
    try {
      const result = await this.dependencies.capabilities.invoke({
        name: input.name,
        arguments: input.argumentsValue,
        context: toolInvocationContextFromScope({
          ...executionScopeFromRun(accepted),
          capabilityGrants: [input.name],
        }),
        grantedTools: input.grantedTools,
        operationId: input.toolCallId,
        sequenceNumber: 1,
        lifecycle,
      });
      const completed = await this.dependencies.runs.completeRun(accepted.id, {
        capability: input.name,
        output: result.output,
        argumentsHash: result.argumentsHash,
        latencyMs: result.latencyMs,
      });
      return { accepted: completed, output: result.output };
    } catch (error) {
      const normalized = { code: "IMMEDIATE_READ_FAILED", message: error instanceof Error ? error.message : "Immediate read failed" };
      await this.dependencies.runs.transitionRun(accepted.id, "running", "failed", normalized);
      throw new InstallationCapabilityError("TOOL_FAILED", normalized.message);
    }
  }
}
