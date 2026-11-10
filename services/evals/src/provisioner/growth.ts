import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import type { EvalsConfig } from "../config.js";
import {
  addWorkspaceRef,
  createSandboxPair,
  getSandbox,
  updateSandboxProvisioning,
  type ProvisioningStep,
} from "../store.js";
import { ensureSandboxBilling } from "./billing.js";
import {
  availablePort,
  createDatabase,
  dropDatabase,
  markStep,
  productEnvironment,
  runProductScript,
  startProductProcess,
  stopProvisionedSandbox,
  updateSteps,
  waitFor,
  type ProductEnv,
} from "./local.js";

export interface GrowthProvisioningInput {
  growthSandboxId: string;
  agentsSandboxId: string;
  workspaceName: string;
  label?: string;
}

interface GrowthBootstrap {
  userId: string;
  organizationId: string;
  organizationName: string;
  session: string;
  expiresAt: string;
  agentSetupRequestId: string;
}

function growthDatabaseName(sandboxId: string): string {
  return `growth_sandbox_${sandboxId.replaceAll("-", "").slice(0, 16)}`;
}

function growthDirectory(config: EvalsConfig, sandboxId: string): string {
  return join(config.repoRoot, ".audit", "sandboxes", sandboxId);
}

function growthEnvironment(
  config: EvalsConfig,
  growthPort: number,
  databaseName: string,
  agentsApiUrl: string,
  mediaDirectory: string,
): ProductEnv {
  const base = productEnvironment(config, join(config.repoRoot, "products/growth/api"));
  const origin = `http://127.0.0.1:${growthPort}`;
  const databaseUrl = (() => {
    const url = new URL(config.evalDatabaseUrl);
    url.pathname = `/${encodeURIComponent(databaseName)}`;
    return url.toString();
  })();
  return {
    ...base,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    PORT: String(growthPort),
    FRONTEND_URL: origin,
    KASITEK_CORE_PUBLIC_URL: origin,
    ENVIRONMENT: "development",
    NODE_ENV: "development",
    KASITEK_DISABLE_BACKGROUND_WORKERS: "1",
    AGENTS_PRODUCT_API_URL: agentsApiUrl,
    KASITEK_MEDIA_STORAGE_PATH: mediaDirectory,
    KASITEK_RELEASE_ID: process.env.KASITEK_RELEASE_ID || "local-sandbox",
    KASITEK_PROCESS: "",
  };
}

function growthWorkerEnvironment(
  config: EvalsConfig,
  growthPort: number,
  databaseName: string,
  agentsApiUrl: string,
  mediaDirectory: string,
): ProductEnv {
  return {
    ...growthEnvironment(config, growthPort, databaseName, agentsApiUrl, mediaDirectory),
    KASITEK_PROCESS: "growth-agent-setup-worker",
  };
}

function runMigrations(
  config: EvalsConfig,
  databaseName: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const databaseDir = join(config.repoRoot, "products/growth/database");
  const database = (() => {
    const url = new URL(config.evalDatabaseUrl);
    url.pathname = `/${encodeURIComponent(databaseName)}`;
    return url.toString();
  })();
  const prisma = join(databaseDir, "node_modules/prisma/build/index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prisma, "migrate", "deploy"], {
      cwd: databaseDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        DATABASE_URL: database,
        DIRECT_URL: database,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Growth database migrations timed out"));
    }, 300_000);
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readGrowthAgentSetup(
  databaseName: string,
  config: EvalsConfig,
  organizationId: string,
): Promise<{ status: string; failureCode: string | null } | null> {
  const url = new URL(config.evalDatabaseUrl);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const result = await pool.query<{ status: string; failure_code: string | null }>(
      `SELECT status, "failureCode" AS failure_code FROM "GrowthAgentSetup" WHERE "orgId"=$1`,
      [organizationId],
    );
    return result.rows[0]
      ? { status: result.rows[0].status, failureCode: result.rows[0].failure_code }
      : null;
  } finally {
    await pool.end();
  }
}

export async function provisionGrowthPair(
  config: EvalsConfig,
  pool: Pool,
  input: GrowthProvisioningInput,
): Promise<void> {
  const growth = await getSandbox(pool, input.growthSandboxId);
  const agents = await getSandbox(pool, input.agentsSandboxId);
  if (!growth || !agents) throw new Error("Growth or Agents sandbox not found");
  const directory = growthDirectory(config, input.growthSandboxId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "media"), { recursive: true, mode: 0o700 });
  const growthDatabase = growthDatabaseName(input.growthSandboxId);
  let steps: ProvisioningStep[] = [
    { name: "agents", status: "pending" },
    { name: "database", status: "pending" },
    { name: "schema", status: "pending" },
    { name: "runtime", status: "pending" },
    { name: "workspace", status: "pending" },
    { name: "billing", status: "pending" },
    { name: "pairing", status: "pending" },
    { name: "agent-setup", status: "pending" },
  ];
  await updateSteps(pool, input.growthSandboxId, steps);
  let growthApi: ChildProcess | undefined;
  let growthWorker: ChildProcess | undefined;
  let agentsProvisioned = false;
  const growthPort = await availablePort();
  const growthApiUrl = `http://127.0.0.1:${growthPort}`;
  try {
    steps = markStep(steps, "agents", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    await provisionAgentsSandbox(config, pool, input, growthApiUrl);
    agentsProvisioned = true;
    const agentsDetail = await getSandbox(pool, input.agentsSandboxId);
    const agentsApiUrl = agentsDetail?.sandbox.runtime.productApiUrl;
    const agentsDatabase = agentsDetail?.sandbox.runtime.productDatabase;
    if (typeof agentsApiUrl !== "string") throw new Error("Paired Agents API URL is missing");
    steps = markStep(steps, "agents", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "database", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    await createDatabase(config, growthDatabase);
    steps = markStep(steps, "database", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "schema", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    const migrated = await runMigrations(config, growthDatabase);
    if (migrated.code !== 0) {
      throw new Error(`Growth schema migrations failed: ${migrated.stderr.slice(0, 500)}`);
    }
    steps = markStep(steps, "schema", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "runtime", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    const env = growthEnvironment(config, growthPort, growthDatabase, agentsApiUrl, join(directory, "media"));
    growthApi = startProductProcess(
      config,
      join(config.repoRoot, "products/growth/api"),
      "src/bootstrap.ts",
      env,
      join(directory, "api.log"),
    );
    const api = growthApi;
    await waitFor(async () => {
      const response = await fetch(`${growthApiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    }, "Growth API");
    const ownerEmail = `growth-owner-${input.growthSandboxId.slice(0, 8)}@example.local`;
    const bootstrap = await runProductScript(
      config,
      join(config.repoRoot, "products/growth/api"),
      "src/bootstrap-sandbox.ts",
      {
        ...env,
        GROWTH_BOOTSTRAP_EMAIL: ownerEmail,
        GROWTH_BOOTSTRAP_WORKSPACE_NAME: input.workspaceName,
        GROWTH_BOOTSTRAP_DISPLAY_NAME: "Sandbox owner",
      },
    );
    if (bootstrap.code !== 0) {
      throw new Error(`Growth workspace bootstrap failed: ${bootstrap.stderr.slice(0, 500)}`);
    }
    const owner = JSON.parse(bootstrap.stdout) as GrowthBootstrap;
    steps = markStep(steps, "runtime", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "workspace", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    await addWorkspaceRef(pool, input.growthSandboxId, {
      productWorkspaceId: owner.organizationId,
      label: owner.organizationName,
    });
    await writeFile(join(directory, "owner-session.json"), JSON.stringify({
      origin: growthApiUrl,
      organizationId: owner.organizationId,
      organizationName: owner.organizationName,
      accountId: owner.userId,
      session: owner.session,
      expiresAt: owner.expiresAt,
    }, null, 2), { mode: 0o600 });
    steps = markStep(steps, "workspace", "complete");
    steps = markStep(steps, "billing", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    const billing = await ensureSandboxBilling(config, {
      product: "growth",
      tenantId: owner.organizationId,
      name: owner.organizationName,
      billingEmail: ownerEmail,
    });
    steps = markStep(steps, "billing", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "agent-setup", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    growthWorker = startProductProcess(
      config,
      join(config.repoRoot, "products/growth/api"),
      "src/bootstrap.ts",
      growthWorkerEnvironment(config, growthPort, growthDatabase, agentsApiUrl, join(directory, "media")),
      join(directory, "worker.log"),
    );
    await waitFor(async () => {
      const setup = await readGrowthAgentSetup(growthDatabase, config, owner.organizationId);
      if (setup?.status === "failed" || setup?.status === "blocked") {
        throw new Error(`Growth agent setup ${setup.status}: ${setup.failureCode ?? "unknown"}`);
      }
      return setup?.status === "ready";
    }, "Growth agent setup", 180_000);
    let growthAgentsOrganizationId: string | null = null;
    if (typeof agentsDatabase === "string") {
      const agentsDatabaseUrl = new URL(config.evalDatabaseUrl);
      agentsDatabaseUrl.pathname = `/${encodeURIComponent(agentsDatabase)}`;
      const agentsPool = new Pool({ connectionString: agentsDatabaseUrl.toString(), max: 1 });
      try {
        const organization = await agentsPool.query<{ id: string; name: string }>(
          `SELECT id, name FROM agents_platform.organizations
           WHERE name='Growth business' ORDER BY created_at LIMIT 1`,
        );
        if (organization.rows[0]) {
          growthAgentsOrganizationId = organization.rows[0].id;
          await addWorkspaceRef(pool, input.agentsSandboxId, {
            productWorkspaceId: organization.rows[0].id,
            label: organization.rows[0].name,
          });
        }
      } finally {
        await agentsPool.end();
      }
    }
    steps = markStep(steps, "agent-setup", "complete");
    await updateSteps(pool, input.growthSandboxId, steps);

    steps = markStep(steps, "pairing", "running");
    await updateSteps(pool, input.growthSandboxId, steps);
    const pair = await createSandboxPair(pool, input.growthSandboxId, input.agentsSandboxId);
    steps = markStep(steps, "pairing", "complete");
    await updateSandboxProvisioning(pool, input.growthSandboxId, {
      status: "ready",
      steps,
      provisionedAt: new Date().toISOString(),
      runtime: {
        profile: "local",
        product: "growth",
        productApiUrl: growthApiUrl,
        productDatabase: growthDatabase,
        mediaStoragePath: join(directory, "media"),
        organizationId: owner.organizationId,
        organizationName: owner.organizationName,
        accountId: owner.userId,
        sessionFile: join(directory, "owner-session.json"),
        billing,
        agentsSandboxId: input.agentsSandboxId,
        agentsApiUrl,
        ...(growthAgentsOrganizationId ? { growthAgentsOrganizationId } : {}),
        growthApiPid: api.pid,
        growthWorkerPid: growthWorker.pid,
        pairId: pair.id,
        agentSetupStatus: "ready",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep = steps.find((step) => step.status === "running")?.name ?? "runtime";
    steps = markStep(steps, failedStep, "failed", message);
    await updateSandboxProvisioning(pool, input.growthSandboxId, {
      status: "failed",
      steps,
      error: message.slice(0, 2_000),
    }).catch(() => undefined);
    for (const child of [growthWorker, growthApi]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    if (agentsProvisioned) {
      await stopProvisionedSandbox(input.agentsSandboxId).catch(() => undefined);
      await updateSandboxProvisioning(pool, input.agentsSandboxId, {
        status: "failed",
        error: `Growth pair provisioning failed: ${message}`.slice(0, 2_000),
      }).catch(() => undefined);
    }
    await dropDatabase(config, growthDatabase).catch(() => undefined);
    throw error;
  }
}

async function provisionAgentsSandbox(
  config: EvalsConfig,
  pool: Pool,
  input: GrowthProvisioningInput,
  growthApiUrl: string,
): Promise<void> {
  const { provisionLocalSandbox } = await import("./local.js");
  await provisionLocalSandbox(config, pool, {
    sandboxId: input.agentsSandboxId,
    workspaceName: `${input.workspaceName} runtime`,
    ...(input.label ? { label: `${input.label} runtime` } : {}),
    growthProductApiUrl: growthApiUrl,
  });
}
