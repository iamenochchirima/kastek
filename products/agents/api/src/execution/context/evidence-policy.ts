import {parseSkillPackage} from "../../capabilities/skills/package";
import type { Pool,PoolClient } from "pg";
import { capabilityBindingSchema,type CapabilityBinding,type ResourceHandle } from "../../contracts/capability-catalog";
import { isCustomerPrincipal, connectedToolAuthorityIds,PlatformError,requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import {
assertDependencyManifest,collectDependencyGraph,createDependencyManifest,evidenceReferenceSchema,
type DependencyManifest,type EvidenceDependency,type EvidenceReference
} from "../../contracts/source-contracts";
import { assertBaseAuthority } from "../lifecycle/authority";
import { loadExecution } from "../lifecycle/state";
import { assertChannelCustomerAuthority } from "../admission/channel-authority";
import { assertProductAuthority } from "../admission/product-authority";

export type Db = Pool | PoolClient;
export type EvidenceKind = "context" | "summary" | "memory" | "artifact" | "child_result" | "input";
export interface EvidenceNode { id: string; taskId: string; kind: EvidenceKind; ownerId: string; evidenceIds: string[]; parents: string[]; manifest: DependencyManifest }
export interface EvidencePassage { reference: EvidenceReference; label: string; text: string; title: string; page: number | null; section: string | null }
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
  if (isCustomerPrincipal(principal)) return null;
  if (principal.kind === "automation") return principal.ownerAccountId;
  return (await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [principal.issuer, principal.subject])).rows[0]?.id ?? null;
}
export async function inspectionAuthority(db: Db, execution: Execution): Promise<void> {
  const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
  const accountId = await owner(db, root);
  const grant = (await db.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!grant || grant.revoked_at) throw unavailable();
  if(root.task.product!=="agents") {
    await assertProductAuthority(db,{product:root.task.product,organizationId:root.task.organization_id,resourceId:root.task.resource_id,
      callerClientId:root.task.caller_client_id,principal:root.task.principal},root.task.version_id,root.task.grant_id);
  } else if (accountId) {
    if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [root.task.organization_id, accountId])).rowCount) throw unavailable();
  } else if (root.task.principal.kind === "visitor") {
    if (!(await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.id=$1 AND s.id=$2 AND d.revoked_at IS NULL AND s.expires_at>now() AND d.agent_id=$3 AND d.organization_id=$4 FOR SHARE OF d`, [root.task.principal.deploymentId, root.task.principal.sessionId, root.agentId, root.task.organization_id])).rowCount) throw unavailable();
  } else if (root.task.principal.kind === "channel_customer") {
    await assertChannelCustomerAuthority(db, { organizationId: root.task.organization_id, principal: root.task.principal,
      agentId: root.agentId, versionId: root.task.version_id });
  } else throw unavailable();
  if ((await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id
    WHERE t.root_task_id=$1 AND c.deleted_at IS NOT NULL LIMIT 1`, [root.task.id])).rowCount) throw unavailable();
}
export async function sourceAllowed(db: Db, execution: Execution, revisionId: string): Promise<void> {
  const grant = (await db.query("SELECT source_revision_ids,operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!execution.configuration.sourceRevisionIds.includes(revisionId) || !grant?.source_revision_ids.includes(revisionId) || !grant.operations.includes("knowledge.read")) throw denied();
  if (!(await db.query("SELECT 1 FROM agents_platform.version_sources WHERE organization_id=$1 AND version_id=$2 AND revision_id=$3", [execution.task.organization_id, execution.task.version_id, revisionId])).rowCount) throw denied();
  if (execution.task.parent_task_id) {
    const root = await loadExecution(db, execution.task.root_task_id); await sourceAllowed(db, root, revisionId);
  }
}
export async function rootRoleAllows(db:Db,root:Execution,roleId:string,versionId:string,bindingId:string):Promise<void>{
  const role=root.configuration.capabilities.delegation.enabled?root.configuration.capabilities.delegation.bindings.find(role=>role.id===roleId):undefined;
  if(!role||role.versionId!==versionId||!role.connectedToolBindingIds.includes(bindingId)||!connectedToolAuthorityIds(root.configuration).includes(bindingId))throw denied();
  const grant=(await db.query("SELECT connected_tool_binding_ids,operations,revoked_at FROM agents_platform.execution_grants WHERE id=$1",[root.task.grant_id])).rows[0];
  if(grant?.revoked_at)throw unavailable();
  const row=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=$2",[root.task.organization_id,bindingId])).rows[0];
  const binding=row?capabilityBindingSchema.parse(row.binding):undefined;
  const operation=["remote-mcp-v1","custom-api-v1"].includes(binding?.connection?.profileId??"")&&binding?.policy.effect==="reviewed_write"?"connected.execute":"connected.read";
  if(!binding||!grant?.operations.includes(operation)||!grant.connected_tool_binding_ids.includes(bindingId)||!(await db.query("SELECT 1 FROM agents_platform.version_connected_tools WHERE organization_id=$1 AND version_id=$2 AND binding_id=$3",[root.task.organization_id,root.task.version_id,bindingId])).rowCount)throw denied();
}
export async function assertChildConnectedAuthority(db:Db,child:Execution,bindingId:string):Promise<void>{
  if(!child.task.parent_task_id)return;
  const root=await loadExecution(db,child.task.root_task_id);
  const delegation=(await db.query("SELECT binding_id,parent_task_id FROM agents_platform.delegations WHERE child_task_id=$1",[child.task.id])).rows[0];
  if(!delegation||delegation.parent_task_id!==root.task.id||child.task.parent_task_id!==root.task.id||child.task.organization_id!==root.task.organization_id||await owner(db,child)!==await owner(db,root))throw denied();
  await rootRoleAllows(db,root,delegation.binding_id,child.task.version_id,bindingId);
}
export async function historyOrigins(db:Db,current:Execution,extra:string[]):Promise<Execution[]>{
  const origins:Execution[]=[],seen=new Set<string>(),queue:{id:string;consumer:Execution}[]=extra.map(id=>({id,consumer:current}));
  async function linked(consumer:Execution){for(const row of(await db.query("SELECT h.origin_task_id FROM agents_platform.evidence_history_links h JOIN agents_platform.evidence_nodes n ON n.id=h.node_id WHERE n.task_id=$1",[consumer.task.id])).rows)queue.push({id:row.origin_task_id,consumer});}
  await linked(current);
  while(queue.length){const item=queue.shift()!;if(item.id===item.consumer.task.id)throw integrity();
    const origin=await loadExecution(db,item.id);
    if(origin.task.parent_task_id||!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(origin.task.state)||origin.task.organization_id!==current.task.organization_id||origin.task.conversation_id!==current.task.conversation_id||origin.agentId!==current.agentId||requestDigest(origin.task.principal)!==requestDigest(current.task.principal)||BigInt(origin.task.turn_sequence)>=BigInt(item.consumer.task.turn_sequence))throw denied();
    if(seen.has(item.id))continue;if(seen.size>=32)throw new PlatformError("EVIDENCE_LIMIT",413,"History provenance exceeds its origin limit");seen.add(item.id);await inspectionAuthority(db,origin);origins.push(origin);await linked(origin);
  }return origins;
}
export async function suppliedNodes(db:Db,execution:Execution):Promise<EvidenceNode[]>{
  const rows=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto),graph=new Map(rows.map(node=>[node.id,node]));
  const roots=rows.filter(node=>node.taskId===execution.task.id);collectDependencyGraph(roots.map(node=>node.id),graph);
  const seen=new Set<string>();const visit=(id:string):void=>{if(seen.has(id))return;seen.add(id);for(const parent of graph.get(id)!.parents)visit(parent);};roots.forEach(node=>visit(node.id));return rows.filter(node=>seen.has(node.id));
}
export async function connectionEvidenceBinding(db:Db,execution:Execution,dependency:Extract<EvidenceDependency,{kind:"connection"}>,origins:Execution[]=[]):Promise<CapabilityBinding>{
  const own=execution.configuration.connectedToolBindingIds,candidates=[...own],delegated=new Map<string,Execution>();
  if(!execution.task.parent_task_id){
    for(const origin of [execution,...origins])for(const node of await suppliedNodes(db,origin)){
      if(node.taskId===origin.task.id||node.kind!=="child_result"||!node.manifest.dependencies.some(item=>requestDigest(item)===requestDigest(dependency)))continue;
      const child=await loadExecution(db,node.taskId);
      if(child.task.parent_task_id!==origin.task.id||!child.task.output||!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(child.task.state))continue;
      const roleId=(await db.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1",[child.task.id])).rows[0]?.binding_id;
      for(const id of child.configuration.connectedToolBindingIds){await assertChildConnectedAuthority(db,child,id);await rootRoleAllows(db,execution,roleId,child.task.version_id,id);candidates.push(id);delegated.set(id,child);}
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
  if (!row || row.account_id !== await owner(db, execution)) throw denied();
  const binding = capabilityBindingSchema.parse(row.binding);
  const remote=["remote-mcp-v1","custom-api-v1"].includes(binding.connection?.profileId??""),reviewed=remote&&binding.policy.effect==="reviewed_write";
  if(!grant.operations.includes(reviewed?"connected.execute":"connected.read"))throw denied();
  if (!binding.connection || (!remote && (binding.policy.effect !== "read" || binding.policy.disclosure !== (binding.connection.profileId === "stash-read-v1" ? "approved_resource_identifiers" : "public_identifiers")))) throw denied();
  if(reviewed&&operationId){
    const review=(await db.query(`SELECT p.*,r.request_digest AS operation_request_digest FROM agents_platform.tool_invocation_reviews p
      JOIN agents_platform.connected_reads r ON r.operation_id=p.operation_id AND r.task_id=p.task_id AND r.binding_id=p.binding_id
      WHERE p.organization_id=$1 AND p.task_id=$2 AND p.operation_id=$3 AND p.binding_id=$4 AND p.binding_digest=$5
      AND p.connection_id=$6 AND p.connection_policy_revision=$7 AND p.state IN ('claimed','completed')
      AND p.approved_at IS NOT NULL AND p.claimed_at IS NOT NULL FOR SHARE OF p`,
      [execution.task.organization_id,execution.task.id,operationId,binding.id,binding.digest,binding.connection.id,binding.connection.policyRevision])).rows[0];
    if(!review||review.reviewer_account_id!==await owner(db,execution)
      ||review.request_digest!==requestDigest({bindingDigest:binding.digest,arguments:review.arguments})
      ||review.operation_request_digest!==requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args:review.arguments}))throw denied();
  }
  await assertChildConnectedAuthority(db,execution,bindingId);
  return binding;
}
export async function delegationInput(db:Db,childTaskId:string){
 const child=await loadExecution(db,childTaskId);if(!child.task.parent_task_id)return;
 const row=(await db.query("SELECT parent_task_id,input_manifest FROM agents_platform.delegations WHERE child_task_id=$1",[childTaskId])).rows[0];
 if(!row||row.parent_task_id!==child.task.parent_task_id||row.parent_task_id!==child.task.root_task_id)throw integrity();
 const parent=await loadExecution(db,row.parent_task_id);if(parent.task.organization_id!==child.task.organization_id||await owner(db,parent)!==await owner(db,child))throw integrity();
 return{parentTaskId:row.parent_task_id as string,manifest:assertDependencyManifest(row.input_manifest),child};
}
export async function assertDelegationInputEvidence(db:Db,childTaskId:string,expectedDigest?:string,trail:readonly string[]=[],consumerTaskId=childTaskId):Promise<void>{
 const input=await delegationInput(db,childTaskId);if(!input){if(expectedDigest)throw integrity();return;}
 const consumer=consumerTaskId===childTaskId?input.child:await loadExecution(db,consumerTaskId);
 if(consumer.task.organization_id!==input.child.task.organization_id||await owner(db,consumer)!==await owner(db,input.child))throw denied();
 if(expectedDigest&&expectedDigest!==input.manifest.digest||trail.includes(childTaskId)||trail.length>=32)throw integrity();
 // Inspection validates the original actor and live policies, even after the parent task completes.
 await assertCurrentEvidence(db,input.parentTaskId,input.manifest,{requireActiveTask:false,delegationTrail:[...trail,childTaskId]});
}
export async function delegationDependency(db:Db,taskId:string):Promise<EvidenceDependency[]>{
 const input=await delegationInput(db,taskId);return input?[{kind:"delegation_input",referenceId:taskId,manifestDigest:input.manifest.digest}]:[];
}
/** Call inside the same transaction as the consuming model/effect claim, holding the organization lock. */
export async function assertCurrentEvidence(db: Db, taskId: string, input: DependencyManifest, options: { requireActiveTask?: boolean; delegationTrail?:readonly string[]; historyOriginTaskIds?:string[] } = {}): Promise<void> {
  const manifest = assertDependencyManifest(input), execution = await loadExecution(db, taskId);
  if (options.requireActiveTask !== false) await assertCurrentAuthority(db, execution); else {await inspectionAuthority(db, execution);if(execution.task.parent_task_id)await assertDelegationInputEvidence(db,taskId,undefined,options.delegationTrail);}
  const origins=execution.task.parent_task_id?[]:await historyOrigins(db,execution,options.historyOriginTaskIds??[]);
  const dependencies = [...manifest.dependencies].sort((a, b) => {
    const key = (value: EvidenceDependency) => value.kind === "source" ? value.sourceId : value.kind === "connection" ? value.connectionId : value.kind === "skill" ? value.skillId : value.referenceId;
    return key(a).localeCompare(key(b));
  });
  for(const dependency of dependencies)if(dependency.kind==="delegation_input")await assertDelegationInputEvidence(db,dependency.referenceId,dependency.manifestDigest,options.delegationTrail,taskId);
  for (const dependency of dependencies.filter(item => item.kind === "source")) {
    if (dependency.kind !== "source") continue;
    await sourceAllowed(db, execution, dependency.revisionId);
    const row = (await db.query(`SELECT s.*,p.state AS revision_state FROM agents_platform.sources s
      JOIN agents_platform.source_revision_policy p ON p.source_id=s.id AND p.organization_id=s.organization_id
      WHERE s.id=$1 AND s.organization_id=$2 AND p.revision_id=$3 FOR SHARE OF s,p`, [dependency.sourceId, execution.task.organization_id, dependency.revisionId])).rows[0];
    if (!row || row.state !== "active" || row.revision_state !== "approved" || row.generation !== dependency.generation || row.visibility !== dependency.visibility || isCustomerPrincipal(execution.task.principal) && row.visibility !== "public") throw unavailable();
  }
  for (const dependency of dependencies.filter(item => item.kind === "connection")) {
    if (dependency.kind !== "connection") continue;
    const binding = await connectionEvidenceBinding(db,execution,dependency,origins);
    const row = (await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 FOR SHARE", [dependency.connectionId, execution.task.organization_id])).rows[0];
    if (!row || row.state !== "active" || row.policy_revision !== dependency.policyRevision || new Date(row.expires_at).getTime() <= Date.now() || row.account_id !== await owner(db, execution) || binding.connection?.policyRevision !== row.policy_revision || !row.resource_handles.some((resource: ResourceHandle) => requestDigest(resource) === dependency.resource)) throw unavailable();
  }
  for(const dependency of dependencies){
    if(dependency.kind!=="skill")continue;
    const root=execution.task.parent_task_id?await loadExecution(db,execution.task.root_task_id):execution;
    const candidates=[execution,root,...origins];
    if(!candidates.some(origin=>origin.agentId===dependency.agentId&&origin.configuration.skillIds.includes(dependency.skillId)))throw denied();
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
    const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
    if (root.task.principal.kind !== "human") throw denied();
    const row = (await db.query("SELECT * FROM agents_platform.memory_scopes WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND agent_id=$4 FOR SHARE", [dependency.referenceId, execution.task.organization_id, await owner(db, root), root.agentId])).rows[0];
    if (!row || Number(row.generation) !== dependency.generation || row.next_expiry_at && new Date(row.next_expiry_at).getTime() <= Date.now()) throw unavailable();
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
  if (value && typeof value === "object") return Object.values(value).some(item => payloadHas(item, text, label, remainingDecodes));
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
  await assertBaseAuthority(db,execution);
  if(execution.task.parent_task_id)await assertDelegationInputEvidence(db,execution.task.id);
}
