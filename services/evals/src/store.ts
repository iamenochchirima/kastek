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
