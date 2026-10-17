import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";

export async function setupPlatformSchema(pool: Pool): Promise<void> {
  const sql = await readFile(join(__dirname, "../../schema/001_platform.sql"), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(19871017, 1)");
    const existing = await client.query(
      "SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='agents_platform'",
    );
    if (existing.rowCount) {
      const version = await client.query<{ version: string; checksum: string }>("SELECT version,checksum FROM agents_platform.schema_version");
      if (version.rowCount !== 1 || version.rows[0]?.version !== "001_platform" || version.rows[0].checksum !== checksum) {
        throw new Error("Unsupported Agents platform schema");
      }
      await client.query("COMMIT");
      return;
    }
    const tables = await client.query(
      "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' LIMIT 1",
    );
    if (tables.rowCount) throw new Error("Agents platform requires a fresh dedicated database; existing databases are not modified");
    await client.query(sql);
    await client.query("CREATE TABLE agents_platform.schema_version (version text PRIMARY KEY, checksum text NOT NULL)");
    await client.query("INSERT INTO agents_platform.schema_version(version,checksum) VALUES ('001_platform',$1)", [checksum]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

if (require.main === module) {
  const connectionString = process.env.AGENTS_MIGRATION_DATABASE_URL || process.env.AGENTS_DATABASE_URL;
  if (!connectionString) throw new Error("AGENTS_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  setupPlatformSchema(pool)
    .then(() => { process.stdout.write("Agents platform schema ready\n"); })
    .catch(() => { process.stderr.write("Agents platform setup failed; use a fresh dedicated database and verify access\n"); process.exitCode = 1; })
    .finally(() => pool.end());
}
