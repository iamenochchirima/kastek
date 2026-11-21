import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  getSandbox,
  listSandboxIds,
  retireSandbox,
  type SandboxDetail,
} from "./store.js";
import {
  deleteBucket,
  dropDatabase,
  stopProvisionedSandbox,
} from "./provisioner/local.js";

export class SandboxLifecycleError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxLifecycleError";
  }
}

export interface SandboxDeleteResult {
  deleted: string[];
  alreadyRetired: boolean;
  stoppedProcesses: number;
  droppedDatabases: string[];
  removedDirectories: string[];
  bucket: "deleted" | "not_empty" | "missing" | "skipped" | "failed";
}

export interface DeleteAllResult {
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
}

function fail(statusCode: number, code: string, message: string): never {
  throw new SandboxLifecycleError(statusCode, code, message);
}

function databaseName(detail: SandboxDetail): string {
  const product = detail.sandbox.product;
  if (!["agents", "growth", "agency"].includes(product)) {
    fail(409, "unsupported_product", `Unsupported sandbox product: ${product}`);
  }
  const prefix = `${product}_sandbox_`;
  const runtimeDatabase = detail.sandbox.runtime.productDatabase;
  if (
    typeof runtimeDatabase === "string" &&
    new RegExp(`^${prefix}[a-f0-9]{16}$`).test(runtimeDatabase)
  ) {
    return runtimeDatabase;
  }
  return `${prefix}${detail.sandbox.id.replaceAll("-", "").slice(0, 16)}`;
}

function sandboxDirectory(config: EvalsConfig, sandboxId: string): string {
  return join(config.repoRoot, ".audit", "sandboxes", sandboxId);
}

function runtimePids(detail: SandboxDetail): number[] {
  const runtime = detail.sandbox.runtime;
  const candidates = detail.sandbox.product === "growth"
    ? [runtime.growthApiPid, runtime.growthWorkerPid, runtime.apiPid, runtime.workerPid]
    : [runtime.apiPid, runtime.workerPid];
  return [...new Set(
    candidates.filter((value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 1,
    ),
  )];
}

function processEnvironment(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`)
      .toString()
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function belongsToSandbox(pid: number, sandboxId: string, database: string): boolean {
  const environment = processEnvironment(pid);
  if (!environment) return false;
  return (
    environment.includes(`AGENTS_SANDBOX_ID=${sandboxId}`) ||
    environment.some((entry) =>
      entry.startsWith("DATABASE_URL=") && entry.includes(`/${database}`),
    ) ||
    environment.some((entry) =>
      entry.startsWith("AGENTS_DATABASE_URL=") && entry.includes(`/${database}`),
    )
  );
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!running(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !running(pid);
}

async function stopRecordedProcess(
  pid: number,
  sandboxId: string,
  database: string,
): Promise<boolean> {
  if (!belongsToSandbox(pid, sandboxId, database)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  if (await waitForExit(pid, 3_000)) return true;
  if (!belongsToSandbox(pid, sandboxId, database)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the check and the signal.
  }
  return waitForExit(pid, 1_000);
}

async function deleteAgentsBucket(
  config: EvalsConfig,
  detail: SandboxDetail,
): Promise<SandboxDeleteResult["bucket"]> {
  if (detail.sandbox.product !== "agents") return "skipped";
  const bucket = detail.sandbox.runtime.bucket;
  if (typeof bucket !== "string" || !config.localProvisioning) return "skipped";
  try {
    return await deleteBucket(
      config.localProvisioning.s3Endpoint,
      config.localProvisioning.s3Region,
      config.localProvisioning.s3AccessKeyId,
      config.localProvisioning.s3SecretAccessKey,
      bucket,
    );
  } catch {
    return "failed";
  }
}

export async function deleteSandbox(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<SandboxDeleteResult> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  const targets = [detail];
  if (detail.pair) {
    const pairedId = detail.pair.growthSandboxId === detail.sandbox.id
      ? detail.pair.agentsSandboxId
      : detail.pair.growthSandboxId;
    const paired = await getSandbox(pool, pairedId);
    if (paired) targets.push(paired);
  }
  const deleted: string[] = [];
  let stoppedProcesses = 0;
  const droppedDatabases: string[] = [];
  const removedDirectories: string[] = [];
  let bucket: SandboxDeleteResult["bucket"] = "skipped";
  let alreadyRetired = true;
  for (const target of targets) {
    const result = await cleanupSandbox(config, pool, target);
    deleted.push(...result.deleted);
    stoppedProcesses += result.stoppedProcesses;
    droppedDatabases.push(...result.droppedDatabases);
    removedDirectories.push(...result.removedDirectories);
    if (result.bucket !== "skipped") bucket = result.bucket;
    if (!result.alreadyRetired) alreadyRetired = false;
  }
  return {
    deleted: [...new Set(deleted)],
    alreadyRetired,
    stoppedProcesses,
    droppedDatabases: [...new Set(droppedDatabases)],
    removedDirectories: [...new Set(removedDirectories)],
    bucket,
  };
}

async function cleanupSandbox(
  config: EvalsConfig,
  pool: Pool,
  detail: SandboxDetail,
): Promise<SandboxDeleteResult> {
  const id = detail.sandbox.id;
  if (detail.sandbox.status === "retired") {
    return {
      deleted: [id],
      alreadyRetired: true,
      stoppedProcesses: 0,
      droppedDatabases: [],
      removedDirectories: [],
      bucket: "skipped",
    };
  }
  if (detail.sandbox.status === "provisioning") {
    fail(409, "sandbox_provisioning", "Wait for the sandbox to finish provisioning before deleting it");
  }

  if (detail.sandbox.runtime.kind === "api") {
    const directory = join(config.repoRoot, ".audit", "api-environments", id);
    await rm(directory, { recursive: true, force: true });
    await retireSandbox(pool, id);
    return {
      deleted: [id],
      alreadyRetired: false,
      stoppedProcesses: 0,
      droppedDatabases: [],
      removedDirectories: [directory],
      bucket: "skipped",
    };
  }

  const database = databaseName(detail);
  let stoppedProcesses = 0;
  await stopProvisionedSandbox(id).catch(() => undefined);
  for (const pid of runtimePids(detail)) {
    if (await stopRecordedProcess(pid, id, database)) stoppedProcesses += 1;
  }

  await dropDatabase(config, database);
  const bucket = await deleteAgentsBucket(config, detail);
  await rm(sandboxDirectory(config, id), { recursive: true, force: true });
  await retireSandbox(pool, id);

  return {
    deleted: [id],
    alreadyRetired: false,
    stoppedProcesses,
    droppedDatabases: [database],
    removedDirectories: [sandboxDirectory(config, id)],
    bucket,
  };
}

export async function deleteAllSandboxes(
  config: EvalsConfig,
  pool: Pool,
): Promise<DeleteAllResult> {
  const ids = await listSandboxIds(pool, "not_retired");
  if (!ids.length) return { deleted: [], failed: [] };
  for (const id of ids) {
    const detail = await getSandbox(pool, id);
    if (detail?.sandbox.status === "provisioning") {
      fail(
        409,
        "sandbox_provisioning",
        "Wait for all provisioning sandboxes to finish before deleting all sandboxes",
      );
    }
  }
  const handled = new Set<string>();
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    if (handled.has(id)) continue;
    try {
      const result = await deleteSandbox(config, pool, id);
      for (const item of result.deleted) handled.add(item);
      deleted.push(...result.deleted);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      handled.add(id);
    }
  }
  return { deleted: [...new Set(deleted)], failed };
}
