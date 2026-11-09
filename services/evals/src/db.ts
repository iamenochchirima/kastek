import pg from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: "kasitek-evals-service",
    options: "-c timezone=UTC",
  });
}

export async function transaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
