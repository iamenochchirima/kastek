import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import type { Pool } from "pg";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { privateFixtureBucketRequest } from "./support/private-s3-fixture";

const image = "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742";
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
async function eventually(check: () => Promise<boolean>) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error("Owned catalogue runtime startup timed out"); }
async function stop(child?: ChildProcess) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }

/** Owns every service it starts. No shared storage, containers, or credentials are used. */
export async function createCatalogueRuntimeFixture(pool: Pool, database: string, origin: string, model: string) {
  const container = `agents-catalogue-browser-${randomUUID()}`, directory = await mkdtemp(resolve(tmpdir(), "agents-catalogue-browser-"));
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  let minio: ChildProcess | undefined, worker: ChildProcess | undefined, started = false, timer: ReturnType<typeof setInterval> | undefined, pending: Promise<unknown> | undefined;
  const close = async () => { if (timer) clearInterval(timer); await pending; await stop(worker); if (started) docker("rm", "-f", container); await stop(minio); await rm(directory, { recursive: true, force: true }); };
  try {
    const binary = process.env.AGENTS_TEST_MINIO_BINARY ?? "/tmp/kasitek-minio-ui.bNXY0o/minio";
    assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"), "c580413cbabd0c91c0c8163790bf79316dd8bf05a240965c43b2b66f864a2849", "Pinned fixture MinIO checksum mismatch");
    const port = await freePort(), consolePort = await freePort(), endpoint = `http://127.0.0.1:${port}`;
    const accessKeyId = "catalogue-fixture", secretAccessKey = randomBytes(32).toString("hex"), bucket = `agents-ingestion-${randomUUID().replaceAll("-", "")}`;
    minio = spawn(binary, ["server", directory, "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${consolePort}`], { env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey }, stdio: "ignore" });
    await eventually(async () => { try { return (await fetch(`${endpoint}/minio/health/ready`)).ok; } catch { return false; } });
    assert.ok((await privateFixtureBucketRequest({ endpoint, bucket, accessKeyId, secretAccessKey }, "PUT")).ok);
    Object.assign(process.env, { AGENTS_S3_ENDPOINT: endpoint, AGENTS_S3_REGION: "us-east-1", AGENTS_S3_BUCKET: bucket, AGENTS_S3_ACCESS_KEY_ID: accessKeyId, AGENTS_S3_SECRET_ACCESS_KEY: secretAccessKey, OPENROUTER_API_KEY: "controlled-model-fixture" });
    const workerPort = await freePort();
    worker = spawn(process.execPath, ["--import", "tsx", resolve(__dirname, "catalogue-execution-worker.ts")], { cwd: resolve(__dirname, ".."), env: { ...process.env, NODE_ENV: "test", OTEL_SDK_DISABLED: "true", AGENTS_DATABASE_URL: database, AGENTS_PUBLIC_URL: origin, CATALOGUE_MODEL_URL: model, CATALOGUE_WORKER_PORT: String(workerPort) }, stdio: ["ignore", "pipe", "pipe"] });
    let ready = false; worker.stdout!.on("data", chunk => { if (String(chunk).includes("CATALOGUE_WORKER_READY")) ready = true; }); worker.stderr!.resume();
    await eventually(async () => { if (worker!.exitCode !== null) throw Error("Owned catalogue worker exited before startup"); return ready; });
    docker("run", "-d", "--name", container, "--cpus", "1", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", image); started = true;
    const ingressUrl = `http://${docker("port", container, "8080/tcp")}`, adminUrl = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } });
    const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, force: false }) });
    assert.ok(registration.ok, "Owned catalogue worker deployment failed");
    timer = setInterval(() => { if (!pending) pending = dispatchTasksOnce(pool, { ingressUrl, adminUrl }).catch(() => undefined).finally(() => { pending = undefined; }); }, 150);
    return { close };
  } catch (error) { await close(); throw error; }
}
