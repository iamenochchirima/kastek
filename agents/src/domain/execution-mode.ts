import type { AgentExecutionMode } from "./types";

/**
 * The runtime identity of an installation is an authorization boundary. Keep
 * this policy in one place so HTTP, invocation, and future protocol adapters
 * cannot accidentally infer a mode from a display name or owner alone.
 */
export interface ExecutionModeInstallation {
  execution_mode?: AgentExecutionMode | null;
  agent_owner_type?: string | null;
  agent_protected?: boolean | null;
  agent_slug?: string | null;
  status?: string | null;
}

export const executionModePolicy = {
  credentials: { system_hosted: false, kasitek_hosted: false, external_connected: true },
  hostedRuntime: { system_hosted: true, kasitek_hosted: true, external_connected: false },
  channels: { system_hosted: true, kasitek_hosted: true, external_connected: false },
  schedules: { system_hosted: true, kasitek_hosted: true, external_connected: false },
  hostedKnowledgeMemory: { system_hosted: true, kasitek_hosted: true, external_connected: false },
  kasiAiControl: { system_hosted: true, kasitek_hosted: false, external_connected: false },
} as const satisfies Record<string, Record<AgentExecutionMode, boolean>>;

export type ExecutionModeOperation = keyof typeof executionModePolicy;

export function allowsExecutionMode(mode: AgentExecutionMode, operation: ExecutionModeOperation): boolean {
  return executionModePolicy[operation][mode];
}

export class ExecutionModeError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(code: string, message: string, statusCode = 403) {
    super(message);
    this.name = "ExecutionModeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function requireExecutionMode(
  installation: ExecutionModeInstallation | null | undefined,
  allowedModes: readonly AgentExecutionMode[],
  options: { code?: string; message?: string; statusCode?: number } = {},
): asserts installation is ExecutionModeInstallation & { execution_mode: AgentExecutionMode } {
  const mode = installation?.execution_mode;
  if (!installation || !mode || !allowedModes.includes(mode)) {
    throw new ExecutionModeError(
      options.code ?? "installation_execution_mode_not_allowed",
      options.message ?? `Installation execution mode is not allowed${allowedModes.length ? `; expected ${allowedModes.join(" or ")}` : ""}`,
      options.statusCode ?? 403,
    );
  }
}

export function requireExternalConnected(installation: ExecutionModeInstallation | null | undefined): void {
  if (!installation || !installation.execution_mode || !allowsExecutionMode(installation.execution_mode, "credentials")) {
    throw new ExecutionModeError(
      "external_installation_required",
      "This operation is available only to external-connected installations",
    );
  }
  requireExecutionMode(installation, ["external_connected"], {
    code: "external_installation_required",
    message: "This operation is available only to external-connected installations",
  });
}

export function requireHostedInstallation(installation: ExecutionModeInstallation | null | undefined): void {
  if (!installation || !installation.execution_mode || !allowsExecutionMode(installation.execution_mode, "hostedRuntime")) {
    throw new ExecutionModeError(
      "hosted_installation_required",
      "This operation is available only to hosted installations",
    );
  }
  requireExecutionMode(installation, ["system_hosted", "kasitek_hosted"], {
    code: "hosted_installation_required",
    message: "This operation is available only to hosted installations",
  });
}

export function requireKasiAiInstallation(installation: ExecutionModeInstallation | null | undefined): void {
  requireExecutionMode(installation, ["system_hosted"], {
    code: "kasiai_installation_required",
    message: "This operation is available only to the protected KasiAi installation",
  });
  if (installation.agent_owner_type !== "system" || installation.agent_protected !== true || installation.agent_slug !== "kasiai") {
    throw new ExecutionModeError(
      "kasiai_installation_required",
      "This operation is available only to the protected KasiAi installation",
    );
  }
}

export function isHostedExecutionMode(mode: AgentExecutionMode | null | undefined): boolean {
  return mode === "system_hosted" || mode === "kasitek_hosted";
}
