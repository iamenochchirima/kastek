import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";

export const growthControlInputSchema = z.strictObject({
  tenantId: z.string().trim().min(1).max(256),
  action: z.enum(["tenant.disable", "tenant.enable", "model.revoke"]),
});
export type GrowthControlInput = z.infer<typeof growthControlInputSchema>;
export interface GrowthControlResult {
  action: GrowthControlInput["action"]; tenantId: string; organizationId: string; enabled: boolean;
  revokedExecutionGrants: number; revokedModelConnections: number; revokedModelCredentials: number;
  revokedModelUseGrants: number; removedModelDefaults: number; requestedTaskTrees: number; pendingTaskTrees: number;
}

/** Operator database authority only; absent from all product HTTP routes. */
export async function controlGrowthExecution(pool: Pool, raw: unknown): Promise<GrowthControlResult> {
  const input = growthControlInputSchema.parse(raw);
  const result = await transaction(pool, async db => {
    const tenant = (await db.query(`SELECT organization_id,issuer,client_id,revoked_at
      FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1 FOR UPDATE`, [input.tenantId])).rows[0];
    if (!tenant || tenant.client_id !== "growth-api") throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE", 404, "Growth business is not registered");
    const result: GrowthControlResult = { ...input, organizationId: tenant.organization_id,
      enabled: input.action === "tenant.enable" || input.action !== "tenant.disable" && !tenant.revoked_at,
      revokedExecutionGrants: 0, revokedModelConnections: 0, revokedModelCredentials: 0,
      revokedModelUseGrants: 0, removedModelDefaults: 0, requestedTaskTrees: 0, pendingTaskTrees: 0 };
    if (input.action === "tenant.enable") {
      await db.query("UPDATE agents_platform.product_execution_tenants SET revoked_at=NULL WHERE product='growth' AND tenant_id=$1", [input.tenantId]);
      return result;
    }
    if (input.action === "tenant.disable") await db.query(`UPDATE agents_platform.product_execution_tenants
      SET revoked_at=coalesce(revoked_at,now()) WHERE product='growth' AND tenant_id=$1`, [input.tenantId]);
    result.revokedExecutionGrants = (await db.query(`UPDATE agents_platform.execution_grants g SET revoked_at=now()
      FROM agents_platform.product_execution_authorities a WHERE a.grant_id=g.id AND a.product='growth'
      AND a.organization_id=$1 AND g.product='growth' AND g.revoked_at IS NULL`, [tenant.organization_id])).rowCount ?? 0;
    if (input.action === "model.revoke") {
      const ids = (await db.query(`SELECT id FROM agents_platform.model_provider_connections
        WHERE organization_id=$1 AND created_by IS NULL AND created_by_service->>'product'='growth'
        AND created_by_service->>'issuer'=$2 FOR UPDATE`, [tenant.organization_id, tenant.issuer])).rows.map(row => row.id);
      if (ids.length) {
        result.revokedModelCredentials = (await db.query(`UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL
          WHERE organization_id=$1 AND connection_id=ANY($2::uuid[]) AND state='active'`, [tenant.organization_id, ids])).rowCount ?? 0;
        result.revokedModelUseGrants = (await db.query(`UPDATE agents_platform.model_provider_use_grants SET state='revoked',revision=revision+1
          WHERE organization_id=$1 AND connection_id=ANY($2::uuid[]) AND state='active'`, [tenant.organization_id, ids])).rowCount ?? 0;
        result.revokedModelConnections = (await db.query(`UPDATE agents_platform.model_provider_connections
          SET state='revoked',revision=revision+1,verification='saved',updated_at=now()
          WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND state='active'`, [tenant.organization_id, ids])).rowCount ?? 0;
      }
      result.removedModelDefaults = (await db.query("DELETE FROM agents_platform.product_model_defaults WHERE product='growth' AND organization_id=$1", [tenant.organization_id])).rowCount ?? 0;
    }
    return result;
  });
  if (input.action === "tenant.enable") return result;
  // The authority fence commits first. Existing lifecycle code owns tree cancellation and its events.
  const roots = (await pool.query(`SELECT t.id FROM agents_platform.tasks t
    JOIN agents_platform.product_task_contexts p ON p.task_id=t.id
    WHERE t.product='growth' AND t.organization_id=$1 AND p.product='growth' AND p.tenant_id=$2
      AND t.parent_task_id IS NULL AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') ORDER BY t.id`,
  [result.organizationId, input.tenantId])).rows;
  for (const root of roots) {
    try { await requestTreeCancellation(pool, root.id); result.requestedTaskTrees++; }
    catch { result.pendingTaskTrees++; }
  }
  return result;
}
