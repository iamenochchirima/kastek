import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createPool, transaction } from "./db.js";
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await transaction(pool, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('kasitek-operations-migrations'))",
      );
      await c.query(
        "CREATE TABLE IF NOT EXISTS ops_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => /^\d+.*\.sql$/.test(n))
        .sort()) {
        const sql = await readFile(new URL(name, dir), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const saved = (
          await c.query("SELECT checksum FROM ops_migrations WHERE name=$1", [
            name,
          ])
        ).rows[0];
        if (saved) {
          if (saved.checksum !== checksum)
            throw new Error(`Applied migration checksum differs: ${name}`);
          continue;
        }
        await c.query(sql);
        await c.query(
          "INSERT INTO ops_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
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
