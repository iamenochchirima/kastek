import { assertKnowledgeBackfilled } from "../platform/knowledge/cutover";
import { PostgresKnowledgeObjectStore } from "../platform/knowledge/postgres-object-store";
import type { PrivateObjectStore } from "../infrastructure/object-store";
import { PlatformError } from "../contracts/contracts";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { Pool } from "pg";
import { reapSourceObjects } from "../platform/knowledge/source-objects";
import { reapExecutionObjects } from "../execution/artifacts/execution-objects";
import { privateStoreFromEnvironment } from "../infrastructure/object-store";

export async function runSourceObjectReaper(pool: Pool, signal: AbortSignal): Promise<void> {
  await assertKnowledgeBackfilled(pool);
  const legacy = privateStoreFromEnvironment(process.env, 10_485_760);
  const knowledge = new PostgresKnowledgeObjectStore(pool);
  const pick = (key: string): PrivateObjectStore => {
    if (key.startsWith("knowledge/") || key.startsWith("knowledge-query/")) return knowledge;
    if (!legacy) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    return legacy;
  };
  const objects: PrivateObjectStore = {
    put: (key, bytes, type, db) => pick(key).put(key, bytes, type, db),
    get: (key, db) => pick(key).get(key, db),
    delete: (key, db) => pick(key).delete(key, db),
  };
  while (!signal.aborted) {
    try { await reapSourceObjects(pool, objects); }
    catch { console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "cleanup.retry", code: "SOURCE_OBJECT_CLEANUP_PENDING" })); }
    try { await reapExecutionObjects(pool, objects, new Date(), !legacy); }
    catch { console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "cleanup.retry", code: "EXECUTION_OBJECT_CLEANUP_PENDING" })); }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 1000); signal.addEventListener("abort", finish, { once: true });
    });
  }
}
if (require.main === module) {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("cleanup") }), abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  void runSourceObjectReaper(pool, abort.signal).catch(() => {
    console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "startup.failed" })); process.exitCode = 1;
  }).finally(() => pool.end());
}
