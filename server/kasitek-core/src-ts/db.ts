import pg from 'pg';
import type { CoreConfig } from './config.js';

export function createPool(config: CoreConfig): pg.Pool {
  // Prisma timestamp columns have no timezone. SQLx initializes its sessions in UTC.
  // pg's parser also uses the process timezone, which main.ts fixes before queries.
  return new pg.Pool({ connectionString: config.databaseUrl, max: config.databaseMaxConnections,
    options: '-c timezone=UTC', application_name: 'kasitek-core' });
}

/** All statements in a transaction must use the same checked-out connection. */
export async function transaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
