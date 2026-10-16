import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "./pool";
import { operationalLogger } from "../telemetry/logger";
import { withSpan } from "../telemetry/spans";

async function main(): Promise<void> {
  const config = loadConfig();
  // Migrations run as a one-shot administrative process. Keep the runtime
  // connection restricted and require an explicit migration URL for DDL.
  const migrationDatabaseUrl = process.env.AGENTS_MIGRATION_DATABASE_URL?.trim();
  if (config.NODE_ENV === "production" && !migrationDatabaseUrl) {
    throw new Error("AGENTS_MIGRATION_DATABASE_URL is required in production");
  }
  const pool = createPool({
    ...config,
    AGENTS_DATABASE_URL: migrationDatabaseUrl || config.AGENTS_DATABASE_URL,
  });
  const migrationsDirectory = join(dirname(__filename), "../../migrations");
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.split("_")[0];
      if (!version || appliedVersions.has(version)) continue;
      await withSpan("database.migration", { "db.migration.name": file.slice(0, 128) }, async () => {
        const sql = await readFile(join(migrationsDirectory, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
          await client.query("COMMIT");
          operationalLogger.info({ event: "migration.applied", migration: file }, "Migration applied");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }
  } finally {
    client.release();
    await pool.end();
    await shutdownTelemetry();
  }
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "migration.failed" }, "Migration failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
