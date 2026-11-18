import { databasePoolOptions } from "../infrastructure/pool-policy";
import { Pool } from "pg";
import { resourceBackends } from "./resource-backends";
import { reapDocumentResources } from "../platform/knowledge";
import { reapQueryEmbeddingResources } from "../platform/knowledge";
import { reconcilePendingRoots } from "../execution/lifecycle/execution";

export async function runDocumentReaper(pool: Pool, signal: AbortSignal, intervalMs = 1000): Promise<void> {
  const {documents:runtime}=resourceBackends(pool);
  if (!runtime) throw new Error("Document runtime is not configured");
  while (!signal.aborted) {
    for (const reap of [reapDocumentResources, reapQueryEmbeddingResources]) {
      try { await reap(pool, runtime); }
      catch { console.error(JSON.stringify({ service: "agents-document-reaper", event: "cleanup.retry", code: "DOCUMENT_CLEANUP_PENDING" })); }
    }
    try { await reconcilePendingRoots(pool); } catch { console.error(JSON.stringify({service:"agents-document-reaper",event:"settlement.retry",code:"RESOURCE_SETTLEMENT_PENDING"})); }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, intervalMs); signal.addEventListener("abort", finish, { once: true });
    });
  }
}
if (require.main === module) {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("cleanup") }), abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  void runDocumentReaper(pool, abort.signal).catch(() => {
    console.error(JSON.stringify({ service: "agents-document-reaper", event: "startup.failed" })); process.exitCode = 1;
  }).finally(() => pool.end());
}
