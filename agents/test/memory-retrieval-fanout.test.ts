import { describe, expect, it, vi } from "vitest";
import { MemoryRevisionRetrievalRepository } from "../src/db/repositories/memory-revision-retrieval-repository";

const row = {
  revision_id: "revision-1",
  canonical_text: "Concise replies",
  fact_key: "reply_style",
  subject_key: "actor:user-1",
  predicate_key: "reply_style",
  memory_type: "semantic",
  namespace: "agent_private",
  organization_id: "org-1",
  installation_id: "installation-1",
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  conversation_id: null,
  end_user_id: null,
  workspace_id: "workspace-1",
  valid_from: "2026-09-07T00:00:00.000Z",
  valid_to: null,
  confidence: "0.9",
  source_trust: "user_explicit",
  source_event_ids: ["source-1"],
  lexical_score: "0.8",
  semantic_score: "0.4",
  usage_count: "1",
  fact_key_match: "1",
};

describe("memory retrieval candidate fan-out", () => {
  it("runs text/vector and structured/temporal branches in parallel and merges by revision", async () => {
    const query = vi.fn(async (text: string) => text.includes("agent_memory_relations")
      ? {
        rows: [{
          relation_id: "relation-1",
          from_revision_id: "revision-1",
          to_revision_id: "revision-2",
          relation_type: "contradicts",
        }],
      }
      : { rows: [row] });
    const repository = new MemoryRevisionRetrievalRepository({ query } as never);
    const candidates = await repository.search({
      organizationId: "org-1", workspaceId: "workspace-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1",
      memoryKinds: ["semantic"], query: "reply style", freshness: "current", limit: 8,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      revisionId: "revision-1",
      factKeyMatch: 1,
      lexicalScore: 0.8,
      semanticScore: 0.4,
      relations: [{ relationType: "contradicts", relatedRevisionId: "revision-2" }],
    });
  });
});
