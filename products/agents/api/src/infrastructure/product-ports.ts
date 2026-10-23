import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../contracts/contracts";
import type { EvidenceDependency } from "../contracts/source-contracts";

export type ProductEvidenceDependency = Extract<EvidenceDependency, { kind: "product" }>;
export interface ProductExecutionPorts {
  assertCurrentEvidence(db: Pool | PoolClient, input: {
    consumerTaskId: string;
    dependency: ProductEvidenceDependency;
  }): Promise<void>;
}
const bindings = new WeakMap<Pool | PoolClient, ProductExecutionPorts>();
export function registerProductPorts(pool: Pool, ports: ProductExecutionPorts): void { bindings.set(pool, ports); }
export function inheritProductPorts(pool: Pool, db: PoolClient): void {
  const ports = bindings.get(pool); if (ports) bindings.set(db, ports); else bindings.delete(db);
}
export function clearProductPorts(db: PoolClient): void { bindings.delete(db); }
export function productPorts(db: Pool | PoolClient): ProductExecutionPorts {
  const ports = bindings.get(db);
  if (!ports) throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE", 503, "Product evidence authorization is unavailable");
  return ports;
}
