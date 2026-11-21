import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { createExecutorHost } from "../adapters/executors/executor-host";
import { decodeExecutorValue, encodeExecutorValue,type ExecutorRequest } from "../contracts/executor";
import { PlatformError } from "../contracts/contracts";
import { sandboxManagerFromEnvironment, sandboxAllocationId } from "../capabilities/sandbox/sandbox";
import { documentRuntimeFromEnvironment } from "../platform/knowledge";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { ExecutorOwners } from "../infrastructure/executor-owners";

export function ownedExecutor(pool: Pool, environment: NodeJS.ProcessEnv = process.env) {
  const id = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).parse(environment.AGENTS_EXECUTOR_ID), key = z.string().min(32).parse(environment.AGENTS_EXECUTOR_KEY);
  const requests=new AsyncLocalStorage<ExecutorRequest>(),owners=new ExecutorOwners(pool);
  const sandbox = sandboxManagerFromEnvironment(pool, environment,{async assertOwnership(allocationId,starting){const request=requests.getStore();if(!request||request.resourceKind!=="sandbox"||request.allocationId!==allocationId)throw new PlatformError("EXECUTOR_SCOPE_DENIED",403,"Physical executor context is unavailable");await owners.assert("sandbox",allocationId,id,request.generation,starting);}}), documents = documentRuntimeFromEnvironment(environment);
  const journalDirectory = environment.AGENTS_EXECUTOR_JOURNAL_DIRECTORY || join(homedir(), ".cache/kasitek-executors", id);
  const scopeSchema = z.object({ organizationId: z.uuid(), rootTaskId: z.uuid(), taskId: z.uuid(), deadlineAt: z.coerce.date() });
  return createExecutorHost({ pool, executorId: id, key, journalDirectory,maxActive:z.coerce.number().int().min(1).max(16).parse(environment.AGENTS_EXECUTOR_MAX_ACTIVE||"2"), async dispatch(request, recovering) {
    return requests.run(request,async()=>{
    const payload = decodeExecutorValue(request.payload);
    if (request.resourceKind === "sandbox") {
      if (!sandbox) throw new PlatformError("SANDBOX_UNAVAILABLE", 503, "Sandbox executor is unavailable");
      if (request.command === "available") return sandbox.available();
      if (request.command === "analyze") {
        const scope = scopeSchema.parse(payload?.scope), input = payload?.input;
        if (sandboxAllocationId(scope.taskId, z.string().min(1).max(128).parse(input?.operationId)) !== request.allocationId) throw new PlatformError("EXECUTOR_IDENTITY_CONFLICT", 409, "Sandbox allocation identity conflict");
        if (recovering && !(await pool.query("SELECT 1 FROM agents_platform.sandbox_allocations WHERE id=$1", [request.allocationId])).rowCount) throw new PlatformError("EXECUTOR_START_UNCERTAIN", 503, "Sandbox start outcome is uncertain");
        return encodeExecutorValue(await sandbox.analyze(scope, input));
      }
      const row = (await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE id=$1", [request.allocationId])).rows[0];
      if(!row&&["destroy","quiesce"].includes(request.command)&&await sandbox.confirmAbsent(request.allocationId))return {state:"destroyed",allocationId:request.allocationId};
      if (!row) throw new PlatformError("EXECUTOR_RESOURCE_UNKNOWN", 503, "Sandbox ownership is unresolved");
      const scope = { organizationId: row.organization_id, rootTaskId: row.root_task_id, taskId: row.task_id, deadlineAt: new Date(row.lease_expires_at) };
      if (request.command === "status") return encodeExecutorValue(await sandbox.status(scope, request.allocationId));
      if (request.command === "finalize") { await sandbox.finalize(scope, request.allocationId, z.array(z.unknown()).max(4).parse(payload?.artifactRefs)); return { state: "destroyed", allocationId: request.allocationId }; }
      if (request.command === "destroy" || request.command === "quiesce") { await sandbox.destroy(scope, request.allocationId); return { state: "destroyed", allocationId: request.allocationId }; }
    } else {
      if (!documents) throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE", 503, "Document executor is unavailable");
      if (request.command === "available") return documents.available(payload?.release);
      if (request.command === "profile") return documents.profile(payload?.release);
      if (request.command === "start") {
        if (payload?.allocationId !== request.allocationId) throw new PlatformError("EXECUTOR_IDENTITY_CONFLICT", 409, "Document allocation identity conflict");
        const row = (await pool.query(`SELECT job_id AS job,profile_release FROM agents_platform.document_allocations WHERE id=$1 UNION ALL SELECT task_id AS job,profile_release FROM agents_platform.query_embedding_allocations WHERE id=$1`, [request.allocationId])).rows[0];
        if (!row || row.job !== payload.jobId || row.profile_release !== payload.profileRelease) throw new PlatformError("DOCUMENT_SCOPE_DENIED", 403, "Document allocation scope denied");
        return recovering ? documents.status(request.allocationId) : documents.start(payload);
      }
      if (request.command === "status") return documents.status(request.allocationId);
      if (request.command === "result") return encodeExecutorValue(await documents.result(request.allocationId));
      if (request.command === "destroy" || request.command === "quiesce") return documents.destroy(request.allocationId);
    }
    throw new PlatformError("EXECUTOR_COMMAND_DENIED", 400, "Executor command is unavailable");
    });
  } });
}

async function main() {
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("cleanup") });
  let guard: ChildProcess | undefined, app: ReturnType<typeof ownedExecutor> | undefined;
  try {
    const directory = process.env.AGENTS_EXECUTOR_JOURNAL_DIRECTORY || join(homedir(), ".cache/kasitek-executors", process.env.AGENTS_EXECUTOR_ID || "");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // This lock survives neither process death nor an unknown local replacement.
    guard = spawn("/usr/bin/python3", ["-c", "import fcntl,sys;f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('ready',flush=True);sys.stdin.buffer.read()", join(directory, "executor.lock")], { stdio: ["pipe", "pipe", "ignore"] });
    guard.stdin!.on("error", () => undefined);
    const activeGuard = guard;
    await new Promise<void>((resolve, reject) => { activeGuard.once("error", reject); activeGuard.once("exit", () => reject(new Error("Executor identity is already active"))); activeGuard.stdout!.once("data", () => resolve()); });
    app = ownedExecutor(pool);
    const activeApp = app;
    app.addHook("onClose", async () => { activeGuard.stdin?.end(); await pool.end(); });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void activeApp.close(); });
    guard.once("exit", () => { void activeApp.close(); });
    await app.listen({ host: process.env.AGENTS_EXECUTOR_HOST || "127.0.0.1", port: z.coerce.number().int().min(1).max(65535).parse(process.env.AGENTS_EXECUTOR_PORT || "9190") });
  } catch (error) {
    guard?.stdin?.end();
    if (app) await app.close(); else await pool.end();
    throw error;
  }
}
if (require.main === module) main().catch(() => { process.stderr.write("Resource executor startup failed\n"); process.exitCode = 1; });
