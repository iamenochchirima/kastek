import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { loadExecution } from "../lifecycle/execution";
import { productReferenceRules, type ProductReferenceRule } from "../../capabilities/products/product-capabilities";

const referencePattern = /^aref_[A-Za-z0-9_-]{43}$/;
type Target = { parent: Record<string, unknown> | unknown[]; key: string | number; value: unknown };

/** Project only adapter-declared native selectors. Receipts and authorization inputs stay native. */
export async function projectProductReferences(
  pool: Pool,
  taskId: string,
  operationId: string,
  binding: CapabilityBinding,
  modelResult: unknown,
): Promise<unknown> {
  const rules = productReferenceRules(binding).filter(rule => rule.outputRows?.length||rule.outputValues?.length);
  if (!rules.length) return modelResult;
  const execution = await loadExecution(pool, taskId);
  const authority = binding.authority;
  if (!authority || execution.task.principal.kind !== "human" || execution.task.organization_id !== binding.organizationId ||
      !execution.configuration.productBindings.some(item => item.id === binding.id && item.digest === binding.digest)) throw denied();

  return projectReferenceFields(modelResult,rules,(rule,row)=>issueReference(pool,execution.task,operationId,binding,rule.resourceType,row.id,displayLabel(row,rule.labelFields??[])));
}

/** Resolve only handles at adapter-declared selector paths. The product still rechecks current access. */
export async function resolveProductReferences(
  pool: Pool,
  taskId: string,
  binding: CapabilityBinding,
  input: unknown,
): Promise<unknown> {
  const rules = productReferenceRules(binding).filter(rule => rule.inputPaths?.length);
  if (!rules.length) return input;
  return resolveReferenceFields(input,rules,(rule,id)=>resolveReference(pool,taskId,binding,rule.resourceType,id));
}

export async function projectReferenceFields(
  modelResult:unknown,rules:readonly ProductReferenceRule[],issue:(rule:ProductReferenceRule,row:{id:string;[key:string]:unknown})=>Promise<string>,
):Promise<unknown>{
  const output=structuredClone(modelResult);
  for(const rule of rules)for(const path of rule.outputRows??[])for(const target of pathTargets(output,path)){
    if(!target.value||typeof target.value!=="object"||Array.isArray(target.value))throw unavailable();
    const row=target.value as Record<string,unknown>;
    if(typeof row.id!=="string"||!row.id||row.id.length>512)throw unavailable();
    row.id=await issue(rule,row as {id:string;[key:string]:unknown});
  }
  for(const rule of rules)for(const path of rule.outputValues??[])for(const target of pathTargets(output,path)){
    if(typeof target.value!=="string"||!target.value||target.value.length>512)throw unavailable();
    const handle=await issue(rule,{id:target.value});
    if(Array.isArray(target.parent))target.parent[target.key as number]=handle;
    else target.parent[target.key as string]=handle;
  }
  return output;
}

export async function resolveReferenceFields(
  input:unknown,rules:readonly ProductReferenceRule[],resolve:(rule:ProductReferenceRule,id:string)=>Promise<string>,
):Promise<unknown>{
  const output=structuredClone(input);
  for(const rule of rules)for(const path of rule.inputPaths??[])for(const target of pathTargets(output,path)){
    if(typeof target.value!=="string"||!target.value.startsWith("aref_"))continue;
    if(!referencePattern.test(target.value))throw unavailable();
    const resolved=await resolve(rule,target.value);
    if(Array.isArray(target.parent))target.parent[target.key as number]=resolved;
    else target.parent[target.key as string]=resolved;
  }
  return output;
}

function pathTargets(value: unknown, path: string): Target[] {
  const parts = path.split(".");
  const found: Target[] = [];
  const walk = (current: unknown, index: number) => {
    if (!current || typeof current !== "object" || index >= parts.length) return;
    const part = parts[index]!;
    if (part === "*") {
      for (const key of Array.isArray(current) ? current.keys() : Object.keys(current)) {
        const child = (current as Record<string | number, unknown>)[key];
        if (index === parts.length - 1) found.push({ parent: current as Record<string, unknown> | unknown[], key, value: child });
        else walk(child, index + 1);
      }
      return;
    }
    if (!Object.hasOwn(current, part)) return;
    const child = (current as Record<string, unknown>)[part];
    if (index === parts.length - 1) found.push({ parent: current as Record<string, unknown>, key: part, value: child });
    else walk(child, index + 1);
  };
  walk(value, 0);
  return found;
}

function displayLabel(row: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 512);
  }
  return null;
}

async function issueReference(
  pool: Pool,
  task: Awaited<ReturnType<typeof loadExecution>>["task"],
  operationId: string,
  binding: CapabilityBinding,
  resourceType: string,
  resourceId: string,
  displayLabel: string | null,
): Promise<string> {
  const authority = binding.authority;
  if (!authority) throw denied();
  const principalDigest = requestDigest(task.principal);
  const id = `aref_${randomBytes(32).toString("base64url")}`;
  await pool.query(`INSERT INTO agents_platform.product_references(
      id,organization_id,product,tenant_id,conversation_id,source_task_id,root_task_id,source_operation_id,
      binding_id,binding_digest,principal_digest,resource_type,resource_id,display_label)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(root_task_id,product,tenant_id,principal_digest,resource_type,resource_id) DO NOTHING`,
  [id,task.organization_id,authority.destinationProduct,authority.tenantId,task.conversation_id,task.id,task.root_task_id,
    operationId,binding.id,binding.digest,principalDigest,resourceType,resourceId,displayLabel]);
  const saved = (await pool.query<{ id: string }>(`SELECT id FROM agents_platform.product_references
    WHERE root_task_id=$1 AND product=$2 AND tenant_id=$3 AND principal_digest=$4 AND resource_type=$5 AND resource_id=$6`,
  [task.root_task_id,authority.destinationProduct,authority.tenantId,principalDigest,resourceType,resourceId])).rows[0];
  if (!saved || !referencePattern.test(saved.id)) throw unavailable();
  return saved.id;
}

async function resolveReference(pool: Pool, taskId: string, binding: CapabilityBinding, resourceType: string, id: string): Promise<string> {
  const authority = binding.authority;
  if (!authority) throw denied();
  const execution = await loadExecution(pool, taskId);
  if (execution.task.principal.kind !== "human" || execution.task.organization_id !== binding.organizationId ||
      !execution.configuration.productBindings.some(item => item.id === binding.id && item.digest === binding.digest)) throw denied();
  const row = (await pool.query<{ resource_id: string }>(`SELECT ref.resource_id FROM agents_platform.product_references ref
    JOIN agents_platform.tasks source ON source.id=ref.source_task_id AND source.organization_id=ref.organization_id
    JOIN agents_platform.tasks source_root ON source_root.id=source.root_task_id AND source_root.organization_id=source.organization_id
    WHERE ref.id=$1 AND ref.organization_id=$2 AND ref.product=$3 AND ref.tenant_id=$4
      AND ref.conversation_id=$5 AND ref.principal_digest=$6 AND ref.resource_type=$7
      AND (ref.root_task_id=$8 OR (source_root.conversation_id=$5 AND source_root.turn_sequence<=$9))
      AND source.principal=$10::jsonb`,
  [id,execution.task.organization_id,authority.destinationProduct,authority.tenantId,execution.task.conversation_id,
    requestDigest(execution.task.principal),resourceType,execution.task.root_task_id,execution.task.turn_sequence,JSON.stringify(execution.task.principal)])).rows[0];
  if (!row) throw unavailable();
  return row.resource_id;
}

function denied(): PlatformError { return new PlatformError("PRODUCT_AUTHORITY_INACTIVE", 403, "Product capability access is unavailable"); }
function unavailable(): PlatformError { return new PlatformError("PRODUCT_REFERENCE_UNAVAILABLE", 404, "The selected item is no longer available. Read the current list and choose it again."); }
