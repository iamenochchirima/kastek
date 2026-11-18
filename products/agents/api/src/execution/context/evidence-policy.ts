import {parseSkillPackage} from "../../capabilities/skills/package";
import type { Pool,PoolClient } from "pg";
import { capabilityBindingSchema,type CapabilityBinding,type ResourceHandle } from "../../contracts/capability-catalog";
import { isCustomerPrincipal, connectedToolAuthorityIds,sourceAuthorityIds,PlatformError,requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import {
assertDependencyManifest,collectDependencyGraph,createDependencyManifest,evidenceReferenceSchema,
type DependencyManifest,type EvidenceDependency,type EvidenceReference
} from "../../contracts/source-contracts";
import { assertBaseAuthority, assertPendingSupportStatusAuthority } from "../lifecycle/authority";
import { loadExecution } from "../lifecycle/state";
import { assertEvaluationTrial } from "../admission/trial-authority";
import { assertChannelCustomerAuthority } from "../admission/channel-authority";
import { assertProductAuthority } from "../admission/product-authority";
import { assertApplicationHistoryAccess } from "../admission/application-authority";
import { productPorts } from "../../infrastructure/product-ports";
import { assertCustomerNativeBindings } from "../../capabilities/connected-tools/customer-native-policy";
import { applicationConnectionCustodian } from "../../capabilities/connected-tools/application-connection-authority";
import { currentVisitorLineageAllowed,historyPrincipalAllowed } from "./visitor-lineage";
import { assertParentEdge, delegationAncestors } from "../delegation/scope";
import { continuationChildAllowed } from "./work-lineage";
import { memoryScopeMatchesExecution } from "../memory/scope";
import { assertProductNativeTaskAccess } from "../../contracts/resource-scope";
import { assertAcceptedProductMemoryTransition } from "../products/product-information";
import { assertProductReadCustody } from "../products/product-read-custody";
import { assertMcpTaskAuthority } from "../../infrastructure/mcp-job-authority";

export type Db = Pool | PoolClient;
export type EvidenceKind = "context" | "summary" | "memory" | "artifact" | "child_result" | "input";
export interface EvidenceNode { id: string; taskId: string; kind: EvidenceKind; ownerId: string; evidenceIds: string[]; parents: string[]; manifest: DependencyManifest }
export interface EvidencePassage { reference: EvidenceReference; label: string; text: string; title: string; page: number | null; section: string | null }
export interface ProductEvidenceInput {
  product: string; tenantId: string; contextRevision: string;
  bindingId?:string;bindingDigest?:string;operationName?:string;
  sources: { id: string }[]; text: string; title: string; acquiredAt: string;
  information?: import("@kasitek-labs/contracts").ProductInformationEnvelope;
}
export interface ConnectedEvidenceInput { bindingId: string; resource: ResourceHandle; text: string; title: string; acquiredAt: string; receiptDigest: string }
export const denied = () => new PlatformError("EVIDENCE_SCOPE_DENIED", 403, "Evidence is outside the task's permitted scope");
export const unavailable = () => new PlatformError("EVIDENCE_UNAVAILABLE", 403, "Evidence is no longer available");
export const integrity = () => new PlatformError("EVIDENCE_INTEGRITY", 409, "Evidence content or provenance changed");
export function dto(row: Record<string, any>): EvidenceReference { return evidenceReferenceSchema.parse({ id: row.id, organizationId: row.organization_id, rootTaskId: row.root_task_id,
  operationId: row.operation_id, sourceId: row.source_id, revisionId: row.revision_id, chunkId: row.chunk_id, start: row.start_offset, end: row.end_offset,
  contentDigest: row.content_digest, acquiredAt: new Date(row.acquired_at).toISOString(), manifest: row.manifest }); }
export function nodeDto(row: Record<string, any>): EvidenceNode { return { id: row.id, taskId: row.task_id, kind: row.kind, ownerId: row.owner_id, evidenceIds: row.evidence_ids, parents: row.parents, manifest: assertDependencyManifest(row.manifest) }; }
export async function owner(db: Db, execution: Execution): Promise<string | null> {
  const principal = execution.task.principal;
  if (isCustomerPrincipal(principal) || principal.kind === "application") return null;
  if (principal.kind === "automation") return principal.ownerAccountId;
  return (await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [principal.issuer, principal.subject])).rows[0]?.id ?? null;
}
export async function inspectionAuthority(db: Db, execution: Execution): Promise<void> {
  const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
  if (root.task.evaluation_trial_id) {
    await assertEvaluationTrial(db, { trialId: root.task.evaluation_trial_id, agentId: root.agentId,
      versionId: root.task.version_id, authority: { product: root.task.product,
        organizationId: root.task.organization_id, resourceId: root.task.resource_id,
        callerClientId: root.task.caller_client_id, principal: root.task.principal } });
  }
  for(const ancestor of await delegationAncestors(db,execution)) {
    const grant=(await db.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[ancestor.task.grant_id])).rows[0];
    if(!grant||grant.revoked_at)throw unavailable();
  }
  const accountId = await owner(db, root);
  const grant = (await db.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!grant || grant.revoked_at) throw unavailable();
  if(execution.task.parent_task_id && root.task.product!=="agents") {
    const rootGrant=(await db.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[root.task.grant_id])).rows[0];
    if(!rootGrant||rootGrant.revoked_at)throw unavailable();
  }
  if(root.task.product!=="agents") {
    await assertProductNativeTaskAccess(db, execution);
    await assertProductAuthority(db,{product:root.task.product,organizationId:root.task.organization_id,resourceId:root.task.resource_id,
      callerClientId:root.task.caller_client_id,principal:root.task.principal},root.task.version_id);
    if(execution.task.parent_task_id)await assertProductAuthority(db,{product:execution.task.product,organizationId:execution.task.organization_id,resourceId:execution.task.resource_id,
      callerClientId:execution.task.caller_client_id,principal:execution.task.principal},execution.task.version_id);
  } else if (accountId) {
    if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [root.task.organization_id, accountId])).rowCount) throw unavailable();
  } else if (root.task.principal.kind === "application") {
    await assertApplicationHistoryAccess(db, { product: root.task.product, organizationId: root.task.organization_id,
      resourceId: root.task.resource_id, callerClientId: root.task.caller_client_id, principal: root.task.principal }, root.agentId);
  } else if (root.task.principal.kind === "visitor") {
    if (!await currentVisitorLineageAllowed(db,root)) throw unavailable();
    if (!(await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.id=$1 AND s.id=$2 AND d.agent_id=$3 AND d.organization_id=$4 FOR SHARE OF d`, [root.task.principal.deploymentId, root.task.principal.sessionId, root.agentId, root.task.organization_id])).rowCount) throw unavailable();
  } else if (root.task.principal.kind === "channel_customer") {
    await assertChannelCustomerAuthority(db, { organizationId: root.task.organization_id, principal: root.task.principal,
      agentId: root.agentId, versionId: root.task.version_id,inspectionOnly:true });
  } else throw unavailable();
  if ((await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id
    WHERE t.root_task_id=$1 AND c.deleted_at IS NOT NULL LIMIT 1`, [root.task.id])).rowCount) throw unavailable();
}
export async function sourceAllowed(db: Db, execution: Execution, revisionId: string): Promise<void> {
  const grant = (await db.query("SELECT source_revision_ids,operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!sourceAuthorityIds(execution.configuration).includes(revisionId) || !grant?.source_revision_ids.includes(revisionId) || !grant.operations.includes("knowledge.read")) throw denied();
  if (!(await db.query("SELECT 1 FROM agents_platform.version_sources WHERE organization_id=$1 AND version_id=$2 AND revision_id=$3", [execution.task.organization_id, execution.task.version_id, revisionId])).rowCount) throw denied();
  if (execution.task.parent_task_id) {
    const parent = await loadExecution(db, execution.task.parent_task_id); assertParentEdge(parent,execution); await sourceAllowed(db, parent, revisionId);
  }
}
export async function rootRoleAllows(db:Db,root:Execution,roleId:string,versionId:string,bindingId:string):Promise<void>{
  const role=root.configuration.capabilities.delegation.enabled?root.configuration.capabilities.delegation.bindings.find(role=>role.id===roleId):undefined;
  if(!role||role.versionId!==versionId||!role.connectedToolBindingIds.includes(bindingId)||!connectedToolAuthorityIds(root.configuration).includes(bindingId))throw denied();
  const grant=(await db.query("SELECT connected_tool_binding_ids,operations,revoked_at FROM agents_platform.execution_grants WHERE id=$1",[root.task.grant_id])).rows[0];
  if(grant?.revoked_at)throw unavailable();
  const row=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=$2",[root.task.organization_id,bindingId])).rows[0];
  const binding=row?capabilityBindingSchema.parse(row.binding):undefined;
  const operation=["remote-mcp-v1","custom-api-v1","hubspot-contacts-v1"].includes(binding?.connection?.profileId??"")&&binding?.policy.effect==="reviewed_write"?"connected.execute":"connected.read";
  if(!binding||!grant?.operations.includes(operation)||!grant.connected_tool_binding_ids.includes(bindingId)||!(await db.query("SELECT 1 FROM agents_platform.version_connected_tools WHERE organization_id=$1 AND version_id=$2 AND binding_id=$3",[root.task.organization_id,root.task.version_id,bindingId])).rowCount)throw denied();
}
export async function assertChildConnectedAuthority(db:Db,child:Execution,bindingId:string):Promise<void>{
  if(!child.task.parent_task_id)return;
  const parent=await loadExecution(db,child.task.parent_task_id);
  assertParentEdge(parent,child);
  const delegation=(await db.query("SELECT binding_id,parent_task_id FROM agents_platform.delegations WHERE child_task_id=$1",[child.task.id])).rows[0];
  if(!delegation||delegation.parent_task_id!==parent.task.id||await owner(db,child)!==await owner(db,parent))throw denied();
  await rootRoleAllows(db,parent,delegation.binding_id,child.task.version_id,bindingId);
  await assertChildConnectedAuthority(db,parent,bindingId);
}
/** Only explicit follow-up ancestry can supply another child turn's conversation. */
export async function childHistoryAllowed(db:Db,current:Execution,origin:Execution):Promise<boolean>{
  const task=current.task,prior=origin.task;
  if(!task.parent_task_id||!prior.parent_task_id||prior.parent_task_id!==task.parent_task_id||
    task.root_task_id!==prior.root_task_id||task.organization_id!==prior.organization_id||task.conversation_id!==prior.conversation_id||
    task.version_id!==prior.version_id||current.agentId!==origin.agentId||!await historyPrincipalAllowed(db,current,origin)||
    BigInt(prior.turn_sequence)>=BigInt(task.turn_sequence))return false;
  let cursor=task.id;const seen=new Set<string>();
  while(true){
    if(seen.has(cursor))throw integrity();seen.add(cursor);
    const link=(await db.query(`SELECT d.prior_task_id FROM agents_platform.delegations d
      JOIN agents_platform.tasks t ON t.id=d.child_task_id
      WHERE d.child_task_id=$1 AND d.parent_task_id=$2 AND t.root_task_id=$6 AND t.organization_id=$3
        AND t.conversation_id=$4 AND t.version_id=$5`,[cursor,task.parent_task_id,task.organization_id,task.conversation_id,task.version_id,task.root_task_id])).rows[0];
    if(!link?.prior_task_id)return false;
    if(link.prior_task_id===prior.id)return true;
    cursor=link.prior_task_id;
  }
}
export async function historyOrigins(db:Db,current:Execution,extra:string[]):Promise<Execution[]>{
  const origins:Execution[]=[],seen=new Set<string>(),queue:{id:string;consumer:Execution}[]=extra.map(id=>({id,consumer:current}));
  async function linked(consumer:Execution){for(const row of(await db.query("SELECT h.origin_task_id FROM agents_platform.evidence_history_links h JOIN agents_platform.evidence_nodes n ON n.id=h.node_id WHERE n.task_id=$1",[consumer.task.id])).rows)queue.push({id:row.origin_task_id,consumer});}
  await linked(current);
  while(queue.length){const item=queue.shift()!;if(item.id===item.consumer.task.id)throw integrity();
    const origin=await loadExecution(db,item.id);
    const priorSpecialist=await continuationChildAllowed(db,current,origin);
    if(!priorSpecialist&&((current.task.parent_task_id?!await childHistoryAllowed(db,item.consumer,origin):!!origin.task.parent_task_id)||!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(origin.task.state)||origin.task.organization_id!==current.task.organization_id||origin.task.conversation_id!==current.task.conversation_id||origin.agentId!==current.agentId||!await historyPrincipalAllowed(db,current,origin)||BigInt(origin.task.turn_sequence)>=BigInt(item.consumer.task.turn_sequence)))throw denied();
    if(priorSpecialist&&!["completed","incomplete","refused","failed","cancelled"].includes(origin.task.state))throw denied();
    if(seen.has(item.id))continue;seen.add(item.id);await inspectionAuthority(db,origin);origins.push(origin);await linked(origin);
  }return origins;
}
export async function suppliedNodes(db:Db,execution:Execution):Promise<EvidenceNode[]>{
  const rows=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto),graph=new Map(rows.map(node=>[node.id,node]));
  const roots=rows.filter(node=>node.taskId===execution.task.id);collectDependencyGraph(roots.map(node=>node.id),graph);
  const seen=new Set<string>(),pending=roots.map(node=>node.id);
  while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);for(const parent of graph.get(id)!.parents)pending.push(parent);}
  return rows.filter(node=>seen.has(node.id));
}
export async function connectionEvidenceBinding(db:Db,execution:Execution,dependency:Extract<EvidenceDependency,{kind:"connection"}>,origins:Execution[]=[]):Promise<CapabilityBinding>{
  const own=execution.configuration.connectedToolBindingIds,candidates=[...own],delegated=new Map<string,Execution>();
  {
    for(const origin of origins)if(await continuationChildAllowed(db,execution,origin)) {
      const roleId=(await db.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1",[origin.task.id])).rows[0]?.binding_id;
      for(const id of origin.configuration.connectedToolBindingIds){await assertChildConnectedAuthority(db,origin,id);await rootRoleAllows(db,execution,roleId,origin.task.version_id,id);candidates.push(id);delegated.set(id,origin);}
    }
    for(const origin of [execution,...origins])for(const node of await suppliedNodes(db,origin)){
      if(node.taskId===origin.task.id||node.kind!=="child_result"||!node.manifest.dependencies.some(item=>requestDigest(item)===requestDigest(dependency)))continue;
      const child=await loadExecution(db,node.taskId);
      if(!(await delegationAncestors(db,child)).some(ancestor=>ancestor.task.id===origin.task.id)||!child.task.output||!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(child.task.state))continue;
      for(const id of child.configuration.connectedToolBindingIds){await assertChildConnectedAuthority(db,child,id);candidates.push(id);delegated.set(id,child);}
    }
  }
  const rows=(await db.query("SELECT id,binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])",[execution.task.organization_id,dependency.connectionId,[...new Set(candidates)]])).rows;
  const match=rows.find(row=>row.binding.catalog.digest===dependency.catalogDigest&&row.binding.resources.some((resource:ResourceHandle)=>requestDigest(resource)===dependency.resource));
  if(!match)throw denied();return bindingAllowed(db,own.includes(match.id)?execution:delegated.get(match.id)!,match.id);
}
export async function bindingAllowed(db: Db, execution: Execution, bindingId: string, operationId?:string): Promise<CapabilityBinding> {
  const grant = (await db.query("SELECT connected_tool_binding_ids,operations,revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if(grant?.revoked_at)throw unavailable();
  if (!execution.configuration.connectedToolBindingIds.includes(bindingId) || !grant?.connected_tool_binding_ids.includes(bindingId)) throw denied();
  if (!(await db.query("SELECT 1 FROM agents_platform.version_connected_tools WHERE organization_id=$1 AND version_id=$2 AND binding_id=$3",[execution.task.organization_id,execution.task.version_id,bindingId])).rowCount) throw denied();
  const row = (await db.query("SELECT binding,account_id FROM agents_platform.capability_bindings WHERE id=$1 AND organization_id=$2", [bindingId, execution.task.organization_id])).rows[0];
  if (!row) throw denied();
  const binding = capabilityBindingSchema.parse(row.binding);
  const expectedOwner=isCustomerPrincipal(execution.task.principal)?(await assertCustomerNativeBindings(db as PoolClient,execution.task.organization_id,[bindingId]))[0]?.ownerAccountId:
    execution.task.principal.kind==="application"?await applicationConnectionCustodian(db,execution,binding):await owner(db,execution);
  if (row.account_id !== expectedOwner) throw denied();
  const remote=["remote-mcp-v1","custom-api-v1","hubspot-contacts-v1"].includes(binding.connection?.profileId??""),reviewed=remote&&binding.policy.effect==="reviewed_write";
  if(!grant.operations.includes(reviewed?"connected.execute":"connected.read"))throw denied();
  if (!binding.connection || (!remote && (binding.policy.effect !== "read" || binding.policy.disclosure !== (binding.connection.profileId === "stash-read-v1" ? "approved_resource_identifiers" : "public_identifiers")))) throw denied();
  if(reviewed&&operationId){
    const review=(await db.query(`SELECT p.*,r.request_digest AS operation_request_digest FROM agents_platform.tool_invocation_reviews p
      JOIN agents_platform.connected_reads r ON r.operation_id=p.operation_id AND r.task_id=p.task_id AND r.binding_id=p.binding_id
      WHERE p.organization_id=$1 AND p.task_id=$2 AND p.operation_id=$3 AND p.binding_id=$4 AND p.binding_digest=$5
      AND p.connection_id=$6 AND p.connection_policy_revision=$7 AND p.state IN ('claimed','completed')
      AND p.approved_at IS NOT NULL AND p.claimed_at IS NOT NULL FOR SHARE OF p`,
      [execution.task.organization_id,execution.task.id,operationId,binding.id,binding.digest,binding.connection.id,binding.connection.policyRevision])).rows[0];
    if(!review||review.reviewer_account_id!==expectedOwner
      ||review.request_digest!==requestDigest({bindingDigest:binding.digest,arguments:review.arguments})
      ||review.operation_request_digest!==requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args:review.arguments}))throw denied();
  }
  await assertChildConnectedAuthority(db,execution,bindingId);
  return binding;
}
export async function delegationInput(db:Db,childTaskId:string){
 const child=await loadExecution(db,childTaskId);if(!child.task.parent_task_id)return;
 const row=(await db.query("SELECT parent_task_id,input_manifest FROM agents_platform.delegations WHERE child_task_id=$1",[childTaskId])).rows[0];
 if(!row||row.parent_task_id!==child.task.parent_task_id)throw integrity();
 const parent=await loadExecution(db,row.parent_task_id);assertParentEdge(parent,child);if(parent.task.organization_id!==child.task.organization_id||await owner(db,parent)!==await owner(db,child))throw integrity();
 return{parentTaskId:row.parent_task_id as string,manifest:assertDependencyManifest(row.input_manifest),child};
}
export async function assertDelegationInputEvidence(db:Db,childTaskId:string,expectedDigest?:string,trail:readonly string[]=[],consumerTaskId=childTaskId):Promise<void>{
 const input=await delegationInput(db,childTaskId);if(!input){if(expectedDigest)throw integrity();return;}
 if(input.child.task.product!=="agents")await inspectionAuthority(db,input.child);
 const consumer=consumerTaskId===childTaskId?input.child:await loadExecution(db,consumerTaskId);
 if(consumer.task.organization_id!==input.child.task.organization_id||consumer.task.product!==input.child.task.product||
    !await historyPrincipalAllowed(db,consumer,input.child)||await owner(db,consumer)!==await owner(db,input.child))throw denied();
 if(consumer.task.product!=="agents") {
   const {currentProductInformation,assertProductInformationAudience}=await import("../products/product-information");
   await assertProductInformationAudience(db,consumer,await currentProductInformation(db,input.child));
 }
 if(expectedDigest&&expectedDigest!==input.manifest.digest||trail.includes(childTaskId))throw integrity();
 // Inspection validates the original actor and live policies, even after the parent task completes.
 await assertCurrentEvidence(db,input.parentTaskId,input.manifest,{requireActiveTask:false,delegationTrail:[...trail,childTaskId]});
}
export async function delegationDependency(db:Db,taskId:string):Promise<EvidenceDependency[]>{
 const input=await delegationInput(db,taskId);return input?[{kind:"delegation_input",referenceId:taskId,manifestDigest:input.manifest.digest}]:[];
}
async function joinedSpecialistSkillAllowed(db:Db,current:Execution,dependency:Extract<EvidenceDependency,{kind:"skill"}>,origins:Execution[]):Promise<boolean>{
  const root=current;
  if(root.configuration.program.id!=="tool-directed"||root.configuration.program.version!=="4"||!root.configuration.capabilities.delegation.enabled)return false;
  for(const origin of [root,...origins]){
    for(const node of await suppliedNodes(db,origin)){
      if(node.kind!=="child_result"||node.taskId===origin.task.id||!node.manifest.dependencies.some(item=>requestDigest(item)===requestDigest(dependency)))continue;
      const child=await loadExecution(db,node.taskId);
      if(!(await delegationAncestors(db,child)).some(ancestor=>ancestor.task.id===origin.task.id)||child.task.organization_id!==root.task.organization_id||child.agentId!==dependency.agentId||!child.configuration.skillIds.includes(dependency.skillId))continue;
      const delegated=(await db.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1 AND parent_task_id=$2",[child.task.id,child.task.parent_task_id])).rows[0];
      const parent=await loadExecution(db,child.task.parent_task_id!);
      if(!parent.configuration.capabilities.delegation.enabled||!parent.configuration.capabilities.delegation.bindings.some(binding=>binding.id===delegated?.binding_id&&binding.versionId===child.task.version_id))continue;
      await inspectionAuthority(db,child);
      return true;
    }
  }
  return false;
}
async function memoryDependencyAllowed(db:Db,current:Execution,row:Record<string,any>,origins:Execution[]):Promise<boolean>{
  for(const candidate of [current,...await delegationAncestors(db,current),...origins]) {
    if(await memoryScopeMatchesExecution(db,candidate,row))return true;
  }
  for(const origin of [current,...origins])for(const node of await suppliedNodes(db,origin)) {
    if(node.kind!=="child_result"||!node.manifest.dependencies.some(dependency=>dependency.kind==="memory"&&dependency.referenceId===row.id))continue;
    const child=await loadExecution(db,node.taskId);
    if(!(await delegationAncestors(db,child)).some(ancestor=>ancestor.task.id===origin.task.id))continue;
    if(await memoryScopeMatchesExecution(db,child,row)){await inspectionAuthority(db,child);return true;}
  }
  return false;
}
/** Call inside the same transaction as the consuming model/effect claim, holding the organization lock. */
export async function assertCurrentEvidence(db: Db, taskId: string, input: DependencyManifest, options: { requireActiveTask?: boolean; delegationTrail?:readonly string[]; historyOriginTaskIds?:string[] } = {}): Promise<void> {
  const manifest = assertDependencyManifest(input), execution = await loadExecution(db, taskId);
  if(options.requireActiveTask===false)await assertProductReadCustody(db,taskId);
  if (options.requireActiveTask !== false) await assertCurrentAuthority(db, execution); else {await inspectionAuthority(db, execution);if(execution.task.parent_task_id)await assertDelegationInputEvidence(db,taskId,undefined,options.delegationTrail);}
  const origins=await historyOrigins(db,execution,options.historyOriginTaskIds??[]);
  const dependencies = [...manifest.dependencies].sort((a, b) => {
    const key = (value: EvidenceDependency) => value.kind === "source" ? value.sourceId : value.kind === "connection" ? value.connectionId : value.kind === "skill" ? value.skillId : value.kind === "product" ? `${value.product}:${value.tenantId}:${value.taskId}:${value.sourceId}` : value.kind === "product_access" ? `${value.product}:${value.tenantId}:${value.taskId}:${value.reference}` : value.kind === "product_context" ? `${value.product}:${value.tenantId}:${value.taskId}` : value.kind === "product_artifact" ? value.artifactId : value.referenceId;
    return key(a).localeCompare(key(b));
  });
  for (const dependency of dependencies) {
    if (dependency.kind !== "product" && dependency.kind !== "product_access") continue;
    const currentGrant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
    if(!currentGrant?.operations.includes("product.read"))throw denied();
    const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
    let origin = [execution, root, ...origins].find(candidate => candidate.task.id === dependency.taskId);
    if(!origin&&dependency.memoryTransition){origin=await assertAcceptedProductMemoryTransition(db,execution,dependency);await inspectionAuthority(db,origin);}
    if(!origin) {
      const candidate=await loadExecution(db,dependency.taskId);
      for(const context of [execution,...origins]) {
        const joined=(await suppliedNodes(db,context)).some(node=>node.kind==="child_result"&&node.taskId===candidate.task.id&&
          node.manifest.dependencies.some(value=>requestDigest(value)===requestDigest(dependency)));
        if(joined&&(await delegationAncestors(db,candidate)).some(ancestor=>ancestor.task.id===context.task.id)) {
          await inspectionAuthority(db,candidate);origin=candidate;break;
        }
      }
    }
    if (!origin || (!dependency.bindingId && (origin.task.product !== dependency.product || root.task.product !== dependency.product))) throw denied();
    try {
      const port=productPorts(db);
      if(dependency.kind==="product_access"){
        if(!port.assertCurrentAccess)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product result authorization is unavailable");
        await port.assertCurrentAccess(db,{consumerTaskId:taskId,dependency});
      }else await port.assertCurrentEvidence(db, { consumerTaskId: taskId, dependency });
    }
    catch (error) {
      if (error instanceof PlatformError && [403, 404, 409].includes(error.statusCode)) throw unavailable();
      throw error;
    }
  }
  for(const dependency of dependencies)if(dependency.kind==="product_context"){
    const root=execution.task.parent_task_id?await loadExecution(db,execution.task.root_task_id):execution;
    let origin=[execution,root,...origins].find(candidate=>candidate.task.id===dependency.taskId);
    if(!origin&&dependency.memoryTransition){origin=await assertAcceptedProductMemoryTransition(db,execution,dependency);await inspectionAuthority(db,origin);}
    if(!origin||origin.task.product!==dependency.product||root.task.product!==dependency.product)throw denied();
    try {
      const port=productPorts(db);
      if(!port.assertCurrentContext)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product context authorization is unavailable");
      await port.assertCurrentContext(db,{consumerTaskId:taskId,dependency});
    } catch(error) {
      if(error instanceof PlatformError&&[403,404,409].includes(error.statusCode))throw unavailable();
      throw error;
    }
  }
  for(const dependency of dependencies)if(dependency.kind==="product_artifact"){
    const origin=await loadExecution(db,dependency.taskId);
    if(origin.task.organization_id!==execution.task.organization_id||origin.task.product!==execution.task.product||
      !await historyPrincipalAllowed(db,execution,origin))throw denied();
    await inspectionAuthority(db,origin);
    try{
      const port=productPorts(db);
      if(!port.assertCurrentArtifact)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product artifact authorization is unavailable");
      await port.assertCurrentArtifact(db,{consumerTaskId:taskId,dependency});
    }catch(error){if(error instanceof PlatformError&&[403,404,409].includes(error.statusCode))throw unavailable();throw error;}
  }
  for(const dependency of dependencies)if(dependency.kind==="delegation_input"){
    if(dependency.memoryTransition){
      const origin=await assertAcceptedProductMemoryTransition(db,execution,dependency);await inspectionAuthority(db,origin);
      await assertDelegationInputEvidence(db,dependency.referenceId,dependency.manifestDigest,options.delegationTrail,origin.task.id);
    }else await assertDelegationInputEvidence(db,dependency.referenceId,dependency.manifestDigest,options.delegationTrail,taskId);
  }
  for(const dependency of dependencies)if(dependency.kind==="artifact"){
    const row=(await db.query(`SELECT a.task_id,a.content_digest FROM agents_platform.artifacts a
      JOIN agents_platform.tasks t ON t.id=a.task_id JOIN agents_platform.conversations c ON c.id=t.conversation_id
      WHERE a.id=$1 AND a.organization_id=$2 AND a.state='available' AND c.deleted_at IS NULL FOR SHARE OF a,c`,
    [dependency.referenceId,execution.task.organization_id])).rows[0];
    if(!row||row.content_digest!==dependency.contentDigest)throw unavailable();
    const origin=await loadExecution(db,row.task_id);
    if(!await historyPrincipalAllowed(db,execution,origin))throw denied();
    await inspectionAuthority(db,origin);
  }
  for (const dependency of dependencies.filter(item => item.kind === "source")) {
    if (dependency.kind !== "source") continue;
    await sourceAllowed(db, execution, dependency.revisionId);
    const row = (await db.query(`SELECT s.*,p.state AS revision_state FROM agents_platform.sources s
      JOIN agents_platform.source_revision_policy p ON p.source_id=s.id AND p.organization_id=s.organization_id
      WHERE s.id=$1 AND s.organization_id=$2 AND p.revision_id=$3 FOR SHARE OF s,p`, [dependency.sourceId, execution.task.organization_id, dependency.revisionId])).rows[0];
    if (!row || row.state !== "active" || row.revision_state !== "approved" || row.generation !== dependency.generation || row.visibility !== dependency.visibility) throw unavailable();
  }
  for (const dependency of dependencies.filter(item => item.kind === "connection")) {
    if (dependency.kind !== "connection") continue;
    const binding = await connectionEvidenceBinding(db,execution,dependency,origins);
    const row = (await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 FOR SHARE", [dependency.connectionId, execution.task.organization_id])).rows[0];
    const expectedOwner=isCustomerPrincipal(execution.task.principal)?(await assertCustomerNativeBindings(db as PoolClient,execution.task.organization_id,[binding.id]))[0]?.ownerAccountId:
      execution.task.principal.kind==="application"?await applicationConnectionCustodian(db,execution,binding):await owner(db,execution);
    if (!row || row.state !== "active" || row.policy_revision !== dependency.policyRevision || new Date(row.expires_at).getTime() <= Date.now() || row.account_id !== expectedOwner || binding.connection?.policyRevision !== row.policy_revision || !row.resource_handles.some((resource: ResourceHandle) => requestDigest(resource) === dependency.resource)) throw unavailable();
  }
  for(const dependency of dependencies){
    if(dependency.kind!=="skill")continue;
    const root=execution.task.parent_task_id?await loadExecution(db,execution.task.root_task_id):execution;
    const candidates=[execution,root,...origins];
    if(!candidates.some(origin=>origin.agentId===dependency.agentId&&origin.configuration.skillIds.includes(dependency.skillId))&&!await joinedSpecialistSkillAllowed(db,execution,dependency,origins))throw denied();
    const row=(await db.query(`SELECT s.content_digest,p.files,r.content_digest AS reviewed_digest,st.state
      FROM agents_platform.skill_revisions s JOIN agents_platform.skill_packages p ON p.skill_revision_id=s.id
      JOIN agents_platform.skill_package_reviews r ON r.skill_revision_id=s.id
      JOIN agents_platform.skill_installation_states st ON st.skill_revision_id=s.id
      WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.id=$3 FOR SHARE OF st`,[execution.task.organization_id,dependency.agentId,dependency.skillId])).rows[0];
    if(!row||row.state!=="enabled"||row.content_digest!==dependency.packageDigest||row.reviewed_digest!==dependency.packageDigest)throw unavailable();
    if(parseSkillPackage({files:row.files.map((file:any)=>({path:file.path,content:file.content,encoding:file.encoding}))}).contentDigest!==dependency.packageDigest)throw integrity();
  }
  for (const dependency of dependencies.filter(item => item.kind === "memory")) {
    if (dependency.kind !== "memory") continue;
    const row = (await db.query("SELECT * FROM agents_platform.memory_scopes WHERE id=$1 AND organization_id=$2 FOR SHARE", [dependency.referenceId, execution.task.organization_id])).rows[0];
    if (!row) throw unavailable();
    try{if(!await memoryDependencyAllowed(db,execution,row,origins))throw denied();}
    catch(error){if(error instanceof PlatformError&&[403,404,409].includes(error.statusCode))throw unavailable();throw error;}
    if(dependency.memoryId) {
      const memory=(await db.query("SELECT revision,status,expires_at FROM agents_platform.memories WHERE id=$1 AND scope_id=$2 FOR SHARE",[dependency.memoryId,row.id])).rows[0];
      if(!memory||memory.status!=="accepted"||Number(memory.revision)!==dependency.memoryRevision||memory.expires_at&&new Date(memory.expires_at).getTime()<=Date.now())throw unavailable();
    } else if(Number(row.generation)!==dependency.generation||row.next_expiry_at&&new Date(row.next_expiry_at).getTime()<=Date.now())throw unavailable();
  }
}

export async function taskEvidenceManifest(db:Db,taskId:string):Promise<DependencyManifest>{
  const execution=await loadExecution(db,taskId);
  const rows=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
  const own=collectDependencyGraph(rows.filter(node=>node.taskId===taskId).map(node=>node.id),new Map(rows.map(node=>[node.id,node])));
  return createDependencyManifest([...own.dependencies,...await delegationDependency(db,taskId)]);
}
export function citationLabels(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(E(?:[a-f0-9]{32}|[0-9]+))\]/g)].map(match => match[1]!))];
}
export function boundedText(text: string): void {
  if (!text.length || Buffer.byteLength(text) > 8192) throw new PlatformError("EVIDENCE_LIMIT", 413, "Evidence passage exceeds its visible text limit");
}
export function payloadHas(value: unknown, text: string, label: string, remainingDecodes = 4): boolean {
  if (typeof value === "string") {
    if ((value.includes(text) || value.includes(JSON.stringify(text).slice(1,-1))) && value.includes(`[${label}]`)) return true;
    // Compaction packs tool messages whose content is already a JSON observation.
    if (remainingDecodes > 0) try { return payloadHas(JSON.parse(value), text, label, remainingDecodes - 1); } catch { return false; }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => payloadHas(item, text, label, remainingDecodes));
  // Tool schemas and the discovery catalogue never carry evidence passages; walking them is pure cost.
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) =>
    key !== "catalog" && key !== "tools" && payloadHas(item, text, label, remainingDecodes));
  return false;
}
export function memoryVisible(value:unknown,id:string,content:string):boolean{
  if(typeof value==="string"){
    if(value.includes(content))return true;
    const start=value.indexOf("{");if(start>=0)try{const record=JSON.parse(value.slice(start));return record.kind==="memory"&&record.sourceId===id&&typeof record.content==="string"&&record.content.length>0&&content.startsWith(record.content);}catch{return false;}
    return false;
  }
  if(Array.isArray(value))return value.some(item=>memoryVisible(item,id,content));
  if(value&&typeof value==="object")return Object.values(value).some(item=>memoryVisible(item,id,content));
  return false;
}

export async function assertCurrentAuthority(db:Pool|PoolClient,execution:Execution):Promise<void>{
  if(execution.task.execution_purpose==="support_status_v1")await assertPendingSupportStatusAuthority(db,execution);
  else await assertBaseAuthority(db,execution);
  await assertMcpTaskAuthority(db, execution.task.root_task_id ?? execution.task.id);
  if(execution.task.parent_task_id)await assertDelegationInputEvidence(db,execution.task.id);
}
