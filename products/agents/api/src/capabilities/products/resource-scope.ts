import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";

export interface ProductResourceScope {
  kind: "product_feature"; product: "growth"; tenantId: string; organizationId: string; agentId: string;
  actor: { issuer: string; subject: string }; service: { issuer: string; clientId: string }; authority: "read" | "manage";
  accountId?: never;
}
export interface PersonalResourceScope { organizationId: string; accountId: string; agentId?: string }
export type AgentResourceScope = (PersonalResourceScope & { agentId: string }) | ProductResourceScope;
const scopeSchema = z.strictObject({ kind: z.literal("product_feature"), product: z.literal("growth"), tenantId: z.string().min(1).max(256),
  organizationId: z.uuid(), agentId: z.uuid(), actor: z.strictObject({ issuer: z.url().max(2048), subject: z.string().min(1).max(512) }),
  service: z.strictObject({ issuer: z.url().max(2048), clientId: z.string().min(1).max(128) }), authority: z.enum(["read", "manage"]) });
export function isProductResourceScope(scope: PersonalResourceScope | ProductResourceScope): scope is ProductResourceScope {
  return "kind" in scope && scope.kind === "product_feature";
}
/** The owning product verifies actor permissions before signing this feature-management scope. */
export async function requireProductResourceAccess(db: Pool | PoolClient, input: ProductResourceScope, manage = false): Promise<void> {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success || manage && parsed.data.authority !== "manage") throw new PlatformError("PRODUCT_RESOURCE_DENIED", 403, "Product resource management is unavailable");
  const scope = parsed.data;
  const result = await db.query(`SELECT 1 FROM agents_platform.product_execution_tenants n
    JOIN agents_platform.product_execution_features f ON f.product=n.product AND f.tenant_id=n.tenant_id AND f.organization_id=n.organization_id
    WHERE n.product=$1 AND n.tenant_id=$2 AND n.organization_id=$3 AND n.client_id=$4 AND n.issuer=$5 AND n.revoked_at IS NULL
      AND f.agent_id=$6 AND f.enabled FOR SHARE OF n,f`, [scope.product, scope.tenantId, scope.organizationId, scope.service.clientId, scope.service.issuer, scope.agentId]);
  if (!result.rowCount) throw new PlatformError("PRODUCT_RESOURCE_DENIED", 403, "The product feature mapping is unavailable");
}
export function resourceAccountId(scope: PersonalResourceScope | ProductResourceScope): string | null { return scope.accountId ?? null; }
export function resourceService(scope: PersonalResourceScope | ProductResourceScope) {
  if (!isProductResourceScope(scope)) return null;
  return { product: scope.product, tenantId: scope.tenantId, agentId: scope.agentId, actor: scope.actor, service: scope.service };
}
export function resourceOwnership(scope: ProductResourceScope) { return { product: scope.product, tenantId: scope.tenantId, agentId: scope.agentId }; }
export function resourceMatchesScope(service: Record<string, unknown> | null | undefined, scope: ProductResourceScope): boolean {
  return Boolean(service && requestDigest({ product: service.product, tenantId: service.tenantId, agentId: service.agentId }) === requestDigest(resourceOwnership(scope)));
}
export function knowledgeJobScope(row: Record<string, any>): PersonalResourceScope | ProductResourceScope {
  if (!row.importer_service) return { organizationId: row.organization_id, accountId: row.importer_account_id };
  return { kind: "product_feature", ...row.importer_service, organizationId: row.organization_id, authority: "manage" };
}

/** Immutable task pins do not restore resources removed from the current product configuration. */
export async function assertProductNativeTaskAccess(db: Pool | PoolClient, execution: Execution): Promise<void> {
  if (execution.task.product === "agents" || !execution.configuration.sourceRevisionIds.length && !execution.configuration.skillIds.length) return;
  if (execution.task.product !== "growth" || execution.task.principal.kind !== "human") throw new PlatformError("PRODUCT_RESOURCE_DENIED", 403, "Native product resources are unavailable");
  const row = (await db.query(`SELECT p.tenant_id,n.issuer,n.client_id,v.configuration FROM agents_platform.product_task_contexts p
    JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id AND n.organization_id=$2
    JOIN agents_platform.product_execution_features f ON f.product=n.product AND f.tenant_id=n.tenant_id AND f.agent_id=$3
    JOIN agents_platform.agent_versions v ON v.id=f.version_id AND v.organization_id=f.organization_id
    WHERE p.task_id=$1 AND p.product=$4 AND n.revoked_at IS NULL AND f.enabled FOR SHARE OF n,f`, [execution.task.root_task_id, execution.task.organization_id, execution.agentId, execution.task.product])).rows[0];
  if (!row || execution.configuration.sourceRevisionIds.some(id => !row.configuration.sourceRevisionIds?.includes(id)) ||
      execution.configuration.skillIds.some(id => !row.configuration.skillIds?.includes(id))) throw new PlatformError("PRODUCT_RESOURCE_REVOKED", 403, "A selected source or skill was removed from this product agent");
  const scope: ProductResourceScope = { kind: "product_feature", product: "growth", tenantId: row.tenant_id, organizationId: execution.task.organization_id,
    agentId: execution.agentId, actor: { issuer: execution.task.principal.issuer, subject: execution.task.principal.subject }, service: { issuer: row.issuer, clientId: row.client_id }, authority: "read" };
  const sources = execution.configuration.sourceRevisionIds.length ? (await db.query("SELECT s.importer_service FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])", [scope.organizationId, execution.configuration.sourceRevisionIds])).rows : [];
  const skills = execution.configuration.skillIds.length ? (await db.query("SELECT created_by_service FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND id=ANY($3::uuid[])", [scope.organizationId, scope.agentId, execution.configuration.skillIds])).rows : [];
  if (sources.length !== execution.configuration.sourceRevisionIds.length || skills.length !== execution.configuration.skillIds.length ||
      sources.some(source => !resourceMatchesScope(source.importer_service, scope)) || skills.some(skill => !resourceMatchesScope(skill.created_by_service, scope))) {
    throw new PlatformError("PRODUCT_RESOURCE_DENIED", 403, "A selected native resource is outside this product feature");
  }
}
