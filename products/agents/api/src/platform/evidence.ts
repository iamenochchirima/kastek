import {writeExecutionObject} from "./execution-objects";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "./contracts";
import { capabilityBindingSchema, type CapabilityBinding, type ResourceHandle } from "./capability-catalog";
import { assertCurrentAuthority, loadExecution, type Execution } from "./execution";
import { transaction } from "./database";
import type { PrivateObjectStore } from "./artifacts";
import { assertDependencyManifest, collectDependencyGraph, createDependencyManifest, evidenceReferenceSchema, SOURCE_LIMITS, textDigest,
  type DependencyManifest, type EvidenceDependency, type EvidenceReference } from "./source-contracts";

type Db = Pool | PoolClient;
export type EvidenceKind = "context" | "summary" | "memory" | "artifact" | "child_result" | "input";
export interface EvidenceNode { id: string; taskId: string; kind: EvidenceKind; ownerId: string; evidenceIds: string[]; parents: string[]; manifest: DependencyManifest }
export interface EvidencePassage { reference: EvidenceReference; label: string; text: string; title: string; page: number | null; section: string | null }
export interface ConnectedEvidenceInput { bindingId: string; resource: ResourceHandle; text: string; title: string; acquiredAt: string; receiptDigest: string }
const denied = () => new PlatformError("EVIDENCE_SCOPE_DENIED", 403, "Evidence is outside the task's permitted scope");
const unavailable = () => new PlatformError("EVIDENCE_UNAVAILABLE", 403, "Evidence is no longer available");
const integrity = () => new PlatformError("EVIDENCE_INTEGRITY", 409, "Evidence content or provenance changed");
function dto(row: Record<string, any>): EvidenceReference { return evidenceReferenceSchema.parse({ id: row.id, organizationId: row.organization_id, rootTaskId: row.root_task_id,
  operationId: row.operation_id, sourceId: row.source_id, revisionId: row.revision_id, chunkId: row.chunk_id, start: row.start_offset, end: row.end_offset,
  contentDigest: row.content_digest, acquiredAt: new Date(row.acquired_at).toISOString(), manifest: row.manifest }); }
function nodeDto(row: Record<string, any>): EvidenceNode { return { id: row.id, taskId: row.task_id, kind: row.kind, ownerId: row.owner_id, evidenceIds: row.evidence_ids, parents: row.parents, manifest: assertDependencyManifest(row.manifest) }; }
async function owner(db: Db, execution: Execution): Promise<string | null> {
  const principal = execution.task.principal;
  if (principal.kind === "visitor") return null;
  if (principal.kind === "automation") return principal.ownerAccountId;
  return (await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [principal.issuer, principal.subject])).rows[0]?.id ?? null;
}
async function inspectionAuthority(db: Db, execution: Execution): Promise<void> {
  const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
  const accountId = await owner(db, root);
  if (accountId) {
    if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [root.task.organization_id, accountId])).rowCount) throw unavailable();
  } else if (root.task.principal.kind === "visitor") {
    if (!(await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.id=$1 AND s.id=$2 AND d.revoked_at IS NULL AND s.expires_at>now() AND d.version_id=$3 FOR SHARE OF d`, [root.task.principal.deploymentId, root.task.principal.sessionId, root.task.version_id])).rowCount) throw unavailable();
  } else throw unavailable();
  if ((await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id
    WHERE t.root_task_id=$1 AND c.deleted_at IS NOT NULL LIMIT 1`, [root.task.id])).rowCount) throw unavailable();
  const grant = (await db.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!grant || grant.revoked_at) throw unavailable();
}
async function sourceAllowed(db: Db, execution: Execution, revisionId: string): Promise<void> {
  const grant = (await db.query("SELECT source_revision_ids,operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!execution.configuration.sourceRevisionIds.includes(revisionId) || !grant?.source_revision_ids.includes(revisionId) || !grant.operations.includes("knowledge.read")) throw denied();
  if (!(await db.query("SELECT 1 FROM agents_platform.version_sources WHERE organization_id=$1 AND version_id=$2 AND revision_id=$3", [execution.task.organization_id, execution.task.version_id, revisionId])).rowCount) throw denied();
  if (execution.task.parent_task_id) {
    const root = await loadExecution(db, execution.task.root_task_id); await sourceAllowed(db, root, revisionId);
  }
}
async function bindingAllowed(db: Db, execution: Execution, bindingId: string): Promise<CapabilityBinding> {
  const grant = (await db.query("SELECT connected_tool_binding_ids,operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE", [execution.task.grant_id])).rows[0];
  if (!execution.configuration.connectedToolBindingIds.includes(bindingId) || !grant?.connected_tool_binding_ids.includes(bindingId) || !grant.operations.includes("connected.read")) throw denied();
  if (!(await db.query("SELECT 1 FROM agents_platform.version_connected_tools WHERE organization_id=$1 AND version_id=$2 AND binding_id=$3",[execution.task.organization_id,execution.task.version_id,bindingId])).rowCount) throw denied();
  const row = (await db.query("SELECT binding,account_id FROM agents_platform.capability_bindings WHERE id=$1 AND organization_id=$2", [bindingId, execution.task.organization_id])).rows[0];
  if (!row || row.account_id !== await owner(db, execution)) throw denied();
  const binding = capabilityBindingSchema.parse(row.binding);
  if (binding.policy.effect !== "read" || binding.policy.disclosure !== (binding.connection?.profileId === "stash-read-v1" ? "approved_resource_identifiers" : "public_identifiers") || !binding.connection) throw denied();
  if (execution.task.parent_task_id) await bindingAllowed(db, await loadExecution(db, execution.task.root_task_id), bindingId);
  return binding;
}
async function delegationInput(db:Db,childTaskId:string){
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
async function delegationDependency(db:Db,taskId:string):Promise<EvidenceDependency[]>{
 const input=await delegationInput(db,taskId);return input?[{kind:"delegation_input",referenceId:taskId,manifestDigest:input.manifest.digest}]:[];
}
/** Call inside the same transaction as the consuming model/effect claim, holding the organization lock. */
export async function assertCurrentEvidence(db: Db, taskId: string, input: DependencyManifest, options: { requireActiveTask?: boolean; delegationTrail?:readonly string[] } = {}): Promise<void> {
  const manifest = assertDependencyManifest(input), execution = await loadExecution(db, taskId);
  if (options.requireActiveTask !== false) await assertCurrentAuthority(db, execution); else {await inspectionAuthority(db, execution);if(execution.task.parent_task_id)await assertDelegationInputEvidence(db,taskId,undefined,options.delegationTrail);}
  const dependencies = [...manifest.dependencies].sort((a, b) => {
    const key = (value: EvidenceDependency) => value.kind === "source" ? value.sourceId : value.kind === "connection" ? value.connectionId : value.referenceId;
    return key(a).localeCompare(key(b));
  });
  for(const dependency of dependencies)if(dependency.kind==="delegation_input")await assertDelegationInputEvidence(db,dependency.referenceId,dependency.manifestDigest,options.delegationTrail,taskId);
  for (const dependency of dependencies.filter(item => item.kind === "source")) {
    if (dependency.kind !== "source") continue;
    await sourceAllowed(db, execution, dependency.revisionId);
    const row = (await db.query(`SELECT s.*,p.state AS revision_state FROM agents_platform.sources s
      JOIN agents_platform.source_revision_policy p ON p.source_id=s.id AND p.organization_id=s.organization_id
      WHERE s.id=$1 AND s.organization_id=$2 AND p.revision_id=$3 FOR SHARE OF s,p`, [dependency.sourceId, execution.task.organization_id, dependency.revisionId])).rows[0];
    if (!row || row.state !== "active" || row.revision_state !== "approved" || row.generation !== dependency.generation || row.visibility !== dependency.visibility || execution.task.principal.kind === "visitor" && row.visibility !== "public") throw unavailable();
  }
  for (const dependency of dependencies.filter(item => item.kind === "connection")) {
    if (dependency.kind !== "connection") continue;
    const bindings = (await db.query("SELECT id,binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])", [execution.task.organization_id, dependency.connectionId, execution.configuration.connectedToolBindingIds])).rows;
    const match = bindings.find(row => row.binding.catalog.digest === dependency.catalogDigest && row.binding.resources.some((resource: ResourceHandle) => requestDigest(resource) === dependency.resource));
    if (!match) throw denied();
    const binding = await bindingAllowed(db, execution, match.id);
    const row = (await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 FOR SHARE", [dependency.connectionId, execution.task.organization_id])).rows[0];
    if (!row || row.state !== "active" || row.policy_revision !== dependency.policyRevision || new Date(row.expires_at).getTime() <= Date.now() || row.account_id !== await owner(db, execution) || binding.connection?.policyRevision !== row.policy_revision || !row.resource_handles.some((resource: ResourceHandle) => requestDigest(resource) === dependency.resource)) throw unavailable();
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
function boundedText(text: string): void {
  if (!text.length || Buffer.byteLength(text) > 8192) throw new PlatformError("EVIDENCE_LIMIT", 413, "Evidence passage exceeds its visible text limit");
}
function payloadHas(value: unknown, text: string, label: string): boolean {
  if (typeof value === "string") return (value.includes(text) || value.includes(JSON.stringify(text).slice(1,-1))) && value.includes(`[${label}]`);
  if (Array.isArray(value)) return value.some(item => payloadHas(item, text, label));
  if (value && typeof value === "object") return Object.values(value).some(item => payloadHas(item, text, label));
  return false;
}
function memoryVisible(value:unknown,id:string,content:string):boolean{
  if(typeof value==="string"){
    if(value.includes(content))return true;
    const start=value.indexOf("{");if(start>=0)try{const record=JSON.parse(value.slice(start));return record.kind==="memory"&&record.sourceId===id&&typeof record.content==="string"&&record.content.length>0&&content.startsWith(record.content);}catch{return false;}
    return false;
  }
  if(Array.isArray(value))return value.some(item=>memoryVisible(item,id,content));
  if(value&&typeof value==="object")return Object.values(value).some(item=>memoryVisible(item,id,content));
  return false;
}
export class EvidenceStore {
  constructor(private readonly pool: Pool, private readonly objects?: PrivateObjectStore) {}
  private objectStore(): PrivateObjectStore {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private evidence storage is unavailable");
    return this.objects;
  }
  private async scoped<T>(taskId: string, work: (db: PoolClient, execution: Execution) => Promise<T>): Promise<T> {
    return transaction(this.pool, async db => {
      const initial = await loadExecution(db, taskId);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.task.organization_id]);
      const execution = await loadExecution(db, taskId);
      await assertCurrentAuthority(db, execution);
      return work(db, execution);
    });
  }
  private async operation(db: Db, taskId: string, operationId: string, names?: string[]): Promise<void> {
    const row = (await db.query("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2", [operationId, taskId])).rows[0];
    if (!row || !["started", "completed"].includes(row.state) || names && !names.includes(row.name)) throw denied();
  }
  private async insert(db: PoolClient, execution: Execution, operationId: string, input: {
    sourceId?: string; revisionId?: string; chunkId?: string; start: number; end: number; text: string; title: string;
    acquiredAt: string; manifest: DependencyManifest; page?: number | null; section?: string | null;
    bindingId?: string; resource?: ResourceHandle; receiptDigest?: string; objectKey?: string; inlineContent?: string;
  }): Promise<EvidencePassage> {
    boundedText(input.text);
    const digest = requestDigest(input);
    const prior = (await db.query("SELECT * FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2 AND request_digest=$3", [execution.task.id, operationId, digest])).rows[0];
    await assertCurrentEvidence(db, execution.task.id, input.manifest);
    if (prior) return { reference: dto(prior), label: prior.citation_label, text: input.text, title: input.title, page: input.page ?? null, section: input.section ?? null };
    const count = Number((await db.query("SELECT count(*) AS count FROM agents_platform.evidence_references WHERE root_task_id=$1", [execution.task.root_task_id])).rows[0].count);
    if (count >= SOURCE_LIMITS.manifestNodes) throw new PlatformError("EVIDENCE_LIMIT", 413, "Too many evidence references");
    const id = randomUUID(), label = `E${id.replaceAll("-", "")}`;
    const row = (await db.query(`INSERT INTO agents_platform.evidence_references
      (id,organization_id,root_task_id,task_id,operation_id,citation_label,request_digest,source_id,revision_id,chunk_id,start_offset,end_offset,content_digest,acquired_at,manifest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id, execution.task.organization_id, execution.task.root_task_id, execution.task.id, operationId, label, digest, input.sourceId ?? null, input.revisionId ?? null, input.chunkId ?? null, input.start, input.end, textDigest(input.text), input.acquiredAt, input.manifest])).rows[0];
    await db.query(`INSERT INTO agents_platform.evidence_contents(reference_id,object_key,title,content_bytes,page,section,binding_id,resource,receipt_digest,inline_content)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, input.objectKey ?? null, input.title.slice(0,200), Buffer.byteLength(input.text), input.page ?? null, input.section ?? null, input.bindingId ?? null, input.resource ?? null, input.receiptDigest ?? null, input.inlineContent ?? null]);
    return { reference: dto(row), label, text: input.text, title: input.title.slice(0,200), page: input.page ?? null, section: input.section ?? null };
  }
  async recordChunk(taskId: string, operationId: string, chunkId: string, span: {start?: number; end?: number} = {}): Promise<EvidencePassage> {
    return this.scoped(taskId, async (db, execution) => {
      await this.operation(db, taskId, operationId, ["knowledge.search", "knowledge.read"]);
      const row = (await db.query(`SELECT c.*,r.source_id,r.acquired_at,s.title,s.generation,s.visibility FROM agents_platform.source_chunks c
        JOIN agents_platform.source_revisions r ON r.id=c.revision_id JOIN agents_platform.sources s ON s.id=r.source_id
        WHERE c.id=$1 AND c.organization_id=$2`, [chunkId, execution.task.organization_id])).rows[0];
      if (!row || textDigest(row.content) !== row.content_digest) throw integrity();
      const start = span.start ?? row.start_offset, end = span.end ?? row.end_offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < row.start_offset || end > row.end_offset || end <= start) throw integrity();
      const splitSurrogate = (offset:number) => offset > 0 && offset < row.content.length && /[\uD800-\uDBFF]/.test(row.content[offset-1]) && /[\uDC00-\uDFFF]/.test(row.content[offset]);
      if(splitSurrogate(start-row.start_offset)||splitSurrogate(end-row.start_offset))throw integrity();
      const text = row.content.slice(start-row.start_offset, end-row.start_offset);
      return this.insert(db, execution, operationId, {sourceId:row.source_id,revisionId:row.revision_id,chunkId,start,end,text,title:row.title,
        acquiredAt:new Date(row.acquired_at).toISOString(),page:row.page,section:row.section,
        manifest:createDependencyManifest([{kind:"source",sourceId:row.source_id,revisionId:row.revision_id,generation:row.generation,visibility:row.visibility}])});
    });
  }
  async recordConnected(taskId: string, operationId: string, input: ConnectedEvidenceInput): Promise<EvidencePassage> {
    boundedText(input.text); z.string().regex(/^[a-f0-9]{64}$/).parse(input.receiptDigest); z.string().datetime().parse(input.acquiredAt);
    const initial = await loadExecution(this.pool, taskId);
    const objectKey = `evidence/${initial.task.organization_id}/${initial.task.root_task_id}/${textDigest(input.text)}`;
    // Content-addressed bytes are immutable; policy is checked again before the reference is published.
    await writeExecutionObject(this.pool,this.objectStore(),{taskId,operationId,key:objectKey,bytes:Buffer.from(input.text),contentType:"text/plain; charset=utf-8"});
    return this.scoped(taskId, async (db, execution) => {
      const binding = await bindingAllowed(db, execution, input.bindingId);
      await this.operation(db, taskId, operationId, [binding.alias]);
      if (!binding.resources.some(resource => requestDigest(resource) === requestDigest(input.resource))) throw denied();
      return this.insert(db, execution, operationId, {start:0,end:input.text.length,text:input.text,title:input.title,acquiredAt:input.acquiredAt,
        bindingId:input.bindingId,resource:input.resource,receiptDigest:input.receiptDigest,objectKey,
        manifest:createDependencyManifest([{kind:"connection",connectionId:binding.connection!.id,policyRevision:binding.connection!.policyRevision,resource:requestDigest(input.resource),catalogDigest:binding.catalog.digest}])});
    });
  }
  async recordMemory(taskId:string,operationId:string,memoryId:string):Promise<EvidencePassage>{
    const initial=await loadExecution(this.pool,taskId);
    if(initial.task.parent_task_id||initial.task.principal.kind!=="human"||!initial.configuration.memory.enabled)throw denied();
    const row=(await this.pool.query(`SELECT m.*,s.organization_id,s.agent_id,s.account_id,s.generation FROM agents_platform.memories m
      JOIN agents_platform.memory_scopes s ON s.id=m.scope_id WHERE m.id=$1`,[memoryId])).rows[0];
    if(!row||row.organization_id!==initial.task.organization_id||row.agent_id!==initial.agentId||row.account_id!==await owner(this.pool,initial)||row.status!=="accepted"||row.expires_at&&new Date(row.expires_at).getTime()<=Date.now())throw denied();
    if(textDigest(row.content)!==row.content_digest)throw integrity();
    boundedText(row.content);
    return this.scoped(taskId,async(db,execution)=>{
      await this.operation(db,taskId,operationId,["memory.search"]);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("memory.read"))throw denied();
      const origin=await this.memoryOrigin(db,execution,memoryId);if(origin.row.revision!==row.revision||origin.row.content_digest!==row.content_digest)throw integrity();
      return this.insert(db,execution,operationId,{start:0,end:row.content.length,text:row.content,title:"Personal memory",acquiredAt:new Date(row.updated_at).toISOString(),inlineContent:row.content,
        manifest:origin.manifest});
    });
  }
  private async passage(db: Db, taskId: string, evidenceId: string): Promise<EvidencePassage> {
    const execution = await loadExecution(db, taskId);
    const row = (await db.query(`SELECT e.*,c.object_key,c.inline_content,c.title,c.page,c.section FROM agents_platform.evidence_references e
      JOIN agents_platform.evidence_contents c ON c.reference_id=e.id WHERE e.id=$1 AND e.organization_id=$2 AND (e.root_task_id=$3 OR EXISTS(
        SELECT 1 FROM agents_platform.evidence_nodes n WHERE n.task_id=$4 AND e.id=ANY(n.evidence_ids)))`, [evidenceId,execution.task.organization_id,execution.task.root_task_id,taskId])).rows[0];
    if (!row) throw denied();
    const reference = dto(row); await assertCurrentEvidence(db, taskId, reference.manifest, {requireActiveTask:false});
    let text: string;
    if (row.inline_content !== null) text = row.inline_content;
    else if (row.object_key) text = Buffer.from(await this.objectStore().get(row.object_key)).toString("utf8");
    else {
      const chunk = (await db.query("SELECT content,start_offset FROM agents_platform.source_chunks WHERE id=$1 AND organization_id=$2", [row.chunk_id,execution.task.organization_id])).rows[0];
      if (!chunk) throw unavailable();
      text = chunk.content.slice(row.start_offset-chunk.start_offset,row.end_offset-chunk.start_offset);
    }
    if (textDigest(text) !== row.content_digest) throw integrity();
    return {reference,label:row.citation_label,text,title:row.title,page:row.page,section:row.section};
  }
  private async node(db: PoolClient, execution: Execution, kind: EvidenceKind, ownerId: string, evidenceIds: string[], parents: EvidenceNode[], inherited?:{evidenceIds:string[];manifest:DependencyManifest}): Promise<EvidenceNode> {
    const ids = [...new Set([...evidenceIds,...(inherited?.evidenceIds??[])])].sort(), parentIds = [...new Set(parents.map(parent=>parent.id))].sort();
    if (ids.length > SOURCE_LIMITS.manifestNodes || parentIds.length > SOURCE_LIMITS.manifestNodes) throw new PlatformError("EVIDENCE_LIMIT",413,"Evidence graph exceeds its limit");
    const dependencies: EvidenceDependency[] = [...await delegationDependency(db,execution.task.id),...parents.flatMap(parent=>parent.manifest.dependencies),...(inherited?.manifest.dependencies??[])];
    for (const id of evidenceIds) dependencies.push(...(await this.passage(db,execution.task.id,id)).reference.manifest.dependencies);
    const manifest = createDependencyManifest(dependencies);
    await assertCurrentEvidence(db,execution.task.id,manifest);
    const existing = (await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
    const graph = new Map(existing.map(node=>[node.id,node]));
    collectDependencyGraph(parentIds,graph);
    const digest = requestDigest({ids,parentIds,manifest});
    const prior = (await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind=$2 AND owner_id=$3",[execution.task.id,kind,ownerId])).rows[0];
    if (prior) { if (prior.request_digest!==digest) throw integrity(); return nodeDto(prior); }
    return nodeDto((await db.query(`INSERT INTO agents_platform.evidence_nodes(id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),execution.task.organization_id,execution.task.root_task_id,execution.task.id,kind,ownerId,ids,parentIds,manifest,digest])).rows[0]);
  }
  private async history(db:Db,execution:Execution,priorTaskId:string):Promise<{taskId:string;eligible:boolean;omissionCode?:string;evidenceIds:string[];manifest:DependencyManifest;originNodeIds:string[]}>{
    const empty={taskId:priorTaskId,evidenceIds:[] as string[],manifest:createDependencyManifest([]),originNodeIds:[] as string[]};
    const prior=(await db.query(`SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2 AND conversation_id=$3
      AND turn_sequence<$4 AND parent_task_id IS NULL`,[priorTaskId,execution.task.organization_id,execution.task.conversation_id,execution.task.turn_sequence])).rows[0];
    if(!prior)throw denied();
    const rows=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[prior.root_task_id])).rows.map(nodeDto);
    const roots=rows.filter(node=>node.taskId===priorTaskId),graph=new Map(rows.map(node=>[node.id,node]));
    const manifest=collectDependencyGraph(roots.map(node=>node.id),graph),ids=new Set<string>(),seen=new Set<string>();
    const visit=(id:string):void=>{if(seen.has(id))return;seen.add(id);const node=graph.get(id);if(!node)throw integrity();node.evidenceIds.forEach(value=>ids.add(value));node.parents.forEach(visit);};roots.forEach(node=>visit(node.id));
    try{await assertCurrentEvidence(db,execution.task.id,manifest);}
    catch(error){if(error instanceof PlatformError&&["EVIDENCE_SCOPE_DENIED","EVIDENCE_UNAVAILABLE","GRANT_CAPABILITY_DENIED"].includes(error.code))return{...empty,eligible:false,omissionCode:error.code};throw error;}
    return{taskId:priorTaskId,eligible:true,evidenceIds:[...ids].sort(),manifest,originNodeIds:roots.map(node=>node.id)};
  }
  async checkHistory(taskId:string,priorTaskIds:string[]){
    if(priorTaskIds.length>100)throw new PlatformError("EVIDENCE_LIMIT",413,"Too many history turns");
    return this.scoped(taskId,async(db,execution)=>{const results=[];for(const id of [...new Set(priorTaskIds)])results.push(await this.history(db,execution,id));return results;});
  }
  async inheritHistory(taskId:string,snapshotId:string,priorTaskIds:string[]):Promise<EvidenceNode>{
    if(priorTaskIds.length>100)throw new PlatformError("EVIDENCE_LIMIT",413,"Too many history turns");
    return this.scoped(taskId,async(db,execution)=>{
      const snapshot=(await db.query("SELECT payload FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[snapshotId,taskId])).rows[0];
      if(!snapshot||!Array.isArray(snapshot.payload.historyGroupIds))throw integrity();
      const selected=snapshot.payload.historyGroupIds as string[];
      if(requestDigest([...new Set(priorTaskIds)].sort())!==requestDigest([...new Set(selected)].sort()))throw integrity();
      const origins=[];for(const id of [...new Set(priorTaskIds)]){const prior=await this.history(db,execution,id);if(!prior.eligible)throw unavailable();origins.push(prior);}
      const manifest=createDependencyManifest(origins.flatMap(origin=>origin.manifest.dependencies));
      const node=await this.node(db,execution,"input",`history:${snapshotId}`,[],[],{evidenceIds:origins.flatMap(origin=>origin.evidenceIds),manifest});
      for(const origin of origins)await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,origin.taskId,origin.originNodeIds]);
      return node;
    });
  }
  private async memoryOrigin(db:Db,execution:Execution,memoryId:string){
    if(execution.task.parent_task_id||execution.task.principal.kind!=="human"||!execution.configuration.memory.enabled)throw denied();
    const row=(await db.query(`SELECT m.*,s.organization_id,s.agent_id,s.account_id,s.generation FROM agents_platform.memories m
      JOIN agents_platform.memory_scopes s ON s.id=m.scope_id WHERE m.id=$1`,[memoryId])).rows[0];
    if(!row||row.organization_id!==execution.task.organization_id||row.agent_id!==execution.agentId||row.account_id!==await owner(db,execution)||row.status!=="accepted"||row.expires_at&&new Date(row.expires_at).getTime()<=Date.now()||textDigest(row.content)!==row.content_digest)throw unavailable();
    let roots:EvidenceNode[]=[],nodes:EvidenceNode[]=[];
    if(row.source_task_id){
      const source=await loadExecution(db,row.source_task_id);
      if(source.task.organization_id!==execution.task.organization_id||source.agentId!==execution.agentId||await owner(db,source)!==row.account_id)throw denied();
      await inspectionAuthority(db,source);
      nodes=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[source.task.root_task_id])).rows.map(nodeDto);
      roots=nodes.filter(node=>node.taskId===row.source_task_id&&node.kind==="memory"&&node.ownerId===memoryId);
      if(!roots.length)roots=nodes.filter(node=>node.taskId===row.source_task_id);
    }
    const graph=new Map(nodes.map(node=>[node.id,node])),origin=collectDependencyGraph(roots.map(node=>node.id),graph);
    const manifest=createDependencyManifest([...origin.dependencies,{kind:"memory",referenceId:row.scope_id,generation:Number(row.generation)}]);
    await assertCurrentEvidence(db,execution.task.id,manifest);
    const evidenceIds=new Set<string>(),visited=new Set<string>();
    const visit=(id:string):void=>{if(visited.has(id))return;visited.add(id);const node=graph.get(id);if(!node)throw integrity();node.evidenceIds.forEach(value=>evidenceIds.add(value));node.parents.forEach(visit);};roots.forEach(node=>visit(node.id));
    return{row,manifest,evidenceIds:[...evidenceIds]};
  }
  async checkMemories(taskId:string,memoryIds:string[]){
    if(memoryIds.length>100)throw new PlatformError("EVIDENCE_LIMIT",413,"Too many memory records");
    return this.scoped(taskId,async(db,execution)=>{const results=[];for(const id of [...new Set(memoryIds)]){
      try{const origin=await this.memoryOrigin(db,execution,id);results.push({id,eligible:true,manifest:origin.manifest});}
      catch(error){if(error instanceof PlatformError&&["EVIDENCE_SCOPE_DENIED","EVIDENCE_UNAVAILABLE","GRANT_CAPABILITY_DENIED"].includes(error.code))results.push({id,eligible:false,omissionCode:error.code});else throw error;}
    }return results;});
  }
  async supplyContext(taskId: string, snapshotId: string, evidenceIds: string[]): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      const snapshot = (await db.query("SELECT * FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[snapshotId,taskId])).rows[0];
      if (!snapshot) throw denied();
      for (const id of evidenceIds) { const passage = await this.passage(db,taskId,id); if (!payloadHas(snapshot.payload,passage.text,passage.label)) throw integrity(); }
      const parents = (await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 ORDER BY created_at,id",[taskId])).rows.map(nodeDto);
      const selectedMemories=(snapshot.source_references??[]).filter((reference:{kind?:string})=>reference.kind==="memory");
      const memoryDependencies:EvidenceDependency[]=[],inheritedIds:string[]=[];
      for(const selected of selectedMemories){const origin=await this.memoryOrigin(db,execution,selected.id);
        if(!memoryVisible(snapshot.payload,selected.id,origin.row.content))throw integrity();
        if(origin.row.revision!==selected.revision||origin.row.scope_id!==snapshot.memory_scope_id||Number(origin.row.generation)!==Number(snapshot.memory_generation))throw integrity();
        memoryDependencies.push(...origin.manifest.dependencies);inheritedIds.push(...origin.evidenceIds);}
      return this.node(db,execution,"context",snapshotId,evidenceIds,parents,{manifest:createDependencyManifest(memoryDependencies),evidenceIds:inheritedIds});
    });
  }
  async inheritArtifactWithin(db:PoolClient,targetTaskId:string,artifactId:string):Promise<EvidenceNode>{
    const execution=await loadExecution(db,targetTaskId);await assertCurrentAuthority(db,execution);
    const row=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1 AND kind='artifact' AND owner_id=$2 AND organization_id=$3",[execution.task.root_task_id,artifactId,execution.task.organization_id])).rows[0];
    if(!row)throw unavailable();return this.node(db,execution,"input",`artifact:${artifactId}`,[],[nodeDto(row)]);
  }
  async deriveWithin(db:PoolClient,taskId:string,kind:Exclude<EvidenceKind,"context">,ownerId:string):Promise<EvidenceNode>{
    const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
    const parents=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND NOT(kind=$2 AND owner_id=$3) ORDER BY created_at,id",[taskId,kind,ownerId])).rows.map(nodeDto);
    return this.node(db,execution,kind,ownerId,[],parents);
  }
  async artifactManifest(db:Db,taskId:string,artifactId:string):Promise<DependencyManifest>{
    const artifact=(await db.query("SELECT task_id FROM agents_platform.artifacts WHERE id=$1",[artifactId])).rows[0];
    const execution=await loadExecution(db,taskId);
    const row=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='artifact' AND owner_id=$2 AND organization_id=$3 AND root_task_id=$4",[artifact?.task_id,artifactId,execution.task.organization_id,execution.task.root_task_id])).rows[0];
    if(!row)throw unavailable();const manifest=assertDependencyManifest(row.manifest);await assertCurrentEvidence(db,taskId,manifest,{requireActiveTask:false});return manifest;
  }
  async derive(taskId: string, kind: Exclude<EvidenceKind,"context">, ownerId: string): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      const parents = (await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND NOT(kind=$2 AND owner_id=$3) ORDER BY created_at,id",[taskId,kind,ownerId])).rows.map(nodeDto);
      return this.node(db,execution,kind,ownerId,[],parents);
    });
  }
  async joinChildren(taskId: string, operationId: string): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      await this.operation(db,taskId,operationId);
      const operation=(await db.query("SELECT kind FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[operationId,taskId])).rows[0];
      if(operation?.kind!=="delegation")throw denied();
      const children = (await db.query(`SELECT n.* FROM agents_platform.evidence_nodes n JOIN agents_platform.tasks t ON t.id=n.task_id
        JOIN agents_platform.delegations d ON d.child_task_id=t.id
        WHERE d.parent_task_id=$1 AND d.operation_id=$2 AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain') AND t.output IS NOT NULL AND n.kind='child_result' ORDER BY n.id`,[taskId,operationId])).rows.map(nodeDto);
      return this.node(db,execution,"input",operationId,[],children);
    });
  }
  async validateCitations(taskId: string, text: string): Promise<EvidencePassage[]> {
    const execution = await loadExecution(this.pool,taskId);
    const rows = (await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 ORDER BY created_at,id",[taskId])).rows.map(nodeDto);
    const all = (await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
    const graph = new Map(all.map(node=>[node.id,node])); collectDependencyGraph(rows.map(node=>node.id),graph);
    const supplied = new Set<string>(), seen = new Set<string>();
    const visit = (id:string):void => { if(seen.has(id))return;seen.add(id);const node=graph.get(id);if(!node)throw integrity();node.evidenceIds.forEach(value=>supplied.add(value));node.parents.forEach(visit); };
    rows.forEach(node=>visit(node.id));
    const references = supplied.size ? (await this.pool.query("SELECT id,citation_label FROM agents_platform.evidence_references WHERE id=ANY($1::uuid[])",[[...supplied]])).rows : [];
    const passages:EvidencePassage[]=[];
    for(const label of citationLabels(text)){const reference=references.find(row=>row.citation_label===label);if(!reference)throw new PlatformError("CITATION_UNKNOWN",422,"Report contains a citation that was not supplied to this task");passages.push(await this.passage(this.pool,taskId,reference.id));}
    return passages;
  }
  async readPassage(taskId:string,evidenceId:string):Promise<EvidencePassage>{return this.passage(this.pool,taskId,evidenceId);}
  async operationEvidenceIds(taskId:string,operationId:string):Promise<string[]>{
    await this.operation(this.pool,taskId,operationId);
    return(await this.pool.query("SELECT id FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2 ORDER BY citation_label",[taskId,operationId])).rows.map(row=>row.id);
  }
  async taskManifest(taskId:string):Promise<DependencyManifest>{
    return taskEvidenceManifest(this.pool,taskId);
  }
  /** Designated reviewers can inspect cited passages only, never arbitrary root evidence or private inputs. */
  async reviewerPassages(scope:{organizationId:string;accountId:string},taskId:string,artifactId:string):Promise<EvidencePassage[]>{
    return transaction(this.pool,db=>this.reviewerPassagesWithin(db,scope,taskId,artifactId));
  }
  async reviewerPassagesWithin(db:PoolClient,scope:{organizationId:string;accountId:string},taskId:string,artifactId:string):Promise<EvidencePassage[]>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw denied();
      const action=(await db.query(`SELECT a.artifact_digest FROM agents_platform.actions a JOIN agents_platform.artifacts f ON f.id=a.artifact_id
        WHERE a.task_id=$1 AND a.organization_id=$2 AND a.artifact_id=$3 AND (a.account_id=$4 OR a.reviewer_account_id=$4)
        AND f.state='available' AND f.content_digest=a.artifact_digest`,[taskId,scope.organizationId,artifactId,scope.accountId])).rows[0];
      if(!action)throw denied();
      await assertCurrentEvidence(db,taskId,await this.taskManifest(taskId),{requireActiveTask:false});
      const references=(await db.query("SELECT reference_id FROM agents_platform.artifact_citations WHERE artifact_id=$1 ORDER BY reference_id",[artifactId])).rows;
      const passages:EvidencePassage[]=[];for(const row of references)passages.push(await this.passage(db,taskId,row.reference_id));return passages;
  }
  async verifyQuote(taskId:string,evidenceId:string,quote:string):Promise<boolean>{if(!quote.length)return false;return(await this.passage(this.pool,taskId,evidenceId)).text.includes(quote);}
  async validateReport(taskId:string,artifactId:string,text:string):Promise<EvidencePassage[]>{
    const passages=await this.validateCitations(taskId,text);
    await this.scoped(taskId,async(db,execution)=>{
      const artifact=(await db.query("SELECT content_digest FROM agents_platform.artifacts WHERE id=$1 AND task_id=$2 AND organization_id=$3",[artifactId,taskId,execution.task.organization_id])).rows[0];
      if(!artifact||artifact.content_digest!==textDigest(text))throw integrity();
      for(const passage of passages){await assertCurrentEvidence(db,taskId,passage.reference.manifest);await db.query("INSERT INTO agents_platform.artifact_citations(artifact_id,reference_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[artifactId,passage.reference.id]);}
    });return passages;
  }
}
