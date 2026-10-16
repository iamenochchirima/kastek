export type AgentReadinessStatus = "ready" | "blocked";

export type AgentReadinessBlocker = {
  code: "installation_inactive" | "workflow_invalid" | "capability_not_available" | "connection_not_configured" | "model_credential_missing";
  title: string;
  detail: string;
  capability?: string;
  connection?: string;
};

export type AgentReadiness = {
  status: AgentReadinessStatus;
  ready: boolean;
  checks: {
    deployment: { status: "ready" | "blocked"; installationStatus: string };
    workflow: { status: "ready" | "blocked"; error?: string };
    capabilities: { required: string[]; available: string[]; missing: string[] };
    connections: { required: string[]; configured: string[]; missing: string[] };
    credentials: { status: "ready" | "blocked" | "not_required"; provider?: string; detail: string };
  };
  blockers: AgentReadinessBlocker[];
};

export function buildAgentReadiness(input: {
  executionMode: "system_hosted" | "kasitek_hosted" | "external_connected";
  installationStatus: string;
  requiredCapabilities: string[];
  capabilityAvailability: Array<{ name: string; available: boolean; reasonCode?: string }>;
  requiredConnections: string[];
  configuredConnections: string[];
  provider?: string;
  credentialConfigured?: boolean;
  workflowError?: string;
}): AgentReadiness {
  const blockers: AgentReadinessBlocker[] = [];
  const availableNames = new Set(input.capabilityAvailability.filter((entry) => entry.available).map((entry) => entry.name));
  const requiredCapabilities = [...new Set(input.requiredCapabilities)];
  const availableCapabilities = requiredCapabilities.filter((name) => availableNames.has(name));
  const missingCapabilities = requiredCapabilities.filter((name) => !availableNames.has(name));
  for (const name of missingCapabilities) {
    const capability = input.capabilityAvailability.find((entry) => entry.name === name);
    blockers.push({
      code: "capability_not_available",
      title: "Capability is not ready",
      detail: capability?.reasonCode ? `${name}: ${capability.reasonCode.replaceAll("_", " ")}.` : `${name} is not available to this installation.`,
      capability: name,
    });
  }

  const configuredConnections = [...new Set(input.configuredConnections)];
  const requiredConnections = [...new Set(input.requiredConnections)];
  const configuredSet = new Set(configuredConnections);
  const missingConnections = requiredConnections.filter((name) => !configuredSet.has(name));
  for (const name of missingConnections) {
    blockers.push({ code: "connection_not_configured", title: "Connection is not configured", detail: `${name} is required before this agent can be activated.`, connection: name });
  }

  const workflow = input.workflowError
    ? { status: "blocked" as const, error: input.workflowError }
    : { status: "ready" as const };
  if (input.workflowError) blockers.push({ code: "workflow_invalid", title: "Workflow needs a fix", detail: input.workflowError });

  const deploymentReady = input.installationStatus === "active";
  if (!deploymentReady) blockers.push({ code: "installation_inactive", title: "Installation is not active", detail: `The installation is ${input.installationStatus.replaceAll("_", " ")}. Resume it before testing or deploying.` });

  const credentials = input.executionMode === "external_connected"
    ? { status: "not_required" as const, detail: "External-connected installations use their transport credential." }
    : input.credentialConfigured
      ? { status: "ready" as const, provider: input.provider, detail: `${input.provider ?? "Model"} credential is available to the runtime.` }
      : { status: "blocked" as const, provider: input.provider, detail: `${input.provider ?? "Model"} credential is not configured for the runtime.` };
  if (credentials.status === "blocked") blockers.push({ code: "model_credential_missing", title: "Model credential is missing", detail: credentials.detail });

  return {
    status: blockers.length ? "blocked" : "ready",
    ready: blockers.length === 0,
    checks: {
      deployment: { status: deploymentReady ? "ready" : "blocked", installationStatus: input.installationStatus },
      workflow,
      capabilities: { required: requiredCapabilities, available: availableCapabilities, missing: missingCapabilities },
      connections: { required: requiredConnections, configured: configuredConnections, missing: missingConnections },
      credentials,
    },
    blockers,
  };
}
