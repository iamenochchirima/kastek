import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "./db.js";
import type { SandboxManifest } from "./version.js";

export interface Sandbox {
  id: string;
  product: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxVersion {
  id: string;
  sandboxId: string;
  codeRevision: string;
  imageDigest: string;
  schemaVersion: string;
  migrationChecksum: string;
  configDigest: string;
  runtimeVersion: string;
  modelRoutesDigest: string;
  adapterVersions: Record<string, string>;
  createdAt: string;
  activatedAt: string;
  retiredAt: string | null;
}

export interface WorkspaceRef {
  id: string;
  sandboxId: string;
  productWorkspaceId: string;
  label: string | null;
  createdAt: string;
}

export interface SandboxDetail {
  sandbox: Sandbox;
  version: SandboxVersion | null;
  workspaceRefs: WorkspaceRef[];
}

export interface CreateSandboxInput {
  product: string;
  manifest: SandboxManifest;
  workspaceRef?: {
    productWorkspaceId: string;
    label?: string;
  };
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function mapSandbox(row: Row): Sandbox {
  return {
    id: String(row.id),
    product: String(row.product),
    status: String(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapVersion(row: Row): SandboxVersion {
  const adapterVersions =
    typeof row.adapter_versions === "string"
      ? (JSON.parse(row.adapter_versions) as Record<string, string>)
      : (row.adapter_versions as Record<string, string>);
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    codeRevision: String(row.code_revision),
    imageDigest: String(row.image_digest),
    schemaVersion: String(row.schema_version),
    migrationChecksum: String(row.migration_checksum),
    configDigest: String(row.config_digest),
    runtimeVersion: String(row.runtime_version),
    modelRoutesDigest: String(row.model_routes_digest),
    adapterVersions,
    createdAt: iso(row.created_at),
    activatedAt: iso(row.activated_at),
    retiredAt: row.retired_at == null ? null : iso(row.retired_at),
  };
}

function mapWorkspaceRef(row: Row): WorkspaceRef {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    productWorkspaceId: String(row.product_workspace_id),
    label: row.label == null ? null : String(row.label),
    createdAt: iso(row.created_at),
  };
}

async function currentVersion(
  db: Pool | PoolClient,
  sandboxId: string,
): Promise<SandboxVersion | null> {
  const result = await db.query(
    `SELECT * FROM evals.sandbox_versions
     WHERE sandbox_id=$1 AND retired_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sandboxId],
  );
  return result.rows[0] ? mapVersion(result.rows[0] as Row) : null;
}

async function workspaceRefs(
  db: Pool | PoolClient,
  sandboxId: string,
): Promise<WorkspaceRef[]> {
  const result = await db.query(
    `SELECT * FROM evals.workspace_refs
     WHERE sandbox_id=$1 ORDER BY created_at, id`,
    [sandboxId],
  );
  return result.rows.map((row) => mapWorkspaceRef(row as Row));
}

async function insertWorkspaceRef(
  db: PoolClient,
  sandboxId: string,
  input: { productWorkspaceId: string; label?: string },
): Promise<WorkspaceRef> {
  const result = await db.query(
    `INSERT INTO evals.workspace_refs(
       id, sandbox_id, product_workspace_id, label
     ) VALUES($1,$2,$3,$4)
     ON CONFLICT (sandbox_id, product_workspace_id)
     DO UPDATE SET label=EXCLUDED.label
     RETURNING *`,
    [randomUUID(), sandboxId, input.productWorkspaceId, input.label ?? null],
  );
  return mapWorkspaceRef(result.rows[0] as Row);
}

export async function createSandbox(
  pool: Pool,
  input: CreateSandboxInput,
): Promise<SandboxDetail> {
  return transaction(pool, async (client) => {
    const sandboxId = randomUUID();
    const versionId = randomUUID();
    const sandboxResult = await client.query(
      `INSERT INTO evals.sandboxes(id, product)
       VALUES($1,$2) RETURNING *`,
      [sandboxId, input.product],
    );
    const versionResult = await client.query(
      `INSERT INTO evals.sandbox_versions(
         id, sandbox_id, code_revision, image_digest, schema_version,
         migration_checksum, config_digest, runtime_version,
         model_routes_digest, adapter_versions
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        versionId,
        sandboxId,
        input.manifest.codeRevision,
        input.manifest.imageDigest,
        input.manifest.schemaVersion,
        input.manifest.migrationChecksum,
        input.manifest.configDigest,
        input.manifest.runtimeVersion,
        input.manifest.modelRoutesDigest,
        JSON.stringify(input.manifest.adapterVersions),
      ],
    );
    const refs: WorkspaceRef[] = [];
    if (input.workspaceRef) {
      refs.push(await insertWorkspaceRef(client, sandboxId, input.workspaceRef));
      await client.query(
        "UPDATE evals.sandboxes SET updated_at=now() WHERE id=$1",
        [sandboxId],
      );
    }
    return {
      sandbox: mapSandbox(sandboxResult.rows[0] as Row),
      version: mapVersion(versionResult.rows[0] as Row),
      workspaceRefs: refs,
    };
  });
}

export async function listSandboxes(
  pool: Pool,
  limit: number,
): Promise<SandboxDetail[]> {
  const result = await pool.query(
    `SELECT * FROM evals.sandboxes
     ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return Promise.all(
    result.rows.map(async (row) => {
      const sandbox = mapSandbox(row as Row);
      return {
        sandbox,
        version: await currentVersion(pool, sandbox.id),
        workspaceRefs: await workspaceRefs(pool, sandbox.id),
      };
    }),
  );
}

export async function getSandbox(
  pool: Pool,
  sandboxId: string,
): Promise<SandboxDetail | null> {
  const result = await pool.query(
    "SELECT * FROM evals.sandboxes WHERE id=$1",
    [sandboxId],
  );
  if (!result.rows[0]) return null;
  const sandbox = mapSandbox(result.rows[0] as Row);
  return {
    sandbox,
    version: await currentVersion(pool, sandbox.id),
    workspaceRefs: await workspaceRefs(pool, sandbox.id),
  };
}

export async function addWorkspaceRef(
  pool: Pool,
  sandboxId: string,
  input: { productWorkspaceId: string; label?: string },
): Promise<WorkspaceRef | null> {
  return transaction(pool, async (client) => {
    const exists = await client.query(
      "SELECT 1 FROM evals.sandboxes WHERE id=$1",
      [sandboxId],
    );
    if (!exists.rows[0]) return null;
    const ref = await insertWorkspaceRef(client, sandboxId, input);
    await client.query(
      "UPDATE evals.sandboxes SET updated_at=now() WHERE id=$1",
      [sandboxId],
    );
    return ref;
  });
}

export interface AgentRef {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  productAgentId: string;
  productVersionId: string;
  sourceIds: string[];
  compositionDigest: string;
  modelRoutesDigest: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentRefError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRefError";
  }
}

export interface CreateAgentRefInput {
  workspaceRefId: string;
  productAgentId: string;
  productVersionId: string;
  sourceIds: string[];
  compositionDigest: string;
  modelRoutesDigest: string;
}

function mapAgentRef(row: Row): AgentRef {
  const sourceIds =
    typeof row.source_ids === "string"
      ? (JSON.parse(row.source_ids) as string[])
      : (row.source_ids as string[]);
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    workspaceRefId: String(row.workspace_ref_id),
    productAgentId: String(row.product_agent_id),
    productVersionId: String(row.product_version_id),
    sourceIds,
    compositionDigest: String(row.composition_digest),
    modelRoutesDigest: String(row.model_routes_digest),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createAgentRef(
  pool: Pool,
  sandboxId: string,
  input: CreateAgentRefInput,
): Promise<AgentRef> {
  return transaction(pool, async (client) => {
    const sandbox = await client.query(
      "SELECT 1 FROM evals.sandboxes WHERE id=$1",
      [sandboxId],
    );
    if (!sandbox.rows[0]) {
      throw new AgentRefError("SANDBOX_NOT_FOUND", "Sandbox not found");
    }
    const workspace = await client.query(
      "SELECT 1 FROM evals.workspace_refs WHERE id=$1 AND sandbox_id=$2",
      [input.workspaceRefId, sandboxId],
    );
    if (!workspace.rows[0]) {
      throw new AgentRefError(
        "WORKSPACE_REF_NOT_FOUND",
        "Workspace reference does not belong to this sandbox",
      );
    }
    const existing = await client.query(
      `SELECT 1 FROM evals.agent_refs
       WHERE sandbox_id=$1 AND product_agent_id=$2 AND product_version_id=$3`,
      [sandboxId, input.productAgentId, input.productVersionId],
    );
    if (existing.rows[0]) {
      throw new AgentRefError(
        "AGENT_REF_EXISTS",
        "That agent version is already recorded for this sandbox",
      );
    }
    const result = await client.query(
      `INSERT INTO evals.agent_refs(
         id, sandbox_id, workspace_ref_id, product_agent_id,
         product_version_id, source_ids, composition_digest, model_routes_digest
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       RETURNING *`,
      [
        randomUUID(),
        sandboxId,
        input.workspaceRefId,
        input.productAgentId,
        input.productVersionId,
        JSON.stringify(input.sourceIds),
        input.compositionDigest,
        input.modelRoutesDigest,
      ],
    );
    await client.query(
      "UPDATE evals.sandboxes SET updated_at=now() WHERE id=$1",
      [sandboxId],
    );
    return mapAgentRef(result.rows[0] as Row);
  });
}

export async function listAgentRefs(
  pool: Pool,
  sandboxId: string,
): Promise<AgentRef[]> {
  const result = await pool.query(
    `SELECT * FROM evals.agent_refs
     WHERE sandbox_id=$1 ORDER BY created_at DESC, id DESC`,
    [sandboxId],
  );
  return result.rows.map((row) => mapAgentRef(row as Row));
}

export async function getAgentRef(
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
): Promise<AgentRef | null> {
  const result = await pool.query(
    "SELECT * FROM evals.agent_refs WHERE sandbox_id=$1 AND id=$2",
    [sandboxId, agentRefId],
  );
  return result.rows[0] ? mapAgentRef(result.rows[0] as Row) : null;
}

export type OutcomeKind = "enquiry" | "booking" | "record";
export type OutcomeStatus = "submitted" | "completed" | "unknown";

export interface OutcomeRef {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  agentRefId: string;
  kind: OutcomeKind;
  productOutcomeId: string;
  productRecordId: string | null;
  status: OutcomeStatus;
  taskId: string | null;
  requestDigest: string;
  responseDigest: string;
  createdAt: string;
  updatedAt: string;
}

export class OutcomeRefError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OutcomeRefError";
  }
}

export interface CreateOutcomeRefInput {
  workspaceRefId: string;
  agentRefId: string;
  kind: OutcomeKind;
  productOutcomeId: string;
  productRecordId?: string;
  status: OutcomeStatus;
  taskId?: string;
  requestDigest: string;
  responseDigest: string;
}

function mapOutcomeRef(row: Row): OutcomeRef {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    workspaceRefId: String(row.workspace_ref_id),
    agentRefId: String(row.agent_ref_id),
    kind: row.kind as OutcomeKind,
    productOutcomeId: String(row.product_outcome_id),
    productRecordId: row.product_record_id == null ? null : String(row.product_record_id),
    status: row.status as OutcomeStatus,
    taskId: row.task_id == null ? null : String(row.task_id),
    requestDigest: String(row.request_digest),
    responseDigest: String(row.response_digest),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createOutcomeRef(
  pool: Pool,
  sandboxId: string,
  input: CreateOutcomeRefInput,
): Promise<OutcomeRef> {
  return transaction(pool, async (client) => {
    const sandbox = await client.query(
      "SELECT 1 FROM evals.sandboxes WHERE id=$1",
      [sandboxId],
    );
    if (!sandbox.rows[0]) {
      throw new OutcomeRefError("SANDBOX_NOT_FOUND", "Sandbox not found");
    }
    const workspace = await client.query(
      "SELECT 1 FROM evals.workspace_refs WHERE id=$1 AND sandbox_id=$2",
      [input.workspaceRefId, sandboxId],
    );
    if (!workspace.rows[0]) {
      throw new OutcomeRefError(
        "WORKSPACE_REF_NOT_FOUND",
        "Workspace reference does not belong to this sandbox",
      );
    }
    const agent = await client.query(
      "SELECT 1 FROM evals.agent_refs WHERE id=$1 AND sandbox_id=$2 AND workspace_ref_id=$3",
      [input.agentRefId, sandboxId, input.workspaceRefId],
    );
    if (!agent.rows[0]) {
      throw new OutcomeRefError(
        "AGENT_REF_NOT_FOUND",
        "Agent reference does not belong to this sandbox and workspace",
      );
    }
    const existing = await client.query(
      `SELECT 1 FROM evals.outcome_refs
       WHERE sandbox_id=$1 AND kind=$2 AND product_outcome_id=$3`,
      [sandboxId, input.kind, input.productOutcomeId],
    );
    if (existing.rows[0]) {
      throw new OutcomeRefError(
        "OUTCOME_REF_EXISTS",
        "That product outcome is already recorded for this sandbox",
      );
    }
    const result = await client.query(
      `INSERT INTO evals.outcome_refs(
         id, sandbox_id, workspace_ref_id, agent_ref_id, kind,
         product_outcome_id, product_record_id, status, task_id,
         request_digest, response_digest
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        randomUUID(),
        sandboxId,
        input.workspaceRefId,
        input.agentRefId,
        input.kind,
        input.productOutcomeId,
        input.productRecordId ?? null,
        input.status,
        input.taskId ?? null,
        input.requestDigest,
        input.responseDigest,
      ],
    );
    await client.query(
      "UPDATE evals.sandboxes SET updated_at=now() WHERE id=$1",
      [sandboxId],
    );
    return mapOutcomeRef(result.rows[0] as Row);
  });
}

export async function listOutcomeRefs(
  pool: Pool,
  sandboxId: string,
): Promise<OutcomeRef[]> {
  const result = await pool.query(
    `SELECT * FROM evals.outcome_refs
     WHERE sandbox_id=$1 ORDER BY created_at DESC, id DESC`,
    [sandboxId],
  );
  return result.rows.map((row) => mapOutcomeRef(row as Row));
}

export async function getOutcomeRef(
  pool: Pool,
  sandboxId: string,
  outcomeRefId: string,
): Promise<OutcomeRef | null> {
  const result = await pool.query(
    "SELECT * FROM evals.outcome_refs WHERE sandbox_id=$1 AND id=$2",
    [sandboxId, outcomeRefId],
  );
  return result.rows[0] ? mapOutcomeRef(result.rows[0] as Row) : null;
}
