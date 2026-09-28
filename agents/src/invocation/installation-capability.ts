import { authorizeInstallationCapability } from "../capabilities/authorization";
import { AgentRepository } from "../db/repositories/agent-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { ToolRegistry } from "../tools/registry";
import type { RunRecord } from "../db/repositories/run-repository";
import type { CapabilityRuntime } from "../capabilities/runtime";

export class InstallationCapabilityError extends Error {
  public constructor(public readonly code: string, message = code) {
    super(message);
  }
}

export interface InstallationCapabilityInvocation {
  organizationId: string;
  actorId: string;
  installationId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  toolCallId: string;
  idempotencyKey: string;
  transport?: "mcp" | "rest";
}

export interface ImmediateReadAcceptance {
  accepted: RunRecord;
  output: unknown;
}

/**
 * Protocol-neutral acceptance boundary for installation credentials. It creates
 * a durable run only after all policy that can be evaluated before a proposal
 * has passed. Execution-time approval and resource reauthorization remain in
 * Temporal activities, immediately before the provider boundary.
 */
export class InstallationCapabilityInvocationService {
  public constructor(private readonly dependencies: {
    agents: AgentRepository;
    runs: RunRepository;
    toolGrants: ToolGrantRepository;
    installationGrants: InstallationGrantRepository;
    killSwitches: KillSwitchRepository;
    tools: ToolRegistry;
    /** Shared capability seam; tools remains a compatibility injection for host tests. */
    capabilities?: CapabilityRuntime;
    temporalEnabled: boolean;
    startWorkflow?: (runId: string) => Promise<void>;
    immediateRead?: (input: InstallationCapabilityInvocation & {
      installation: { id: string; agent_definition_id?: string | null; agent_version_id: string };
      grantedTools: ReadonlySet<string>;
    }) => Promise<ImmediateReadAcceptance>;
  }) {}

  public async accept(input: InstallationCapabilityInvocation) {
    const tools = this.dependencies.capabilities?.registry ?? this.dependencies.tools;
    const installation = await this.dependencies.agents.getInstallation(input.organizationId, input.installationId);
    if (!installation || installation.status !== "active") {
      throw new InstallationCapabilityError("INSTALLATION_NOT_FOUND", "installation_not_found");
    }
    if (!tools.get(input.name)) {
      throw new InstallationCapabilityError("TOOL_NOT_FOUND", "tool_not_found");
    }
    if (!tools.validateArguments(input.name, input.argumentsValue)) {
      throw new InstallationCapabilityError("INVALID_TOOL_ARGUMENTS", "invalid_tool_arguments");
    }
    const grantedTools = await this.dependencies.toolGrants.effectiveTools(
      input.organizationId,
      installation.agent_version_id,
      installation.id,
    );
    let manifest;
    try {
      manifest = await authorizeInstallationCapability({
        organizationId: input.organizationId,
        installationId: installation.id,
        name: input.name,
        argumentsValue: input.argumentsValue,
        grantedTools,
        tools,
        installationGrants: this.dependencies.installationGrants,
        approved: false,
        enforceApproval: false,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "CAPABILITY_NOT_GRANTED";
      throw new InstallationCapabilityError(code, code.toLowerCase());
    }
    if (await this.dependencies.killSwitches.isBlocked({
      organizationId: input.organizationId,
      agentId: installation.agent_definition_id,
      installationId: installation.id,
      toolNames: [input.name],
    })) {
      throw new InstallationCapabilityError("AGENT_KILL_SWITCH_ACTIVE");
    }
    const immediateRead = manifest.manifest?.execution === "immediate" && manifest.riskClass === "read";
    if (immediateRead && !this.dependencies.temporalEnabled && this.dependencies.immediateRead) {
      const result = await this.dependencies.immediateRead({
        ...input,
        installation: {
          id: installation.id,
          agent_definition_id: installation.agent_definition_id,
          agent_version_id: installation.agent_version_id,
        },
        grantedTools,
      });
      return { ...result, installation, manifest, grantedTools, immediate: true };
    }
    if (!this.dependencies.temporalEnabled || !this.dependencies.startWorkflow) {
      throw new InstallationCapabilityError("DURABLE_EXECUTION_UNAVAILABLE", "durable tool execution is unavailable");
    }
    const accepted = await this.dependencies.runs.createRun(input.organizationId, input.actorId, {
      installationId: installation.id,
      triggerType: "manual",
      idempotencyKey: input.idempotencyKey,
      input: { mcpTool: { name: input.name, arguments: input.argumentsValue, toolCallId: input.toolCallId, transport: input.transport ?? "mcp" } },
    });
    if (accepted.created !== false && accepted.status === "received") {
      await this.dependencies.startWorkflow(accepted.id);
    }
    return { accepted, installation, manifest, grantedTools };
  }
}
