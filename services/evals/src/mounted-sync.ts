import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import { listProductAgents, ownerRequest, readOwnerSession } from "./product-agents.js";
import {
  getSandbox,
  recordSandboxVersion,
  retireAgentRefsExcept,
  type SandboxDetail,
  type SandboxVersion,
} from "./store.js";
import { captureSandboxVersion, latestSchemaMigration } from "./version.js";

export interface MountedSyncResult {
  version: SandboxVersion;
  schema: { version: string; latestMigration: string | null };
  agents: { active: number; retired: number };
  session: { organizationId: string; valid: true };
  models: { refreshed: number; warnings: string[] };
}

export class MountedSyncError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MountedSyncError";
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new MountedSyncError(statusCode, code, message);
}

function mounted(detail: SandboxDetail): boolean {
  const runtime = detail.sandbox.runtime as Record<string, unknown>;
  return typeof runtime.sessionFile === "string" ||
    (typeof runtime.apiUrl === "string" && runtime.productDatabase == null);
}

async function refreshModels(
  session: Awaited<ReturnType<typeof readOwnerSession>>,
  product: string,
  cookieName: string,
): Promise<{ refreshed: number; warnings: string[] }> {
  if (product !== "agents") {
    return { refreshed: 0, warnings: ["Model catalogue refresh is only available for Agents mounted sandboxes"] };
  }
  const warnings: string[] = [];
  let refreshed = 0;
  let connections: Array<Record<string, unknown>>;
  try {
    const listed = await ownerRequest(
      session,
      cookieName,
      "GET",
      `/api/organizations/${encodeURIComponent(session.organizationId)}/model-providers`,
    );
    connections = Array.isArray(listed.connections)
      ? listed.connections as Array<Record<string, unknown>>
      : [];
  } catch {
    return { refreshed: 0, warnings: ["Could not read model providers"] };
  }
  for (const connection of connections.slice(0, 4)) {
    if (connection.state !== "active" || typeof connection.id !== "string" ||
        !Number.isInteger(connection.revision)) continue;
    try {
      await ownerRequest(
        session,
        cookieName,
        "POST",
        `/api/organizations/${encodeURIComponent(session.organizationId)}/model-providers/${encodeURIComponent(connection.id)}/models/refresh`,
        { expectedRevision: connection.revision },
      );
      refreshed += 1;
    } catch {
      warnings.push(`Model refresh failed for ${connection.id}`);
    }
  }
  return { refreshed, warnings };
}

/** Sync a mounted workspace: version metadata, active agent refs, session and model catalogue. */
export async function syncMountedSandbox(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<MountedSyncResult> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  if (detail.sandbox.status !== "ready") fail(409, "sandbox_not_ready", "Sandbox is not ready");
  if (!mounted(detail)) fail(409, "not_mounted", "This sandbox is managed; use Update sandbox");

  const cookieName = detail.sandbox.product === "growth" ? "kasitek_session" : "agents_session";
  let session: Awaited<ReturnType<typeof readOwnerSession>>;
  try {
    session = await readOwnerSession(config, detail);
    await ownerRequest(session, cookieName, "GET", "/api/session");
  } catch {
    fail(409, "session_expired", "The sandbox owner session expired; refresh owner-session.json and retry");
  }

  const productAgents = await listProductAgents(config, pool, sandboxId);
  const retired = await retireAgentRefsExcept(pool, sandboxId, productAgents.map(agent => agent.refId));
  const manifest = await captureSandboxVersion(
    config,
    {},
    detail.sandbox.product === "growth" ? "growth" : "agents",
  );
  const version = await recordSandboxVersion(pool, sandboxId, manifest);
  const product = detail.sandbox.product === "growth" ? "growth" : "agents";
  const latestMigration = await latestSchemaMigration(config.repoRoot, product).catch(() => null);
  const models = await refreshModels(session, detail.sandbox.product, cookieName);
  await pool.query("UPDATE evals.sandboxes SET updated_at=now() WHERE id=$1", [sandboxId]);
  return {
    version,
    schema: { version: version.schemaVersion, latestMigration },
    agents: { active: productAgents.length, retired: retired.length },
    session: { organizationId: session.organizationId, valid: true },
    models,
  };
}
