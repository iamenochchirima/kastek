import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import type { Pool } from "pg";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import { EXECUTOR_METADATA_ID, executorRequestSchema, verifyExecutorSignature, type ExecutorRequest } from "../../contracts/executor";
import { ExecutorOwners } from "../../infrastructure/executor-owners";
import { resourceGate } from "../../infrastructure/resource-gate";

export interface ExecutorHostOptions { pool: Pool; executorId: string; key: string; journalDirectory: string;
  maxActive?: number; dispatch(request: ExecutorRequest, recovering: boolean): Promise<unknown> }
interface Journal { digest: string; state: "started" | "completed"; response?: unknown }
const gates = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = gates.get(key) ?? Promise.resolve(), current = prior.catch(() => undefined).then(work); gates.set(key, current);
  try { return await current; } finally { if (gates.get(key) === current) gates.delete(key); }
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, ".."), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
export function createExecutorHost(options: ExecutorHostOptions) {
  if (options.key.length < 32) throw new Error("Executor signing key must contain at least 32 characters");
  const app = Fastify({ logger: false, bodyLimit: 20_000_000 }), owners = new ExecutorOwners(options.pool);
  // An executor ID cannot be silently rebound to a fresh directory or another machine.
  app.addHook("onReady", async () => {
    await mkdir(options.journalDirectory, { recursive: true, mode: 0o700 });
    const identityPath = join(options.journalDirectory, "physical-identity");
    try {
      const file = await open(identityPath, "wx", 0o600);
      try { await file.writeFile(randomBytes(32).toString("hex")); await file.sync(); } finally { await file.close(); }
      const directory = await open(options.journalDirectory, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const identity = await readFile(identityPath, "utf8");
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("Invalid physical executor identity");
    const digest = requestDigest({ identity });
    await options.pool.query("INSERT INTO agents_platform.resource_executor_hosts(executor_id,physical_identity_digest) VALUES($1,$2) ON CONFLICT DO NOTHING", [options.executorId, digest]);
    const registered = (await options.pool.query("SELECT physical_identity_digest FROM agents_platform.resource_executor_hosts WHERE executor_id=$1", [options.executorId])).rows[0];
    if (registered?.physical_identity_digest !== digest) throw new Error("Executor ID is already bound to another physical directory");
  });
  const metadataReads = new Map<string, { expires: number; value: Promise<unknown> }>();
  app.setErrorHandler((error, _request, reply) => {
    const problem = error instanceof PlatformError ? error : new PlatformError("EXECUTOR_COMMAND_UNCERTAIN", 503, "Executor command outcome is uncertain");
    return reply.code(problem.statusCode).send({ error: { code: problem.code, message: problem.message } });
  });
  app.post("/v1/resources/commands", async request => {
    const body = executorRequestSchema.parse(request.body);
    verifyExecutorSignature(body, typeof request.headers["x-executor-signature"] === "string" ? request.headers["x-executor-signature"] : undefined, options.key);
    if (body.executorId !== options.executorId) throw new PlatformError("EXECUTOR_ROUTE_DENIED", 403, "Executor route denied");
    const metadata = ["available", "profile"].includes(body.command);
    if (metadata) {
      if (body.allocationId !== EXECUTOR_METADATA_ID || body.generation !== "0") throw new PlatformError("EXECUTOR_ROUTE_DENIED", 403, "Invalid metadata request");
      const cacheKey = requestDigest({ kind: body.resourceKind, command: body.command, payload: body.payload });
      let cached = metadataReads.get(cacheKey);
      if (!cached || cached.expires <= Date.now()) {
        if (metadataReads.size >= 64) metadataReads.delete(metadataReads.keys().next().value!);
        const value = options.dispatch(body, false);
        cached = { expires: Date.now() + 5_000, value }; metadataReads.set(cacheKey, cached);
        void value.catch(() => { if (metadataReads.get(cacheKey)?.value === value) metadataReads.delete(cacheKey); });
      }
      return { result: await cached.value };
    }
    const starting = body.command === "start" || body.command === "analyze";
    let owner = await owners.assert(body.resourceKind, body.allocationId, body.executorId, body.generation, starting);
    if(starting)await owners.claimStart(owner,options.maxActive??2);
    const identity = `${body.resourceKind}:${body.allocationId}:${body.generation}:${body.commandId}`;
    const path = join(options.journalDirectory, createHash("sha256").update(identity).digest("hex") + ".json");
    const digest = requestDigest({ resourceKind: body.resourceKind, allocationId: body.allocationId, generation: body.generation, command: body.command, payload: body.payload });
    if(owner.quiescent&&["destroy","finalize","quiesce"].includes(body.command)){
      try{const saved:Journal=JSON.parse(await readFile(path,"utf8"));if(saved.digest!==digest)throw new PlatformError("EXECUTOR_COMMAND_CONFLICT",409,"Executor command identity conflict");if(saved.state==="completed")return{result:saved.response};}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    if (owner.quiescent) {
      if (body.command === "result") return { result: null };
      if (!["status", "destroy", "quiesce"].includes(body.command)) throw new PlatformError("EXECUTOR_RESOURCE_DESTROYED", 409, "Resource is already destroyed");
      return { result: { allocationId: body.allocationId, state: "destroyed", quiescenceReceipt: owner.quiescence_receipt } };
    }
    const mutating = ["start", "analyze", "finalize", "destroy", "quiesce"].includes(body.command);
    if (!mutating) return resourceGate(`executor-transition:${body.resourceKind}:${body.allocationId}`,async()=>{
      await owners.assert(body.resourceKind,body.allocationId,body.executorId,body.generation,false);return { result: await options.dispatch(body, false) };
    });
    await mkdir(options.journalDirectory, { recursive: true, mode: 0o700 });
    const prior = await serialized(identity, async () => {
      await owners.assert(body.resourceKind, body.allocationId, body.executorId, body.generation, starting);
      let journal: Journal | undefined;
      try { journal = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (journal && journal.digest !== digest) throw new PlatformError("EXECUTOR_COMMAND_CONFLICT", 409, "Executor command identity conflict");
      if (!journal) await save(path, { digest, state: "started" });
      return journal;
    });
    if (prior?.state === "completed") return { result: prior.response };
    const perform=async()=>{
    await owners.assert(body.resourceKind,body.allocationId,body.executorId,body.generation,starting);
    const result = await options.dispatch(body, Boolean(prior));
    owner = await owners.assert(body.resourceKind, body.allocationId, body.executorId, body.generation, false);
    if(starting&&owner.quiescent)throw new PlatformError("EXECUTOR_RESOURCE_DESTROYED",409,"Resource stopped while operation was active");
    let response = result;
    if (body.command === "quiesce" || (["destroy","finalize"].includes(body.command) && result && typeof result==="object" && (result as {state?:string}).state==="destroyed")) {
      if (!result || typeof result !== "object" || (result as { state?: string }).state !== "destroyed") throw new PlatformError("EXECUTOR_NOT_QUIESCENT", 409, "Resource is not confirmed stopped");
      const receipt = requestDigest({ executorId: owner.executor_id, generation: owner.generation, allocationId: owner.allocation_id, commandDigest: digest, result: canonicalJson(result) });
      await owners.markQuiescent(owner, receipt); response = { ...(result as object), quiescenceReceipt: receipt };
    }
    await save(path, { digest, state: "completed", response });
    return { result: response };
    };
    return body.resourceKind==="sandbox"&&body.command==="analyze"?perform():resourceGate(`executor-transition:${body.resourceKind}:${body.allocationId}`,perform);
  });
  return app;
}
