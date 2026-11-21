import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { ProcedureDefinition } from "../../contracts/procedure-definitions";
import type { ProcedureReference } from "../../contracts/procedures";
import { findProcedure } from "../../contracts/procedure-definitions";
import { declarativeProcedureDefinition, workflowRevisionInputSchema, type WorkflowRevision } from "../../contracts/workflow-revisions";
import { transaction } from "../../infrastructure/database";

export type WorkflowOwner = { accountId: string; organizationId: string };

function revision(row: any): WorkflowRevision {
  return {
    id: row.workflow_id, version: String(row.version), title: row.title, description: row.description,
    prerequisites: row.prerequisites, waits: row.waits, completionEvidence: row.completion_evidence,
    digest: row.digest, publishedAt: new Date(row.published_at).toISOString(),
  };
}

async function requireMember(db: PoolClient | Pool, owner: WorkflowOwner): Promise<void> {
  const member = await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL", [owner.organizationId, owner.accountId]);
  if (!member.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
}

/** Immutable, workspace-scoped declarative workflow revisions. */
export class WorkflowRevisions {
  constructor(private readonly pool: Pool) {}

  async publish(owner: WorkflowOwner, raw: unknown): Promise<WorkflowRevision> {
    const input = workflowRevisionInputSchema.parse(raw);
    if (findProcedure({ id: input.id, version: "1" })) throw new PlatformError("WORKFLOW_ID_RESERVED", 409, "This workflow id is built in");
    return transaction(this.pool, async db => {
      await requireMember(db, owner);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${owner.organizationId}:workflow:${input.id}`]);
      const version = Number((await db.query("SELECT COALESCE(max(version),0)+1 AS version FROM agents_platform.workflow_revisions WHERE organization_id=$1 AND workflow_id=$2", [owner.organizationId, input.id])).rows[0].version);
      const digest = requestDigest({ schemaVersion: 1, ...input, version: String(version) });
      const row = (await db.query(`INSERT INTO agents_platform.workflow_revisions
        (id,organization_id,workflow_id,version,title,description,prerequisites,waits,completion_evidence,digest,published_by)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11) RETURNING *`,
        [randomUUID(), owner.organizationId, input.id, version, input.title, input.description,
          JSON.stringify(input.prerequisites), JSON.stringify(input.waits), JSON.stringify(input.completionEvidence), digest, owner.accountId])).rows[0];
      return revision(row);
    });
  }

  async list(owner: WorkflowOwner): Promise<WorkflowRevision[]> {
    await requireMember(this.pool, owner);
    return (await this.pool.query("SELECT * FROM agents_platform.workflow_revisions WHERE organization_id=$1 ORDER BY workflow_id,version DESC", [owner.organizationId]))
      .rows.map(revision);
  }

  /** Dependencies used by trusted composition checks; unknown references are absent. */
  async dependencies(db: Pool | PoolClient, organizationId: string, references: readonly ProcedureReference[]) {
    const rows = (await db.query("SELECT workflow_id,version,digest FROM agents_platform.workflow_revisions WHERE organization_id=$1", [organizationId])).rows;
    const wanted = new Set(references.map(reference => `${reference.id}@${reference.version}`));
    return rows.filter(row => wanted.has(`${row.workflow_id}@${row.version}`))
      .map(row => ({ id: row.workflow_id as string, version: String(row.version), digest: row.digest as string }));
  }

  async definition(db: Pool | PoolClient, organizationId: string, reference: ProcedureReference): Promise<ProcedureDefinition | undefined> {
    return declarativeDefinition(db, organizationId, reference);
  }
}

export async function declarativeDefinition(db: Pool | PoolClient, organizationId: string, reference: ProcedureReference): Promise<ProcedureDefinition | undefined> {
  const row = (await db.query("SELECT * FROM agents_platform.workflow_revisions WHERE organization_id=$1 AND workflow_id=$2 AND version=$3",
    [organizationId, reference.id, Number(reference.version)])).rows[0];
  if (!row) return undefined;
  return declarativeProcedureDefinition({ id: row.workflow_id, version: String(row.version), title: row.title, description: row.description,
    prerequisites: row.prerequisites, waits: row.waits, completionEvidence: row.completion_evidence, digest: row.digest });
}

/** Definitions for the given references, including built-ins resolved elsewhere. */
export async function procedureDefinitionsFor(db: Pool | PoolClient, organizationId: string, references: readonly ProcedureReference[]) {
  const map = new Map<string, ProcedureDefinition>();
  const custom = references.filter(reference => !findProcedure(reference));
  if (!custom.length) return map;
  const wanted = new Set(custom.map(reference => `${reference.id}@${reference.version}`));
  const rows = (await db.query("SELECT * FROM agents_platform.workflow_revisions WHERE organization_id=$1", [organizationId])).rows;
  for (const row of rows) {
    const key = `${row.workflow_id}@${row.version}`;
    if (!wanted.has(key)) continue;
    map.set(key, declarativeProcedureDefinition({ id: row.workflow_id, version: String(row.version), title: row.title, description: row.description,
      prerequisites: row.prerequisites, waits: row.waits, completionEvidence: row.completion_evidence, digest: row.digest }));
  }
  return map;
}
