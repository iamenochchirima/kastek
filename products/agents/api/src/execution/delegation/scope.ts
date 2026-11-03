import type { Pool, PoolClient } from "pg";
import { sameProductAuthority } from "../../capabilities/products/product-capabilities";
import { connectedToolAuthorityIds, sourceAuthorityIds, PlatformError, canonicalJson, type AgentConfiguration } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import { orchestrationTools } from "../../contracts/orchestration";
import { loadExecution } from "../lifecycle/state";

type Binding = Extract<AgentConfiguration["capabilities"]["delegation"], { enabled: true }>["bindings"][number];
const denied = () => new PlatformError("DELEGATION_SCOPE_DENIED", 403, "Specialist request exceeds its published scope");

/** A published specialist is a ceiling. Its accepted child configuration is a narrower subtree. */
export function delegatedConfiguration(parent: AgentConfiguration, binding: Binding, child: AgentConfiguration,
  requested: { sourceRevisionIds?: string[]; connectedToolBindingIds?: string[] } = {}): AgentConfiguration {
  const parentDelegation = parent.capabilities.delegation;
  if (!parentDelegation.enabled || child.executionKind !== "business") throw denied();
  const sources = requested.sourceRevisionIds ?? binding.sourceRevisionIds;
  const connections = requested.connectedToolBindingIds ?? binding.connectedToolBindingIds;
  const sourceCeiling = sourceAuthorityIds(child), connectionCeiling = connectedToolAuthorityIds(child);
  if (sources.some(id => !binding.sourceRevisionIds.includes(id) || !sourceCeiling.includes(id) || !sourceAuthorityIds(parent).includes(id)) ||
      connections.some(id => !binding.connectedToolBindingIds.includes(id) || !connectionCeiling.includes(id) || !connectedToolAuthorityIds(parent).includes(id)) ||
      binding.tools.some(name => !child.tools.includes(name))) throw denied();

  const parentProducts = [...parent.productBindings, ...(parent.commissionableProductBindings ?? [])];
  const productCeiling = binding.productBindingIds === undefined ? parentProducts : parentProducts.filter(item => binding.productBindingIds!.includes(item.id));
  if (binding.productBindingIds?.some(id => !parentProducts.some(item => item.id === id))) throw denied();
  const products = [...child.productBindings, ...(child.commissionableProductBindings ?? [])];
  const allowedProductIds = new Set(products.filter(item => productCeiling.some(ceiling => sameProductAuthority(ceiling, item))).map(item => item.id));
  // Expose only product operations that are explicitly commissioned at every parent edge.

  const remaining = parentDelegation.maxDepth === null ? null : parentDelegation.maxDepth - 1;
  const childDelegation = child.capabilities.delegation;
  const delegation: AgentConfiguration["capabilities"]["delegation"] = childDelegation.enabled && remaining !== 0 ? {
    ...childDelegation,
    maxDepth: remaining === null ? childDelegation.maxDepth : childDelegation.maxDepth === null ? remaining : Math.min(remaining, childDelegation.maxDepth),
    maxChildren: Math.min(parentDelegation.maxChildren, childDelegation.maxChildren),
    bindings: childDelegation.bindings.map(role => ({ ...role,
      sourceRevisionIds: role.sourceRevisionIds.filter(id => sources.includes(id)),
      connectedToolBindingIds: role.connectedToolBindingIds.filter(id => connections.includes(id)),
      ...(role.productBindingIds === undefined ? {} : { productBindingIds: role.productBindingIds.filter(id => allowedProductIds.has(id)) }),
    })),
  } : { enabled: false };
  const sandbox = child.capabilities.sandbox.enabled && parent.capabilities.sandbox.enabled && binding.tools.includes("sandbox.analyze")
    ? child.capabilities.sandbox : { enabled: false as const };
  const businessActions = child.capabilities.businessActions.enabled && parent.capabilities.businessActions.enabled &&
    canonicalJson(child.capabilities.businessActions) === canonicalJson(parent.capabilities.businessActions)
    ? child.capabilities.businessActions : { enabled: false as const };
  const workflows = child.capabilities.workflows.enabled && parent.capabilities.workflows.enabled &&
    canonicalJson(child.capabilities.workflows) === canonicalJson(parent.capabilities.workflows)
    ? child.capabilities.workflows : { enabled: false as const };
  const memory = { enabled: parent.memory.enabled && child.memory.enabled && binding.tools.some(name => name.startsWith("memory.")) };
  const tools = [...new Set([...binding.tools, ...(delegation.enabled ? child.tools.filter(name => (orchestrationTools as readonly string[]).includes(name)) : [])])]
    .filter(name => delegation.enabled || name !== "agents.delegate" && !(orchestrationTools as readonly string[]).includes(name))
    .filter(name => sandbox.enabled || name !== "sandbox.analyze")
    .filter(name => memory.enabled || !name.startsWith("memory."));
  return { ...child, sourceRevisionIds: child.sourceRevisionIds.filter(id => sources.includes(id)),
    connectedToolBindingIds: child.connectedToolBindingIds.filter(id => connections.includes(id)),
    productBindings: child.productBindings.filter(item => allowedProductIds.has(item.id)), ...(child.commissionableProductBindings === undefined ? {} : {
      commissionableProductBindings: child.commissionableProductBindings.filter(item => allowedProductIds.has(item.id)),
    }), tools, memory, capabilities: { ...child.capabilities, delegation, sandbox, businessActions, workflows } };
}

export function assertParentEdge(parent: Execution, child: Execution): void {
  if (child.task.parent_task_id !== parent.task.id || child.task.root_task_id !== parent.task.root_task_id ||
      child.task.organization_id !== parent.task.organization_id || child.task.product !== parent.task.product ||
      child.task.depth !== parent.task.depth + 1 || canonicalJson(child.task.principal) !== canonicalJson(parent.task.principal) ||
      child.task.work_id !== parent.task.work_id) throw denied();
  const delegation = parent.configuration.capabilities.delegation;
  if (!delegation.enabled || delegation.maxDepth !== null && delegation.maxDepth < 1) throw denied();
}

/** Each ancestor remains an authority boundary, even when its descendant has a broader definition. */
export async function delegationAncestors(db: Pool | PoolClient, execution: Execution): Promise<Execution[]> {
  const result: Execution[] = [], seen = new Set([execution.task.id]);
  let current = execution;
  while (current.task.parent_task_id) {
    const id = current.task.parent_task_id;
    if (seen.has(id)) throw denied();
    seen.add(id);
    const parent = await loadExecution(db, id);
    assertParentEdge(parent, current);
    result.push(parent);
    current = parent;
  }
  if (current.task.id !== execution.task.root_task_id || current.task.depth !== 0) throw denied();
  return result;
}

export async function subtreeUsage(db: Pool | PoolClient, taskId: string) {
  return (await db.query<{ tokens: number; active_ms: number; tokens_reserved: number; active_reserved_ms: number }>(`WITH RECURSIVE subtree AS (
    SELECT id,tokens_used,tokens_reserved,active_ms,active_reserved_ms FROM agents_platform.tasks WHERE id=$1
    UNION ALL SELECT t.id,t.tokens_used,t.tokens_reserved,t.active_ms,t.active_reserved_ms FROM agents_platform.tasks t JOIN subtree s ON t.parent_task_id=s.id
  ) SELECT coalesce(sum(tokens_used),0)::double precision tokens,coalesce(sum(active_ms),0)::double precision active_ms,
      coalesce(sum(tokens_reserved),0)::double precision tokens_reserved,coalesce(sum(active_reserved_ms),0)::double precision active_reserved_ms FROM subtree`, [taskId])).rows[0]!;
}
