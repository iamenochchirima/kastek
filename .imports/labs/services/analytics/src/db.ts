import pg from "pg";
import type { AnalyticsConfig } from "./config.js";
import { parseSerdeValueJson } from "./json.js";

/** Date arithmetic is millisecond-based; the original PostgreSQL fraction stays on the wire. */
export class UtcTimestamp extends Date {
  private readonly fraction: string;
  private readonly leapSecond: boolean;

  constructor(value: string, timezone: boolean) {
    const normalized = value
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const leapSecond = /:60(?=(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$)/i.test(
      normalized,
    );
    const parseValue = leapSecond
      ? normalized.replace(/:60(?=(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$)/i, ":59")
      : normalized;
    const hasOffset = /(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(normalized);
    super(timezone && hasOffset ? parseValue : `${parseValue}Z`);
    if (!Number.isFinite(this.getTime()))
      throw new Error("Invalid PostgreSQL timestamp");
    if (leapSecond) this.setTime(super.getTime() + 1000);
    this.leapSecond = leapSecond;
    const nanoseconds = (value.match(/\.(\d+)/)?.[1] ?? "")
      .padEnd(9, "0")
      .slice(0, 9);
    this.fraction = /^0+$/.test(nanoseconds)
      ? ""
      : nanoseconds.endsWith("000000")
        ? nanoseconds.slice(0, 3)
        : nanoseconds.endsWith("000")
          ? nanoseconds.slice(0, 6)
          : nanoseconds;
  }

  override toISOString(): string {
    const value = this.leapSecond
      ? new Date(super.getTime() - 1000).toISOString()
      : super.toISOString();
    const formatted = value.replace(/\.\d{3}Z$/, "");
    const seconds = this.leapSecond
      ? formatted.replace(/:59$/, ":60")
      : formatted;
    return `${seconds}${this.fraction ? `.${this.fraction}` : ""}Z`;
  }

  override toJSON(): string {
    return this.toISOString();
  }
}

export function installPgTimestampParsers(): void {
  // SQLx binds naive timestamps as UTC. pg otherwise formats Date parameters
  // using the host timezone even when the database session is UTC.
  pg.defaults.parseInputDatesAsUTC = true;
  pg.types.setTypeParser(1082, (value) => value); // NaiveDate is YYYY-MM-DD, not midnight Date.
  pg.types.setTypeParser(1114, (value) => new UtcTimestamp(value, false));
  pg.types.setTypeParser(1184, (value) => new UtcTimestamp(value, true));
  pg.types.setTypeParser(114, parseSerdeValueJson);
  pg.types.setTypeParser(3802, parseSerdeValueJson);
}

function timerMilliseconds(value:number|bigint):number {
  const limit=2147483647n,n=typeof value==='bigint'?value:BigInt(value);
  // Node timers and pg's timeout option use signed 32-bit milliseconds. Values
  // beyond that are saturated to the longest representable driver timeout.
  return Number(n>limit?limit:n);
}

function poolOptions(config:AnalyticsConfig,timeout:number|bigint):pg.PoolConfig {
  installPgTimestampParsers();
  return {
    connectionString: config.database_url,
    max: config.database_max_connections,
    connectionTimeoutMillis: timerMilliseconds(timeout),
    options: "-c timezone=UTC",
    application_name: "kasitek-analytics",
  };
}

export function createPool(config: AnalyticsConfig): pg.Pool {
  // Timestamp columns without a timezone are interpreted as UTC like SQLx sessions.
  return new pg.Pool(poolOptions(config,config.database_acquire_timeout_ms));
}

/** Eagerly proves PostgreSQL is reachable using the dedicated startup deadline. */
export async function connectPool(config:AnalyticsConfig):Promise<pg.Pool>{
  const pool=new pg.Pool(poolOptions(config,config.database_connect_timeout_ms));
  try {const client=await pool.connect();client.release();return pool;}
  catch(error){await pool.end().catch(()=>{});throw error;}
}

/** All statements in a transaction must use the same checked-out connection. */
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
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    client.release();
  }
}
