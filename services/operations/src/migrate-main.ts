import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool, transaction } from "./db.js";
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await transaction(pool, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('kasitek-operations-migrations'))",
      );
      await c.query(
        "CREATE TABLE IF NOT EXISTS ops_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => /^\d+.*\.sql$/.test(n))
        .sort()) {
        if (
          (await c.query("SELECT 1 FROM ops_migrations WHERE name=$1", [name]))
            .rowCount
        )
          continue;
        await c.query(await readFile(new URL(name, dir), "utf8"));
        await c.query("INSERT INTO ops_migrations(name) VALUES($1)", [name]);
      }
    });
  } finally {
    await pool.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  await migrate(process.env.DATABASE_URL);
}
