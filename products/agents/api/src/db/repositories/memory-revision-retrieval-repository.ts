import type { Pool } from "pg";
import { query } from "../pool";
import type { MemoryKind, MemoryScope } from "../../memory/contracts";
import type { RetrievalCandidate, RetrievalRelationSummary } from "../../memory/retrieval-planner";
import { memoryDecayScore } from "../../memory/retention";

interface MemoryCandidateRow {
  revision_id: string;
  canonical_text: string;
  fact_key: string;
  subject_key: string;
  predicate_key: string;
  memory_type: "semantic" | "episodic";
  namespace: MemoryScope["namespace"];
  organization_id: string;
  installation_id: string;
  agent_definition_id: string;
  agent_version_id: string | null;
  conversation_id: string | null;
  end_user_id: string | null;
  workspace_id: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
  confidence: number | string | null;
  sensitivity: "normal" | "sensitive" | "restricted";
  source_trust: "user_explicit" | "platform_curated" | "model_inferred" | "imported" | "system_observed";
  source_event_ids: string[];
  lexical_score: number | string;
  semantic_score: number | string;
  usage_count: number | string;
  fact_key_match?: number | string;
}

interface MemoryRelationRow {
  relation_id: string | null;
  from_revision_id: string | null;
  to_revision_id: string | null;
  relation_type: RetrievalRelationSummary["relationType"] | null;
}

function iso(value: string | Date | null): string | undefined {
  return value === null ? undefined : new Date(value).toISOString();
}

function sourceTrustScore(value: MemoryCandidateRow["source_trust"]): number {
  switch (value) {
    case "user_explicit": return 1;
    case "platform_curated": return 0.95;
    case "system_observed": return 0.8;
    case "imported": return 0.65;
    case "model_inferred": return 0.45;
  }
}

/**
 * Read adapter for the append-only revision domain. It owns authorization and
 * scope filtering; the typed planner owns intent, ranking, and token budgets.
 */
export class MemoryRevisionRetrievalRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Run the lexical/vector, structured fact/entity, and temporal candidate
   * searches as one scoped fan-out. Each branch applies authorization and
   * lifecycle predicates before the results are merged by revision ID.
   */
  public async search(input: {
    organizationId: string;
    workspaceId: string;
    agentDefinitionId: string;
    agentVersionId: string;
    installationId: string;
    conversationId?: string;
    endUserId?: string;
    memoryKinds: readonly MemoryKind[];
    query: string;
    freshness: "current" | "historical" | "any";
    allowSensitive?: boolean;
    readableNamespaces?: readonly string[];
    queryEmbedding?: readonly number[];
    limit?: number;
  }): Promise<RetrievalCandidate[]> {
    const [textCandidates, structuredCandidates] = await Promise.all([
      this.searchText(input),
      this.searchStructured(input),
    ]);
    const merged = new Map<string, RetrievalCandidate>();
    for (const candidate of [...textCandidates, ...structuredCandidates]) {
      const existing = merged.get(candidate.revisionId);
      if (!existing) {
        merged.set(candidate.revisionId, candidate);
        continue;
      }
      merged.set(candidate.revisionId, {
        ...existing,
        lexicalScore: Math.max(existing.lexicalScore ?? 0, candidate.lexicalScore ?? 0),
        semanticScore: Math.max(existing.semanticScore ?? 0, candidate.semanticScore ?? 0),
        factKeyMatch: Math.max(existing.factKeyMatch ?? 0, candidate.factKeyMatch ?? 0),
        selectionReason: candidate.selectionReason === "structured_fact_or_entity_match"
          ? candidate.selectionReason
          : existing.selectionReason,
      });
    }
    const candidates = [...merged.values()];
    if (!candidates.length) return candidates;
    return this.attachRelations(input, candidates);
  }

  /**
   * Hydrate only content-free revision relations after the candidate fan-out.
   * Both endpoints are re-scoped through their facts so a relation cannot leak
   * lineage from another workspace or installation into a retrieval result.
   */
  private async attachRelations(
    input: { organizationId: string; workspaceId: string; installationId: string; agentDefinitionId: string },
    candidates: readonly RetrievalCandidate[],
  ): Promise<RetrievalCandidate[]> {
    const revisionIds = candidates.map((candidate) => candidate.revisionId);
    const result = await query<MemoryRelationRow>(
      this.pool,
      `SELECT relation.id AS relation_id,
              relation.from_revision_id,
              relation.to_revision_id,
              relation.relation_type
       FROM agent_memory_relations relation
       JOIN agent_memory_revisions from_revision ON from_revision.id = relation.from_revision_id
       JOIN agent_memory_facts from_fact ON from_fact.id = from_revision.fact_id
       JOIN agent_memory_revisions to_revision ON to_revision.id = relation.to_revision_id
       JOIN agent_memory_facts to_fact ON to_fact.id = to_revision.fact_id
       WHERE relation.organization_id = $1
         AND (relation.from_revision_id = ANY($2::uuid[])
           OR relation.to_revision_id = ANY($2::uuid[]))
         AND from_fact.organization_id = $1
         AND to_fact.organization_id = $1
         AND from_fact.workspace_id = $3
         AND to_fact.workspace_id = $3
         AND from_fact.installation_id = $4
         AND to_fact.installation_id = $4
         AND from_fact.agent_definition_id = $5
         AND to_fact.agent_definition_id = $5
       ORDER BY relation.created_at ASC, relation.id ASC`,
      [input.organizationId, revisionIds, input.workspaceId, input.installationId, input.agentDefinitionId],
    );
    const relationMap = new Map<string, RetrievalRelationSummary[]>();
    for (const row of result.rows) {
      if (!row.relation_type || !row.from_revision_id || !row.to_revision_id) continue;
      const add = (revisionId: string, relatedRevisionId: string) => {
        const relations = relationMap.get(revisionId) ?? [];
        if (!relations.some((entry) => entry.relatedRevisionId === relatedRevisionId && entry.relationType === row.relation_type)) {
          relations.push({ relationType: row.relation_type!, relatedRevisionId });
        }
        relationMap.set(revisionId, relations);
      };
      add(row.from_revision_id, row.to_revision_id);
      add(row.to_revision_id, row.from_revision_id);
    }
    return candidates.map((candidate) => {
      const relations = relationMap.get(candidate.revisionId);
      return relations?.length ? { ...candidate, relations } : candidate;
    });
  }

  private async searchText(input: {
    organizationId: string;
    workspaceId: string;
    agentDefinitionId: string;
    agentVersionId: string;
    installationId: string;
    conversationId?: string;
    endUserId?: string;
    memoryKinds: readonly MemoryKind[];
    query: string;
    freshness: "current" | "historical" | "any";
    allowSensitive?: boolean;
    readableNamespaces?: readonly string[];
    queryEmbedding?: readonly number[];
    limit?: number;
  }): Promise<RetrievalCandidate[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
    const queryText = input.query.trim().slice(0, 4_000);
    if (!queryText || input.memoryKinds.length === 0) return [];

    const result = await query<MemoryCandidateRow>(
      this.pool,
      `SELECT
         revision.id AS revision_id,
         revision.canonical_text,
         fact.fact_key,
         fact.subject_key,
         fact.predicate_key,
         fact.memory_type,
         fact.namespace,
         fact.organization_id,
         fact.installation_id,
         fact.agent_definition_id,
         fact.agent_version_id,
         fact.conversation_id,
         fact.end_user_id,
         fact.workspace_id,
         revision.valid_from,
         revision.valid_to,
         revision.confidence,
         revision.sensitivity,
         revision.source_trust,
         COALESCE(
           (SELECT array_agg(source.source_event_id ORDER BY source.source_event_type, source.source_event_id)
            FROM agent_memory_revision_sources source
            WHERE source.revision_id = revision.id),
           ARRAY[]::text[]
         ) AS source_event_ids,
         (SELECT COUNT(*)::text FROM agent_memory_quality_events quality
          WHERE quality.organization_id = fact.organization_id
            AND quality.revision_id = revision.id
            AND quality.event_type = 'usage') AS usage_count,
         LEAST(1.0, ts_rank_cd(
           fts.search_vector,
           plainto_tsquery('simple', $8)
         )) AS lexical_score,
         CASE
           WHEN $14::vector IS NULL OR vector.embedding_vector IS NULL THEN 0.0
           ELSE GREATEST(0.0, 1.0 - (vector.embedding_vector <=> $14::vector))
         END AS semantic_score
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       JOIN agent_installations ai ON ai.id = fact.installation_id
       JOIN agent_memory_fts_projections fts
         ON fts.revision_id = revision.id
        AND fts.fact_id = fact.id
        AND fts.organization_id = fact.organization_id
        AND fts.workspace_id = fact.workspace_id
        AND fts.agent_definition_id = fact.agent_definition_id
        AND fts.installation_id = fact.installation_id
        AND fts.lifecycle_state = revision.lifecycle_state
       LEFT JOIN agent_memory_vector_projections vector ON vector.revision_id = revision.id
       WHERE fact.organization_id = $1
         AND ai.organization_id = $1
         AND ai.scope_id = $2
         AND fact.workspace_id = $2
         AND fact.agent_definition_id = $3
         AND fact.installation_id = $4
         AND (fact.agent_version_id IS NULL OR fact.agent_version_id = $5)
         AND fact.memory_type = ANY($6::text[])
         AND revision.lifecycle_state = 'active'
         AND revision.visible_at IS NOT NULL
         AND ($12::boolean OR revision.sensitivity = 'normal')
         AND (fact.conversation_id IS NULL OR fact.conversation_id = $7)
         AND (fact.end_user_id IS NULL OR fact.end_user_id = $9)
         AND ($10 = 'historical' OR revision.valid_from <= now())
         AND ($10 <> 'current' OR revision.valid_to IS NULL OR revision.valid_to > now())
         AND ($10 <> 'current' OR NOT EXISTS (
           SELECT 1
           FROM agent_memory_revisions successor
           WHERE successor.predecessor_revision_id = revision.id
             AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
             AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
             AND successor.valid_from <= now()
         ))
         AND NOT EXISTS (
           SELECT 1
           FROM agent_memory_revisions expired_revision
           WHERE expired_revision.predecessor_revision_id = revision.id
             AND expired_revision.transition_type = 'expiration'
             AND expired_revision.valid_from <= now()
         )
         AND fact.namespace = ANY($13::text[])
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_conflicts conflict
           WHERE conflict.organization_id = fact.organization_id
             AND conflict.status = 'open'
             AND (conflict.left_revision_id = revision.id OR conflict.right_revision_id = revision.id)
         )
       ORDER BY (
         LEAST(1.0, ts_rank_cd(fts.search_vector, plainto_tsquery('simple', $8))) * 0.6 +
         CASE
           WHEN $14::vector IS NULL OR vector.embedding_vector IS NULL THEN 0.0
           ELSE GREATEST(0.0, 1.0 - (vector.embedding_vector <=> $14::vector))
         END * 0.4
       ) DESC, revision.valid_from DESC, revision.id ASC
       LIMIT $11`,
      [
        input.organizationId,
        input.workspaceId,
        input.agentDefinitionId,
        input.installationId,
        input.agentVersionId,
        [...new Set(input.memoryKinds.filter((kind): kind is "semantic" | "episodic" => kind === "semantic" || kind === "episodic"))],
        input.conversationId ?? null,
        queryText,
        input.endUserId ?? null,
        input.freshness,
        limit,
        input.allowSensitive === true,
        [...new Set(input.readableNamespaces ?? ["conversation", "end_user_private", "workspace_shared", "agent_private"])],
        input.queryEmbedding && input.queryEmbedding.length === 1_536 && input.queryEmbedding.every((value) => Number.isFinite(value))
          ? `[${input.queryEmbedding.join(",")}]`
          : null,
      ],
    );

    return result.rows.map((row) => {
      const validFrom = iso(row.valid_from)!;
      const validTo = iso(row.valid_to);
      const scope: MemoryScope = {
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        agentDefinitionId: row.agent_definition_id,
        agentVersionId: row.agent_version_id ?? input.agentVersionId,
        installationId: row.installation_id,
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        ...(row.end_user_id ? { endUserId: row.end_user_id } : {}),
        namespace: row.namespace,
      };
      return {
        revisionId: row.revision_id,
        text: row.canonical_text,
        kind: row.memory_type,
        factKey: row.fact_key,
        subjectKey: row.subject_key,
        predicateKey: row.predicate_key,
        scope,
        lifecycle: "active" as const,
        readiness: "visible" as const,
        sources: row.source_event_ids.map((sourceEventId) => ({
          sourceEventId,
          occurredAt: validFrom,
          relation: "derived" as const,
        })),
        validFrom,
        ...(validTo ? { validTo } : {}),
        ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
        sensitivity: row.sensitivity,
        sourceTrust: sourceTrustScore(row.source_trust),
        lexicalScore: Number(row.lexical_score),
        semanticScore: Number(row.semantic_score),
        usageCount: Number(row.usage_count),
        decayScore: memoryDecayScore({
          observedAt: validFrom,
          confidence: row.confidence === null ? undefined : Number(row.confidence),
          quality: { usage: Number(row.usage_count) },
        }),
        selectionReason: "typed_revision_scope",
      };
    });
  }

  private async searchStructured(input: {
    organizationId: string;
    workspaceId: string;
    agentDefinitionId: string;
    agentVersionId: string;
    installationId: string;
    conversationId?: string;
    endUserId?: string;
    memoryKinds: readonly MemoryKind[];
    query: string;
    freshness: "current" | "historical" | "any";
    allowSensitive?: boolean;
    readableNamespaces?: readonly string[];
    limit?: number;
  }): Promise<RetrievalCandidate[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
    const queryText = input.query.trim().slice(0, 4_000);
    const terms = [...new Set([queryText.toLowerCase(), ...queryText.toLowerCase().split(/[^a-z0-9:_-]+/gu).filter((term) => term.length >= 3)])].slice(0, 32);
    if (!queryText || input.memoryKinds.length === 0 || terms.length === 0) return [];
    const yearMatch = queryText.match(/\b(19|20)\d{2}\b/u);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const result = await query<MemoryCandidateRow>(
      this.pool,
      `SELECT
         revision.id AS revision_id,
         revision.canonical_text,
         fact.fact_key,
         fact.subject_key,
         fact.predicate_key,
         fact.memory_type,
         fact.namespace,
         fact.organization_id,
         fact.installation_id,
         fact.agent_definition_id,
         fact.agent_version_id,
         fact.conversation_id,
         fact.end_user_id,
         fact.workspace_id,
         revision.valid_from,
         revision.valid_to,
         revision.confidence,
         revision.sensitivity,
         revision.source_trust,
         COALESCE((SELECT array_agg(source.source_event_id ORDER BY source.source_event_type, source.source_event_id)
                   FROM agent_memory_revision_sources source WHERE source.revision_id = revision.id), ARRAY[]::text[]) AS source_event_ids,
         0.0::float AS lexical_score,
         0.0::float AS semantic_score,
         (SELECT COUNT(*)::text FROM agent_memory_quality_events quality
          WHERE quality.organization_id = fact.organization_id AND quality.revision_id = revision.id AND quality.event_type = 'usage') AS usage_count,
         CASE WHEN lower(fact.fact_key) = ANY($8::text[]) THEN 1.0
              WHEN EXISTS (SELECT 1 FROM unnest($8::text[]) term WHERE lower(fact.subject_key) LIKE '%' || term || '%' OR lower(fact.predicate_key) LIKE '%' || term || '%') THEN 0.8
              WHEN EXISTS (SELECT 1 FROM unnest($8::text[]) term WHERE lower(revision.canonical_text) LIKE '%' || term || '%') THEN 0.45
              ELSE 0.0 END AS fact_key_match
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       JOIN agent_installations ai ON ai.id = fact.installation_id
       WHERE fact.organization_id = $1
         AND ai.organization_id = $1
         AND ai.scope_id = $2
         AND fact.workspace_id = $2
         AND fact.agent_definition_id = $3
         AND fact.installation_id = $4
         AND (fact.agent_version_id IS NULL OR fact.agent_version_id = $5)
         AND fact.memory_type = ANY($6::text[])
         AND revision.lifecycle_state = 'active'
         AND revision.visible_at IS NOT NULL
         AND ($13::boolean OR revision.sensitivity = 'normal')
         AND (fact.conversation_id IS NULL OR fact.conversation_id = $7)
         AND (fact.end_user_id IS NULL OR fact.end_user_id = $9)
         AND ($10 = 'historical' OR revision.valid_from <= now())
         AND ($10 <> 'current' OR revision.valid_to IS NULL OR revision.valid_to > now())
         AND ($10 <> 'current' OR NOT EXISTS (
           SELECT 1 FROM agent_memory_revisions successor
           WHERE successor.predecessor_revision_id = revision.id
             AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
             AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
             AND successor.valid_from <= now()
         ))
         AND fact.namespace = ANY($11::text[])
         AND ($12::int IS NULL OR EXTRACT(YEAR FROM revision.valid_from) = $12::int)
         AND EXISTS (SELECT 1 FROM unnest($8::text[]) term
                     WHERE lower(fact.fact_key) LIKE '%' || term || '%'
                        OR lower(fact.subject_key) LIKE '%' || term || '%'
                        OR lower(fact.predicate_key) LIKE '%' || term || '%'
                        OR lower(revision.canonical_text) LIKE '%' || term || '%'
                        OR ($12::int IS NOT NULL AND EXTRACT(YEAR FROM revision.valid_from) = $12::int))
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_conflicts conflict
           WHERE conflict.organization_id = fact.organization_id AND conflict.status = 'open'
             AND (conflict.left_revision_id = revision.id OR conflict.right_revision_id = revision.id)
         )
       ORDER BY fact_key_match DESC, revision.valid_from DESC, revision.id ASC
       LIMIT $14`,
      [
        input.organizationId,
        input.workspaceId,
        input.agentDefinitionId,
        input.installationId,
        input.agentVersionId,
        [...new Set(input.memoryKinds.filter((kind): kind is "semantic" | "episodic" => kind === "semantic" || kind === "episodic"))],
        input.conversationId ?? null,
        terms,
        input.endUserId ?? null,
        input.freshness,
        [...new Set(input.readableNamespaces ?? ["conversation", "end_user_private", "workspace_shared", "agent_private"])],
        year,
        input.allowSensitive === true,
        limit,
      ],
    );
    return result.rows.map((row) => {
      const validFrom = iso(row.valid_from)!;
      const validTo = iso(row.valid_to);
      const scope: MemoryScope = {
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        agentDefinitionId: row.agent_definition_id,
        agentVersionId: row.agent_version_id ?? input.agentVersionId,
        installationId: row.installation_id,
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        ...(row.end_user_id ? { endUserId: row.end_user_id } : {}),
        namespace: row.namespace,
      };
      return {
        revisionId: row.revision_id,
        text: row.canonical_text,
        kind: row.memory_type,
        factKey: row.fact_key,
        subjectKey: row.subject_key,
        predicateKey: row.predicate_key,
        scope,
        lifecycle: "active" as const,
        readiness: "visible" as const,
        sources: row.source_event_ids.map((sourceEventId) => ({ sourceEventId, occurredAt: validFrom, relation: "derived" as const })),
        validFrom,
        ...(validTo ? { validTo } : {}),
        ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
        sensitivity: row.sensitivity,
        sourceTrust: sourceTrustScore(row.source_trust),
        lexicalScore: 0,
        semanticScore: 0,
        factKeyMatch: Number(row.fact_key_match ?? 0),
        usageCount: Number(row.usage_count),
        decayScore: memoryDecayScore({ observedAt: validFrom, confidence: row.confidence === null ? undefined : Number(row.confidence), quality: { usage: Number(row.usage_count) } }),
        selectionReason: "structured_fact_or_entity_match",
      };
    });
  }
}
