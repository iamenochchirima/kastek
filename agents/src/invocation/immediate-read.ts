import { InstallationCapabilityError } from "./installation-capability";
import { RunRepository, type RunRecord } from "../db/repositories/run-repository";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { hashToolArguments, ToolRegistry } from "../tools/registry";

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
    tools: ToolRegistry;
  }) {}

  public async execute(input: ImmediateReadInput): Promise<ImmediateReadResult> {
    const accepted = await this.dependencies.runs.createRun(input.organizationId, input.actorId, {
      installationId: input.installationId,
      triggerType: "manual",
      idempotencyKey: input.idempotencyKey,
      input: { mcpTool: { name: input.name, arguments: input.argumentsValue, toolCallId: input.toolCallId } },
    });
    if (accepted.created === false || accepted.status === "completed") {
      return { accepted, output: accepted.output };
    }

    const argumentsHash = hashToolArguments(input.argumentsValue);
    await this.dependencies.runs.transitionRun(accepted.id, "received", "queued", { execution: "immediate", capability: input.name });
    await this.dependencies.runs.transitionRun(accepted.id, "queued", "running", { execution: "immediate", capability: input.name });
    await this.dependencies.toolInvocations.recordProposal({
      organizationId: input.organizationId,
      runId: accepted.id,
      providerToolCallId: input.toolCallId,
      sequenceNumber: 1,
      toolName: input.name,
      toolVersion: this.dependencies.tools.get(input.name)?.version ?? "0.0.0",
      riskClass: "read",
      argumentsHash,
      arguments: input.argumentsValue,
      requiresApproval: false,
    });
    try {
      const result = await this.dependencies.tools.invoke({
        name: input.name,
        arguments: input.argumentsValue,
        context: {
          organizationId: input.organizationId,
          agentId: input.agentId,
          agentVersionId: input.agentVersionId,
          installationId: input.installationId,
          runId: accepted.id,
          actorId: input.actorId,
          correlationId: accepted.correlation_id,
        },
        grantedTools: input.grantedTools,
      });
      await this.dependencies.toolInvocations.recordCompleted({
        runId: accepted.id,
        providerToolCallId: input.toolCallId,
        output: result.output,
        latencyMs: result.latencyMs,
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
      await this.dependencies.toolInvocations.recordFailed({ runId: accepted.id, providerToolCallId: input.toolCallId, error: normalized });
      await this.dependencies.runs.transitionRun(accepted.id, "running", "failed", normalized);
      throw new InstallationCapabilityError("TOOL_FAILED", normalized.message);
    }
  }
}
