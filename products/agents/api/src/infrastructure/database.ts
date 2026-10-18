import type { Pool,PoolClient } from "pg";
import { inheritChannelPorts, clearChannelPorts } from "./channel-ports";

export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  inheritChannelPorts(pool, db);
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { clearChannelPorts(db); db.release(); }
}
