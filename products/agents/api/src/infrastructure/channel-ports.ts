import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../contracts/contracts";
import type { ChannelExecutionPorts } from "../contracts/channel";

const bindings = new WeakMap<Pool | PoolClient, ChannelExecutionPorts>();
export function registerChannelPorts(pool: Pool, ports: ChannelExecutionPorts): void { bindings.set(pool, ports); }
export function inheritChannelPorts(pool: Pool, db: PoolClient): void {
  const ports = bindings.get(pool); if (ports) bindings.set(db, ports); else bindings.delete(db);
}
export function clearChannelPorts(db: PoolClient): void { bindings.delete(db); }
export function channelPorts(db: Pool | PoolClient): ChannelExecutionPorts {
  const ports = bindings.get(db);
  if (!ports) throw new PlatformError("CHANNEL_RUNTIME_UNAVAILABLE", 503, "Customer channel execution is unavailable");
  return ports;
}
