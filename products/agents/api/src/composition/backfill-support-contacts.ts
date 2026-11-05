import { Pool } from "pg";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { transaction } from "../infrastructure/database";
import { projectSupportContact } from "../product/customer-records/support-contacts";

export async function backfillSupportContacts(pool: Pool): Promise<{ scanned: number; projected: number }> {
  let cursor: string | null = null;
  let scanned = 0, projected = 0;
  while (true) {
    const rows: {id:string}[] = (await pool.query<{id:string}>(`SELECT id FROM agents_platform.human_assistance_requests
      WHERE contact IS NOT NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 100`, [cursor])).rows;
    if (!rows.length) break;
    for (const row of rows) {
      if (await transaction(pool, db => projectSupportContact(db, row.id))) projected++;
      scanned++;
    }
    cursor = rows.at(-1)!.id;
  }
  return { scanned, projected };
}
async function main(): Promise<void> {
  const connectionString = process.env.AGENTS_MIGRATION_DATABASE_URL || process.env.AGENTS_DATABASE_URL;
  if (!connectionString) throw new Error("Agent database is not configured");
  const pool = new Pool({ connectionString, ...databasePoolOptions("migration") });
  try { process.stdout.write(JSON.stringify(await backfillSupportContacts(pool)) + "\n"); }
  finally { await pool.end(); }
}
if (require.main === module) void main().catch(() => {
  process.stderr.write("Support contact backfill failed; inspect the configured database.\n");
  process.exitCode = 1;
});
