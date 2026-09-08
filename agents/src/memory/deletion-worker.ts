import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { runWithRequiredDatabaseContext } from "../db/context";
import {
  MemoryDeletionJobRepository,
  type MemoryDeletionJobRecord,
  type MemoryDeletionPurgeCounts,
} from "../db/repositories/memory-deletion-job-repository";
import { assertNoActiveLegalHold, purgeMemoryRecords } from "../db/repositories/memory-repository";
import { operationalLogger } from "../telemetry/logger";
import { recordMemoryDeletion, recordQueueAge, recordRetry, withSpan } from "../telemetry/spans";
import { finalizeReadyAgentDeletions } from "./agent-deletion-finalizer";
import { createMemoryDeletionAnalyticsSink, scopeInput, type MemoryDeletionAnalyticsSink } from "./deletion-analytics";

export interface MemoryDeletionWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  holdRetryMs: number;
}

export type MemoryDeletionPurger = (job: MemoryDeletionJobRecord) => Promise<MemoryDeletionPurgeCounts>;

export interface MemoryDeletionWorkerDependencies {
  jobs?: MemoryDeletionJobRepository;
  purge?: MemoryDeletionPurger;
  workerId?: string;
  finalizeAgentDeletions?: (limit: number) => Promise<number>;
  analytics?: MemoryDeletionAnalyticsSink;
  analyticsPool?: Pool;
}

export function deletionRetryDelayMs(attemptCount: number, baseDelayMs = 2_000, maxDelayMs = 300_000): number {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : 2_000;
  const max = Number.isFinite(maxDelayMs) && maxDelayMs >= base ? maxDelayMs : Math.max(base, 300_000);
  return Math.min(max, base * (2 ** Math.min(attempt - 1, 16)));
}

async function selectIds(client: PoolClient, queryText: string, values: readonly unknown[]): Promise<string[]> {
  const result = await client.query<{ id: string }>(queryText, [...values]);
  return result.rows.map((row) => row.id);
}

/**
 * Canonical purge is transactional, but a successful transaction must also
 * prove that every local projection disappeared.  Foreign-key cascades are a
 * useful safety net; they are not a sufficient deletion contract because a
 * projection can be detached or introduced by a later migration.  Keep this
 * check code-only and scoped to the selected canonical fact IDs.
 */
export async function assertNoResidualRevisionData(
  client: PoolClient,
  input: { organizationId: string; factIds: readonly string[]; revisionIds: readonly string[] },
): Promise<void> {
  if (input.factIds.length === 0 && input.revisionIds.length === 0) return;
  const checks: Array<{ table: string; predicate: string; values: readonly unknown[] }> = [];
  if (input.factIds.length) {
    const values = [input.organizationId, [...new Set(input.factIds)]] as const;
    checks.push({ table: "agent_memory_facts", predicate: "organization_id = $1 AND id::text = ANY($2::text[])", values });
    for (const table of [
      "agent_memory_revisions",
      "agent_memory_projection_outbox",
      "agent_memory_projection_readiness",
      "agent_memory_fts_projections",
      "agent_memory_temporal_projections",
      "agent_memory_vector_projections",
      "agent_memory_provider_projection_receipts",
    ]) {
      checks.push({ table, predicate: "organization_id = $1 AND fact_id::text = ANY($2::text[])", values });
    }
  }
  if (input.revisionIds.length) {
    const values = [input.organizationId, [...new Set(input.revisionIds)]] as const;
    checks.push(
      { table: "agent_memory_revision_sources", predicate: "organization_id = $1 AND revision_id::text = ANY($2::text[])", values },
      { table: "agent_memory_relations", predicate: "organization_id = $1 AND (from_revision_id::text = ANY($2::text[]) OR to_revision_id::text = ANY($2::text[]))", values },
    );
  }
  for (const check of checks) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${check.table} WHERE ${check.predicate}`,
      [...check.values],
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) {
      throw Object.assign(new Error("Memory deletion left residual local projection data"), {
        code: "MEMORY_DELETION_RESIDUAL_PROJECTION",
      });
    }
  }
}

async function purgeRevisionFacts(
  client: PoolClient,
  input: { organizationId: string; factIds?: readonly string[]; conversationIds?: readonly string[]; all?: boolean },
): Promise<number> {
  const factIds = input.factIds?.length
    ? [...new Set(input.factIds)]
    : await selectIds(
      client,
      input.conversationIds?.length
        ? "SELECT id::text AS id FROM agent_memory_facts WHERE organization_id = $1 AND conversation_id::text = ANY($2::text[])"
        : input.all
          ? "SELECT id::text AS id FROM agent_memory_facts WHERE organization_id = $1"
          : "SELECT id::text AS id FROM agent_memory_facts WHERE false",
      input.conversationIds?.length ? [input.organizationId, [...new Set(input.conversationIds)]] : [input.organizationId],
    );
  // A conversation may have source events but no derived fact yet.  Continue
  // through source/checkpoint cleanup for that case; an unrelated target has
  // nothing to purge.
  if (!factIds.length && !input.conversationIds?.length && !input.all) return 0;

  const revisionIds = await selectIds(
    client,
    factIds.length
      ? "SELECT id::text AS id FROM agent_memory_revisions WHERE organization_id = $1 AND fact_id::text = ANY($2::text[])"
      : input.all
        ? "SELECT id::text AS id FROM agent_memory_revisions WHERE organization_id = $1"
        : "SELECT id::text AS id FROM agent_memory_revisions WHERE false",
    factIds.length ? [input.organizationId, factIds] : [input.organizationId],
  );
  const sourceEventIds = revisionIds.length
    ? await selectIds(
      client,
      "SELECT DISTINCT source_event_id AS id FROM agent_memory_revision_sources WHERE organization_id = $1 AND revision_id::text = ANY($2::text[])",
      [input.organizationId, revisionIds],
    )
    : [];

  if (revisionIds.length) {
    await client.query(
      `DELETE FROM agent_memory_relations
       WHERE organization_id = $1
         AND (from_revision_id::text = ANY($2::text[]) OR to_revision_id::text = ANY($2::text[]))`,
      [input.organizationId, revisionIds],
    );
    await client.query(
      `DELETE FROM agent_memory_revision_sources
       WHERE organization_id = $1 AND revision_id::text = ANY($2::text[])`,
      [input.organizationId, revisionIds],
    );
    await client.query(
      `DELETE FROM agent_memory_revisions
       WHERE organization_id = $1 AND id::text = ANY($2::text[])`,
      [input.organizationId, revisionIds],
    );
  }
  if (factIds.length) {
    await client.query(
      `DELETE FROM agent_memory_facts
       WHERE organization_id = $1 AND id::text = ANY($2::text[])`,
      [input.organizationId, factIds],
    );
  }

  const sourceScope = input.conversationIds?.length
    ? "conversation_id::text = ANY($2::text[])"
    : input.all ? "TRUE" : "FALSE";
  const sourceScopeValues = input.conversationIds?.length
    ? [input.organizationId, [...new Set(input.conversationIds)]]
    : [input.organizationId];
  await client.query(
    `DELETE FROM memory_checkpoints
     WHERE organization_id = $1
       AND (${sourceEventIds.length ? "source_event_id::text = ANY($2::text[])" : "FALSE"}
         OR ${sourceScope.replaceAll("$2", sourceEventIds.length ? "$3" : "$2")})`,
    sourceEventIds.length
      ? [input.organizationId, sourceEventIds, ...sourceScopeValues.slice(1)]
      : sourceScopeValues,
  );

  if (sourceEventIds.length) {
    await client.query(
      `DELETE FROM memory_source_events source
       WHERE source.organization_id = $1
         AND source.id::text = ANY($2::text[])
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_revision_sources reference
           WHERE reference.organization_id = source.organization_id
             AND reference.source_event_id = source.id::text
         )`,
      [input.organizationId, sourceEventIds],
    );
  }
  if (input.conversationIds?.length || input.all) {
    await client.query(
      `DELETE FROM memory_source_events source
       WHERE source.organization_id = $1
         AND ${input.conversationIds?.length ? "source.conversation_id::text = ANY($2::text[])" : "TRUE"}
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_revision_sources reference
           WHERE reference.organization_id = source.organization_id
             AND reference.source_event_id = source.id::text
         )`,
      input.conversationIds?.length ? [input.organizationId, [...new Set(input.conversationIds)]] : [input.organizationId],
    );
  }
  await assertNoResidualRevisionData(client, { organizationId: input.organizationId, factIds, revisionIds });
  return factIds.length;
}

async function enqueueProviderDeletionJobs(
  client: PoolClient,
  input: { organizationId: string; deletionJobId: string; factIds: readonly string[] },
): Promise<number> {
  if (!input.factIds.length) return 0;
  const result = await client.query<{ count: string }>(
    `WITH candidates AS (
       SELECT DISTINCT ON (receipt.provider_name, receipt.provider_record_id, receipt.content_digest)
         receipt.provider_name,
         receipt.provider_record_id,
         receipt.content_digest,
         fact.workspace_id,
         fact.installation_id,
         receipt.revision_id
       FROM agent_memory_provider_projection_receipts receipt
       JOIN agent_memory_facts fact ON fact.id = receipt.fact_id
       WHERE receipt.organization_id = $1
         AND receipt.fact_id::text = ANY($2::text[])
         AND receipt.provider_record_id IS NOT NULL
         AND receipt.provider_state <> 'deleted'
       ORDER BY receipt.provider_name, receipt.provider_record_id, receipt.content_digest, receipt.updated_at DESC
     ), inserted AS (
       INSERT INTO agent_memory_provider_deletion_jobs
         (deletion_job_id, organization_id, workspace_id, installation_id, provider_name,
          provider_record_id, content_digest, operation_id)
       SELECT $3, $1, candidates.workspace_id, candidates.installation_id,
              candidates.provider_name, candidates.provider_record_id, candidates.content_digest,
              'memory-delete:' || candidates.revision_id::text
       FROM candidates
       ON CONFLICT (organization_id, provider_name, provider_record_id, content_digest)
       DO UPDATE SET deletion_job_id = COALESCE(agent_memory_provider_deletion_jobs.deletion_job_id, EXCLUDED.deletion_job_id),
                     operation_id = EXCLUDED.operation_id,
                     status = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN 'completed' ELSE 'queued' END,
                     attempt_count = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN agent_memory_provider_deletion_jobs.attempt_count ELSE 0 END,
                     lease_owner = NULL,
                     lease_expires_at = NULL,
                     completed_at = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN agent_memory_provider_deletion_jobs.completed_at ELSE NULL END,
                     updated_at = now()
       RETURNING id
     )
     SELECT count(*)::text FROM inserted`,
    [input.organizationId, [...input.factIds], input.deletionJobId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function v2FactIdsForMemory(client: PoolClient, organizationId: string, targetId: string): Promise<string[]> {
  return selectIds(client, "SELECT id::text AS id FROM agent_memory_facts WHERE organization_id = $1 AND id::text = $2", [organizationId, targetId]);
}

async function v2FactIdsForTarget(client: PoolClient, job: MemoryDeletionJobRecord): Promise<string[]> {
  if (job.target_type === "agent") {
    return selectIds(client, "SELECT id::text AS id FROM agent_memory_facts WHERE organization_id = $1 AND agent_definition_id::text = $2", [job.organization_id, job.target_id]);
  }
  if (job.target_type === "workspace") {
    return selectIds(client, `SELECT fact.id::text AS id
      FROM agent_memory_facts fact
      JOIN agent_installations installation ON installation.id = fact.installation_id
      WHERE fact.organization_id = $1 AND installation.scope_id = $2`, [job.organization_id, job.target_id]);
  }
  return selectIds(client, `SELECT id::text AS id
    FROM agent_memory_facts
    WHERE organization_id = $1 AND end_user_id = $2`, [job.organization_id, job.target_id]);
}

async function installationIdsForTarget(client: PoolClient, job: MemoryDeletionJobRecord): Promise<string[]> {
  if (job.target_type === "agent") {
    return selectIds(client, "SELECT id::text AS id FROM agent_installations WHERE organization_id = $1 AND agent_definition_id::text = $2", [job.organization_id, job.target_id]);
  }
  if (job.target_type === "workspace") {
    return selectIds(client, "SELECT id::text AS id FROM agent_installations WHERE organization_id = $1 AND scope_id = $2", [job.organization_id, job.target_id]);
  }
  return selectIds(client, `SELECT DISTINCT installation_id::text AS id
    FROM memory_records WHERE organization_id = $1 AND owner_user_id = $2 AND installation_id IS NOT NULL
    UNION
    SELECT DISTINCT installation_id::text AS id
    FROM agent_memory_facts WHERE organization_id = $1 AND end_user_id = $2`, [job.organization_id, job.target_id]);
}

async function conversationIdsForTarget(client: PoolClient, job: MemoryDeletionJobRecord, installationIds: readonly string[]): Promise<string[]> {
  if (job.target_type === "user") {
    return selectIds(client, `SELECT DISTINCT conversation_id::text AS id FROM memory_records
      WHERE organization_id = $1 AND owner_user_id = $2 AND conversation_id IS NOT NULL
      UNION
      SELECT DISTINCT conversation_id::text AS id FROM agent_memory_facts
      WHERE organization_id = $1 AND end_user_id = $2 AND conversation_id IS NOT NULL`, [job.organization_id, job.target_id]);
  }
  if (installationIds.length === 0) return [];
  return selectIds(client, `SELECT DISTINCT id::text AS id
    FROM conversations WHERE organization_id = $1 AND installation_id::text = ANY($2::text[])`, [job.organization_id, [...installationIds]]);
}

/** Purges all currently supported canonical and derived memory projections. */
export async function purgeMemoryDeletionJob(pool: Pool, job: MemoryDeletionJobRecord): Promise<MemoryDeletionPurgeCounts> {
  return withTransaction(pool, async (client) => {
    if (job.target_type === "memory") {
      const v2FactIds = await v2FactIdsForMemory(client, job.organization_id, job.target_id);
      if (v2FactIds.length) {
        const scope = (await client.query<{ installation_id: string; conversation_id: string | null }>(
          "SELECT installation_id::text, conversation_id::text FROM agent_memory_facts WHERE organization_id = $1 AND id::text = ANY($2::text[])",
          [job.organization_id, v2FactIds],
        )).rows;
        await assertNoActiveLegalHold(client, {
          organizationId: job.organization_id,
          installationIds: scope.map((row) => row.installation_id),
          conversationIds: scope.flatMap((row) => row.conversation_id ? [row.conversation_id] : []),
        });
        const providerDeletionCount = await enqueueProviderDeletionJobs(client, {
          organizationId: job.organization_id,
          deletionJobId: job.id,
          factIds: v2FactIds,
        });
        return {
          memoryCount: await purgeRevisionFacts(client, { organizationId: job.organization_id, factIds: v2FactIds }),
          conversationCount: 0,
          knowledgeChunkCount: 0,
          providerDeletionCount,
        };
      }
      const purged = await purgeMemoryRecords(client, {
        organizationId: job.organization_id,
        memoryIds: [job.target_id],
      });
      await client.query(
        "DELETE FROM agent_memory_migration_receipts WHERE organization_id = $1 AND legacy_memory_id::text = $2",
        [job.organization_id, job.target_id],
      );
      return {
        memoryCount: purged.memoryIds.length,
        conversationCount: purged.conversationIds.length,
        knowledgeChunkCount: 0,
        providerDeletionCount: 0,
      };
    }

    if (job.target_type === "conversation") {
      const v2Facts = await client.query<{ id: string; installation_id: string; conversation_id: string }>(
        "SELECT id::text, installation_id::text, conversation_id::text FROM agent_memory_facts WHERE organization_id = $1 AND conversation_id::text = $2",
        [job.organization_id, job.target_id],
      );
      const v2SourceScope = await client.query<{ installation_id: string; conversation_id: string | null }>(
        `SELECT DISTINCT installation_id::text, conversation_id::text
         FROM memory_source_events
         WHERE organization_id = $1 AND conversation_id::text = $2`,
        [job.organization_id, job.target_id],
      );
      await assertNoActiveLegalHold(client, {
        organizationId: job.organization_id,
        installationIds: [...v2Facts.rows.map((row) => row.installation_id), ...v2SourceScope.rows.map((row) => row.installation_id)],
        conversationIds: [job.target_id],
      });
      const providerDeletionCount = await enqueueProviderDeletionJobs(client, {
        organizationId: job.organization_id,
        deletionJobId: job.id,
        factIds: v2Facts.rows.map((row) => row.id),
      });
      const v2Count = await purgeRevisionFacts(client, { organizationId: job.organization_id, conversationIds: [job.target_id] });
      const purged = await purgeMemoryRecords(client, {
        organizationId: job.organization_id,
        conversationIds: [job.target_id],
      });
      if (purged.memoryIds.length) {
        await client.query(
          "DELETE FROM agent_memory_migration_receipts WHERE organization_id = $1 AND legacy_memory_id::text = ANY($2::text[])",
          [job.organization_id, purged.memoryIds],
        );
      }
      return {
        memoryCount: v2Count + purged.memoryIds.length,
        conversationCount: purged.conversationIds.length,
        knowledgeChunkCount: 0,
        providerDeletionCount,
      };
    }

    if (job.target_type === "knowledge_source") {
      const source = (await client.query<{ installation_id: string | null }>(
        `SELECT installation_id::text
         FROM knowledge_sources
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [job.target_id, job.organization_id],
      )).rows[0];
      if (!source) return { memoryCount: 0, conversationCount: 0, knowledgeChunkCount: 0, providerDeletionCount: 0 };
      await assertNoActiveLegalHold(client, {
        organizationId: job.organization_id,
        installationIds: source.installation_id ? [source.installation_id] : [],
      });
      const chunks = await client.query(
        "DELETE FROM knowledge_chunks WHERE source_id = $1 AND organization_id = $2 RETURNING id",
        [job.target_id, job.organization_id],
      );
      await client.query(
        "DELETE FROM knowledge_sources WHERE id = $1 AND organization_id = $2",
        [job.target_id, job.organization_id],
      );
      return { memoryCount: 0, conversationCount: 0, knowledgeChunkCount: chunks.rowCount ?? 0, providerDeletionCount: 0 };
    }

    if (job.target_type === "user" || job.target_type === "agent" || job.target_type === "workspace") {
      const installationIds = await installationIdsForTarget(client, job);
      const conversationIds = await conversationIdsForTarget(client, job, installationIds);
      const factIds = await v2FactIdsForTarget(client, job);
      const legacyMemoryIds = await selectIds(client,
        job.target_type === "user"
          ? "SELECT id::text AS id FROM memory_records WHERE organization_id = $1 AND owner_user_id = $2"
          : job.target_type === "agent"
            ? "SELECT id::text AS id FROM memory_records WHERE organization_id = $1 AND agent_definition_id::text = $2"
            : `SELECT memory.id::text AS id FROM memory_records memory
               JOIN agent_installations installation ON installation.id = memory.installation_id
               WHERE memory.organization_id = $1 AND installation.scope_id = $2`,
        [job.organization_id, job.target_id],
      );
      await assertNoActiveLegalHold(client, {
        organizationId: job.organization_id,
        installationIds,
        conversationIds,
      });
      const providerDeletionCount = await enqueueProviderDeletionJobs(client, {
        organizationId: job.organization_id,
        deletionJobId: job.id,
        factIds,
      });
      const v2Count = await purgeRevisionFacts(client, { organizationId: job.organization_id, factIds });
      const purged = await purgeMemoryRecords(client, { organizationId: job.organization_id, memoryIds: legacyMemoryIds });
      if (legacyMemoryIds.length) {
        await client.query(
          "DELETE FROM agent_memory_migration_receipts WHERE organization_id = $1 AND legacy_memory_id::text = ANY($2::text[])",
          [job.organization_id, legacyMemoryIds],
        );
      }

      // Source events may not yet have a derived revision (for example, a
      // queued extraction). Remove them by the same ownership selector so a
      // later consolidation worker cannot resurrect forgotten content.
      if (job.target_type === "user") {
        await client.query(`DELETE FROM memory_source_events
          WHERE organization_id = $1 AND end_user_id = $2`, [job.organization_id, job.target_id]);
      } else if (installationIds.length) {
        await client.query(`DELETE FROM memory_source_events
          WHERE organization_id = $1 AND installation_id::text = ANY($2::text[])`, [job.organization_id, [...installationIds]]);
      }

      let knowledgeChunkCount = 0;
      if (job.target_type !== "user") {
        const sources = await client.query<{ id: string }>(
          job.target_type === "agent"
            ? "SELECT id::text FROM knowledge_sources WHERE organization_id = $1 AND agent_definition_id::text = $2"
            : `SELECT source.id::text FROM knowledge_sources source
               JOIN agent_installations installation ON installation.id = source.installation_id
               WHERE source.organization_id = $1 AND installation.scope_id = $2`,
          [job.organization_id, job.target_id],
        );
        if (sources.rows.length) {
          const sourceIds = sources.rows.map((row) => row.id);
          const chunks = await client.query("DELETE FROM knowledge_chunks WHERE organization_id = $1 AND source_id::text = ANY($2::text[]) RETURNING id", [job.organization_id, sourceIds]);
          knowledgeChunkCount = chunks.rowCount ?? 0;
          await client.query("DELETE FROM knowledge_sources WHERE organization_id = $1 AND id::text = ANY($2::text[])", [job.organization_id, sourceIds]);
        }
      }
      if (factIds.length) {
        await client.query("DELETE FROM agent_memory_retention_rules WHERE organization_id = $1 AND scope_type = 'record' AND fact_id::text = ANY($2::text[])", [job.organization_id, factIds]);
      }
      const workspaceIds = installationIds.length
        ? await selectIds(client, "SELECT DISTINCT scope_id AS id FROM agent_installations WHERE organization_id = $1 AND id::text = ANY($2::text[])", [job.organization_id, installationIds])
        : [];
      if (workspaceIds.length) {
        await client.query("DELETE FROM agent_memory_retention_rules WHERE organization_id = $1 AND scope_type = 'workspace' AND scope_id = ANY($2::text[])", [job.organization_id, workspaceIds]);
        await client.query("DELETE FROM agent_memory_maintenance_jobs WHERE organization_id = $1 AND workspace_id = ANY($2::text[])", [job.organization_id, workspaceIds]);
      }
      return { memoryCount: v2Count + purged.memoryIds.length, conversationCount: purged.conversationIds.length, knowledgeChunkCount, providerDeletionCount };
    }

    // Organization deletion is intentionally explicit: gather the bounded
    // selectors first, then pass them through the same hold-aware purge path.
    const memoryIds = await selectIds(client, "SELECT id::text AS id FROM memory_records WHERE organization_id = $1", [job.organization_id]);
    const conversationIds = await selectIds(
      client,
      `SELECT DISTINCT conversation_id::text AS id
       FROM memory_records
       WHERE organization_id = $1 AND conversation_id IS NOT NULL
       UNION
       SELECT DISTINCT conversation_id::text AS id
       FROM conversation_summaries
       WHERE organization_id = $1`,
      [job.organization_id],
    );
    const installationIds = await selectIds(client, "SELECT DISTINCT installation_id::text AS id FROM memory_records WHERE organization_id = $1 AND installation_id IS NOT NULL", [job.organization_id]);
    const sourceInstallationIds = await selectIds(client, "SELECT DISTINCT installation_id::text AS id FROM knowledge_sources WHERE organization_id = $1 AND installation_id IS NOT NULL", [job.organization_id]);
    const v2InstallationIds = await selectIds(client, "SELECT DISTINCT installation_id::text AS id FROM agent_memory_facts WHERE organization_id = $1", [job.organization_id]);
    const v2ConversationIds = await selectIds(client, "SELECT DISTINCT conversation_id::text AS id FROM agent_memory_facts WHERE organization_id = $1 AND conversation_id IS NOT NULL", [job.organization_id]);
    const v2SourceInstallationIds = await selectIds(client, "SELECT DISTINCT installation_id::text AS id FROM memory_source_events WHERE organization_id = $1 AND installation_id IS NOT NULL", [job.organization_id]);
    const v2SourceConversationIds = await selectIds(client, "SELECT DISTINCT conversation_id::text AS id FROM memory_source_events WHERE organization_id = $1 AND conversation_id IS NOT NULL", [job.organization_id]);
    await assertNoActiveLegalHold(client, {
      organizationId: job.organization_id,
      installationIds: [...installationIds, ...sourceInstallationIds, ...v2InstallationIds, ...v2SourceInstallationIds],
      conversationIds: [...conversationIds, ...v2ConversationIds, ...v2SourceConversationIds],
    });
    const providerDeletionCount = await enqueueProviderDeletionJobs(client, {
      organizationId: job.organization_id,
      deletionJobId: job.id,
      factIds: await selectIds(client, "SELECT id::text AS id FROM agent_memory_facts WHERE organization_id = $1", [job.organization_id]),
    });
    const v2Count = await purgeRevisionFacts(client, { organizationId: job.organization_id, all: true });
    const purged = await purgeMemoryRecords(client, {
      organizationId: job.organization_id,
      memoryIds,
      conversationIds,
    });
    await client.query("DELETE FROM agent_memory_migration_receipts WHERE organization_id = $1", [job.organization_id]);
    // Source events are immutable during normal operation, but an approved
    // organization deletion is the system-owned purge boundary. Remove the
    // captured evidence here so queued extraction cannot resurrect deleted
    // memory after the canonical facts have been purged.
    await client.query("DELETE FROM memory_source_events WHERE organization_id = $1", [job.organization_id]);
    const chunks = await client.query(
      `DELETE FROM knowledge_chunks
       WHERE organization_id = $1
       RETURNING id`,
      [job.organization_id],
    );
    await client.query("DELETE FROM knowledge_sources WHERE organization_id = $1", [job.organization_id]);
    await client.query("DELETE FROM agent_memory_retention_rules WHERE organization_id = $1", [job.organization_id]);
    await client.query("DELETE FROM agent_memory_maintenance_jobs WHERE organization_id = $1", [job.organization_id]);
    return {
      memoryCount: v2Count + purged.memoryIds.length,
      conversationCount: purged.conversationIds.length,
      knowledgeChunkCount: chunks.rowCount ?? 0,
      providerDeletionCount,
    };
  });
}

export class MemoryDeletionWorker {
  private readonly jobs: MemoryDeletionJobRepository;
  private readonly purge: MemoryDeletionPurger;
  private readonly workerId: string;
  private readonly finalizeAgentDeletions: (limit: number) => Promise<number>;
  private readonly analytics?: MemoryDeletionAnalyticsSink;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryDeletionWorkerSettings,
    dependencies: MemoryDeletionWorkerDependencies = {},
  ) {
    this.jobs = dependencies.jobs ?? new MemoryDeletionJobRepository(pool);
    this.purge = dependencies.purge ?? ((job) => purgeMemoryDeletionJob(pool, job));
    this.workerId = dependencies.workerId?.trim() || `memory-deletion-${randomUUID()}`;
    this.finalizeAgentDeletions = dependencies.finalizeAgentDeletions
      ?? (typeof (pool as unknown as { query?: unknown }).query === "function"
        ? (limit) => finalizeReadyAgentDeletions(pool, limit)
        : async () => 0);
    this.analytics = dependencies.analytics
      ?? (dependencies.analyticsPool ? createMemoryDeletionAnalyticsSink(dependencies.analyticsPool) : undefined);
  }

  public stop(): void {
    this.stopping = true;
  }

  public async runOnce(organizationId?: string): Promise<number> {
    const operation = this.runOnceInternal(organizationId);
    this.activeRuns.add(operation);
    try {
      return await operation;
    } finally {
      this.activeRuns.delete(operation);
    }
  }

  /** Bound shutdown while preserving lease expiry as the recovery mechanism. */
  public async shutdown(timeoutMs = 30_000): Promise<{ drained: boolean }> {
    this.stop();
    const active = [...this.activeRuns];
    if (!active.length) return { drained: true };
    const timeout = Math.max(1, Math.min(Math.trunc(timeoutMs), 300_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
    ]);
    if (timer) clearTimeout(timer);
    return { drained };
  }

  private async runOnceInternal(organizationId?: string): Promise<number> {
    const claimed = await runWithRequiredDatabaseContext(
      "memory-deletion-claim",
      { organizationId: "platform", actorId: "system:memory-deletion", operator: true },
      () => this.jobs.claimDue(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    claimed.forEach((job) => recordQueueAge("memory_deletion", Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000)));
    await Promise.all(claimed.map((job) => withSpan(
      "memory.deletion.job",
      { "memory.deletion.target": job.target_type },
      () => this.process(job),
    )));
    try {
      await this.finalizeAgentDeletions(this.settings.batchSize);
    } catch (error) {
      operationalLogger.warn({ err: error, event: "agent.deletion.finalization.scan.failed" }, "Agent deletion finalization scan failed");
    }
    return claimed.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        operationalLogger.error({ err: error, event: "memory.deletion.poll.failed" }, "Memory deletion poll failed");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.settings.pollIntervalMs));
    }
  }

  private async process(job: MemoryDeletionJobRecord): Promise<void> {
    return runWithRequiredDatabaseContext(
      "memory-deletion-job",
      { organizationId: job.organization_id, actorId: "system:memory-deletion" },
      () => this.processScoped(job),
    );
  }

  private async processScoped(job: MemoryDeletionJobRecord): Promise<void> {
    const startedAt = Date.now();
    const analytics = this.analytics
      ? await this.analytics.resolveJob({
        organizationId: job.organization_id,
        targetType: job.target_type,
        targetId: job.target_id,
      })
      : undefined;
    await this.emitAnalytics(job, analytics, "requested", {
      attemptCount: job.attempt_count,
      latencyMs: elapsedMs(startedAt),
    });
    try {
      const counts = await this.purge(job);
      const completed = await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, counts });
      if (completed) {
        const common = {
          attemptCount: job.attempt_count,
          targetCount: counts.memoryCount + counts.conversationCount + counts.knowledgeChunkCount,
          purgedRevisionCount: counts.memoryCount,
          providerJobCount: counts.providerDeletionCount ?? 0,
          residualCount: 0,
          latencyMs: elapsedMs(startedAt),
        };
        await this.emitAnalytics(job, analytics, "canonical_purged", common);
        if ((counts.providerDeletionCount ?? 0) > 0) {
          await this.emitAnalytics(job, analytics, "projections_purged", common);
        } else {
          await this.emitAnalytics(job, analytics, "completed", common);
        }
        recordMemoryDeletion({
          outcome: "completed",
          target: job.target_type,
          count: counts.memoryCount + counts.conversationCount + counts.knowledgeChunkCount,
        });
        operationalLogger.info({
          event: "memory.deletion.completed",
          job_id: job.id,
          target_type: job.target_type,
          memory_count: counts.memoryCount,
          conversation_count: counts.conversationCount,
          knowledge_chunk_count: counts.knowledgeChunkCount,
        }, "Memory deletion job completed");
      }
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code.slice(0, 120)
        : "MEMORY_DELETION_FAILED";
      if (code === "MEMORY_LEGAL_HOLD_ACTIVE") {
        const held = await this.jobs.markHeld({ jobId: job.id, workerId: this.workerId, retryAfterMs: this.settings.holdRetryMs });
        if (held) {
          await this.emitAnalytics(job, analytics, "held", {
            attemptCount: job.attempt_count,
            legalHold: true,
            errorCode: code,
            latencyMs: elapsedMs(startedAt),
          });
          recordMemoryDeletion({ outcome: "held", target: job.target_type });
          operationalLogger.info({ event: "memory.deletion.held", job_id: job.id, target_type: job.target_type }, "Memory deletion job held by legal hold");
        }
        return;
      }

      const message = error instanceof Error ? error.message : "Memory deletion job failed";
      const status = await this.jobs.markRetryable({
        jobId: job.id,
        workerId: this.workerId,
        maxAttempts: this.settings.maxAttempts,
        retryAfterMs: deletionRetryDelayMs(job.attempt_count, this.settings.retryBaseDelayMs, this.settings.retryMaxDelayMs),
        error: { code, message },
      });
      if (status === "queued") {
        await this.emitAnalytics(job, analytics, "retrying", {
          attemptCount: job.attempt_count,
          retryable: true,
          errorCode: code,
          latencyMs: elapsedMs(startedAt),
        });
        recordRetry("memory_deletion");
        recordMemoryDeletion({ outcome: "failed", target: job.target_type });
        operationalLogger.warn({ event: "memory.deletion.retry.scheduled", job_id: job.id, target_type: job.target_type, attempt: job.attempt_count, error_code: code }, "Memory deletion retry scheduled");
      } else if (status === "failed") {
        await this.emitAnalytics(job, analytics, "failed", {
          attemptCount: job.attempt_count,
          retryable: false,
          errorCode: code,
          latencyMs: elapsedMs(startedAt),
        });
        recordMemoryDeletion({ outcome: "failed", target: job.target_type });
        operationalLogger.error({ event: "memory.deletion.failed", job_id: job.id, target_type: job.target_type, attempt: job.attempt_count, error_code: code }, "Memory deletion job failed permanently");
      }
    }
  }

  private async emitAnalytics(
    job: MemoryDeletionJobRecord,
    resolution: Awaited<ReturnType<MemoryDeletionAnalyticsSink["resolveJob"]>> | undefined,
    status: Parameters<MemoryDeletionAnalyticsSink["emit"]>[0]["status"],
    details: Partial<Parameters<MemoryDeletionAnalyticsSink["emit"]>[0]> = {},
  ): Promise<void> {
    if (!this.analytics || !resolution) return;
    try {
      await this.analytics.emit({
        ...scopeInput(job.organization_id, resolution),
        deletionId: job.id,
        targetType: job.target_type,
        status,
        legalHold: details.legalHold ?? status === "held",
        attemptCount: details.attemptCount ?? job.attempt_count,
        occurredAt: new Date(),
        ...details,
      });
    } catch (error) {
      operationalLogger.warn({
        event: "memory.deletion.analytics.enqueue.failed",
        job_id: job.id,
        target_type: job.target_type,
        status,
        error_code: "MEMORY_DELETION_ANALYTICS_ENQUEUE_FAILED",
      }, "Memory deletion analytics enqueue failed");
      void error;
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.trunc(Date.now() - startedAt));
}
