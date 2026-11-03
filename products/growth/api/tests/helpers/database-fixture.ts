import { randomUUID } from "node:crypto";
import pg from "pg";

/** Copy definitions into a schema-only search path; preserve the review revision trigger when installed. */
export async function isolatedDatabase(
  url: string,
  prefix: string,
  tables: readonly string[],
) {
  if (
    !/^[a-z_]+$/.test(prefix) ||
    tables.some((name) => !/^[A-Za-z_]+$/.test(name))
  )
    throw new Error("Invalid fixture identifier");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c timezone=UTC`,
  });
  const close = async () => {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  };
  try {
    const enums = (
      await admin.query<{ name: string }>(
        `SELECT DISTINCT t.typname AS name FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND t.typtype='e'`,
        [tables],
      )
    ).rows;
    for (const { name } of enums) {
      if (!/^[A-Za-z_]+$/.test(name))
        throw new Error("Invalid fixture enum name");
      const labels = (
        await admin.query<{ enumlabel: string }>(
          `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid
        JOIN pg_namespace ON pg_namespace.oid=typnamespace WHERE pg_namespace.nspname='public' AND typname=$1 ORDER BY enumsortorder`,
          [name],
        )
      ).rows;
      await pool.query(
        `CREATE TYPE "${name}" AS ENUM (${labels.map((row) => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(",")})`,
      );
    }
    for (const table of tables)
      await pool.query(
        `CREATE TABLE "${table}"(LIKE public."${table}" INCLUDING ALL)`,
      );
    const revisionTriggers = (await admin.query<{ name: string }>(`SELECT c.relname AS name FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname='agent_review_revision' AND NOT t.tgisinternal AND c.relname=ANY($1::text[])`, [tables])).rows;
    for (const {name} of revisionTriggers)
      await pool.query(`CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "${name}" FOR EACH ROW EXECUTE FUNCTION public.growth_advance_agent_review_revision()`);
    const columns = (
      await admin.query<{
        table_name: string;
        column_name: string;
        udt_name: string;
      }>(
        `SELECT table_name,column_name,udt_name
      FROM information_schema.columns WHERE table_schema=$1 AND udt_schema='public' AND udt_name=ANY($2::text[])`,
        [schema, enums.map((row) => row.name)],
      )
    ).rows;
    for (const column of columns) {
      if (
        ![column.table_name, column.column_name, column.udt_name].every(
          (name) => /^[A-Za-z_]+$/.test(name),
        )
      )
        throw new Error("Invalid fixture column name");
      await pool.query(`ALTER TABLE "${column.table_name}" ALTER COLUMN "${column.column_name}" DROP DEFAULT;
        ALTER TABLE "${column.table_name}" ALTER COLUMN "${column.column_name}" TYPE "${column.udt_name}"
        USING "${column.column_name}"::text::"${column.udt_name}"`);
    }
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
