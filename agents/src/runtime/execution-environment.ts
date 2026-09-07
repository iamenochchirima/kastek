import { z } from "zod";

/**
 * The product execution environment is an installation boundary.  Keep this
 * separate from NODE_ENV: a local process may run either a playground or a
 * live installation, and a production process may still execute playground
 * runs.
 */
export const agentEnvironmentSchema = z.enum(["playground", "live"]);
export type AgentEnvironment = z.infer<typeof agentEnvironmentSchema>;

export class AgentEnvironmentError extends Error {
  public readonly code: "AGENT_ENVIRONMENT_REQUIRED" | "AGENT_ENVIRONMENT_INVALID";

  public constructor(code: AgentEnvironmentError["code"], message: string) {
    super(message);
    this.name = "AgentEnvironmentError";
    this.code = code;
  }
}

export function parseAgentEnvironment(value: unknown): AgentEnvironment {
  if (value === undefined || value === null || value === "") {
    throw new AgentEnvironmentError(
      "AGENT_ENVIRONMENT_REQUIRED",
      "Agent installation environment is required; expected playground or live",
    );
  }
  const parsed = agentEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentEnvironmentError(
      "AGENT_ENVIRONMENT_INVALID",
      "Agent installation environment is invalid; expected playground or live",
    );
  }
  return parsed.data;
}

export function environmentFromInstallationSettings(settings: unknown): AgentEnvironment {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new AgentEnvironmentError(
      "AGENT_ENVIRONMENT_REQUIRED",
      "Agent installation settings must declare playground or live environment",
    );
  }
  return parseAgentEnvironment((settings as Record<string, unknown>).environment);
}

export function assertSameAgentEnvironment(parent: AgentEnvironment, child: AgentEnvironment): void {
  if (parent !== child) {
    throw new AgentEnvironmentError(
      "AGENT_ENVIRONMENT_INVALID",
      `Child agent environment ${child} does not match parent environment ${parent}`,
    );
  }
}
