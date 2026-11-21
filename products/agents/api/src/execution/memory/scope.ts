import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, type InitiatingPrincipal } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import type { MemoryManagementScope, ProductMemoryManagementScope } from "../../contracts/memory";
export type { MemoryManagementScope, ProductMemoryManagementScope } from "../../contracts/memory";

type Db = Pool | PoolClient;
const productScope = z.strictObject({ namespace: z.literal("product_actor"), product: z.enum(["growth", "agencies"]),
  tenantId: z.string().min(1).max(256), organizationId: z.uuid(), agentId: z.uuid(),
  actor: z.strictObject({ issuer: z.url().max(2048), subject: z.string().min(1).max(512) }), clientId: z.string().min(1).max(256).nullable(),
}).refine(value => value.product === "agencies" ? value.clientId !== null : value.clientId === null);

export function isProductMemoryScope(scope: MemoryManagementScope): scope is ProductMemoryManagementScope {
  return "namespace" in scope && scope.namespace === "product_actor";
}
export async function requireProductMemoryAccess(db: Db, input: ProductMemoryManagementScope, requireSelected = false): Promise<ProductMemoryManagementScope> {
  const parsed = productScope.safeParse(input);
  if (!parsed.success) throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "The complete product memory scope is required");
  const scope = parsed.data;
  const row = (await db.query(`SELECT 1 FROM agents_platform.product_execution_tenants n
    JOIN agents_platform.product_execution_features f ON f.product=n.product AND f.tenant_id=n.tenant_id AND f.organization_id=n.organization_id
    JOIN agents_platform.agent_versions v ON v.id=f.version_id AND v.organization_id=f.organization_id
    WHERE n.product=$1 AND n.tenant_id=$2 AND n.organization_id=$3 AND n.revoked_at IS NULL AND f.agent_id=$4 AND f.enabled
      AND ($5::boolean=false OR coalesce((v.configuration->'memory'->>'enabled')::boolean,false))
    FOR SHARE OF n,f`, [scope.product, scope.tenantId, scope.organizationId, scope.agentId, requireSelected])).rows[0];
  if (!row) throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Product memory access is unavailable");
  return scope;
}
export const resolveProductMemoryManagementScope = requireProductMemoryAccess;

/** Product callers supply task identity, never a model-selected actor, tenant or client. */
export async function productMemoryScopeForTask(db: Db, taskId: string, expected: {
  organizationId: string; agentId: string; principal: InitiatingPrincipal;
}, operation: "memory.read" | "memory.propose" = "memory.read"): Promise<ProductMemoryManagementScope | null> {
  const row = (await db.query(`SELECT t.product,t.principal,t.organization_id,v.agent_id,
      p.product AS origin_product,p.tenant_id,p.client_id,g.operations,g.revoked_at,g.expires_at,
      coalesce(t.effective_configuration,v.configuration) AS configuration
    FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
    LEFT JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id
    WHERE t.id=$1 AND t.organization_id=$2 AND v.agent_id=$3`, [z.uuid().parse(taskId), expected.organizationId, expected.agentId])).rows[0];
  if (!row || requestDigest(row.principal) !== requestDigest(expected.principal)) throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "The memory task is outside the current actor scope");
  if (expected.principal.kind !== "human" || !row.configuration?.memory?.enabled || row.revoked_at ||
      new Date(row.expires_at).getTime() <= Date.now() || !Array.isArray(row.operations) || !row.operations.includes(operation)) {
    throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Memory is unavailable to this task");
  }
  if (row.product === "agents") return null;
  if (row.product !== row.origin_product) throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Product memory is unavailable to this task");
  return requireProductMemoryAccess(db, { namespace: "product_actor", product: row.product, tenantId: row.tenant_id,
    organizationId: row.organization_id, agentId: row.agent_id,
    actor: { issuer: expected.principal.issuer, subject: expected.principal.subject }, clientId: row.client_id ?? null }, true);
}

/** Compare the complete namespace before snippets, ranking, counts or derived evidence. */
export async function memoryScopeMatchesExecution(db: Db, execution: Execution, row: Record<string, any>, requireEnabled = true): Promise<boolean> {
  if (row.organization_id !== execution.task.organization_id || row.agent_id !== execution.agentId ||
      execution.task.principal.kind !== "human" || requireEnabled && !execution.configuration.memory.enabled) return false;
  if (requireEnabled) {
    const grant = (await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1", [execution.task.grant_id])).rows[0];
    if (!Array.isArray(grant?.operations) || !grant.operations.includes("memory.read")) return false;
  }
  const principal = execution.task.principal;
  if (row.namespace === "product_actor") {
    if (execution.task.product !== row.product || principal.issuer !== row.actor_issuer || principal.subject !== row.actor_subject) return false;
    const context = (await db.query(`SELECT product,tenant_id,client_id FROM agents_platform.product_task_contexts WHERE task_id=$1`, [execution.task.root_task_id])).rows[0];
    if (!context || context.product !== row.product || context.tenant_id !== row.tenant_id || (context.client_id ?? null) !== row.client_id) return false;
    await requireProductMemoryAccess(db, { namespace: "product_actor", product: row.product, tenantId: row.tenant_id,
      organizationId: row.organization_id, agentId: row.agent_id, actor: { issuer: row.actor_issuer, subject: row.actor_subject }, clientId: row.client_id }, requireEnabled);
    return true;
  }
  if (execution.task.product !== "agents" || row.namespace && row.namespace !== "personal") return false;
  const account = (await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [principal.issuer, principal.subject])).rows[0];
  return Boolean(account && row.account_id === account.id);
}

export async function memoryMutationActor(db: Db, scope: MemoryManagementScope) {
  if (isProductMemoryScope(scope)) return { product: scope.product, ...scope.actor, tenantId: scope.tenantId, clientId: scope.clientId };
  const actor = (await db.query("SELECT issuer,subject FROM agents_platform.accounts WHERE id=$1", [scope.accountId])).rows[0];
  if (!actor) throw new PlatformError("ACCESS_DENIED", 403, "Memory reviewer is unavailable");
  return { product: "agents", issuer: actor.issuer as string, subject: actor.subject as string };
}
