import type { Catalogue, CatalogueItem } from "../src/platform/api";

export function catalogueItem(id: string, name: string, tools: CatalogueItem["configuration"]["tools"] = []): CatalogueItem {
  return { id, name, revision: 1, digest: "digest", kind: "builtin", description: `Approved ${name.toLowerCase()} for this agent.`, publisher: { id: "kasitek", name: "KasiTek", verified: true }, purposes: ["faq"], products: ["agents"], executionKinds: ["business"], requires: { connectionProfiles: [], permissions: [] }, readiness: { state: "ready", reasons: [] }, added: false, recommended: true, action: { kind: "add" }, configuration: { tools, connectedToolBindingIds: [], skillIds: [] } };
}
export const toolCatalogue: Catalogue = { schemaVersion: 1, revision: "2026-10-20.1", agentId: "root", entries: [
  catalogueItem("knowledge-search", "Knowledge search", ["knowledge.search"]),
  catalogueItem("knowledge-read", "Read knowledge", ["knowledge.read"]),
  catalogueItem("human-handoff", "Human support", ["channel.request_handoff"]),
] };
