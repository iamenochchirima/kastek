import { Pool } from "pg";
import { privateStoreFromEnvironment } from "./artifacts";
import { reapExecutionObjects } from "./execution-objects";
import { reapSourceObjects } from "./source-objects";

export async function runSourceObjectReaper(pool: Pool, signal: AbortSignal): Promise<void> {
  const objects = privateStoreFromEnvironment(process.env, 10_485_760);
  if (!objects) throw new Error("Private storage is not configured");
  while (!signal.aborted) {
    try { await reapSourceObjects(pool, objects); }
    catch { console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "cleanup.retry", code: "SOURCE_OBJECT_CLEANUP_PENDING" })); }
    try { await reapExecutionObjects(pool, objects); }
    catch { console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "cleanup.retry", code: "EXECUTION_OBJECT_CLEANUP_PENDING" })); }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 1000); signal.addEventListener("abort", finish, { once: true });
    });
  }
}
if (require.main === module) {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, max: 2 }), abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  void runSourceObjectReaper(pool, abort.signal).catch(() => {
    console.error(JSON.stringify({ service: "agents-source-object-reaper", event: "startup.failed" })); process.exitCode = 1;
  }).finally(() => pool.end());
}
