import { Pool } from "pg";
import { backfillLegacyKnowledgeObjects, assertKnowledgeBackfilled } from "../platform/knowledge/bootstrap";
import { PostgresKnowledgeObjectStore } from "../platform/knowledge";
import { privateStoreFromEnvironment } from "../infrastructure/object-store";
import { databasePoolOptions } from "../infrastructure/pool-policy";

async function main(): Promise<void> {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const source = privateStoreFromEnvironment(process.env, 10_485_760);
  if (!source) throw new Error("Legacy object storage must be configured for backfill");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("migration") });
  try {
    const result = await backfillLegacyKnowledgeObjects(pool, source, new PostgresKnowledgeObjectStore(pool));
    await assertKnowledgeBackfilled(pool);
    process.stdout.write(`Verified ${result.copied} knowledge objects.\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Knowledge backfill failed"}\n`); process.exitCode = 1; });
