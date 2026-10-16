import type { Pool, PoolClient } from "pg";
import { enqueueMemoryDeletionEvent, type MemoryAnalyticsScopeInput, type MemoryDeletionAnalyticsInput, type MemoryDeletionScopeResolution, type MemoryDeletionTarget } from "../analytics/memory";
import { withTransaction } from "../db/pool";

export interface MemoryDeletionAnalyticsResolution {
  readonly workspaceId: string | null;
  readonly agentDefinitionId: string | null;
  readonly agentVersionId: string | null;
  readonly installationId: string | null;
  readonly scopeResolution: MemoryDeletionScopeResolution;
}

export interface MemoryDeletionAnalyticsJobInput {
  organizationId: string;
  targetType: MemoryDeletionTarget;
  targetId: string;
}

export interface MemoryProviderDeletionAnalyticsInput {
  organizationId: string;
  installationId: string;
  deletionJobId: string | null;
  providerJobId: string;
}

export interface MemoryDeletionAnalyticsSink {
  resolveJob(input: MemoryDeletionAnalyticsJobInput): Promise<MemoryDeletionAnalyticsResolution>;
  resolveProviderJob(input: MemoryProviderDeletionAnalyticsInput): Promise<{
    deletionId: string;
    targetType: MemoryDeletionTarget;
    scope: MemoryDeletionAnalyticsResolution;
  }>;
  emit(input: MemoryDeletionAnalyticsInput): Promise<void>;
}

interface ScopeRow {
  workspace_id: string;
  agent_definition_id: string;
  agent_version_id: string | null;
  installation_id: string;
}

const organizationAggregateScope: MemoryDeletionAnalyticsResolution = {
  workspaceId: null,
  agentDefinitionId: null,
  agentVersionId: null,
  installationId: null,
  scopeResolution: "organization_aggregate",
};

function installationScope(row: ScopeRow): MemoryDeletionAnalyticsResolution {
  return {
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    agentVersionId: row.agent_version_id,
    installationId: row.installation_id,
    scopeResolution: "installation",
  };
}

function boundedTargetType(value: string | null | undefined): MemoryDeletionTarget {
  switch (value) {
    case "memory":
    case "revision":
    case "conversation":
    case "end_user":
    case "user":
    case "knowledge_source":
    case "agent":
    case "workspace":
    case "organization":
      return value;
    default:
      return "memory";
  }
}

async function targetScopeRows(client: PoolClient, input: MemoryDeletionAnalyticsJobInput): Promise<ScopeRow[]> {
  const values = [input.organizationId, input.targetId];
  const branches: string[] = [];
  const addFactScope = (predicate: string): void => {
    branches.push(`
      SELECT fact.workspace_id::text AS workspace_id,
             fact.agent_definition_id::text AS agent_definition_id,
             COALESCE(fact.agent_version_id, installation.agent_version_id)::text AS agent_version_id,
             fact.installation_id::text AS installation_id
      FROM agent_memory_facts fact
      JOIN agent_installations installation ON installation.id = fact.installation_id
      WHERE fact.organization_id = $1 AND ${predicate}`);
  };
  const addSourceScope = (predicate: string): void => {
    branches.push(`
      SELECT source.workspace_id::text AS workspace_id,
             source.agent_definition_id::text AS agent_definition_id,
             source.agent_version_id::text AS agent_version_id,
             source.installation_id::text AS installation_id
      FROM memory_source_events source
      WHERE source.organization_id = $1 AND ${predicate}`);
  };
  const addLegacyMemoryScope = (predicate: string): void => {
    branches.push(`
      SELECT installation.scope_id::text AS workspace_id,
             installation.agent_definition_id::text AS agent_definition_id,
             installation.agent_version_id::text AS agent_version_id,
             installation.id::text AS installation_id
      FROM memory_records memory
      JOIN agent_installations installation ON installation.id = memory.installation_id
      WHERE memory.organization_id = $1 AND ${predicate}`);
  };

  switch (input.targetType) {
    case "memory":
      addFactScope("fact.id::text = $2");
      addLegacyMemoryScope("memory.id::text = $2");
      break;
    case "revision":
      branches.push(`
        SELECT fact.workspace_id::text AS workspace_id,
               fact.agent_definition_id::text AS agent_definition_id,
               COALESCE(fact.agent_version_id, installation.agent_version_id)::text AS agent_version_id,
               fact.installation_id::text AS installation_id
        FROM agent_memory_revisions revision
        JOIN agent_memory_facts fact ON fact.id = revision.fact_id
        JOIN agent_installations installation ON installation.id = fact.installation_id
        WHERE revision.organization_id = $1 AND revision.id::text = $2`);
      break;
    case "conversation":
      addFactScope("fact.conversation_id::text = $2");
      addSourceScope("source.conversation_id::text = $2");
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM conversations conversation
        JOIN agent_installations installation ON installation.id = conversation.installation_id
        WHERE conversation.organization_id = $1 AND conversation.id::text = $2`);
      addLegacyMemoryScope("memory.conversation_id::text = $2");
      break;
    case "end_user":
      addFactScope("fact.end_user_id = $2");
      addSourceScope("source.end_user_id = $2");
      addLegacyMemoryScope("memory.owner_user_id = $2");
      break;
    case "user":
      addFactScope("fact.end_user_id = $2");
      addSourceScope("source.end_user_id = $2");
      addLegacyMemoryScope("memory.owner_user_id = $2");
      break;
    case "knowledge_source":
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM knowledge_sources source
        JOIN agent_installations installation ON installation.id = source.installation_id
        WHERE source.organization_id = $1 AND source.id::text = $2`);
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM knowledge_chunks chunk
        JOIN agent_installations installation ON installation.id = chunk.installation_id
        WHERE chunk.organization_id = $1 AND chunk.source_id::text = $2`);
      break;
    case "agent":
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM agent_installations installation
        WHERE installation.organization_id = $1 AND installation.agent_definition_id::text = $2`);
      break;
    case "workspace":
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM agent_installations installation
        WHERE installation.organization_id = $1 AND installation.scope_id = $2`);
      break;
    case "organization":
      branches.push(`
        SELECT installation.scope_id::text AS workspace_id,
               installation.agent_definition_id::text AS agent_definition_id,
               installation.agent_version_id::text AS agent_version_id,
               installation.id::text AS installation_id
        FROM agent_installations installation
        WHERE installation.organization_id = $1`);
      break;
  }

  if (branches.length === 0) return [];
  const result = await client.query<ScopeRow>(
    `SELECT DISTINCT workspace_id, agent_definition_id, agent_version_id, installation_id
     FROM (${branches.join(" UNION ALL ")}) scoped
     WHERE workspace_id IS NOT NULL
       AND agent_definition_id IS NOT NULL
       AND installation_id IS NOT NULL
     LIMIT 2`,
    values,
  );
  return result.rows;
}

async function installationScopeRow(client: PoolClient, input: MemoryProviderDeletionAnalyticsInput): Promise<ScopeRow | null> {
  const result = await client.query<ScopeRow>(
    `SELECT installation.scope_id::text AS workspace_id,
            installation.agent_definition_id::text AS agent_definition_id,
            installation.agent_version_id::text AS agent_version_id,
            installation.id::text AS installation_id
     FROM agent_installations installation
     WHERE installation.organization_id = $1 AND installation.id::text = $2
     LIMIT 1`,
    [input.organizationId, input.installationId],
  );
  return result.rows[0] ?? null;
}

function resolutionFromRows(rows: readonly ScopeRow[]): MemoryDeletionAnalyticsResolution {
  return rows.length === 1 ? installationScope(rows[0]!) : organizationAggregateScope;
}

export function createMemoryDeletionAnalyticsSink(pool: Pool): MemoryDeletionAnalyticsSink {
  return {
    async resolveJob(input): Promise<MemoryDeletionAnalyticsResolution> {
      try {
        const rows = await withTransaction(pool, (client) => targetScopeRows(client, input));
        return resolutionFromRows(rows);
      } catch {
        // Analytics must not block canonical deletion. An explicit aggregate
        // scope remains honest when the target lookup is unavailable.
        return organizationAggregateScope;
      }
    },

    async resolveProviderJob(input) {
      try {
        const result = await withTransaction(pool, async (client) => {
          const [scopeRow, parent] = await Promise.all([
            installationScopeRow(client, input),
            input.deletionJobId
              ? client.query<{ target_type: string }>(
                "SELECT target_type FROM memory_deletion_jobs WHERE id::text = $1 AND organization_id = $2 LIMIT 1",
                [input.deletionJobId, input.organizationId],
              )
              : Promise.resolve({ rows: [] as Array<{ target_type: string }> }),
          ]);
          return { scopeRow, targetType: boundedTargetType(parent.rows[0]?.target_type), deletionId: input.deletionJobId ?? input.providerJobId };
        });
        return {
          deletionId: result.deletionId,
          targetType: result.targetType,
          scope: result.scopeRow ? installationScope(result.scopeRow) : organizationAggregateScope,
        };
      } catch {
        return {
          deletionId: input.deletionJobId ?? input.providerJobId,
          targetType: "memory",
          scope: organizationAggregateScope,
        };
      }
    },

    async emit(input) {
      await withTransaction(pool, (client) => enqueueMemoryDeletionEvent(client, input));
    },
  };
}

export function scopeInput(
  organizationId: string,
  resolution: MemoryDeletionAnalyticsResolution,
): Pick<MemoryAnalyticsScopeInput, "organizationId"> & Pick<MemoryDeletionAnalyticsInput, "workspaceId" | "agentDefinitionId" | "agentVersionId" | "installationId" | "scopeResolution"> {
  return {
    organizationId,
    workspaceId: resolution.workspaceId,
    agentDefinitionId: resolution.agentDefinitionId,
    agentVersionId: resolution.agentVersionId,
    installationId: resolution.installationId,
    scopeResolution: resolution.scopeResolution,
  };
}
