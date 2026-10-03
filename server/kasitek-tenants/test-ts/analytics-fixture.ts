import pg from "pg";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../src-ts/migrate.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
/** Real Agency migrations, isolated schema only; public never appears in the test search path. */
export async function analyticsFixture() {
  installPgTimestampParsers();
  const schema = `tenant_analytics_fixture_${randomUUID().replaceAll("-", "")}`,
    url = process.env.TENANT_TEST_DATABASE_URL!;
  const admin = new pg.Pool({ connectionString: url });
  let pool: pg.Pool | undefined;
  let schemaCreated = false;
  const close = async () => {
    try {
      await pool?.end();
    } finally {
      try {
        if (schemaCreated)
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO workspaces(id,slug,display_name) VALUES('w','workspace','Workspace'),('foreign','foreign','Foreign');INSERT INTO tenant_clients(id,workspace_id,name,slug) VALUES('client','w','Client','client'),('client-other','w','Other','other'),('foreign-client','foreign','Foreign','foreign')`,
    );
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
