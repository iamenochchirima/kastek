import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { parse as parseEnv } from "dotenv";
import { Pool } from "pg";
import type { EvalsConfig } from "../config.js";
import {
  addWorkspaceRef,
  getSandbox,
  updateSandboxProvisioning,
  type ProvisioningStep,
} from "../store.js";

interface LocalProvisioningInput {
  sandboxId: string;
  workspaceName: string;
  label?: string;
}

interface ProductEnv {
  [key: string]: string | undefined;
}

interface StartedRuntime {
  api: ChildProcess;
  worker: ChildProcess;
  apiPort: number;
  workerPort: number;
  apiUrl: string;
  workerUrl: string;
  directory: string;
  log: (message: string) => Promise<void>;
}

const running = new Map<string, StartedRuntime>();

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function bucketName(sandboxId: string): string {
  return `agents-sandbox-${sandboxId.replaceAll("-", "").slice(0, 16)}`;
}

function databaseName(sandboxId: string): string {
  return `agents_sandbox_${sandboxId.replaceAll("-", "").slice(0, 16)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

async function ensureBucket(
  endpoint: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Generated bucket name is invalid");
  }
  const url = new URL(endpoint);
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const payload = sha256(new Uint8Array());
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
  const canonicalRequest = ["PUT", `/${bucket}`, "", canonicalHeaders, signedHeaders, payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/${bucket}`, {
    method: "PUT",
    headers: {
      "x-amz-date": date,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (![200, 409].includes(response.status)) {
    throw new Error(`Storage bucket creation failed with HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not allocate a local port");
  return port;
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  return waitFor(async () => new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  }), `Worker port ${port}`, timeoutMs);
}

function productEnvironment(config: EvalsConfig): ProductEnv {
  const productDir = join(config.repoRoot, "products/agents/api");
  const files = [
    join(productDir, ".env"),
    join(productDir, ".env.evals"),
  ];
  const loaded: ProductEnv = {};
  for (const file of files) {
    try {
      Object.assign(loaded, parseEnv(readFileSync(file, "utf8")));
    } catch {
      // Optional local product environment.
    }
  }
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    DOCKER_HOST: process.env.DOCKER_HOST,
    NODE_ENV: "development",
    ...loaded,
  };
}

function childEnvironment(
  config: EvalsConfig,
  sandboxId: string,
  productDatabase: string,
  bucket: string,
  apiPort: number,
  workerPort: number,
): ProductEnv {
  const env = productEnvironment(config);
  const base = productEnvironment(config);
  delete env.AGENTS_EVALS_DATABASE_URL;
  delete env.AGENTS_BROWSER_FIXTURE_DATABASE_URL;
  const evalDatabaseUrl = databaseUrl(config.evalDatabaseUrl, productDatabase);
  return {
    ...env,
    AGENTS_DATABASE_URL: evalDatabaseUrl,
    AGENTS_MIGRATION_DATABASE_URL: evalDatabaseUrl,
    AGENTS_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
    AGENTS_LOGIN_RETURN_SECRET:
      env.AGENTS_LOGIN_RETURN_SECRET || randomBytes(32).toString("base64url"),
    AGENTS_BILLING_ENFORCEMENT: "0",
    AGENTS_ALLOW_UNSIGNED_WORKER: "1",
    AGENTS_S3_ENDPOINT: config.localProvisioning!.s3Endpoint,
    AGENTS_S3_REGION: config.localProvisioning!.s3Region,
    AGENTS_S3_BUCKET: bucket,
    AGENTS_S3_ACCESS_KEY_ID: config.localProvisioning!.s3AccessKeyId,
    AGENTS_S3_SECRET_ACCESS_KEY: config.localProvisioning!.s3SecretAccessKey,
    PORT: String(apiPort),
    HOST: "127.0.0.1",
    RESTATE_INGRESS_URL: config.localProvisioning!.restateIngressUrl,
    RESTATE_ADMIN_URL: config.localProvisioning!.restateAdminUrl,
    RESTATE_WORKER_PORT: String(workerPort),
    RESTATE_WORKER_HOST: "0.0.0.0",
    KASITEK_RELEASE_ID: process.env.KASITEK_RELEASE_ID || "local-sandbox",
    AGENTS_SANDBOX_ID: sandboxId,
    AGENTS_CONNECTION_ACTIVE_KEY: base.AGENTS_CONNECTION_ACTIVE_KEY,
    AGENTS_CONNECTION_KEYS: base.AGENTS_CONNECTION_KEYS,
    OPENROUTER_API_KEY: base.OPENROUTER_API_KEY,
  };
}

function startProductProcess(
  config: EvalsConfig,
  script: string,
  env: ProductEnv,
  logFile: string,
): ChildProcess {
  const productDir = join(config.repoRoot, "products/agents/api");
  const loader = join(productDir, "node_modules/tsx/dist/loader.mjs");
  const fd = openSync(logFile, "a", 0o600);
  try {
    return spawn(process.execPath, ["--import", loader, script], {
      cwd: productDir,
      env,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}

function runProductScript(
  config: EvalsConfig,
  script: string,
  env: ProductEnv,
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const productDir = join(config.repoRoot, "products/agents/api");
  const loader = join(productDir, "node_modules/tsx/dist/loader.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, script], {
      cwd: productDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} timed out`));
    }, timeoutMs);
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function updateSteps(
  pool: Pool,
  sandboxId: string,
  steps: ProvisioningStep[],
): Promise<void> {
  await updateSandboxProvisioning(pool, sandboxId, { steps });
}

function markStep(
  steps: ProvisioningStep[],
  name: string,
  status: ProvisioningStep["status"],
  message?: string,
): ProvisioningStep[] {
  const next = steps.filter((step) => step.name !== name);
  next.push({
    name,
    status,
    ...(message ? { message } : {}),
    at: new Date().toISOString(),
  });
  return next;
}

async function createDatabase(config: EvalsConfig, name: string): Promise<void> {
  const admin = new Pool({
    connectionString: databaseUrl(config.evalDatabaseUrl, "postgres"),
    max: 1,
  });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(config: EvalsConfig, name: string): Promise<void> {
  const admin = new Pool({
    connectionString: databaseUrl(config.evalDatabaseUrl, "postgres"),
    max: 1,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function restateWorkerHost(): string {
  const override = process.env.EVALS_LOCAL_RESTATE_WORKER_HOST?.trim();
  if (override) return override;
  try {
    return execFileSync(
      "docker",
      ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
      { encoding: "utf8", timeout: 15_000, env: process.env },
    ).trim();
  } catch {
    return "127.0.0.1";
  }
}

async function registerWorker(config: EvalsConfig, workerPort: number): Promise<string> {
  const host = restateWorkerHost();
  const response = await fetch(`${config.localProvisioning!.restateAdminUrl.replace(/\/+$/, "")}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: `http://${host}:${workerPort}`, use_http_11: false }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Restate worker registration failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const value = text ? JSON.parse(text) as { id?: string } : {};
  return value.id ?? `http://${host}:${workerPort}`;
}

async function stopRuntime(runtime: StartedRuntime | undefined): Promise<void> {
  if (!runtime) return;
  for (const child of [runtime.api, runtime.worker]) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function provisionLocalSandbox(
  config: EvalsConfig,
  pool: Pool,
  input: LocalProvisioningInput,
): Promise<void> {
  const sandbox = await getSandbox(pool, input.sandboxId);
  if (!sandbox) throw new Error("Sandbox not found");
  const directory = join(config.repoRoot, ".audit", "sandboxes", input.sandboxId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let steps: ProvisioningStep[] = [
    { name: "database", status: "pending" },
    { name: "schema", status: "pending" },
    { name: "storage", status: "pending" },
    { name: "runtime", status: "pending" },
    { name: "workspace", status: "pending" },
  ];
  await updateSteps(pool, input.sandboxId, steps);
  const productDatabase = databaseName(input.sandboxId);
  const bucket = bucketName(input.sandboxId);
  let runtime: StartedRuntime | undefined;
  try {
    steps = markStep(steps, "database", "running");
    await updateSteps(pool, input.sandboxId, steps);
    await createDatabase(config, productDatabase);
    steps = markStep(steps, "database", "complete");
    await updateSteps(pool, input.sandboxId, steps);

    steps = markStep(steps, "schema", "running");
    await updateSteps(pool, input.sandboxId, steps);
    const baseEnv = productEnvironment(config);
    const migrationEnv: ProductEnv = {
      ...baseEnv,
      AGENTS_DATABASE_URL: databaseUrl(config.evalDatabaseUrl, productDatabase),
      AGENTS_MIGRATION_DATABASE_URL: databaseUrl(config.evalDatabaseUrl, productDatabase),
      AGENTS_BILLING_ENFORCEMENT: "0",
    };
    const setup = await runProductScript(config, "src/composition/setup.ts", migrationEnv);
    if (setup.code !== 0) {
      throw new Error(`Agents schema setup failed: ${setup.stderr.slice(0, 500)}`);
    }
    steps = markStep(steps, "schema", "complete");
    await updateSteps(pool, input.sandboxId, steps);

    steps = markStep(steps, "storage", "running");
    await updateSteps(pool, input.sandboxId, steps);
    await ensureBucket(
      config.localProvisioning!.s3Endpoint,
      config.localProvisioning!.s3Region,
      config.localProvisioning!.s3AccessKeyId,
      config.localProvisioning!.s3SecretAccessKey,
      bucket,
    );
    steps = markStep(steps, "storage", "complete");
    await updateSteps(pool, input.sandboxId, steps);

    steps = markStep(steps, "runtime", "running");
    await updateSteps(pool, input.sandboxId, steps);
    const apiPort = await availablePort();
    const workerPort = await availablePort();
    const env = childEnvironment(config, input.sandboxId, productDatabase, bucket, apiPort, workerPort);
    const api = startProductProcess(config, "src/composition/server.ts", env, join(directory, "api.log"));
    const worker = startProductProcess(config, "src/composition/worker.ts", env, join(directory, "worker.log"));
    runtime = {
      api,
      worker,
      apiPort,
      workerPort,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      workerUrl: `http://127.0.0.1:${workerPort}`,
      directory,
      log: async (message) => {
        await writeFile(join(directory, "provisioner.log"), `${new Date().toISOString()} ${message}\n`, { flag: "a", mode: 0o600 });
      },
    };
    running.set(input.sandboxId, runtime);
    await waitFor(async () => {
      const response = await fetch(`${runtime!.apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    }, "Agents API");
    await waitForPort(workerPort);
    const deploymentId = await registerWorker(config, workerPort);
    steps = markStep(steps, "runtime", "complete");
    await updateSteps(pool, input.sandboxId, steps);

    steps = markStep(steps, "workspace", "running");
    await updateSteps(pool, input.sandboxId, steps);
    const ownerEmail = `sandbox-owner-${input.sandboxId.slice(0, 8)}@example.local`;
    const bootstrap = await runProductScript(config, "src/composition/bootstrap-sandbox.ts", {
      ...env,
      AGENTS_BOOTSTRAP_EMAIL: ownerEmail,
      AGENTS_BOOTSTRAP_WORKSPACE_NAME: input.workspaceName,
      AGENTS_BOOTSTRAP_DISPLAY_NAME: "Sandbox owner",
      AGENTS_BOOTSTRAP_ISSUER: env.AGENTS_OIDC_ISSUER_URL || "http://localhost/sandbox",
      AGENTS_BOOTSTRAP_SUBJECT: `sandbox-owner-${input.sandboxId}`,
    });
    if (bootstrap.code !== 0) {
      throw new Error(`Workspace bootstrap failed: ${bootstrap.stderr.slice(0, 500)}`);
    }
    const owner = JSON.parse(bootstrap.stdout) as {
      accountId: string;
      organizationId: string;
      organizationName: string;
      session: string;
      expiresAt: string;
    };
    await addWorkspaceRef(pool, input.sandboxId, {
      productWorkspaceId: owner.organizationId,
      label: owner.organizationName,
    });
    await writeFile(join(directory, "owner-session.json"), JSON.stringify({
      origin: runtime.apiUrl,
      organizationId: owner.organizationId,
      organizationName: owner.organizationName,
      accountId: owner.accountId,
      session: owner.session,
      expiresAt: owner.expiresAt,
    }, null, 2), { mode: 0o600 });
    steps = markStep(steps, "workspace", "complete");
    await updateSandboxProvisioning(pool, input.sandboxId, {
      status: "ready",
      steps,
      provisionedAt: new Date().toISOString(),
      runtime: {
        profile: "local",
        productApiUrl: runtime.apiUrl,
        productWorkerUrl: runtime.workerUrl,
        productDatabase,
        bucket,
        apiPid: api.pid,
        workerPid: worker.pid,
        restateDeploymentId: deploymentId,
        workspaceId: owner.organizationId,
        workspaceName: owner.organizationName,
        accountId: owner.accountId,
        sessionFile: join(directory, "owner-session.json"),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep = steps.find((step) => step.status === "running")?.name ?? "runtime";
    steps = markStep(steps, failedStep, "failed", message);
    await updateSandboxProvisioning(pool, input.sandboxId, {
      status: "failed",
      steps,
      error: message.slice(0, 2_000),
    }).catch(() => undefined);
    await stopRuntime(runtime);
    running.delete(input.sandboxId);
    await dropDatabase(config, productDatabase).catch(() => undefined);
    throw error;
  }
}

export function stopProvisionedSandbox(sandboxId: string): Promise<void> {
  const runtime = running.get(sandboxId);
  running.delete(sandboxId);
  return stopRuntime(runtime);
}
