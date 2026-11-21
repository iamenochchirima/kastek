/** Optional Knowledge capability descriptor used by setup and the HTTP interface. */
export const knowledgeCapability = {
  id: "knowledge",
  title: "Knowledge",
  optional: true,
  /** Workspace sources, import jobs, review decisions and retrieval. */
  basePath: "/api/organizations/:organizationId/knowledge",
  agentTestPath: "/api/organizations/:organizationId/agents/:agentId/knowledge/test",
  summary: "Upload, review and assign workspace sources with retrieval provenance.",
} as const;

/** Setup readiness for an agent configuration. Source approval still gates retrieval. */
export function knowledgeReadiness(configuration: { sourceRevisionIds: readonly string[] }): { configured: number; state: "unconfigured" | "ready" } {
  return { configured: configuration.sourceRevisionIds.length, state: configuration.sourceRevisionIds.length ? "ready" : "unconfigured" };
}
