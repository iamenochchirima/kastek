import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { observeConnectionControl } from "../../observability/connection-telemetry";

async function owner(db: PoolClient, scope: ActionScope) {
  await requireActionMember(db, scope);
  if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE", [scope.organizationId, scope.accountId])).rowCount) {
    throw new PlatformError("ACCESS_DENIED", 403, "Workspace owner access required");
  }
}
async function connection(db: PoolClient, scope: ActionScope, id: string) {
  const row = (await db.query("SELECT revision,state FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND id=$2 AND state<>'removed' FOR SHARE", [scope.organizationId, id])).rows[0];
  if (!row) throw new PlatformError("MODEL_CONNECTION_NOT_FOUND", 404, "Model provider not found");
  return row as { revision: number; state: string };
}
const depends = `(s->>'kind'='connection' AND s->>'connectionId'=$2::text) OR
 (s->>'kind'='organization_default' AND EXISTS(SELECT 1 FROM agents_platform.model_provider_defaults d WHERE d.organization_id=$1 AND d.connection_id=$2::uuid))`;

export function registerModelProviderDependencyRoutes(app: FastifyInstance, options: {
  pool: Pool; resolveScope(request: FastifyRequest): Promise<ActionScope>;
}): void {
  const base = "/api/organizations/:organizationId/model-providers/:connectionId";
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).connectionId);
  app.get(`${base}/dependencies`, async request => {
    const scope = await options.resolveScope(request), connectionId = id(request);
    const { cursor } = z.object({ cursor: z.string().max(80).optional() }).parse(request.query);
    return transaction(options.pool, async db => {
      await owner(db, scope); const current = await connection(db, scope, connectionId);
      const result = await db.query(`WITH dependencies AS (
        SELECT 'agent:'||a.id AS cursor,'agent' AS kind,a.id,a.name,a.draft_revision AS revision,
          EXISTS(SELECT 1 FROM agents_platform.model_provider_use_grants g WHERE g.organization_id=$1 AND g.connection_id=$2::uuid
            AND g.consumer=jsonb_build_object('kind','agent','agentId',a.id::text) AND g.state='active' AND g.roles ?& array['primary','compaction','delegated']) AS authorized,
          EXISTS(SELECT 1 FROM (SELECT a.draft->'model'->'selection' s UNION ALL SELECT v.configuration->'model'->'selection' FROM agents_platform.agent_versions v WHERE v.organization_id=$1 AND v.agent_id=a.id AND v.number=(SELECT max(number) FROM agents_platform.agent_versions WHERE agent_id=a.id)) selections WHERE s->>'kind'='connection' AND s->>'connectionId'=$2::text) AS reauthorizable
        FROM agents_platform.agents a WHERE a.organization_id=$1 AND (
          EXISTS(SELECT 1 FROM (SELECT a.draft->'model'->'selection' s UNION ALL
            SELECT v.configuration->'model'->'selection' FROM agents_platform.agent_versions v WHERE v.organization_id=$1 AND v.agent_id=a.id AND v.number=(SELECT max(number) FROM agents_platform.agent_versions WHERE agent_id=a.id)) selections WHERE ${depends}))
        UNION ALL
        SELECT 'schedule:'||a.id,'schedule',a.id,a.name,a.revision,false,false FROM agents_platform.automations a
          JOIN agents_platform.automation_revisions r ON r.automation_id=a.id AND r.revision=a.revision
          JOIN agents_platform.agent_versions v ON v.id=r.version_id AND v.organization_id=a.organization_id
          CROSS JOIN LATERAL (SELECT v.configuration->'model'->'selection' s) selection
          WHERE a.organization_id=$1 AND a.state<>'revoked' AND (${depends})
      ) SELECT *, (SELECT count(*)::integer FROM dependencies) AS total FROM dependencies WHERE ($3::text IS NULL OR cursor>$3) ORDER BY cursor LIMIT 51`, [scope.organizationId, connectionId, cursor ?? null]);
      const page = result.rows.slice(0, 50);
      const active = (await db.query(`SELECT (count(DISTINCT t.task_id) FILTER (WHERE task.state<>'uncertain'))::integer AS count, (count(DISTINCT t.task_id) FILTER (WHERE task.state='uncertain'))::integer AS uncertain FROM agents_platform.task_model_routes t
        JOIN agents_platform.tasks task ON task.id=t.task_id WHERE t.organization_id=$1 AND task.state NOT IN ('completed','incomplete','refused','failed','cancelled')
        AND t.routes::jsonb @> jsonb_build_object('primary',jsonb_build_object('binding',jsonb_build_object('connectionId',$2::text)))`, [scope.organizationId, connectionId])).rows[0];
      const defaultRow = (await db.query("SELECT model_id,revision FROM agents_platform.model_provider_defaults WHERE organization_id=$1 AND connection_id=$2", [scope.organizationId, connectionId])).rows[0];
      return { connectionRevision: current.revision, state: current.state, defaultModel: defaultRow ? { modelId: defaultRow.model_id, revision: defaultRow.revision } : null,
        entries: page.map(({ total: _total, ...entry }) => entry), total: result.rows[0]?.total ?? 0, nextCursor: result.rows.length > page.length ? page.at(-1)!.cursor : null, activeTasks: active?.count ?? 0, uncertainTasks: active?.uncertain ?? 0 };
    });
  });
  app.post(`${base}/reauthorize`, async request => {
    const scope = await options.resolveScope(request), connectionId = id(request);
    const input = z.strictObject({ expectedRevision: z.number().int().positive(), agentId: z.uuid(), agentRevision: z.number().int().positive() }).parse(request.body);
    return observeConnectionControl(options.pool, "model_provider", "authorize", { organizationId: scope.organizationId, connectionId }, () => transaction(options.pool, async db => {
      await owner(db, scope);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const agent = (await db.query("SELECT draft,draft_revision FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 FOR SHARE", [scope.organizationId, input.agentId])).rows[0];
      if (!agent) throw new PlatformError("MODEL_CONSUMER_NOT_FOUND", 404, "Agent not found");
      const current = await connection(db, scope, connectionId);
      if (current.state !== "active" || current.revision !== input.expectedRevision || agent.draft_revision !== input.agentRevision) throw new PlatformError("MODEL_CONNECTION_CHANGED", 409, "Reload provider dependencies");
      const latest = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [scope.organizationId, input.agentId])).rows[0];
      const modelIds = [...new Set([agent.draft, latest?.configuration].filter(Boolean).map(configuration => agentConfigurationSchema.parse(configuration).model.selection)
        .flatMap(selection => selection.kind === "connection" && selection.connectionId === connectionId ? [selection.modelId] : []))];
      if (!modelIds.length) throw new PlatformError("MODEL_USE_DENIED", 409, "Choose this provider in the agent configuration first");
      await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
        VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), scope.organizationId, connectionId, { kind: "agent", agentId: input.agentId }, JSON.stringify(["primary", "compaction", "delegated"]), JSON.stringify(modelIds)]);
      return { authorized: true };
    }));
  });
}
