import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { AppConfig } from "../config";

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.AGENTS_DATABASE_URL,
    max: config.AGENTS_DATABASE_POOL_MAX,
    application_name: "kasitek-agents",
    ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}
