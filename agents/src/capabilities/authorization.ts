import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { ToolRegistry } from "../tools/registry";
import { evaluateCapabilityPolicy } from "./policy";

/**
 * Evaluates the capability policy shared by hosted-agent execution and the
 * installation MCP/public-API acceptance boundary. `enforceApproval` is
 * disabled only while creating a durable proposal: the activity enforces the
 * approval again immediately before it crosses a provider boundary.
 */
export async function authorizeInstallationCapability(input: {
  organizationId: string;
  installationId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  grantedTools: ReadonlySet<string>;
  tools: ToolRegistry;
  installationGrants: InstallationGrantRepository;
  approved: boolean;
  enforceApproval?: boolean;
}): Promise<NonNullable<ReturnType<ToolRegistry["get"]>>> {
  const manifest = input.tools.get(input.name);
  if (!manifest) throw new Error("TOOL_NOT_FOUND");
  const selector = manifest.manifest?.resourceSelector;
  const selected = selector?.argument ? input.argumentsValue[selector.argument] : undefined;
  const requestedResources = selector && typeof selected === "string" && selected.trim()
    ? [{ type: selector.type, id: selected.trim() }]
    : undefined;
  const grants = await input.installationGrants.effective(input.organizationId, input.installationId);
  const resourceScopeUnconstrained = typeof input.installationGrants.isResourceScopeUnconstrained === "function"
    ? await input.installationGrants.isResourceScopeUnconstrained(input.organizationId, input.installationId)
    : false;
  const decision = evaluateCapabilityPolicy({
    capability: input.name,
    grantedCapabilities: input.grantedTools,
    requestedResources,
    grantedResources: grants.resources,
    resourceScopeUnconstrained,
    available: manifest.manifest?.availability !== "not_configured" && manifest.manifest?.availability !== "unhealthy",
    requiresApproval: input.enforceApproval === false ? false : manifest.requiresApproval,
    approved: input.approved,
  });
  if (!decision.allowed) throw new Error(decision.code);
  return manifest;
}
