import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool, transaction } from "./db.js";

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await transaction(pool, async (client) => {
      await client.query("CREATE SCHEMA IF NOT EXISTS evals");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('kasitek-evals-migrations'))",
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS evals.schema_migrations(
           name text PRIMARY KEY,
           checksum text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const directory = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(directory))
        .filter((item) => /^\d+.*\.sql$/.test(item))
        .sort()) {
        const sql = await readFile(new URL(name, directory), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const saved = await client.query<{ checksum: string }>(
          "SELECT checksum FROM evals.schema_migrations WHERE name=$1",
          [name],
        );
        if (saved.rows[0]) {
          if (saved.rows[0].checksum !== checksum) {
            throw new Error(`Applied evals migration checksum differs: ${name}`);
          }
          continue;
        }
        await client.query(sql);
        await client.query(
          "INSERT INTO evals.schema_migrations(name, checksum) VALUES($1,$2)",
          [name, checksum],
        );
      }
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.EVALS_DATABASE_URL;
  if (!url) throw new Error("EVALS_DATABASE_URL is required");
  await migrate(url);
}
