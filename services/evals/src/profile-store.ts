import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "./db.js";

export type AgentTargetType = "platform_assistant" | "business_agent";

export interface AgentProfileSpec {
  targetType: AgentTargetType;
  agentName: string;
  model?: {
    providerId: string;
    connectionName: string;
    modelId: string;
  };
  instructions: string;
  knowledge: {
    title: string;
    content: string;
    visibility?: "private" | "public";
  };
  responsibilities: Array<
    "answer-questions" | "customer-support" | "bookings" | "enquiries"
  >;
  website?: {
    allowedOrigins: string[];
  };
}

export interface AgentProfile {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  name: string;
  targetType: AgentTargetType;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileVersion {
  id: string;
  profileId: string;
  version: number;
  spec: AgentProfileSpec;
  specDigest: string;
  createdAt: string;
}

export interface AgentSetupStep {
  name: string;
  status: "pending" | "running" | "complete" | "failed";
  message?: string;
  at?: string;
}

export interface AgentSetupRun {
  id: string;
  sandboxId: string;
  profileVersionId: string;
  idempotencyKey: string;
  status: "pending" | "running" | "ready" | "failed";
  steps: AgentSetupStep[];
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileDetail extends AgentProfile {
  version: AgentProfileVersion;
  latestRun: AgentSetupRun | null;
}

export interface SandboxUpdate {
  id: string;
  sandboxId: string;
  previousVersionId: string | null;
  targetCodeRevision: string;
  targetSchemaVersion: string;
  targetMigrationChecksum: string;
  status: "pending" | "running" | "ready" | "failed";
  steps: AgentSetupStep[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value as T | null | undefined) ?? fallback;
}

function mapProfile(row: Row): AgentProfile {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    workspaceRefId: String(row.workspace_ref_id),
    name: String(row.name),
    targetType: String(row.target_type) as AgentTargetType,
    currentVersion: Number(row.current_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapVersion(row: Row): AgentProfileVersion {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    version: Number(row.version),
    spec: json<AgentProfileSpec>(row.spec, {} as AgentProfileSpec),
    specDigest: String(row.spec_digest),
    createdAt: iso(row.created_at),
  };
}

function mapSetupRun(row: Row): AgentSetupRun {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    profileVersionId: String(row.profile_version_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as AgentSetupRun["status"],
    steps: json<AgentSetupStep[]>(row.steps, []),
    result: json<Record<string, unknown>>(row.result, {}),
    error: row.error == null ? null : String(row.error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createAgentProfile(
  pool: Pool,
  input: {
    sandboxId: string;
    workspaceRefId: string;
    name: string;
    targetType: AgentTargetType;
    spec: AgentProfileSpec;
    specDigest: string;
  },
): Promise<AgentProfileDetail> {
  return transaction(pool, async (client) => {
    const id = randomUUID();
    const versionId = randomUUID();
    const profileResult = await client.query(
      `INSERT INTO evals.agent_profiles(
         id, sandbox_id, workspace_ref_id, name, target_type, current_version
       ) VALUES($1,$2,$3,$4,$5,1) RETURNING *`,
      [id, input.sandboxId, input.workspaceRefId, input.name, input.targetType],
    );
    const versionResult = await client.query(
      `INSERT INTO evals.agent_profile_versions(
         id, profile_id, version, spec, spec_digest
       ) VALUES($1,$2,1,$3::jsonb,$4) RETURNING *`,
      [versionId, id, JSON.stringify(input.spec), input.specDigest],
    );
    return {
      ...mapProfile(profileResult.rows[0] as Row),
      version: mapVersion(versionResult.rows[0] as Row),
      latestRun: null,
    };
  });
}

export async function createAgentProfileVersion(
  pool: Pool,
  profileId: string,
  spec: AgentProfileSpec,
  specDigest: string,
): Promise<AgentProfileVersion> {
  return transaction(pool, async (client) => {
    const profile = await client.query(
      "SELECT id FROM evals.agent_profiles WHERE id=$1 FOR UPDATE",
      [profileId],
    );
    if (!profile.rows[0]) throw new Error("Agent profile not found");
    const next = await client.query<{ version: number }>(
      "SELECT coalesce(max(version),0)+1 AS version FROM evals.agent_profile_versions WHERE profile_id=$1",
      [profileId],
    );
    const version = Number(next.rows[0]!.version);
    const versionId = randomUUID();
    const result = await client.query(
      `INSERT INTO evals.agent_profile_versions(
         id, profile_id, version, spec, spec_digest
       ) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [versionId, profileId, version, JSON.stringify(spec), specDigest],
    );
    await client.query(
      "UPDATE evals.agent_profiles SET current_version=$2, updated_at=now() WHERE id=$1",
      [profileId, version],
    );
    return mapVersion(result.rows[0] as Row);
  });
}

export async function getAgentProfile(
  pool: Pool,
  profileId: string,
): Promise<AgentProfileDetail | null> {
  const profile = await pool.query("SELECT * FROM evals.agent_profiles WHERE id=$1", [profileId]);
  if (!profile.rows[0]) return null;
  const mapped = mapProfile(profile.rows[0] as Row);
  const version = await pool.query(
    "SELECT * FROM evals.agent_profile_versions WHERE profile_id=$1 AND version=$2",
    [profileId, mapped.currentVersion],
  );
  if (!version.rows[0]) throw new Error("Agent profile has no current version");
  const run = await pool.query(
    `SELECT * FROM evals.agent_setup_runs
      WHERE profile_version_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [String((version.rows[0] as Row).id)],
  );
  return {
    ...mapped,
    version: mapVersion(version.rows[0] as Row),
    latestRun: run.rows[0] ? mapSetupRun(run.rows[0] as Row) : null,
  };
}

export async function listAgentProfiles(
  pool: Pool,
  sandboxId: string,
): Promise<AgentProfileDetail[]> {
  const result = await pool.query(
    `SELECT p.*, v.id AS version_id, v.version AS version_number,
            v.spec, v.spec_digest, v.created_at AS version_created_at
       FROM evals.agent_profiles p
       JOIN evals.agent_profile_versions v
         ON v.profile_id=p.id AND v.version=p.current_version
      WHERE p.sandbox_id=$1
      ORDER BY p.created_at DESC, p.id DESC`,
    [sandboxId],
  );
  const profiles: AgentProfileDetail[] = [];
  for (const row of result.rows) {
    const mapped = mapProfile(row as Row);
    const version = mapVersion({
      ...row,
      id: row.version_id,
      version: row.version_number,
      profile_id: row.id,
      created_at: row.version_created_at,
    } as Row);
    const run = await pool.query(
      `SELECT * FROM evals.agent_setup_runs
        WHERE profile_version_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [version.id],
    );
    profiles.push({
      ...mapped,
      version,
      latestRun: run.rows[0] ? mapSetupRun(run.rows[0] as Row) : null,
    });
  }
  return profiles;
}

export async function createAgentSetupRun(
  pool: Pool,
  input: {
    sandboxId: string;
    profileVersionId: string;
    idempotencyKey: string;
  },
): Promise<AgentSetupRun> {
  const existing = await pool.query(
    `SELECT * FROM evals.agent_setup_runs
      WHERE profile_version_id=$1 AND idempotency_key=$2`,
    [input.profileVersionId, input.idempotencyKey],
  );
  if (existing.rows[0]) return mapSetupRun(existing.rows[0] as Row);
  const result = await pool.query(
    `INSERT INTO evals.agent_setup_runs(
       id, sandbox_id, profile_version_id, idempotency_key
     ) VALUES($1,$2,$3,$4) RETURNING *`,
    [randomUUID(), input.sandboxId, input.profileVersionId, input.idempotencyKey],
  );
  return mapSetupRun(result.rows[0] as Row);
}

export async function updateAgentSetupRun(
  pool: Pool,
  runId: string,
  input: {
    status?: AgentSetupRun["status"];
    steps?: AgentSetupStep[];
    result?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<AgentSetupRun | null> {
  const result = await pool.query(
    `UPDATE evals.agent_setup_runs SET
       status=COALESCE($2,status),
       steps=COALESCE($3::jsonb,steps),
       result=COALESCE($4::jsonb,result),
       error=$5,
       updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      runId,
      input.status ?? null,
      input.steps === undefined ? null : JSON.stringify(input.steps),
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error ?? null,
    ],
  );
  return result.rows[0] ? mapSetupRun(result.rows[0] as Row) : null;
}

export async function latestReadySetupRunForProfile(
  pool: Pool,
  profileId: string,
): Promise<AgentSetupRun | null> {
  const result = await pool.query(
    `SELECT r.* FROM evals.agent_setup_runs r
       JOIN evals.agent_profile_versions v ON v.id=r.profile_version_id
      WHERE v.profile_id=$1 AND r.status='ready'
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [profileId],
  );
  return result.rows[0] ? mapSetupRun(result.rows[0] as Row) : null;
}

export async function createSandboxUpdate(
  pool: Pool,
  input: {
    sandboxId: string;
    previousVersionId: string | null;
    targetCodeRevision: string;
    targetSchemaVersion: string;
    targetMigrationChecksum: string;
  },
): Promise<SandboxUpdate> {
  const result = await pool.query(
    `INSERT INTO evals.sandbox_updates(
       id, sandbox_id, previous_version_id, target_code_revision,
       target_schema_version, target_migration_checksum
     ) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      randomUUID(),
      input.sandboxId,
      input.previousVersionId,
      input.targetCodeRevision,
      input.targetSchemaVersion,
      input.targetMigrationChecksum,
    ],
  );
  return mapSandboxUpdate(result.rows[0] as Row);
}

export async function updateSandboxUpdate(
  pool: Pool,
  updateId: string,
  input: { status?: SandboxUpdate["status"]; steps?: AgentSetupStep[]; error?: string | null },
): Promise<SandboxUpdate | null> {
  const result = await pool.query(
    `UPDATE evals.sandbox_updates SET
       status=COALESCE($2,status),
       steps=COALESCE($3::jsonb,steps),
       error=$4,
       updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      updateId,
      input.status ?? null,
      input.steps === undefined ? null : JSON.stringify(input.steps),
      input.error ?? null,
    ],
  );
  return result.rows[0] ? mapSandboxUpdate(result.rows[0] as Row) : null;
}

function mapSandboxUpdate(row: Row): SandboxUpdate {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    previousVersionId: row.previous_version_id == null ? null : String(row.previous_version_id),
    targetCodeRevision: String(row.target_code_revision),
    targetSchemaVersion: String(row.target_schema_version),
    targetMigrationChecksum: String(row.target_migration_checksum),
    status: String(row.status) as SandboxUpdate["status"],
    steps: json<AgentSetupStep[]>(row.steps, []),
    error: row.error == null ? null : String(row.error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
