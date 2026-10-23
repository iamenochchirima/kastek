import { createHash } from "node:crypto";
import type { ProductCapabilityDescriptor, ProductCapabilityManifest } from "@kasitek-labs/contracts";

export function capabilityDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item instanceof Date) return JSON.stringify(item.toISOString());
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const workspaceAgentMetadataDescriptor: ProductCapabilityDescriptor = {
  operation: "agency.workspace_agents.read",
  revision: "1",
  description: "Read permitted Agency workspace agents' names, status and update times. Does not return agent configuration or conversation messages.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    agentId: { type: "string", minLength: 1, maxLength: 256 },
    after: { type: "string", minLength: 1, maxLength: 256 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  } },
  outputSchema: null,
  handlerRef: "agency.workspace-agent-metadata@1",
  policy: { effect: "read", disclosure: "approved_resource_identifiers", retry: "safe_read", approval: "none", cancel: "stop_admission" },
  requiredAuthority: ["agency.workspace.agent.read"],
  evidence: "versioned_sources",
  limits: { timeoutMs: 5000, maxPhysicalAttempts: 1, maxResponseBytes: 65536, maxModelResultBytes: 8192 },
};
export const agencyCapabilityAdapterManifest = {
  schemaVersion: 1 as const, id: "agency-product", release: "1",
  executableDigest: capabilityDigest({ transport: "signed-product-http-v1", handler: workspaceAgentMetadataDescriptor.handlerRef, release: "agency-metadata-v1" }),
  transports: ["native_http" as const], protocolVersions: [], boundedSchemaValidation: true as const,
};
const manifest = {
  schemaVersion: 1 as const, product: "agency", revision: "agency-metadata-v1",
  adapter: { id: "agency-product", release: "1", manifestDigest: capabilityDigest(agencyCapabilityAdapterManifest) },
  operations: [workspaceAgentMetadataDescriptor],
};
export const agencyCapabilityManifest: ProductCapabilityManifest = { ...manifest, digest: capabilityDigest(manifest) };
