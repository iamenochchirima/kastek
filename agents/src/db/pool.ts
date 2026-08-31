import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { AppConfig } from "../config";
import { currentDatabaseContext } from "./context";

async function setTransactionDatabaseContext(client: PoolClient): Promise<void> {
  const context = currentDatabaseContext();
  if (!context) return;
  await client.query(
    `SELECT set_config('kasitek.organization_id', $1, true),
            set_config('kasitek.actor_id', $2, true),
            set_config('kasitek.operator', $3, true)`,
    [context.organizationId ?? "", context.actorId ?? "", context.operator === true ? "true" : "false"],
  );
}

function executeQuery(client: PoolClient, args: any[]): Promise<any> {
  if (args.length === 1) return client.query(args[0]);
  return client.query(args[0], args[1]);
}

export function createPool(config: AppConfig): Pool {
  const pool = new Pool({
    connectionString: config.AGENTS_DATABASE_URL,
    max: config.AGENTS_DATABASE_POOL_MAX,
    application_name: "kasitek-agents",
    ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });
  const rawQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
  pool.query = ((...args: any[]) => {
    const context = currentDatabaseContext();
    if (!context || typeof args.at(-1) === "function") return rawQuery(...args);
    return withTransaction(pool, (client) => executeQuery(client, args));
  }) as Pool["query"];
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTransactionDatabaseContext(client);
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

export { setTransactionDatabaseContext };
