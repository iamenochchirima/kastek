/** Optional Memory capability descriptor used by setup and the HTTP interface. */
export const memoryCapability = {
  id: "memory",
  title: "Memory",
  optional: true,
  /** Personal, scoped memory with review, correction and forgetting. */
  agentBasePath: "/api/organizations/:organizationId/agents/:agentId",
  summary: "Retain accepted information across conversations with correction and forgetting.",
} as const;

/** Setup readiness for an agent configuration. Memory is off unless explicitly enabled. */
export function memoryReadiness(configuration: { memory?: { enabled?: boolean } | null }): { state: "disabled" | "enabled" } {
  return { state: configuration.memory?.enabled ? "enabled" : "disabled" };
}
