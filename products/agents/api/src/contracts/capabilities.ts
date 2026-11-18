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
