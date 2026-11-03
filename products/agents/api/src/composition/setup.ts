import { databasePoolOptions } from "../infrastructure/pool-policy";
import { createHash } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

export async function setupPlatformSchema(pool: Pool): Promise<void> {
  const directory = join(__dirname, "../../schema");
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  const contents = new Map(await Promise.all(files.map(async name => [name, await readFile(join(directory, name), "utf8")] as const)));
  const checksumFor = (names: readonly string[]) => createHash("sha256").update(names.map(name => contents.get(name)!).join("\n")).digest("hex");
  const sql = files.map(name => contents.get(name)!).join("\n");
  const checksum = checksumFor(files);
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
      const installedChecksum = version.rows[0].checksum;
      if (installedChecksum !== checksum) {
        // Both released branches share exact bytes through 098. Only complete known prefixes can advance.
        const managedDefault = "099_managed_default_model.sql";
        const firstUpgrade = files.indexOf("068_product_default_provisions.sql");
        const prefixes = (lineage: readonly string[], minimum: number) => {
          for (let end = minimum; end <= lineage.length; end++) {
            const applied = lineage.slice(0, end);
            if (installedChecksum === checksumFor(applied)) return new Set(applied);
          }
          return undefined;
        };
        let applied = firstUpgrade < 0 ? undefined : prefixes(files, firstUpgrade);
        if (!applied && files.includes(managedDefault)) {
          // The local recursive-delegation branch shipped before the independently released managed-model 099.
          const localBranch = files.filter(name => name !== managedDefault);
          const recursive = localBranch.indexOf("099_recursive_delegation.sql");
          if (recursive >= 0) applied = prefixes(localBranch, recursive + 1);
        }
        if (!applied) throw new Error("Unsupported Agents platform schema");
        for (const name of files) if (!applied.has(name)) await client.query(contents.get(name)!);
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
    .catch(() => { process.stderr.write("Agents platform setup failed; verify the installed schema checksum and migration access\n"); process.exitCode = 1; })
    .finally(() => pool.end());
}
