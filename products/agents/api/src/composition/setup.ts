import { databasePoolOptions } from "../infrastructure/pool-policy";
import { createHash } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

export async function setupPlatformSchema(pool: Pool): Promise<void> {
  const directory = join(__dirname, "../../schema");
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  const sql = (await Promise.all(files.map(name => readFile(join(directory, name), "utf8")))).join("\n");
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
      if (version.rowCount !== 1 || version.rows[0]?.version !== "001_platform") throw new Error("Unsupported Agents platform schema");
      if (version.rows[0].checksum !== checksum) {
        // Only the exact preceding schema can receive this additive migration.
        let addition = -1;
        for (const name of ["068_product_default_provisions.sql", "069_admin_customers.sql", "070_product_capability_reviews.sql", "071_growth_capability_publications.sql", "072_product_capability_release.sql", "073_operations_heartbeats.sql", "074_website_crawls.sql", "075_customer_setup.sql", "076_native_enquiries.sql", "077_guided_setup_progress.sql", "078_customer_records.sql", "079_customer_record_actions.sql", "080_agent_deletion.sql", "081_agent_directory_indexes.sql", "082_inbox_customer_identity.sql", "084_support_waiting.sql", "085_customer_followup.sql", "086_support_event_handoff.sql", "087_handoff_pending_receipts.sql", "088_support_presence.sql", "089_support_status_execution.sql", "090_connected_uncertain_escalations.sql", "091_connected_reconciliation.sql"]) {
          const candidate=files.indexOf(name);
          if(candidate<0)continue;
          const previous=(await Promise.all(files.slice(0,candidate).map(file=>readFile(join(directory,file),"utf8")))).join("\n");
          if(version.rows[0].checksum===createHash("sha256").update(previous).digest("hex")){addition=candidate;break;}
        }
        if(addition<0)throw new Error("Unsupported Agents platform schema");
        for (const name of files.slice(addition)) await client.query(await readFile(join(directory, name), "utf8"));
        await client.query("UPDATE agents_platform.schema_version SET checksum=$1 WHERE version='001_platform'", [checksum]);
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
  const pool = new Pool({ connectionString, ...databasePoolOptions("migration") });
  setupPlatformSchema(pool)
    .then(() => { process.stdout.write("Agents platform schema ready\n"); })
    .catch(() => { process.stderr.write("Agents platform setup failed; use a fresh dedicated database and verify access\n"); process.exitCode = 1; })
    .finally(() => pool.end());
}
