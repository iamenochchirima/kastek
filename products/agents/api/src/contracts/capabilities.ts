export type CapabilityId = "tools" | "knowledge" | "memory" | "handoff" | "delegation" | "workflows" | "skills"
  | "schedules" | "code" | "browser";
export type CapabilityAvailability = "available" | "deferred";

const prefixes: ReadonlyArray<[CapabilityId, string]> = [
  ["knowledge", "knowledge."], ["memory", "memory."], ["skills", "skills."],
  ["delegation", "agents."], ["handoff", "channel.request_handoff"], ["workflows", "workflow."],
  ["schedules", "schedule."], ["code", "code."], ["browser", "browser."],
];
export const deferredCapabilities: ReadonlySet<CapabilityId> = new Set(["schedules", "code", "browser"]);

/** Capability that owns an operation name; plain operations belong to Tools. */
export function capabilityForOperation(name: string): CapabilityId {
  return prefixes.find(([, prefix]) => name === prefix || name.startsWith(prefix))?.[0] ?? "tools";
}
export function operationCapabilityDeferred(name: string): boolean {
  return deferredCapabilities.has(capabilityForOperation(name));
}

type ConfigurationLike = {
  tools: readonly string[]; sourceRevisionIds: readonly string[]; connectedToolBindingIds: readonly string[];
  skillIds: readonly string[]; memory: { enabled: boolean };
  capabilities: { delegation: { enabled: boolean }; workflows?: { enabled: boolean } | null };
};

/** Capabilities a configuration currently enables. Deferred capabilities are never included. */
export function enabledCapabilities(configuration: ConfigurationLike): CapabilityId[] {
  const enabled: CapabilityId[] = [];
  if (configuration.tools.length || configuration.connectedToolBindingIds.length) enabled.push("tools");
  if (configuration.sourceRevisionIds.length) enabled.push("knowledge");
  if (configuration.memory.enabled) enabled.push("memory");
  if (configuration.tools.includes("channel.request_handoff")) enabled.push("handoff");
  if (configuration.capabilities.delegation.enabled) enabled.push("delegation");
  if (configuration.capabilities.workflows?.enabled) enabled.push("workflows");
  if (configuration.skillIds.length) enabled.push("skills");
  return enabled;
}
