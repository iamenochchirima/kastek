import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createPool, transaction } from "./db.js";

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await transaction(pool, async (client) => {
      await client.query("CREATE SCHEMA IF NOT EXISTS billing");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('kasitek-billing-migrations'))",
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS billing.schema_migrations(
           name text PRIMARY KEY, checksum text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((item) => /^\d+.*\.sql$/.test(item))
        .sort()) {
        const sql = await readFile(new URL(name, dir), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const saved = await client.query<{ checksum: string }>(
          `SELECT checksum FROM billing.schema_migrations WHERE name=$1`,
          [name],
        );
        if (saved.rows[0]) {
          if (saved.rows[0].checksum !== checksum)
            throw new Error(`Applied billing migration checksum differs: ${name}`);
          continue;
        }
        await client.query(sql);
        await client.query(
          `INSERT INTO billing.schema_migrations(name, checksum) VALUES($1,$2)`,
          [name, checksum],
        );
      }
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.BILLING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("BILLING_DATABASE_URL is required");
  await migrate(url);
}
