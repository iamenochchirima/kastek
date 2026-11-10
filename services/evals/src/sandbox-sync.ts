import { join } from "node:path";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  databaseUrl,
  productEnvironment,
  registerWorker,
  runProductScript,
  startProductProcess,
  waitFor,
  waitForPort,
} from "./provisioner/local.js";
import {
  growthEnvironment,
  growthWorkerEnvironment,
  runMigrations,
} from "./provisioner/growth.js";
import { ownerRequest, readOwnerSession } from "./product-agents.js";
import {
  getSandbox,
  recordSandboxVersion,
  type SandboxDetail,
} from "./store.js";
import {
  createSandboxUpdate,
  updateSandboxUpdate,
  type AgentSetupStep,
  type SandboxUpdate,
} from "./profile-store.js";
import {
  restartSandboxRuntime,
  stopPid,
} from "./runtime.js";
import { captureSandboxVersion } from "./version.js";

export class SandboxSyncError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxSyncError";
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new SandboxSyncError(statusCode, code, message);
}

function steps(names: string[]): AgentSetupStep[] {
  return names.map((name) => ({ name, status: "pending" }));
}

function mark(stepsValue: AgentSetupStep[], name: string, status: AgentSetupStep["status"], message?: string): AgentSetupStep[] {
  const next = stepsValue.filter((item) => item.name !== name);
  next.push({ name, status, ...(message ? { message } : {}), at: new Date().toISOString() });
  return next;
}

const activeSyncs = new Set<string>();

async function applyAgentsSchema(config: EvalsConfig, database: string): Promise<void> {
  const url = databaseUrl(config.evalDatabaseUrl, database);
  const result = await runProductScript(
    config,
    join(config.repoRoot, "products/agents/api"),
    "src/composition/setup.ts",
    {
      ...productEnvironment(config),
      AGENTS_DATABASE_URL: url,
      AGENTS_MIGRATION_DATABASE_URL: url,
      AGENTS_BILLING_ENFORCEMENT: "1",
    },
    300_000,
  );
  if (result.code !== 0) {
    throw new Error(`Agents schema update failed: ${result.stderr.slice(0, 500)}`);
  }
}

async function restartGrowthRuntime(
  config: EvalsConfig,
  detail: SandboxDetail,
  sandboxId: string,
): Promise<void> {
  const runtime = detail.sandbox.runtime as Record<string, unknown>;
  const database = String(runtime.productDatabase ?? "");
  const apiUrl = String(runtime.productApiUrl ?? "");
  const agentsApiUrl = String(runtime.agentsApiUrl ?? "");
  const mediaDirectory = String(runtime.mediaStoragePath ?? join(config.repoRoot, ".audit", "sandboxes", sandboxId, "media"));
  if (!database || !apiUrl || !agentsApiUrl) throw new Error("Growth runtime metadata is incomplete");
  for (const value of [runtime.growthApiPid, runtime.growthWorkerPid]) {
    if (typeof value === "number") await stopPid(value, sandboxId, database);
  }
  const port = Number(new URL(apiUrl).port);
  const environment = growthEnvironment(config, port, database, agentsApiUrl, mediaDirectory);
  const api = startProductProcess(
    config,
    join(config.repoRoot, "products/growth/api"),
    "src/bootstrap.ts",
    environment,
    join(config.repoRoot, ".audit", "sandboxes", sandboxId, "api.log"),
  );
  await waitFor(async () => {
    const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  }, "Growth API");
  const worker = startProductProcess(
    config,
    join(config.repoRoot, "products/growth/api"),
    "src/bootstrap.ts",
    growthWorkerEnvironment(config, port, database, agentsApiUrl, mediaDirectory),
    join(config.repoRoot, ".audit", "sandboxes", sandboxId, "worker.log"),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (worker.exitCode !== null) throw new Error("Growth worker failed to start");
  (detail.sandbox.runtime as Record<string, unknown>).growthApiPid = api.pid;
  (detail.sandbox.runtime as Record<string, unknown>).growthWorkerPid = worker.pid;
}

async function smoke(
  config: EvalsConfig,
  detail: SandboxDetail,
): Promise<void> {
  const session = await readOwnerSession(config, detail);
  const runtime = detail.sandbox.runtime as Record<string, unknown>;
  const apiUrl = String(runtime.productApiUrl ?? "");
  if (!apiUrl) throw new Error("Product API URL is missing");
  const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error("Product health check failed");
  if (detail.sandbox.product === "growth") {
    const bootstrap = await ownerRequest(session, "kasitek_session", "GET", "/api/agents/bootstrap");
    if (!Array.isArray(bootstrap.features)) throw new Error("Growth agent read failed");
    return;
  }
  const sessionResponse = await ownerRequest(
    session,
    "agents_session",
    "GET",
    "/api/session",
  );
  void sessionResponse;
  const agents = await ownerRequest(
    session,
    "agents_session",
    "GET",
    `/api/organizations/${encodeURIComponent(session.organizationId)}/agents`,
  );
  if (!Array.isArray(agents.agents)) throw new Error("Agents read failed");
}

async function updateGrowthRuntimeMetadata(
  pool: Pool,
  sandboxId: string,
  detail: SandboxDetail,
): Promise<void> {
  const { updateSandboxProvisioning } = await import("./store.js");
  await updateSandboxProvisioning(pool, sandboxId, {
    runtime: { ...detail.sandbox.runtime },
  });
}

export async function syncSandbox(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<SandboxUpdate> {
  if (activeSyncs.has(sandboxId)) fail(409, "sandbox_sync_running", "A sandbox update is already running");
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  if (detail.sandbox.status !== "ready") fail(409, "sandbox_not_ready", "Sandbox is not ready");
  const active = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM evals.interactive_sessions WHERE sandbox_id=$1 AND state='active'",
    [sandboxId],
  );
  if (Number(active.rows[0]?.count ?? "0") > 0) {
    fail(409, "active_session", "Finish active conversations before updating the sandbox");
  }
  const manifest = await captureSandboxVersion(
    config,
    {},
    detail.sandbox.product === "growth" ? "growth" : "agents",
  );
  const update = await createSandboxUpdate(pool, {
    sandboxId,
    previousVersionId: detail.version?.id ?? null,
    targetCodeRevision: manifest.codeRevision,
    targetSchemaVersion: manifest.schemaVersion,
    targetMigrationChecksum: manifest.migrationChecksum,
  });
  activeSyncs.add(sandboxId);
  let currentSteps = steps(["preflight", "migrations", "runtime", "smoke", "version"]);
  try {
    currentSteps = mark(currentSteps, "preflight", "complete");
    await updateSandboxUpdate(pool, update.id, { status: "running", steps: currentSteps });

    currentSteps = mark(currentSteps, "migrations", "running");
    await updateSandboxUpdate(pool, update.id, { steps: currentSteps });
    if (detail.sandbox.product === "growth") {
      const growthDatabase = String(detail.sandbox.runtime.productDatabase ?? "");
      const pairedId = detail.pair?.agentsSandboxId;
      if (!growthDatabase) throw new Error("Growth database is missing");
      const migrated = await runMigrations(config, growthDatabase);
      if (migrated.code !== 0) throw new Error(`Growth schema update failed: ${migrated.stderr.slice(0, 500)}`);
      if (pairedId) {
        const paired = await getSandbox(pool, pairedId);
        const pairedDatabase = paired ? String(paired.sandbox.runtime.productDatabase ?? "") : "";
        if (pairedDatabase) await applyAgentsSchema(config, pairedDatabase);
      }
    } else {
      const database = String(detail.sandbox.runtime.productDatabase ?? "");
      if (!database) throw new Error("Agents database is missing");
      await applyAgentsSchema(config, database);
    }
    currentSteps = mark(currentSteps, "migrations", "complete");

    currentSteps = mark(currentSteps, "runtime", "running");
    await updateSandboxUpdate(pool, update.id, { steps: currentSteps });
    if (detail.sandbox.product === "growth") {
      await restartGrowthRuntime(config, detail, sandboxId);
      const pairedId = detail.pair?.agentsSandboxId;
      if (!pairedId) throw new Error("Growth sandbox has no paired Agents runtime");
      await restartSandboxRuntime(config, pool, pairedId, { force: true });
      await updateGrowthRuntimeMetadata(pool, sandboxId, detail);
    } else {
      await restartSandboxRuntime(config, pool, sandboxId, { force: true });
    }
    currentSteps = mark(currentSteps, "runtime", "complete");

    currentSteps = mark(currentSteps, "smoke", "running");
    await updateSandboxUpdate(pool, update.id, { steps: currentSteps });
    await smoke(config, detail);
    currentSteps = mark(currentSteps, "smoke", "complete");

    currentSteps = mark(currentSteps, "version", "running");
    await recordSandboxVersion(pool, sandboxId, manifest);
    currentSteps = mark(currentSteps, "version", "complete");
    return (await updateSandboxUpdate(pool, update.id, {
      status: "ready",
      steps: currentSteps,
      error: null,
    }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const running = currentSteps.find((item) => item.status === "running")?.name ?? "runtime";
    await updateSandboxUpdate(pool, update.id, {
      status: "failed",
      steps: mark(currentSteps, running, "failed", message),
      error: message.slice(0, 2_000),
    }).catch(() => undefined);
    throw error;
  } finally {
    activeSyncs.delete(sandboxId);
  }
}
