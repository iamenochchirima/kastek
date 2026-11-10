import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  childEnvironment,
  registerWorker,
  startProductProcess,
  waitFor,
  waitForPort,
} from "./provisioner/local.js";
import { getSandbox, updateSandboxProvisioning } from "./store.js";

export interface RuntimeRestartResult {
  sandboxId: string;
  alreadyRunning: boolean;
  apiPid: number;
  workerPid: number;
  apiUrl: string;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function belongsToSandbox(pid: number, sandboxId: string, database: string): boolean {
  try {
    const environment = readFileSync(`/proc/${pid}/environ`).toString().split("\0");
    return environment.includes(`AGENTS_SANDBOX_ID=${sandboxId}`) ||
      environment.some((entry) =>
        (entry.startsWith("AGENTS_DATABASE_URL=") || entry.startsWith("DATABASE_URL=")) &&
        entry.includes(`/${database}`));
  } catch {
    return false;
  }
}

async function stopPid(pid: number, sandboxId: string, database: string): Promise<void> {
  if (!belongsToSandbox(pid, sandboxId, database)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
}

export async function restartSandboxRuntime(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<RuntimeRestartResult> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) throw new Error("Sandbox not found");
  if (detail.sandbox.status === "provisioning") throw new Error("Sandbox is still provisioning");
  if (detail.sandbox.status === "retired") throw new Error("Sandbox is retired");
  if (!config.localProvisioning) throw new Error("Local provisioning is not configured");
  if (detail.sandbox.product === "growth") {
    const pairedId = detail.pair?.agentsSandboxId
      ?? (typeof detail.sandbox.runtime.agentsSandboxId === "string"
        ? detail.sandbox.runtime.agentsSandboxId
        : undefined);
    if (!pairedId) throw new Error("Growth sandbox has no paired Agents runtime");
    return restartSandboxRuntime(config, pool, pairedId);
  }
  if (detail.sandbox.product !== "agents") {
    throw new Error(`Runtime restart is not supported for ${detail.sandbox.product}`);
  }

  const runtime = detail.sandbox.runtime as Record<string, unknown>;
  const apiUrl = String(runtime.productApiUrl ?? "");
  const workerUrl = String(runtime.productWorkerUrl ?? "");
  if (!apiUrl || !workerUrl) throw new Error("Sandbox runtime metadata is incomplete");
  if (await healthy(apiUrl)) {
    return {
      sandboxId,
      alreadyRunning: true,
      apiPid: Number(runtime.apiPid ?? 0),
      workerPid: Number(runtime.workerPid ?? 0),
      apiUrl,
    };
  }

  const productDatabase = String(runtime.productDatabase ?? "");
  const bucket = String(runtime.bucket ?? "");
  const apiPort = Number(new URL(apiUrl).port);
  const workerPort = Number(new URL(workerUrl).port);
  if (!productDatabase || !bucket || !apiPort || !workerPort) {
    throw new Error("Sandbox runtime metadata is incomplete");
  }
  for (const value of [runtime.apiPid, runtime.workerPid]) {
    if (typeof value === "number") await stopPid(value, sandboxId, productDatabase);
  }
  let growthApiUrl: string | undefined;
  if (detail.pair) {
    const growth = await getSandbox(pool, detail.pair.growthSandboxId);
    const value = growth?.sandbox.runtime.productApiUrl;
    if (typeof value === "string") growthApiUrl = value;
  }
  const directory = join(config.repoRoot, ".audit", "sandboxes", sandboxId);
  const env = childEnvironment(config, sandboxId, productDatabase, bucket, apiPort, workerPort, growthApiUrl);
  const api = startProductProcess(
    config,
    join(config.repoRoot, "products/agents/api"),
    "src/composition/server.ts",
    env,
    join(directory, "api-restart.log"),
  );
  const worker = startProductProcess(
    config,
    join(config.repoRoot, "products/agents/api"),
    "src/composition/worker.ts",
    env,
    join(directory, "worker-restart.log"),
  );
  await waitFor(async () => healthy(apiUrl), "Agents API");
  await waitForPort(workerPort);
  const deploymentId = await registerWorker(config, workerPort);
  await updateSandboxProvisioning(pool, sandboxId, {
    runtime: {
      ...runtime,
      apiPid: api.pid,
      workerPid: worker.pid,
      restateDeploymentId: deploymentId,
    },
  });
  return {
    sandboxId,
    alreadyRunning: false,
    apiPid: api.pid ?? 0,
    workerPid: worker.pid ?? 0,
    apiUrl,
  };
}


export async function restoreReadySandboxRuntimes(
  config: EvalsConfig,
  pool: Pool,
): Promise<Array<{ sandboxId: string; error: string }>> {
  if (!config.localProvisioning) return [];
  const result = await pool.query<{ id: string; product: string }>(
    `SELECT id::text, product FROM evals.sandboxes
      WHERE status='ready' AND product IN ('agents', 'growth')
      ORDER BY created_at, id`,
  );
  const failures: Array<{ sandboxId: string; error: string }> = [];
  for (const row of result.rows) {
    try {
      await restartSandboxRuntime(config, pool, row.id);
    } catch (error) {
      failures.push({
        sandboxId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}
