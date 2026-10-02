import pg from 'pg';
import type { CoreConfig } from './config.js';
import { parseLosslessJson } from '@kasitek/server-support/json';

/** Date arithmetic is millisecond-based; the original PostgreSQL fraction stays on the wire. */
export class UtcTimestamp extends Date {
  private readonly fraction: string;

  constructor(value: string, timezone: boolean) {
    const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const hasOffset = /(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(normalized);
    super(timezone && hasOffset ? normalized : `${normalized}Z`);
    if (!Number.isFinite(this.getTime())) throw new Error('Invalid PostgreSQL timestamp');
    const nanoseconds = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
    this.fraction = /^0+$/.test(nanoseconds) ? '' : nanoseconds.endsWith('000000')
      ? nanoseconds.slice(0, 3) : nanoseconds.endsWith('000') ? nanoseconds.slice(0, 6) : nanoseconds;
  }

  override toISOString(): string {
    const seconds = super.toISOString().replace(/\.\d{3}Z$/, '');
    return `${seconds}${this.fraction ? `.${this.fraction}` : ''}Z`;
  }

  override toJSON(): string { return this.toISOString(); }
}

export function installPgTimestampParsers(): void {
  // SQLx binds naive timestamps as UTC. pg otherwise formats Date parameters
  // using the host timezone even when the database session is UTC.
  pg.defaults.parseInputDatesAsUTC = true;
  pg.types.setTypeParser(1082, (value) => value); // NaiveDate is YYYY-MM-DD, not midnight Date.
  pg.types.setTypeParser(1114, (value) => new UtcTimestamp(value, false));
  pg.types.setTypeParser(1184, (value) => new UtcTimestamp(value, true));
  pg.types.setTypeParser(114, parseLosslessJson);
  pg.types.setTypeParser(3802, parseLosslessJson);
}

export function createPool(config: CoreConfig): pg.Pool {
  installPgTimestampParsers();
  // Timestamp columns without a timezone are interpreted as UTC like SQLx sessions.
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
